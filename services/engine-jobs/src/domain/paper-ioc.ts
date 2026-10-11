import type { PaperBook, PaperBookLevel, PaperSide } from './paper-pricing.js';
import { normalizePaperBook } from './paper-depth.js';
export const IOC_QUANTITY_STEP = 0.01;
// Explicit inherited-epsilon correction; no claim of unchanged arbitrary float parity.
export const PAPER_IOC_EVIDENCE_VERSION = 'paper-ioc-conservative-microprice-v2';
export interface IocFillResult {
  filledCount: number;
  averagePrice: number;
  cashCents: number;
  displayedAtLimit: number;
  levelsConsumed: number;
}
const empty = (): IocFillResult => ({
  filledCount: 0,
  averagePrice: 0,
  cashCents: 0,
  displayedAtLimit: 0,
  levelsConsumed: 0,
});
export function paperIocPriceQuanta(price: number): number {
  const units = Math.round(price * 1000000);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    price >= 1 ||
    !Number.isSafeInteger(units) ||
    Math.abs(price - units / 1000000) > 1e-12
  )
    throw new Error('Unrepresentable IOC microprice.');
  return units;
}
function requestValid(side: PaperSide, price: number, count: number): number {
  if (
    !['UP', 'DOWN'].includes(side) ||
    !Number.isFinite(count) ||
    count <= 0 ||
    count > 1000000 ||
    Math.abs(count - Math.round(count * 100) / 100) > 1e-12
  )
    throw new Error('Invalid bounded IOC request/lattice.');
  return paperIocPriceQuanta(price);
}
function sweep(
  levels: PaperBookLevel[],
  requested: number,
  limit: number,
  buy: boolean,
): IocFillResult {
  let displayed = 0;
  for (const level of levels) {
    displayed += level.quantity;
    if (!Number.isFinite(displayed)) throw new Error('Nonfinite IOC depth.');
  }
  const available = Math.min(requested, displayed);
  // Never add an epsilon: a displayed .0099999999 is NOT .01 executable inventory.
  let units = Math.floor(available * 100),
    count = units / 100;
  if (count > available) {
    units -= 1;
    count = units / 100;
  }
  if (count <= 0) return { ...empty(), displayedAtLimit: displayed };
  let remaining = count,
    cash = 0,
    consumed = 0;
  // Re-sweep best-to-worst at the reduced quantity: excess is removed from the worst consumed level.
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(level.quantity, remaining);
    if (take <= 0) continue;
    cash += take * level.price * 100;
    remaining -= take;
    consumed += 1;
    if (!Number.isFinite(cash) || !Number.isFinite(remaining))
      throw new Error('Nonfinite IOC accumulation.');
  }
  const average = cash / count / 100;
  if (
    remaining > 1e-12 ||
    count > requested ||
    count > displayed ||
    ![count, cash, average].every(Number.isFinite) ||
    cash < 0 ||
    average <= 0 ||
    average >= 1 ||
    (buy ? average > limit + 1e-12 : average < limit - 1e-12)
  )
    throw new Error('IOC evidence exceeded quantity or authorized price.');
  return {
    filledCount: count,
    averagePrice: average,
    cashCents: cash,
    displayedAtLimit: displayed,
    levelsConsumed: consumed,
  };
}
function execute(
  book: PaperBook | undefined,
  side: PaperSide,
  price: number,
  requested: number,
  buy: boolean,
): IocFillResult {
  const limitUnits = requestValid(side, price, requested),
    normalized = normalizePaperBook(book);
  if (!normalized) return empty(); // Caller MUST tag unavailable book separately, never classify this as an observed miss.
  const source = buy
    ? side === 'UP'
      ? normalized.noBids
      : normalized.yesBids
    : side === 'UP'
      ? normalized.yesBids
      : normalized.noBids;
  const levels = source
    .map((l) => {
      const units = paperIocPriceQuanta(l.price);
      return { price: (buy ? 1000000 - units : units) / 1000000, quantity: l.quantity };
    })
    .filter(
      (l) =>
        l.quantity > 0 &&
        (buy
          ? Math.round(l.price * 1000000) <= limitUnits
          : Math.round(l.price * 1000000) >= limitUnits),
    )
    .sort((a, b) => (buy ? a.price - b.price : b.price - a.price));
  return sweep(levels, requested, limitUnits / 1000000, buy);
}
export function immediateSellFill(
  book: PaperBook | undefined,
  side: PaperSide,
  minimumPrice: number,
  requestedCount: number,
): IocFillResult {
  return execute(book, side, minimumPrice, requestedCount, false);
}
export function immediateBuyFill(
  book: PaperBook | undefined,
  side: PaperSide,
  maximumPrice: number,
  requestedCount: number,
): IocFillResult {
  return execute(book, side, maximumPrice, requestedCount, true);
}
