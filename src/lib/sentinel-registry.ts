/**
 * The single enumeration of prospective-evidence instruments, in the same spirit as the provider,
 * market, and strategy registries: a new sentinel is a registry entry, never new UI.
 *
 * A sentinel records what a candidate rule *would* have done, prospectively, so a later review can be
 * decided on committed evidence rather than a retrospective screen. Nothing here authorizes anything.
 * Every entry is observation-only by construction, and `spec/policy-and-track-separation.md` §12.5 still
 * requires a manual, versioned promotion recorded in an immutable ledger before any behavior changes.
 *
 * This module holds descriptors and pure projection helpers only. It reads no durable store, so it stays
 * importable from tests and from the client boundary; the API route performs the reads.
 */
import { EXIT_POLICY_MINIMUM_DIVERGENT_WINDOWS, EXIT_POLICY_REVIEW_WINDOWS, EXIT_POLICY_MINIMUM_COVERAGE, EXIT_CANDIDATE_IDS } from './exit-policy-sentinel';
import { MAKER_RESTRICTION_MINIMUM_DIVERGENT_WINDOWS, MAKER_RESTRICTION_REVIEW_WINDOWS, MAKER_RESTRICTION_MINIMUM_COVERAGE } from './maker-restriction-sentinel';
import { MAKER_LIFECYCLE_CANDIDATE_IDS, MAKER_LIFECYCLE_MINIMUM_COVERAGE, MAKER_LIFECYCLE_MINIMUM_DIVERGENT_WINDOWS, MAKER_LIFECYCLE_REVIEW_WINDOWS } from './maker-lifecycle-sentinel';

export const SENTINEL_REGISTRY_VERSION = 'sentinel-registry-v1';

export type SentinelId =
  | 'exit-policy-sentinel-v2'
  | 'maker-restriction-sentinel-v1'
  | 'edge-spike-sentinel-v1'
  | 'maker-lifecycle-sentinel-v1'
  | 'hourly-threshold-observation-v1';

/**
 * `collecting` accrues evidence; `locked-for-review` has met every threshold and awaits a maintainer;
 * `concluded` reached a recorded decision; `retired` stopped collecting and cannot conclude. A retired
 * instrument stays enumerated so a stopped experiment remains visible rather than disappearing.
 */
export type SentinelLifecycle = 'collecting' | 'locked-for-review' | 'concluded' | 'retired';

/** Arm-bearing sentinels compare candidate rules; observation sentinels only accrue records. */
export type SentinelKind = 'candidate-arms' | 'observation';

export interface SentinelDescriptor {
  id: SentinelId;
  name: string;
  /** One sentence: the question this instrument exists to answer. */
  question: string;
  kind: SentinelKind;
  lifecycle: SentinelLifecycle;
  /** The frozen candidate family. Empty for observation instruments, which is reported, not hidden. */
  arms: readonly string[];
  /** Durable store this instrument writes, for operator orientation. */
  store: string;
  /** Why a non-collecting instrument stopped. Required whenever lifecycle is not `collecting`. */
  closedReason?: string;
  /**
   * When this instrument was last reviewed, and what that review concluded. A reviewed instrument that was
   * told to keep collecting must not keep showing `locked-for-review`: the badge would ask for a review that
   * has already happened, and the reader has no way to tell the difference.
   */
  lastReviewedAt?: string;
  lastReviewSummary?: string;
  lastReviewReport?: string;
}

export const SENTINELS: readonly SentinelDescriptor[] = [
  {
    id: 'exit-policy-sentinel-v2',
    name: 'Exit policy candidates (v2)',
    question: 'Would a tighter strict-value margin, a confirmation, or a trailing stop have beaten the production exit?',
    kind: 'candidate-arms',
    lifecycle: 'retired',
    arms: EXIT_CANDIDATE_IDS,
    store: 'exit-policy-sentinels-v2',
    closedReason: 'A fresh zero executable bid was recorded as generic unavailable, so losing paths that converge to zero were dropped and every incomplete position was a loss. The review lock can never open. Superseded by v3 under DEC-20260828-01.',
  },
  {
    id: 'maker-restriction-sentinel-v1',
    name: 'Maker restrictions',
    question: 'Would refusing to post a maker on a wide spread or an edge spike have paid?',
    kind: 'candidate-arms',
    lifecycle: 'collecting',
    arms: ['maker-spread-max2c-v1', 'maker-spike-max2pp-v1'],
    store: 'maker-restriction-sentinels',
  },
  {
    id: 'maker-lifecycle-sentinel-v1',
    name: 'Maker lifecycle: short expiry and the taker',
    question: 'Would abandoning the maker at two seconds pay, and is it the shorter life or the taker that does it?',
    kind: 'candidate-arms',
    lifecycle: 'collecting',
    arms: MAKER_LIFECYCLE_CANDIDATE_IDS,
    store: 'maker-lifecycle-sentinels',
  },
  {
    id: 'edge-spike-sentinel-v1',
    name: 'Edge-spike freshness gate',
    question: 'Does the v18 edge-spike gate refuse the worse cohort, or is it inert?',
    kind: 'candidate-arms',
    lifecycle: 'collecting',
    arms: ['admitted', 'declined'],
    store: 'edge-spike-sentinels',
    lastReviewedAt: '2026-08-29',
    lastReviewSummary: 'Reviewed at its bar: advantage −6.16pp ± 3.80 (t −1.62) and shrinking as evidence accrues, so arming the gate is not supported. The gate stays disarmed and collection continues.',
    lastReviewReport: 'reports/edge-spike-gate-review-2026-08-29.md',
  },
  {
    id: 'hourly-threshold-observation-v1',
    name: 'Hourly threshold observations (H2)',
    question: 'Do the planned hourly threshold contracts expose exact, resolvable one-hour pairs often enough to model?',
    kind: 'observation',
    arms: [],
    lifecycle: 'collecting',
    store: 'hourly-threshold-observations',
  },
] as const;

export function sentinelDescriptor(id: string): SentinelDescriptor | undefined {
  return SENTINELS.find((sentinel) => sentinel.id === id);
}

export interface SentinelThresholdProgress {
  label: string;
  current: number;
  required: number;
  met: boolean;
  /** `count` renders as a bare number; `fraction` renders as a percentage. */
  unit: 'count' | 'fraction';
}

export interface SentinelArmProjection {
  armId: string;
  windows: number;
  divergentWindows: number | null;
  meanReturn: number | null;
  standardError: number | null;
  /** Mean over standard error. Null when either is unavailable or the error is degenerate. */
  tStatistic: number | null;
  clears: boolean;
}

export interface SentinelTrackProjection {
  mode: 'live' | 'paper';
  positions: number;
  completePositions: number;
  coverage: number | null;
  arms: SentinelArmProjection[];
}

export interface SentinelProjection extends SentinelDescriptor {
  openedAt: string | null;
  reviewUnlocked: boolean;
  thresholds: SentinelThresholdProgress[];
  tracks: SentinelTrackProjection[];
  /** Observation instruments report counts instead of arms. */
  observations: { label: string; value: number }[];
  /**
   * Straight-line projection of when the slowest unmet threshold is reached at the rate observed so far.
   * Null while the instrument is not collecting, has no elapsed time, or has met everything.
   */
  projectedCompleteAt: string | null;
  /** Holm bar the best arm must clear, as a t statistic, given this instrument's frozen family size. */
  holmBestArmT: number | null;
}

/** Thresholds are declared beside the constants that enforce them, never duplicated as literals. */
export function sentinelThresholds(id: SentinelId): { windows: number; divergentWindows: number; coverage: number } | null {
  if (id === 'exit-policy-sentinel-v2') {
    return { windows: EXIT_POLICY_REVIEW_WINDOWS, divergentWindows: EXIT_POLICY_MINIMUM_DIVERGENT_WINDOWS, coverage: EXIT_POLICY_MINIMUM_COVERAGE };
  }
  if (id === 'maker-restriction-sentinel-v1') {
    return { windows: MAKER_RESTRICTION_REVIEW_WINDOWS, divergentWindows: MAKER_RESTRICTION_MINIMUM_DIVERGENT_WINDOWS, coverage: MAKER_RESTRICTION_MINIMUM_COVERAGE };
  }
  if (id === 'maker-lifecycle-sentinel-v1') {
    return { windows: MAKER_LIFECYCLE_REVIEW_WINDOWS, divergentWindows: MAKER_LIFECYCLE_MINIMUM_DIVERGENT_WINDOWS, coverage: MAKER_LIFECYCLE_MINIMUM_COVERAGE };
  }
  return null;
}

/**
 * Two-sided normal quantile for the Holm bar `alpha / arms`, expressed as the one-sided t a candidate must
 * reach. Family size is the whole point: a fifth arm raises the bar for the other four.
 */
export function holmBestArmThreshold(arms: number, alpha = 0.05): number | null {
  if (!Number.isFinite(arms) || arms < 1) return null;
  const p = alpha / arms;
  // Acklam's inverse-normal approximation is ample here: the value is displayed, never used to decide.
  const q = 1 - p;
  const t = Math.sqrt(-2 * Math.log(1 - q));
  return Number((t - (2.30753 + 0.27061 * t) / (1 + 0.99229 * t + 0.04481 * t * t)).toFixed(3));
}

/** Straight-line completion estimate. Returns null rather than guessing when the rate is unknowable. */
export function projectCompletion(
  openedAt: string | null,
  thresholds: SentinelThresholdProgress[],
  nowMs = Date.now(),
): string | null {
  if (!openedAt) return null;
  const elapsedMs = nowMs - Date.parse(openedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  // A rate only extrapolates a count. Coverage is a ratio that can sit below its bar indefinitely, so an
  // unmet fraction threshold means the date is unknowable rather than soon -- projecting past it would
  // promise a completion the instrument may never reach.
  if (thresholds.some((threshold) => threshold.unit === 'fraction' && !threshold.met)) return null;
  const unmet = thresholds.filter((threshold) => !threshold.met && threshold.unit === 'count' && threshold.current > 0);
  if (!unmet.length) return null;
  const remainingMs = unmet.map((threshold) => (threshold.required - threshold.current) * (elapsedMs / threshold.current));
  return new Date(nowMs + Math.max(...remainingMs)).toISOString();
}
