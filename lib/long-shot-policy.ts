import type { PositionSide } from './types';

/**
 * Pure rule layer for the long-shot round-trip policy. See docs/long-shot-policy-design.md.
 *
 * This module has no I/O and no `server-only` import so it can be exercised directly by tests and reused
 * by report surfaces. It deliberately takes no execution-mode parameter: as with the edge policy's rule
 * layer, paper and live must be unable to express a different decision (SPEC 12.3). `lib/mirror-invariant.test.ts`
 * asserts that by arity.
 */
export const LONG_SHOT_POLICY_VERSION = 'long-shot-round-trip-buy10-sell90-v1';

export interface LongShotSettings {
  enabled: boolean;
  /** Executable selected-side ask at or below which a candidate exists. */
  entryMarkCents: number;
  /** Resting reduce-only limit sell price. */
  exitMarkCents: number;
  /**
   * Expressed as time remaining rather than time elapsed. What makes a comeback possible is how much clock
   * is left for it, which is identical to "first N minutes" on a first entry and correct for re-entries,
   * where elapsed time is not.
   */
  minimumSecondsRemaining: number;
  /** Consecutive losses the ticket must survive; the ticket is equity divided by this. */
  drawdownDivisor: number;
  /** Below this the `max(1, ceil(...))` fee dominates and the traded edge disappears. */
  minimumTicketCents: number;
  maximumOpenPerSettlementWindow: number;
  maximumEntriesPerAssetWindow: number;
  /** Daily net-loss circuit breaker, denominated in tickets. */
  dailyLossTickets: number;
  excludedAssets: string[];
}

const bounded = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

const assetList = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((entry) => entry.trim().toUpperCase()).filter(Boolean);

export function longShotSettings(environment: NodeJS.ProcessEnv = process.env): LongShotSettings {
  const entryMarkCents = Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_ENTRY_MARK_CENTS, 10, 1, 49));
  return {
    enabled: environment.MONEY_NOODLE_LONG_SHOT_ENABLED === 'true',
    entryMarkCents,
    // Must stay strictly above the entry mark, or the exit would be at or below cost.
    exitMarkCents: Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_EXIT_MARK_CENTS, 90, entryMarkCents + 1, 99)),
    minimumSecondsRemaining: Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_MIN_SECONDS_REMAINING, 720, 120, 899)),
    drawdownDivisor: Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_DRAWDOWN_DIVISOR, 30, 5, 500)),
    minimumTicketCents: Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_MIN_TICKET_CENTS, 10, 2, 1000)),
    maximumOpenPerSettlementWindow: Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_MAX_OPEN_PER_WINDOW, 3, 1, 10)),
    maximumEntriesPerAssetWindow: Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_MAX_ENTRIES_PER_ASSET_WINDOW, 3, 1, 10)),
    dailyLossTickets: Math.floor(bounded(environment.MONEY_NOODLE_LONG_SHOT_DAILY_LOSS_TICKETS, 10, 1, 1000)),
    excludedAssets: assetList(environment.MONEY_NOODLE_LONG_SHOT_EXCLUDED_ASSETS),
  };
}

export interface LongShotSizing {
  ticketCents: number;
  halted: boolean;
  haltThresholdCents: number;
  reason?: string;
}

/**
 * The ticket is this policy's own equity divided by the drought it must survive, floored where fees stop
 * being negligible. It is deliberately not derived from the edge policy's all-in cap: that cap was sized
 * around a different policy's position limit, and depending on it would mean lowering the edge policy's
 * per-trade size silently halves this one.
 *
 * Callers snapshot this once per settlement window and hold it fixed for every entry in that window, so a
 * round trip's winnings cannot size up the next bet inside the same correlated event.
 *
 * The loss stop is the consequence rather than a separate number: below `minimumTicketCents x divisor` the
 * policy can no longer fund a viable ticket with adequate runway, and halts.
 */
export function longShotSizing(equityCents: number, settings: LongShotSettings): LongShotSizing {
  const haltThresholdCents = settings.minimumTicketCents * settings.drawdownDivisor;
  if (!Number.isFinite(equityCents) || equityCents < haltThresholdCents) {
    return {
      ticketCents: 0, halted: true, haltThresholdCents,
      reason: `Long-shot equity ${Math.max(0, Math.floor(equityCents || 0))}c is below the ${haltThresholdCents}c required to fund a ${settings.minimumTicketCents}c ticket with ${settings.drawdownDivisor} losses of runway.`,
    };
  }
  return { ticketCents: Math.floor(equityCents / settings.drawdownDivisor), halted: false, haltThresholdCents };
}

export function longShotDailyLossCapCents(ticketCents: number, settings: LongShotSettings): number {
  return ticketCents * settings.dailyLossTickets;
}

export interface LongShotEntryInput {
  symbol: string;
  side: PositionSide;
  /** Executable selected-side Kalshi ask as a fraction. Not a midpoint, model probability, or opposite ask. */
  askPrice: number;
  secondsRemaining: number;
  /** Open long-shot positions on this exact asset and settlement window. */
  openSameAssetWindow: number;
  /** Open long-shot positions across all assets sharing this settlement window. */
  openSameSettlementWindow: number;
  /** Entries already made on this asset and window, open or closed. */
  entriesThisAssetWindow: number;
  /** Net loss over the trailing day as a positive number of cents. */
  dailyNetLossCents: number;
}

export type LongShotEntryDecision =
  | { qualifies: true; limitPriceCents: number }
  | { qualifies: false; reason: string };

/**
 * Candidate qualification. There is no prior-cycle filter: both proposed readings were measured and failed.
 * "Prior cycle reached the high mark" passes 86-92% of candidates without improving the hit rate, because
 * every winner passes through the high mark on its way to settlement. "Prior cycle completed the full round
 * trip" produced zero candidates at the launch mark over 3.6 days. The evidence needed to choose a filter
 * later is recorded instead. See docs/long-shot-policy-design.md section 4.
 */
export function evaluateLongShotEntry(
  input: LongShotEntryInput,
  sizing: LongShotSizing,
  settings: LongShotSettings,
): LongShotEntryDecision {
  if (!settings.enabled) return { qualifies: false, reason: 'Long-shot policy disabled.' };
  if (sizing.halted) return { qualifies: false, reason: sizing.reason ?? 'Long-shot policy halted.' };
  if (settings.excludedAssets.includes(input.symbol.toUpperCase())) {
    return { qualifies: false, reason: `${input.symbol} is excluded from the long-shot policy.` };
  }

  const dailyCapCents = longShotDailyLossCapCents(sizing.ticketCents, settings);
  if (input.dailyNetLossCents >= dailyCapCents) {
    return { qualifies: false, reason: `Long-shot daily net loss ${input.dailyNetLossCents}c reached the ${dailyCapCents}c (${settings.dailyLossTickets} ticket) cap.` };
  }

  // Fail closed on a missing or nonsensical quote rather than treating absence as cheapness.
  if (!Number.isFinite(input.askPrice) || input.askPrice <= 0) {
    return { qualifies: false, reason: 'No executable selected-side ask.' };
  }
  const askCents = input.askPrice * 100;
  if (askCents > settings.entryMarkCents) {
    return { qualifies: false, reason: `${input.side} ask ${askCents.toFixed(1)}c is above the ${settings.entryMarkCents}c mark.` };
  }
  if (!Number.isFinite(input.secondsRemaining) || input.secondsRemaining < settings.minimumSecondsRemaining) {
    return { qualifies: false, reason: `${Math.max(0, Math.floor(input.secondsRemaining || 0))}s remaining is below the ${settings.minimumSecondsRemaining}s entry window.` };
  }

  // Averaging down is the one shape that turns a single losing window into a compounding series, so a
  // second concurrent position on the same asset and window is forbidden regardless of the entry counts.
  if (input.openSameAssetWindow > 0) {
    return { qualifies: false, reason: `A long-shot position is already open on ${input.symbol} for this window.` };
  }
  if (input.entriesThisAssetWindow >= settings.maximumEntriesPerAssetWindow) {
    return { qualifies: false, reason: `${input.symbol} has used its ${settings.maximumEntriesPerAssetWindow} long-shot entries for this window.` };
  }
  // Arrivals cluster because a market-wide move makes many cheap sides cheap at once. Outcomes measured
  // close to independent, so this bounds how much equity one 15-minute event can consume rather than
  // rationing correlated exposure; the edge policy's beta-tier groups are deliberately not reused.
  if (input.openSameSettlementWindow >= settings.maximumOpenPerSettlementWindow) {
    return { qualifies: false, reason: `${settings.maximumOpenPerSettlementWindow} long-shot positions are already open in this settlement window.` };
  }

  return { qualifies: true, limitPriceCents: settings.entryMarkCents };
}

export interface LongShotRoundTrip {
  quantity: number;
  entryStakeCents: number;
  exitFeeCents: number;
  exitProceedsCents: number;
  netOnWinCents: number;
  /** Fraction of attempts that must reach the exit mark for the policy to break even. */
  breakEvenTouchRate: number;
  /** Fraction that must settle in the money if the position were instead held; for the (ii) comparison. */
  breakEvenHoldRate: number;
}

/**
 * Round-trip economics for an already-sized fill. The fee function is injected rather than imported so this
 * module stays free of `server-only`, and so the sizing logic in `estimatePaperFill` is never duplicated.
 *
 * Selling early beats holding whenever the touch rate exceeds the win rate by `breakEvenTouchRate /
 * breakEvenHoldRate`. That ratio is roughly 1.1-1.2 and improves at deeper discounts. It is very likely
 * cleared, and structurally so: every contract that settles in the money passes through the exit mark on
 * its way to 100c, so every winner is also a toucher, plus every near miss that ran up and fell back.
 */
export function longShotRoundTrip(
  fill: { quantity: number; stakeCents: number },
  exitMarkCents: number,
  feeCents: (limitPriceCents: number, quantity: number) => number,
): LongShotRoundTrip {
  const exitFeeCents = feeCents(exitMarkCents, fill.quantity);
  const exitProceedsCents = fill.quantity * exitMarkCents - exitFeeCents;
  return {
    quantity: fill.quantity,
    entryStakeCents: fill.stakeCents,
    exitFeeCents,
    exitProceedsCents,
    netOnWinCents: exitProceedsCents - fill.stakeCents,
    breakEvenTouchRate: exitProceedsCents > 0 ? fill.stakeCents / exitProceedsCents : Number.POSITIVE_INFINITY,
    breakEvenHoldRate: fill.quantity > 0 ? fill.stakeCents / (fill.quantity * 100) : Number.POSITIVE_INFINITY,
  };
}
