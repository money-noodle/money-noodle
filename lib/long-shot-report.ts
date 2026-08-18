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

/**
 * The exit rule scored against holding, paired on identical orders.
 *
 * The sentinel arm (`lib/hold-sentinel.ts`) answers the same question without execution selection bias but
 * only at the collection cadence. This one is its complement: selected by what actually filled, and
 * therefore biased, but measuring realized proceeds, real fees, and the one-second exit poll. The two are
 * reported side by side and never summed. See docs/long-shot-policy-design.md §10a.
 */
export interface LongShotExitVersusHold {
  /**
   * Mean paired difference — exit minus hold — per $1 staked, over **every** settled attempt.
   *
   * Positive means the exit rule added value. Attempts that never sold contribute exactly zero, which is
   * correct rather than a filler: their realized P&L *is* the hold outcome. This is the figure that answers
   * "is the desk better off having the exit rule at all".
   */
  perDollar: number | null;
  standardError: number | null;
  windows: number;
  attempts: number;
  /** The same difference over only the attempts where the exit fired: "when it fires, is it right?" */
  whenExercisedPerDollar: number | null;
  whenExercisedStandardError: number | null;
  whenExercisedAttempts: number;
  /** Raw cash across the cohort. A per-$1 figure gets loud on a 13c stake; the operator should see both. */
  totalCents: number;
  /**
   * Sold, but neither the settled outcome nor its counterfactual has resolved yet. Excluded and counted:
   * treating an unresolved counterfactual as zero would silently report that selling cost nothing.
   */
  unresolvedCounterfactual: number;
  /**
   * Settled without a `sold` status while carrying an accepted venue exit. Excluded and counted.
   *
   * This conflates two cases the ledger cannot currently tell apart: an exit that filled nothing, whose
   * record is fine, and a **partial** exit, whose record is not — the partial branch of `runLongShotExits`
   * reduces the parent's quantity, payout and stake and does not retain the sold portion's proceeds, so
   * that order's P&L understates what happened. Both are dropped because only one is safe to keep and
   * separating them needs a durable marker that does not exist. Live-only: paper always exits in full.
   */
  exitAttemptedUnsold: number;
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
  exitVersusHold: LongShotExitVersusHold;
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

/** Mean and standard error over settlement windows, averaging within a window first (AGENTS §5.1). */
function clusterByWindow(rows: Array<{ key: string; value: number }>): { mean: number | null; standardError: number | null; windows: number } {
  const windows = new Map<string, number[]>();
  for (const row of rows) windows.set(row.key, [...(windows.get(row.key) ?? []), row.value]);
  const perWindow = [...windows.values()].map((values) => mean(values)!);
  const average = mean(perWindow);
  return {
    mean: average,
    standardError: average !== null && perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((sum, value) => sum + (value - average) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
      : null,
    windows: perWindow.length,
  };
}

/**
 * Return per $1 staked from holding this order to settlement instead of exiting.
 *
 * Computed uniformly for sold and unsold orders alike rather than branching on status. For an order that
 * was never sold this necessarily equals its realized P&L, so the paired difference is exactly zero — an
 * invariant the tests pin, which is stronger than a special case would be.
 *
 * The stake cancels out of the difference: `exit − hold = saleProceeds − settlementPayout`. So §1's exact
 * and whole-cent P&L views cannot mix inside the numerator, whichever view `pnl` returns.
 */
function holdPnlCents(order: PaperOrder): number | null {
  const settledSide = order.outcome ?? order.counterfactualHoldOutcome;
  if (!settledSide) return null;
  const payoutCents = settledSide === order.side ? order.potentialPayoutCents : 0;
  if (!Number.isFinite(payoutCents)) return null;
  return payoutCents - stake(order);
}

function exitVersusHold(settled: PaperOrder[]): LongShotExitVersusHold {
  const all: Array<{ key: string; value: number }> = [];
  const exercised: Array<{ key: string; value: number }> = [];
  let totalCents = 0;
  let unresolvedCounterfactual = 0;
  let exitAttemptedUnsold = 0;

  for (const order of settled) {
    // An accepted venue exit on an order that did not close `sold` may have filled partially, and a
    // partial does not retain its proceeds. Dropped rather than trusted.
    if (order.status !== 'sold' && order.exitVenueOrderId) { exitAttemptedUnsold += 1; continue; }
    const hold = holdPnlCents(order);
    if (hold === null) { unresolvedCounterfactual += 1; continue; }
    const staked = stake(order);
    if (!(staked > 0)) continue;
    const differenceCents = pnl(order) - hold;
    totalCents += differenceCents;
    const row = { key: windowKey(order), value: differenceCents / staked };
    all.push(row);
    if (order.status === 'sold') exercised.push(row);
  }

  const overall = clusterByWindow(all);
  const fired = clusterByWindow(exercised);
  return {
    perDollar: overall.mean,
    standardError: overall.standardError,
    windows: overall.windows,
    attempts: all.length,
    whenExercisedPerDollar: fired.mean,
    whenExercisedStandardError: fired.standardError,
    whenExercisedAttempts: exercised.length,
    totalCents,
    unresolvedCounterfactual,
    exitAttemptedUnsold,
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
    exitVersusHold: exitVersusHold(settled),
    reviewAttemptsRequired: LONG_SHOT_REVIEW_ATTEMPTS,
    reviewUnlocked: settled.length >= LONG_SHOT_REVIEW_ATTEMPTS,
  };
}
