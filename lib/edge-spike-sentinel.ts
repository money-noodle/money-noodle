import type { PositionSide } from './types';

/**
 * Prospective evidence for the edge-spike freshness gate (buy policy v18).
 *
 * Records every decision that passed every other persistence gate and reached the spike check, labelled
 * by whether the gate admitted it. Both arms come from one evaluation on one population at the same
 * moment in the window, so they are comparable by construction.
 *
 * **Committed at decision time, not fill time.** Derived from fills the admitted arm would inherit maker
 * selection — and the 2026-08-17 review found maker fills are themselves adversely selected in exactly
 * this cohort, so scoring a real-fills arm against a counterfactual one would reproduce the error the
 * gate exists to address. The admitted arm is deliberately not taken from the order ledger.
 *
 * Pure and I/O free. See docs/edge-spike-sentinel-design.md §4.
 */
export const EDGE_SPIKE_SENTINEL_VERSION = 'edge-spike-sentinel-v1';

/**
 * Resolved windows in the declined arm before the first review. A review bar, not a promotion criterion:
 * promotion and withdrawal are manual acts with a written reason.
 */
export const EDGE_SPIKE_REVIEW_WINDOWS = 60;

export interface EdgeSpikeSentinel {
  id: string;
  sentinelVersion: string;
  /** Buy policy in force. A policy change starts a fresh evidence cohort. */
  policyVersion: string;
  symbol: string;
  contractId: string;
  side: PositionSide;
  closesAt: string;
  createdAt: string;
  /** Whether the freshness gate let this decision through. This is the arm label. */
  admitted: boolean;
  /** The continuous value, so the threshold can be described at review but not re-chosen. */
  edgeSpike: number;
  /** Both inputs, so the spike is recomputable rather than trusted. */
  netEdge: number;
  medianNetEdge: number;
  selectedSideProbability: number;
  confidence: number;
  askPrice: number;
  estimatedFeeRate: number;
  qualifyingSnapshots: number;
  /** Patched in once at settlement. Nothing else is ever rewritten. */
  outcome?: PositionSide;
  resolvedAt?: string;
  realizedEdge?: number;
  invalidReason?: string;
}

export interface EdgeSpikeArm {
  samples: number;
  windows: number;
  /** Fraction of resolved samples whose chosen side settled in the money. */
  winRate: number | null;
  /** Mean realized edge per $1 of payout, averaged within a settlement window then across windows. */
  clusteredMeanEdge: number | null;
  standardError: number | null;
}

export interface EdgeSpikeSentinelReport {
  sentinelVersion: string;
  policyVersion: string;
  samples: number;
  resolvedSamples: number;
  admitted: EdgeSpikeArm;
  declined: EdgeSpikeArm;
  /** admitted − declined in mean realized edge. Positive means the gate refused the worse cohort. */
  advantage: number | null;
  standardError: number | null;
  reviewWindowsRequired: number;
  reviewUnlocked: boolean;
}

export function edgeSpikeSentinelId(input: { policyVersion: string; symbol: string; side: PositionSide; closesAt: string }): string {
  return `${EDGE_SPIKE_SENTINEL_VERSION}:${input.policyVersion}:${input.symbol}:${input.side}:${input.closesAt}`;
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/**
 * One settlement window is one observation however many rows it contributed.
 *
 * Clustering matters less here than in the row-level reports — the sentinel writes at most one record per
 * (symbol, side, window) — but two sides of one asset in one window still share a single coin flip, and
 * scoring them independently would shrink the interval for no reason.
 */
function arm(sentinels: EdgeSpikeSentinel[]): EdgeSpikeArm {
  const resolved = sentinels.filter((item) => item.resolvedAt && item.realizedEdge !== undefined && !item.invalidReason);
  const byWindow = new Map<string, number[]>();
  for (const item of resolved) {
    const key = `${item.symbol}|${item.closesAt}`;
    byWindow.set(key, [...(byWindow.get(key) ?? []), item.realizedEdge!]);
  }
  const perWindow = [...byWindow.values()].flatMap((values) => {
    const value = mean(values);
    return value === null ? [] : [value];
  });
  const centre = mean(perWindow);
  const standardError = perWindow.length > 1 && centre !== null
    ? Math.sqrt(perWindow.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
    : null;
  return {
    samples: sentinels.length,
    windows: perWindow.length,
    winRate: resolved.length ? resolved.filter((item) => item.outcome === item.side).length / resolved.length : null,
    clusteredMeanEdge: centre,
    standardError,
  };
}

export function buildEdgeSpikeSentinelReport(sentinels: EdgeSpikeSentinel[], policyVersion: string): EdgeSpikeSentinelReport {
  const current = sentinels.filter((item) => item.policyVersion === policyVersion);
  const admitted = arm(current.filter((item) => item.admitted));
  const declined = arm(current.filter((item) => !item.admitted));
  const advantage = admitted.clusteredMeanEdge !== null && declined.clusteredMeanEdge !== null
    ? admitted.clusteredMeanEdge - declined.clusteredMeanEdge : null;
  const standardError = admitted.standardError !== null && declined.standardError !== null
    ? Math.sqrt(admitted.standardError ** 2 + declined.standardError ** 2) : null;
  return {
    sentinelVersion: EDGE_SPIKE_SENTINEL_VERSION,
    policyVersion,
    samples: current.length,
    resolvedSamples: current.filter((item) => item.resolvedAt && !item.invalidReason).length,
    admitted,
    declined,
    advantage,
    standardError,
    reviewWindowsRequired: EDGE_SPIKE_REVIEW_WINDOWS,
    // Gated on the declined arm: it is the one the gate stopped the desk from learning about any other way.
    reviewUnlocked: declined.windows >= EDGE_SPIKE_REVIEW_WINDOWS,
  };
}
