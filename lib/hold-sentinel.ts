import type { PositionSide } from './types';

/**
 * Approach (ii): buy the long-shot trigger and hold to settlement, recorded as evidence and never traded.
 *
 * Committed at **trigger time**, not fill time. Derived from fills it would inherit every selection bias
 * of the executing lane — budget exhaustion, cap blocks, maker no-fills — and would answer "hold,
 * conditional on having successfully bought," which is a different and flatteringly selected question.
 * Written at decision time it also captures triggers the executing lane could not take.
 *
 * Pure and I/O free. See docs/long-shot-policy-design.md §10.
 */
export const HOLD_SENTINEL_VERSION = 'long-shot-hold-v2';

/** Independent settlement windows required before the first manual review. Not a promotion criterion. */
export const HOLD_SENTINEL_MINIMUM_REVIEW_WINDOWS = 60;

export interface HoldSentinel {
  id: string;
  sentinelVersion: string;
  /** Long-shot policy version in force. A policy change starts a fresh evidence cohort. */
  policyVersion: string;
  observedAt: string;
  symbol: string;
  side: PositionSide;
  closesAt: string;
  /** Exact venue contract, so a price is never scored against another venue's outcome. */
  contractId: string;
  /** Executable selected-side ask the round trip would have paid. */
  entryAskCents: number;
  /** Opposite side's ask, from which the owned side's bid is derived. */
  oppositeAskCents: number;
  secondsRemaining: number;
  entryMarkCents: number;
  exitMarkCents: number;
  quantity: number;
  stakeCents: number;
  estimatedFeeCents: number;
  /** Entry generation within this asset and window; 1 is the first, >1 is a re-entry. */
  entryGeneration: number;
  /**
   * Whether the executing lane actually took this trigger, and why not. Recorded as an observation rather
   * than used as a filter: the point of committing at trigger time is that skipped triggers stay in the
   * sample.
   */
  executed: boolean;
  skipReason?: string;
  /** Highest owned-side bid the executing lane observed while it held the position, when it held one. */
  peakOwnedSideBidCents?: number;
  /** Patched in on venue resolution. Nothing else is ever rewritten. */
  resolvedAt?: string;
  settledSide?: PositionSide;
}

export interface HoldSentinelArm {
  windows: number;
  samples: number;
  /** Fraction of samples that paid out; the meaning differs per arm and is documented at each use. */
  rate: number | null;
  /** Mean return per $1 staked, averaged within a settlement window then across windows. */
  clusteredMeanReturn: number | null;
  standardError: number | null;
}

export interface HoldSentinelReport {
  sentinelVersion: string;
  policyVersion: string;
  samples: number;
  resolvedSamples: number;
  /** Triggers the executing lane declined or could not fund; these are why trigger-time capture matters. */
  unexecutedSamples: number;
  hold: HoldSentinelArm;
  roundTrip: HoldSentinelArm;
  /**
   * Resolved sentinels carrying an observed peak bid.
   *
   * `reachedExitMark` reads `peakOwnedSideBidCents`, and a sentinel without one is indistinguishable from
   * one whose bid never moved: the round-trip arm silently collapses onto the hold arm and `advantage`
   * becomes an identical zero. That is exactly what happened between 2026-08-15 and 2026-08-17, when
   * `collectLongShotEvidence` returned no `peakBids` at all and the dashboard reported "selling early
   * beats holding by +0.0%" — a number nothing had measured. See docs/long-shot-policy-design.md §10a.
   *
   * **Zero here means the round-trip arm is unmeasured, not measured at zero**, and every consumer must
   * render it as such rather than showing a figure.
   */
  peakObservedSamples: number;
  /**
   * roundTrip − hold in mean return per $1 staked. Positive means selling early paid.
   *
   * Null when no resolved sentinel carries a peak, because the difference would then be a construction
   * rather than a measurement.
   */
  advantage: number | null;
  reviewWindowsRequired: number;
  reviewUnlocked: boolean;
  firstEntry: HoldSentinelArm;
  reEntry: HoldSentinelArm;
}

const settled = (sentinel: HoldSentinel) => Boolean(sentinel.resolvedAt && sentinel.settledSide);

/** Payout of one contract that settles in the owner's favour, in cents. */
const CONTRACT_PAYOUT_CENTS = 100;

/** Whether the round trip's exit mark was reached while the position was open. */
export function reachedExitMark(sentinel: HoldSentinel): boolean {
  return (sentinel.peakOwnedSideBidCents ?? 0) >= sentinel.exitMarkCents;
}

/** Return per $1 staked from holding this trigger to settlement. */
export function holdReturn(sentinel: HoldSentinel): number | null {
  if (!settled(sentinel) || sentinel.stakeCents <= 0) return null;
  const payout = sentinel.settledSide === sentinel.side ? sentinel.quantity * CONTRACT_PAYOUT_CENTS : 0;
  return (payout - sentinel.stakeCents) / sentinel.stakeCents;
}

/**
 * Return per $1 staked from the round trip on the same trigger.
 *
 * A miss is **not** a total loss: with no fallback exit, a position that never reaches the mark simply
 * settles, exactly as the hold arm does. The break-even touch rates quoted in the design doc assume a
 * worthless miss and are therefore conservative — they set a harder bar than the strategy actually faces.
 * This function makes no such assumption, which is why the comparison below needs no modelling at all.
 */
export function roundTripReturn(sentinel: HoldSentinel, exitFeeCents: number): number | null {
  if (!settled(sentinel) || sentinel.stakeCents <= 0) return null;
  if (!reachedExitMark(sentinel)) return holdReturn(sentinel);
  const proceeds = sentinel.quantity * sentinel.exitMarkCents - Math.max(0, exitFeeCents);
  return (proceeds - sentinel.stakeCents) / sentinel.stakeCents;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

const windowKey = (sentinel: HoldSentinel) => {
  const timestamp = Date.parse(sentinel.closesAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : sentinel.closesAt;
};

/**
 * Clustered by settlement window, because correlated crypto contracts sharing a close are not independent
 * observations. Averaged within a window first, then across windows, so a window carrying six triggers
 * cannot outvote one carrying a single trigger.
 */
function arm(sentinels: HoldSentinel[], value: (sentinel: HoldSentinel) => number | null, paid: (sentinel: HoldSentinel) => boolean): HoldSentinelArm {
  const windows = new Map<string, number[]>();
  let samples = 0;
  let paidCount = 0;
  for (const sentinel of sentinels) {
    const result = value(sentinel);
    if (result === null || !Number.isFinite(result)) continue;
    samples += 1;
    if (paid(sentinel)) paidCount += 1;
    const key = windowKey(sentinel);
    windows.set(key, [...(windows.get(key) ?? []), result]);
  }
  const perWindow = [...windows.values()].map((values) => mean(values)!);
  const average = mean(perWindow);
  const standardError = average !== null && perWindow.length > 1
    ? Math.sqrt(perWindow.reduce((sum, value) => sum + (value - average) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
    : null;
  return {
    windows: windows.size, samples,
    rate: samples ? paidCount / samples : null,
    clusteredMeanReturn: average, standardError,
  };
}

/**
 * Builds the comparison. `exitFeeCents` is supplied by the caller from the production fee model so this
 * module never duplicates it.
 *
 * Sample readiness unlocks a manual review and can never promote anything or change production.
 */
export function buildHoldSentinelReport(input: {
  sentinels: HoldSentinel[];
  policyVersion: string;
  exitFeeCents: (sentinel: HoldSentinel) => number;
}): HoldSentinelReport {
  // A policy change starts a fresh cohort: outcomes generated under different marks, clock, or sizing
  // cannot be credited to the current rules.
  const current = input.sentinels.filter((sentinel) => sentinel.sentinelVersion === HOLD_SENTINEL_VERSION
    && sentinel.policyVersion === input.policyVersion);
  const resolved = current.filter(settled);

  const hold = arm(resolved, holdReturn, (sentinel) => sentinel.settledSide === sentinel.side);
  const roundTrip = arm(resolved, (sentinel) => roundTripReturn(sentinel, input.exitFeeCents(sentinel)), reachedExitMark);
  // Without a peak the round trip cannot differ from the hold, so the comparison is a tautology rather
  // than an observation. Reported as unmeasured instead of as zero (§10a).
  const peakObservedSamples = resolved.filter((sentinel) => sentinel.peakOwnedSideBidCents !== undefined).length;

  return {
    sentinelVersion: HOLD_SENTINEL_VERSION,
    policyVersion: input.policyVersion,
    samples: current.length,
    resolvedSamples: resolved.length,
    unexecutedSamples: current.filter((sentinel) => !sentinel.executed).length,
    hold,
    roundTrip,
    peakObservedSamples,
    advantage: peakObservedSamples > 0 && roundTrip.clusteredMeanReturn !== null && hold.clusteredMeanReturn !== null
      ? roundTrip.clusteredMeanReturn - hold.clusteredMeanReturn
      : null,
    reviewWindowsRequired: HOLD_SENTINEL_MINIMUM_REVIEW_WINDOWS,
    reviewUnlocked: roundTrip.windows >= HOLD_SENTINEL_MINIMUM_REVIEW_WINDOWS,
    // Re-entries carry direct evidence that this window whipsaws, which is a fresher version of what the
    // rejected prior-cycle filter was reaching for. Kept separable so that hypothesis stays testable.
    firstEntry: arm(resolved.filter((sentinel) => sentinel.entryGeneration <= 1), (sentinel) => roundTripReturn(sentinel, input.exitFeeCents(sentinel)), reachedExitMark),
    reEntry: arm(resolved.filter((sentinel) => sentinel.entryGeneration > 1), (sentinel) => roundTripReturn(sentinel, input.exitFeeCents(sentinel)), reachedExitMark),
  };
}
