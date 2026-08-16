/**
 * Trailing entry: once a side is cheap enough to buy, wait while it is still getting cheaper.
 *
 * This is the one lever measured that improves the policy's odds without giving something back. The sweep
 * in docs/long-shot-policy-design.md §14a varied the entry *mark* and found every configuration between
 * 0.48 and 0.72 of break-even, because a lower mark raises the touch rate and the break-even together.
 * Trailing varies the price achieved *within* a mark, which is different in kind: the peak a contract
 * reaches is a property of its own path and does not care what we paid, so a better fill lowers break-even
 * with the touch rate unchanged. Over 457 recorded first touches, 54% improved within two samples by a
 * median of 2.1¢ — roughly a fifth off break-even at a 10¢ entry.
 *
 * There is deliberately **no deadline on the decision**. A price that keeps falling is trending, and this
 * strategy needs a reversal: candidates still falling at the next sample reached 90¢ 0.9% of the time
 * against 2.6% for those that stalled. Never buying one is the intended outcome, not a missed opportunity.
 * Only 2% of first touches rose back above the mark before offering anything better, so waiting is cheap.
 *
 * Watching, however, is bounded — see `TRAILING_FAST_LOOK_BUDGET`. Cost and the trading rule are separate
 * concerns, and a deadline that forced a purchase would resolve the first by breaking the second.
 *
 * Pure and I/O free.
 */
export const TRAILING_ENTRY_POLL_MS = 250;

/**
 * How much cheaper the next look must be to count as still falling.
 *
 * Below 10¢ Kalshi prices in deci-cents — `tapered_deci_cent`, a 0.001 step under 0.10 against 0.01 above
 * it — so one tick down there is 0.1¢ and a sub-cent threshold is a real distinction rather than noise.
 */
export const TRAILING_SIGNIFICANCE_CENTS = 0.1;

/**
 * Looks taken at the fast cadence before dropping back to the slow one.
 *
 * A bound on cost, not on the decision. Watching four times a second costs four requests a second for one
 * contract, and several can qualify at once — 41% of settlement windows carry more than one candidate — so
 * an unbounded fast watch can reach the venue's read ceiling on its own.
 *
 * After the budget the trail continues at the ordinary cadence: it still buys when the fall stalls, just
 * noticed a second later. Deliberately not a deadline that buys, which would purchase exactly the
 * still-falling contracts the stall rule exists to avoid, nor one that abandons, which would drop a
 * candidate that may yet stall. Forty looks is ten seconds — ample for a stall to appear, given 54% of
 * first touches improved within two fifteen-second samples.
 */
export const TRAILING_FAST_LOOK_BUDGET = 40;

export interface TrailingEntryState {
  /** Ask at the first look that qualified. Retained so the trailing gain is measurable, not assumed. */
  firstTouchAskCents: number;
  /** Cheapest ask seen so far, which is what a decision is judged against. */
  bestAskCents: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  looks: number;
}

export function beginTrailingEntry(askCents: number, nowMs: number): TrailingEntryState {
  return {
    firstTouchAskCents: askCents, bestAskCents: askCents,
    firstSeenAtMs: nowMs, lastSeenAtMs: nowMs, looks: 1,
  };
}

export type TrailingEntryDecision =
  | { action: 'buy'; askCents: number; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'abandon'; reason: string };

/**
 * What to do at the next look.
 *
 * The comparison is against the best seen rather than the previous look, so a jitter down and back up
 * cannot restart the wait indefinitely — one improvement buys one more look, not a fresh lease.
 */
export function evaluateTrailingEntry(
  state: TrailingEntryState,
  askCents: number,
  options: { entryMarkCents: number; significanceCents?: number },
): TrailingEntryDecision {
  const significance = options.significanceCents ?? TRAILING_SIGNIFICANCE_CENTS;

  // Fail closed on a vanished or nonsensical quote rather than buying on the last good price.
  if (!Number.isFinite(askCents) || askCents <= 0) {
    return { action: 'wait', reason: 'No executable ask at this look.' };
  }
  // Above the mark it is no longer a candidate. Measured at 2% of first touches, and the alternative —
  // buying above the mark because we were already watching — is the rule quietly widening itself.
  if (askCents > options.entryMarkCents) {
    return { action: 'abandon', reason: `Ask ${askCents.toFixed(1)}¢ rose above the ${options.entryMarkCents}¢ mark while trailing.` };
  }
  if (askCents <= state.bestAskCents - significance) {
    return { action: 'wait', reason: `Still falling: ${askCents.toFixed(1)}¢ against a best of ${state.bestAskCents.toFixed(1)}¢.` };
  }
  // Stalled. Buy at whatever is actually offered now, which may be above the best seen — that best is gone,
  // and holding out for a price the book no longer shows is how a stall turns into a miss.
  return {
    action: 'buy', askCents,
    reason: `Fall stalled at ${askCents.toFixed(1)}¢ after ${state.looks} look(s); best seen ${state.bestAskCents.toFixed(1)}¢.`,
  };
}

export function observeTrailingEntry(state: TrailingEntryState, askCents: number, nowMs: number): TrailingEntryState {
  const valid = Number.isFinite(askCents) && askCents > 0;
  return {
    ...state,
    bestAskCents: valid ? Math.min(state.bestAskCents, askCents) : state.bestAskCents,
    lastSeenAtMs: nowMs,
    looks: state.looks + 1,
  };
}

/** Whether this trail still warrants the fast cadence, or has spent its budget and dropped to the slow one. */
export function trailingIsFast(state: TrailingEntryState, budget = TRAILING_FAST_LOOK_BUDGET): boolean {
  return state.looks <= budget;
}

/** What trailing actually earned on this entry, in cents. Recorded so the rule can be judged on evidence. */
export function trailingGainCents(state: TrailingEntryState, filledAskCents: number): number {
  return Number((state.firstTouchAskCents - filledAskCents).toFixed(2));
}
