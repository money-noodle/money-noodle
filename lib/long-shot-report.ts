import type { ExecutionMode, PaperOrder } from './types';

/**
 * Operator-facing report for the long-shot policy. Pure and I/O free.
 *
 * Never blends execution tracks or strategies: the caller passes orders already narrowed to one strategy,
 * and `mode` narrows to one track. Blending live with paper, or one strategy with another, produces a
 * number that describes neither.
 */
export const LONG_SHOT_REPORT_VERSION = 'long-shot-round-trip-report-v1';

/** Resolved attempts before the first manual review. Sample readiness cannot promote or change anything. */
export const LONG_SHOT_REVIEW_ATTEMPTS = 60;

const settledStatuses = new Set(['won', 'lost', 'invalid', 'sold']);

export interface LongShotSegment {
  label: string;
  attempts: number;
  /** Independent settlement windows, which is the unit uncertainty is read at. */
  windows: number;
  /** Attempts closed by the exit target rather than settlement. */
  exitedAtMark: number;
  settledUnexited: number;
  realizedPnlCents: number;
  stakedCents: number;
  /** Mean return per $1 staked, averaged within a settlement window then across windows. */
  clusteredMeanReturn: number | null;
  standardError: number | null;
}

export interface LongShotReport {
  reportVersion: string;
  mode: ExecutionMode;
  policyVersion?: string;
  /** Attempts that reached the venue, whether or not they filled. */
  submitted: number;
  filled: number;
  unfilled: number;
  open: number;
  resolved: number;
  overall: LongShotSegment;
  byEntryGeneration: LongShotSegment[];
  byRegime: LongShotSegment[];
  byAsset: LongShotSegment[];
  bySide: LongShotSegment[];
  /**
   * How close the unsold positions came to the mark. This is what says whether a different exit mark would
   * have paid, without waiting for another month of collection under a changed parameter.
   */
  peakBidBuckets: Array<{ atLeastCents: number; count: number }>;
  reviewAttemptsRequired: number;
  reviewUnlocked: boolean;
}

const stake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents;
const pnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

const windowKey = (order: PaperOrder) => {
  const timestamp = Date.parse(order.closesAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : order.closesAt;
};

/**
 * Clustered by settlement window because correlated crypto contracts sharing a close are not independent.
 * Averaged within a window first, so a window carrying three attempts cannot outvote one carrying a single
 * attempt — the same rule the desk already applies to calibration evidence.
 */
function segment(label: string, orders: PaperOrder[]): LongShotSegment {
  const settled = orders.filter((order) => settledStatuses.has(order.status));
  const windows = new Map<string, number[]>();
  for (const order of settled) {
    const staked = stake(order);
    if (!(staked > 0)) continue;
    const key = windowKey(order);
    windows.set(key, [...(windows.get(key) ?? []), pnl(order) / staked]);
  }
  const perWindow = [...windows.values()].map((values) => mean(values)!);
  const average = mean(perWindow);
  return {
    label,
    attempts: settled.length,
    windows: windows.size,
    exitedAtMark: settled.filter((order) => order.status === 'sold').length,
    settledUnexited: settled.filter((order) => order.status !== 'sold').length,
    realizedPnlCents: settled.reduce((sum, order) => sum + pnl(order), 0),
    stakedCents: settled.reduce((sum, order) => sum + stake(order), 0),
    clusteredMeanReturn: average,
    standardError: average !== null && perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((sum, value) => sum + (value - average) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
      : null,
  };
}

function groupBy(orders: PaperOrder[], key: (order: PaperOrder) => string | undefined, prefix = ''): LongShotSegment[] {
  const groups = new Map<string, PaperOrder[]>();
  for (const order of orders) {
    const value = key(order) ?? 'unlabelled';
    groups.set(value, [...(groups.get(value) ?? []), order]);
  }
  return [...groups.entries()]
    .map(([label, group]) => segment(`${prefix}${label}`, group))
    // Most evidence first, with the label as a stable tiebreak so the ordering is total.
    .sort((left, right) => right.attempts - left.attempts || left.label.localeCompare(right.label));
}

export function buildLongShotReport(input: {
  orders: PaperOrder[];
  mode: ExecutionMode;
  /** Scopes the cohort. Omit only where every order is known to share one rule set, such as in tests. */
  policyVersion?: string;
  peakBidThresholdsCents?: number[];
}): LongShotReport {
  // A parameter change starts a fresh cohort. Results produced under different marks or a different entry
  // window cannot be credited to the current rules, and blending them is silent rather than loud.
  const mine = input.orders.filter((order) => order.executionMode === input.mode && !order.id.includes(':exit:')
    && (!input.policyVersion || (order.strategyPolicyVersion ?? input.policyVersion) === input.policyVersion));
  const filled = mine.filter((order) => (order.filledCount ?? 0) > 0 || settledStatuses.has(order.status) || order.status === 'open');
  const settled = mine.filter((order) => settledStatuses.has(order.status));

  // Only positions that were never sold can inform a different mark: one that already exited at the mark
  // tells us nothing about whether a higher mark would also have been reached.
  const unsold = settled.filter((order) => order.status !== 'sold');
  const thresholds = input.peakBidThresholdsCents ?? [50, 60, 70, 80, 90];

  return {
    reportVersion: LONG_SHOT_REPORT_VERSION,
    mode: input.mode,
    policyVersion: input.policyVersion,
    submitted: mine.length,
    filled: filled.length,
    unfilled: mine.filter((order) => order.status === 'unfilled' || order.status === 'rejected').length,
    open: mine.filter((order) => order.status === 'open').length,
    resolved: settled.length,
    overall: segment('overall', mine),
    byEntryGeneration: groupBy(mine, (order) => `generation ${order.entryGeneration ?? 1}`),
    byRegime: groupBy(mine, (order) => order.entryCycleRegime),
    byAsset: groupBy(mine, (order) => order.symbol),
    bySide: groupBy(mine, (order) => order.side),
    peakBidBuckets: thresholds.map((atLeastCents) => ({
      atLeastCents,
      count: unsold.filter((order) => (order.peakOwnedSideBidCents ?? 0) >= atLeastCents).length,
    })),
    reviewAttemptsRequired: LONG_SHOT_REVIEW_ATTEMPTS,
    reviewUnlocked: settled.length >= LONG_SHOT_REVIEW_ATTEMPTS,
  };
}
