import type { PaperBook, PaperBookLevel, PaperSide } from './paper-pricing.js';
// One public displayed-book sweep, never a venue order or resting maker.
export const IOC_QUANTITY_STEP = 0.01;

const LEVEL_EPSILON = 1e-6;

export interface IocFillResult {
  filledCount: number;

  averagePrice: number;

  cashCents: number;

  displayedAtLimit: number;

  levelsConsumed: number;
}

const EMPTY: IocFillResult = {
  filledCount: 0,
  averagePrice: 0,
  cashCents: 0,
  displayedAtLimit: 0,
  levelsConsumed: 0,
};

function onLattice(quantity: number): number {
  return Math.floor(quantity / IOC_QUANTITY_STEP + 1e-6) * IOC_QUANTITY_STEP;
}

function sweep(levels: PaperBookLevel[], requestedCount: number): IocFillResult {
  const displayedAtLimit = levels.reduce((sum, level) => sum + level.quantity, 0);
  if (!(requestedCount > 0) || !(displayedAtLimit > 0))
    return { ...EMPTY, displayedAtLimit: Math.max(0, displayedAtLimit) };
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
    return {
      filledCount,
      averagePrice: latticeCash / filledCount / 100,
      cashCents: latticeCash,
      displayedAtLimit,
      levelsConsumed: latticeLevels,
    };
  }
  return {
    filledCount,
    averagePrice: cashCents / filledCount / 100,
    cashCents,
    displayedAtLimit,
    levelsConsumed,
  };
}

function sellableLevels(book: PaperBook, side: PaperSide, minimumPrice: number): PaperBookLevel[] {
  const bids = side === 'UP' ? book.yesBids : book.noBids;
  return bids
    .filter((level) => level.price + LEVEL_EPSILON >= minimumPrice && level.quantity > 0)
    .sort((left, right) => right.price - left.price);
}

function buyableLevels(book: PaperBook, side: PaperSide, maximumPrice: number): PaperBookLevel[] {
  const oppositeBids = side === 'UP' ? book.noBids : book.yesBids;
  return oppositeBids
    .map((level) => ({ price: 1 - level.price, quantity: level.quantity }))
    .filter(
      (level) =>
        level.price - LEVEL_EPSILON <= maximumPrice &&
        level.price > 0 &&
        level.price < 1 &&
        level.quantity > 0,
    )
    .sort((left, right) => left.price - right.price);
}

export function immediateSellFill(
  book: PaperBook | undefined,
  side: PaperSide,
  minimumPrice: number,
  requestedCount: number,
): IocFillResult {
  if (
    book &&
    (book.yesBids.length + book.noBids.length > 1_000 ||
      [...book.yesBids, ...book.noBids].some(
        (l) =>
          !Number.isFinite(l.price) ||
          l.price <= 0 ||
          l.price >= 1 ||
          !Number.isFinite(l.quantity) ||
          l.quantity < 0,
      ))
  )
    throw new Error('Invalid paper IOC book.');
  if (!book || !(minimumPrice > 0) || !(minimumPrice < 1) || !Number.isFinite(requestedCount))
    return EMPTY;
  return sweep(sellableLevels(book, side, minimumPrice), requestedCount);
}

export function immediateBuyFill(
  book: PaperBook | undefined,
  side: PaperSide,
  maximumPrice: number,
  requestedCount: number,
): IocFillResult {
  if (
    book &&
    (book.yesBids.length + book.noBids.length > 1_000 ||
      [...book.yesBids, ...book.noBids].some(
        (l) =>
          !Number.isFinite(l.price) ||
          l.price <= 0 ||
          l.price >= 1 ||
          !Number.isFinite(l.quantity) ||
          l.quantity < 0,
      ))
  )
    throw new Error('Invalid paper IOC book.');
  if (!book || !(maximumPrice > 0) || !(maximumPrice < 1) || !Number.isFinite(requestedCount))
    return EMPTY;
  return sweep(buyableLevels(book, side, maximumPrice), requestedCount);
}
