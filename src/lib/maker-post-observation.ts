import { MAKER_MANAGEMENT_CHECKS, MAKER_MANAGEMENT_POLL_MS, initialManagedMakerPrice, nextManagedMakerPrice, type ManagedMakerQuote } from './managed-maker';
import type { KalshiTradePrint } from './kalshi-market-data';
import type { MakerPostOutcome, PositionSide } from './types';

/**
 * Whether a resting entry would actually have filled, simulated against observed trade prints.
 *
 * Design and limits: docs/maker-post-observation-design.md. The number this exists to replace is
 * `makerExpectedProfitPerContract`, which multiplies an unconditional settlement return by a fill
 * probability and therefore prices the fill as a random draw — the one assumption the desk's own
 * adverse-selection measurements refute, and a positive scaling that can never disagree with the ask
 * benchmark beside it.
 *
 * Pure and I/O free. Observation only: nothing here may gate, size, price, or trade.
 */
export const MAKER_POST_OBSERVATION_VERSION = 'maker-post-observed-v1';

/** Whole-cent lattice tolerance. A price off the lattice is refused, never rounded onto it. */
const LATTICE_EPSILON = 1e-8;

export type { MakerPostOutcome };

export interface MakerPostRung {
  /** Milliseconds since the post was placed. */
  offsetMs: number;
  priceCents: number;
  /** Displayed size ahead of us at this price, read from the posting snapshot. */
  queueAheadCents: number;
}

export interface MakerPostPrint {
  offsetMs: number;
  /** Print price on the owned side's scale. */
  priceCents: number;
  count: number;
}

export interface MakerPostResult {
  outcome: MakerPostOutcome;
  fillCents?: number;
  fillOffsetMs?: number;
  /** Volume that traded through the final resting price, for diagnosis of a near miss. */
  consumedCents: number;
  queueAheadCents?: number;
}

/**
 * Prints that could have consumed a resting bid on this side.
 *
 * Every print carries both a yes and a no price, so attributing all of them to a post at that price
 * counts trades that lifted an ask as if they had hit our bid. A resting YES bid is consumed only by a
 * taker buying NO, and a resting NO bid only by a taker buying YES. `scripts/experiment-maker-depth.ts`
 * predates this and discards `takerSide`, which is why its samples can only be replayed permissively.
 */
export function printsForSide(prints: KalshiTradePrint[], side: PositionSide, postedAtMs: number): MakerPostPrint[] {
  const consumingTaker = side === 'UP' ? 'no' : 'yes';
  const result: MakerPostPrint[] = [];
  for (const print of prints) {
    if (print.takerSide !== consumingTaker) continue;
    const price = side === 'UP' ? print.yesPrice : print.noPrice;
    const at = Date.parse(print.at);
    if (!Number.isFinite(at) || !Number.isFinite(price) || !(price > 0) || price >= 1) continue;
    if (!Number.isFinite(print.count) || !(print.count > 0)) continue;
    result.push({ offsetMs: at - postedAtMs, priceCents: price * 100, count: print.count });
  }
  return result.sort((a, b) => a.offsetMs - b.offsetMs);
}

/**
 * The managed order's price ladder, reconstructed from the quotes recorded through its horizon.
 *
 * Production walks the limit from the bid toward the passive ceiling across `MAKER_MANAGEMENT_CHECKS`
 * checks, one every `MAKER_MANAGEMENT_POLL_MS`. Reconstructing it needs a quote per check, which is why
 * this depends on the 2-second contract path: at a 15-second cadence one sample covers six checks and the
 * ladder collapses to its first rung.
 *
 * `quoteAt` returns the most recent quote at or before an offset, or undefined when none was recorded.
 */
export function makerPostLadder(input: {
  quoteAt: (offsetMs: number) => ManagedMakerQuote | undefined;
  maximumPrice: number;
  queueAheadAt: (priceCents: number) => number | undefined;
  checks?: number;
}): MakerPostRung[] | null {
  const checks = input.checks ?? MAKER_MANAGEMENT_CHECKS;
  const rungs: MakerPostRung[] = [];
  let currentPrice = 0;
  for (let check = 0; check < checks; check += 1) {
    const offsetMs = check * MAKER_MANAGEMENT_POLL_MS;
    const quote = input.quoteAt(offsetMs);
    if (!quote) return check === 0 ? null : rungs;
    const price = check === 0
      ? initialManagedMakerPrice({ quote, maximumPrice: input.maximumPrice })
      : nextManagedMakerPrice({ quote, maximumPrice: input.maximumPrice, currentPrice, managementAttempt: check - 1, managementChecks: checks });
    if (!(price > 0)) return check === 0 ? null : rungs;
    currentPrice = price;
    const priceCents = price * 100;
    // Off-lattice prices are refused rather than rounded: a venue with a finer tick would otherwise be
    // silently quantized into a price that was never postable.
    if (Math.abs(priceCents - Math.round(priceCents)) > LATTICE_EPSILON) return check === 0 ? null : rungs;
    const rounded = Math.round(priceCents);
    if (rungs.length && rungs[rungs.length - 1].priceCents === rounded) continue;
    const queueAheadCents = input.queueAheadAt(rounded);
    if (queueAheadCents === undefined || !Number.isFinite(queueAheadCents)) return rungs.length ? rungs : null;
    rungs.push({ offsetMs, priceCents: rounded, queueAheadCents: Math.max(0, queueAheadCents) });
  }
  return rungs.length ? rungs : null;
}

/** A single post held at the initial price for the whole horizon — the conservative floor beside the ladder. */
export function staticMakerPost(rungs: MakerPostRung[]): MakerPostRung[] {
  const first = rungs[0];
  return first ? [{ ...first, offsetMs: 0 }] : [];
}

/**
 * Whether the post filled, given the rungs it rested at and the prints that traded.
 *
 * A post fills once volume traded at or through its price exceeds the size displayed ahead of it — the
 * rule in `src/lib/maker-depth-experiment.ts`, not a touch. Repricing **upward resets the queue**: the order
 * joins the back of a new price level, so volume consumed at the old price does not carry. A rung that
 * repeats a price is the same resting order and keeps its progress, which is why `makerPostLadder`
 * collapses repeated prices rather than emitting them.
 */
export function simulateMakerPost(rungs: MakerPostRung[], prints: MakerPostPrint[], horizonMs: number): MakerPostResult {
  if (!rungs.length) return { outcome: 'unobserved', consumedCents: 0 };
  let rungIndex = 0;
  let consumedCents = 0;
  const ordered = [...prints].sort((a, b) => a.offsetMs - b.offsetMs);
  for (const print of ordered) {
    if (print.offsetMs < 0 || print.offsetMs > horizonMs) continue;
    while (rungIndex + 1 < rungs.length && rungs[rungIndex + 1].offsetMs <= print.offsetMs) {
      rungIndex += 1;
      consumedCents = 0;
    }
    const rung = rungs[rungIndex];
    if (print.priceCents > rung.priceCents + 1e-9) continue;
    consumedCents += print.count;
    if (consumedCents > rung.queueAheadCents + 1e-9) {
      return { outcome: 'filled', fillCents: rung.priceCents, fillOffsetMs: print.offsetMs, consumedCents, queueAheadCents: rung.queueAheadCents };
    }
  }
  return { outcome: 'unfilled', consumedCents, queueAheadCents: rungs[rungIndex].queueAheadCents };
}
