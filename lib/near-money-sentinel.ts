import { bandEntry, type LongShotCandidate } from './long-shot-candidate';

/**
 * Approach (iii): buy a near-money side and hold it to settlement, with a stop if the bid falls far
 * enough below what was paid.
 *
 * **Committed as a prospective test, not a screen.** The rule below was fixed on the date it carries,
 * before the windows it will be judged on had closed. That is what AGENTS §5.5 requires and what a
 * retroactive sweep can never supply: the same numbers computed after choosing the band would prove
 * nothing, because the band was chosen by looking. Windows closing before `committedAt` are therefore
 * reported **separately** and are screening evidence only.
 *
 * The idea came from a band that looked good in the operator's sweep — near-money entries returned
 * −0.020 ± 0.040 per $1 held, the best cell on the board. That is indistinguishable from zero and
 * consistent with an efficiently priced book minus a ~5% fee drag, so this exists to find out whether
 * anything is there, with the expectation that nothing is.
 *
 * **This places no orders and holds no budget.** Nothing here may gate, size, price, or trade.
 *
 * Pure and I/O free. See docs/long-shot-policy-design.md §15b.
 */
export const NEAR_MONEY_SENTINEL_VERSION = 'near-money-hold-v1';

export interface NearMoneySentinelDefinition {
  id: string;
  /** Fixed before the evidence. Windows closing at or after this are the prospective arm. */
  committedAt: string;
  entryLowCents: number;
  entryHighCents: number;
  minimumSecondsRemaining: number;
  /**
   * Stops evaluated as cents **below the entry ask**, so the rule is self-relative rather than tied to a
   * price level. `null` is the no-stop arm — hold to settlement, which is the comparison every stop has
   * to beat.
   *
   * The spread is why none of these is small: at 70–75¢ the ask sits a median 1¢ over the bid (mean 1.79¢,
   * 40% at 2¢ or more), so a position is marked below cost the instant it is opened. A stop at "the bid
   * reaches what I paid" fires on essentially every entry and measures the spread, not the thesis.
   */
  stopsBelowEntryCents: Array<number | null>;
}

/** The committed rule. Changing any field is a new `id` and a new cohort, never an edit. */
export const NEAR_MONEY_HOLD: NearMoneySentinelDefinition = {
  id: 'near-money-hold-70-75-v1',
  committedAt: '2026-08-18T02:00:00.000Z',
  entryLowCents: 70,
  entryHighCents: 75,
  minimumSecondsRemaining: 600,
  stopsBelowEntryCents: [null, 5, 10, 15, 20],
};

export interface NearMoneyArm {
  /** Cents below the entry ask, or null for hold-to-settlement. */
  stopBelowEntryCents: number | null;
  positions: number;
  windows: number;
  /** Positions whose bid fell to or below the stop at some point after entry. */
  stopped: number;
  stopRate: number | null;
  meanReturn: number | null;
  standardError: number | null;
  /** Positions whose window has not settled, so they cannot be graded. Counted, never read as zero. */
  ungraded: number;
}

export interface NearMoneySentinelReport {
  version: string;
  definition: NearMoneySentinelDefinition;
  /** Windows closing at or after `committedAt`. The only arm that could ever promote anything. */
  prospective: NearMoneyArm[];
  /** Windows that closed before the rule was written. Screening evidence; promotes nothing. */
  retrospective: NearMoneyArm[];
}

function clustered(rows: Array<{ key: string; value: number }>) {
  const windows = new Map<string, number[]>();
  for (const row of rows) windows.set(row.key, [...(windows.get(row.key) ?? []), row.value]);
  const perWindow = [...windows.values()].map((values) => values.reduce((a, b) => a + b, 0) / values.length);
  if (!perWindow.length) return { mean: null, standardError: null, windows: 0 };
  const mean = perWindow.reduce((a, b) => a + b, 0) / perWindow.length;
  return {
    mean,
    standardError: perWindow.length > 1
      ? Math.sqrt(perWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / (perWindow.length - 1) / perWindow.length)
      : null,
    windows: perWindow.length,
  };
}

export interface NearMoneyOptions {
  ticketCents: number;
  fill: (stakeLimitCents: number, askPrice: number) => { quantity: number; stakeCents: number } | null;
  exitFeeCents: (priceCents: number, quantity: number) => number;
}

/**
 * One arm: the committed entry, with or without a stop, held otherwise to settlement.
 *
 * **The stop is optimistic.** It assumes a fill at the stop level, and a bid that gaps through it fills
 * worse. It is also measured at the collection cadence, so a dip between samples is invisible — which
 * understates how often a stop fires. Both biases flatter the stop, so a stop that still loses here loses
 * by more than this says.
 */
function arm(
  candidates: LongShotCandidate[],
  definition: NearMoneySentinelDefinition,
  stopBelowEntryCents: number | null,
  options: NearMoneyOptions,
): NearMoneyArm {
  let positions = 0;
  let stopped = 0;
  let ungraded = 0;
  const returns: Array<{ key: string; value: number }> = [];

  for (const candidate of candidates) {
    const entry = bandEntry(candidate, definition, definition.minimumSecondsRemaining);
    if (!entry) continue;
    const sized = options.fill(options.ticketCents, entry.askCents / 100);
    if (!sized) continue;
    positions += 1;

    const stopCents = stopBelowEntryCents === null ? null : entry.askCents - stopBelowEntryCents;
    const hit = stopCents !== null && stopCents > 0 && entry.troughBidAfterCents <= stopCents;
    if (hit) stopped += 1;

    // Settlement gates the return whether or not the stop fired: a stopped position is priced from the
    // stop and needs no outcome, so admitting those while holding back the rest would fill the average
    // with one kind of result. The same bias cost the band grid a +767% reading.
    if (!candidate.settledSide) { ungraded += 1; continue; }

    const value = hit
      ? ((sized.quantity * stopCents! - options.exitFeeCents(stopCents!, sized.quantity)) - sized.stakeCents) / sized.stakeCents
      : ((candidate.settledSide === candidate.side ? sized.quantity * 100 : 0) - sized.stakeCents) / sized.stakeCents;
    returns.push({ key: candidate.closesAt, value });
  }

  const stats = clustered(returns);
  return {
    stopBelowEntryCents,
    positions,
    windows: stats.windows,
    stopped,
    stopRate: positions ? stopped / positions : null,
    meanReturn: stats.mean,
    standardError: stats.standardError,
    ungraded,
  };
}

export function buildNearMoneySentinelReport(
  candidates: LongShotCandidate[],
  options: NearMoneyOptions,
  definition: NearMoneySentinelDefinition = NEAR_MONEY_HOLD,
): NearMoneySentinelReport {
  const committedMs = Date.parse(definition.committedAt);
  const after = candidates.filter((candidate) => Date.parse(candidate.closesAt) >= committedMs);
  const before = candidates.filter((candidate) => Date.parse(candidate.closesAt) < committedMs);
  return {
    version: NEAR_MONEY_SENTINEL_VERSION,
    definition,
    prospective: definition.stopsBelowEntryCents.map((stop) => arm(after, definition, stop, options)),
    retrospective: definition.stopsBelowEntryCents.map((stop) => arm(before, definition, stop, options)),
  };
}
