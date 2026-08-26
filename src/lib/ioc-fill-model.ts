import type { BinaryOrderBook, OrderBookLevel, PositionSide } from './types';

/**
 * Immediate-or-cancel fills against displayed book depth.
 *
 * **Why this is not the maker simulation.** `paper-maker-simulation.ts` models a resting post: it waits
 * out a 12-second horizon and fills only when aggressive prints reach a price it is already displayed at.
 * Every taker path the desk actually runs is the opposite shape. `placeKalshiSell` and the high-edge
 * entry both send `time_in_force: 'immediate_or_cancel'` with `post_only: false` (`src/lib/live-orders.ts`),
 * so they never rest, never accumulate queue position, and never see a print: they cross what is
 * displayed at the instant they arrive, take whatever fits, and cancel the remainder. Modelling either
 * one by waiting for prints would invent a resting order the venue never held.
 *
 * The model here is therefore a single sweep of the displayed ladder, best price first, stopping at the
 * limit. It is deliberately not optimistic:
 *
 * - **Displayed size only.** Hidden and iceberg liquidity is not inferred, so this understates fills on
 *   a venue that has them. Kalshi publishes full depth, so the understatement should be small.
 * - **One instant.** No re-read, no second attempt. Live gets one IOC and so does this.
 * - **No price improvement.** The sweep pays each level's own price; it never assumes a better one
 *   appeared between the quote read and the order arriving.
 * - **No market impact.** A sweep that consumes several levels would in reality move the book against a
 *   subsequent order. Nothing here models that, which matters only if sizing ever grows enough to walk
 *   the ladder — at current tickets a fill is normally inside the touch.
 *
 * Cash is returned as exact float cents. Quantizing against us at the whole-cent control boundary is the
 * caller's job, per the money rules in AGENTS.md §1: proceeds floor, costs ceil.
 *
 * Pure and I/O free.
 */

/** Kalshi trades in hundredths of a contract; a partial IOC fill still lands on that lattice. */
export const IOC_QUANTITY_STEP = 0.01;
/** Book-level tolerance, matching `quantityAt` in `src/lib/order-book-depth.ts`. */
const LEVEL_EPSILON = 1e-6;

export interface IocFillResult {
  /** Filled contracts, floored onto the quantity lattice. Zero means the IOC cancelled unfilled. */
  filledCount: number;
  /** Volume-weighted price actually paid or received; zero when nothing filled. */
  averagePrice: number;
  /** Exact, unrounded cash: proceeds for a sell, cost for a buy. */
  cashCents: number;
  /** Displayed size that was available at or better than the limit, before our own size was applied. */
  displayedAtLimit: number;
  /** How many distinct price levels the sweep consumed; 1 means the fill stayed inside the touch. */
  levelsConsumed: number;
}

const EMPTY: IocFillResult = { filledCount: 0, averagePrice: 0, cashCents: 0, displayedAtLimit: 0, levelsConsumed: 0 };

/** Floors onto the lattice with a tolerance, so 0.29999999 counts as 0.30 rather than 0.29. */
function onLattice(quantity: number): number {
  return Math.floor(quantity / IOC_QUANTITY_STEP + 1e-6) * IOC_QUANTITY_STEP;
}

/**
 * Walks an already-ordered ladder, taking size until the request is met.
 *
 * `levels` must arrive sorted in the order the sweep should consume them — descending price for a sell,
 * ascending for a buy — and must already be filtered to prices the limit permits.
 */
function sweep(levels: OrderBookLevel[], requestedCount: number): IocFillResult {
  const displayedAtLimit = levels.reduce((sum, level) => sum + level.quantity, 0);
  if (!(requestedCount > 0) || !(displayedAtLimit > 0)) return { ...EMPTY, displayedAtLimit: Math.max(0, displayedAtLimit) };
  let remaining = requestedCount;
  let filled = 0;
  let cashCents = 0;
  let levelsConsumed = 0;
  for (const level of levels) {
    if (remaining <= LEVEL_EPSILON) break;
    if (!(level.quantity > 0)) continue;
    const take = Math.min(level.quantity, remaining);
    filled += take;
    cashCents += take * level.price * 100;
    remaining -= take;
    levelsConsumed += 1;
  }
  const filledCount = onLattice(filled);
  if (!(filledCount > 0)) return { ...EMPTY, displayedAtLimit };
  // Re-price onto the lattice quantity rather than scaling the swept cash: dropping a sub-lattice
  // remainder must drop the cash for it too, and it has to come off the *worst* level we reached.
  if (Math.abs(filledCount - filled) > LEVEL_EPSILON) {
    let rounded = filledCount;
    let latticeCash = 0;
    let latticeLevels = 0;
    for (const level of levels) {
      if (rounded <= LEVEL_EPSILON) break;
      if (!(level.quantity > 0)) continue;
      const take = Math.min(level.quantity, rounded);
      latticeCash += take * level.price * 100;
      rounded -= take;
      latticeLevels += 1;
    }
    return { filledCount, averagePrice: latticeCash / filledCount / 100, cashCents: latticeCash, displayedAtLimit, levelsConsumed: latticeLevels };
  }
  return { filledCount, averagePrice: cashCents / filledCount / 100, cashCents, displayedAtLimit, levelsConsumed };
}

/** Selected-side bid ladder, best (highest) first. This is what a reduce-only sell lifts. */
function sellableLevels(book: BinaryOrderBook, side: PositionSide, minimumPrice: number): OrderBookLevel[] {
  const bids = side === 'UP' ? book.yesBids : book.noBids;
  return bids
    .filter((level) => level.price + LEVEL_EPSILON >= minimumPrice && level.quantity > 0)
    .sort((left, right) => right.price - left.price);
}

/**
 * Selected-side ask ladder, best (lowest) first. Kalshi publishes bids on both outcomes, so the selected
 * side's ask is the complement of the opposite outcome's bid — the same mapping `selectedSideDepth` uses.
 */
function buyableLevels(book: BinaryOrderBook, side: PositionSide, maximumPrice: number): OrderBookLevel[] {
  const oppositeBids = side === 'UP' ? book.noBids : book.yesBids;
  return oppositeBids
    .map((level) => ({ price: 1 - level.price, quantity: level.quantity }))
    .filter((level) => level.price - LEVEL_EPSILON <= maximumPrice && level.price > 0 && level.price < 1 && level.quantity > 0)
    .sort((left, right) => left.price - right.price);
}

/**
 * Simulates a reduce-only IOC sell of `requestedCount` contracts of `side`, refusing any price below
 * `minimumPrice`. Mirrors `placeKalshiSell`, which is the only sell the desk ever sends.
 */
export function immediateSellFill(
  book: BinaryOrderBook | undefined, side: PositionSide, minimumPrice: number, requestedCount: number,
): IocFillResult {
  if (!book || !(minimumPrice > 0) || !(minimumPrice < 1) || !Number.isFinite(requestedCount)) return EMPTY;
  return sweep(sellableLevels(book, side, minimumPrice), requestedCount);
}

/**
 * Simulates an entry IOC buy of `requestedCount` contracts of `side`, refusing any price above
 * `maximumPrice`. Mirrors the taker branch of live entry execution.
 */
export function immediateBuyFill(
  book: BinaryOrderBook | undefined, side: PositionSide, maximumPrice: number, requestedCount: number,
): IocFillResult {
  if (!book || !(maximumPrice > 0) || !(maximumPrice < 1) || !Number.isFinite(requestedCount)) return EMPTY;
  return sweep(buyableLevels(book, side, maximumPrice), requestedCount);
}
