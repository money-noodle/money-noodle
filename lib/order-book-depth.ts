import type { BinaryOrderBook, OrderBookLevel, PositionSide } from './types';

type RawBook = {
  orderbook_fp?: { yes_dollars?: unknown; no_dollars?: unknown };
  orderbook?: { yes?: unknown; no?: unknown };
};

function levels(value: unknown, cents = false): OrderBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!Array.isArray(item) || item.length < 2) return [];
    const rawPrice = Number(item[0]), quantity = Number(item[1]);
    const price = cents ? rawPrice / 100 : rawPrice;
    return Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(quantity) && quantity >= 0
      ? [{ price, quantity }] : [];
  }).sort((a, b) => a.price - b.price);
}

/** Accepts both current fixed-point dollars and legacy integer-cent Kalshi orderbook shapes. */
export function parseKalshiOrderBook(value: unknown, observedAt = new Date().toISOString()): BinaryOrderBook | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as RawBook;
  const yesBids = raw.orderbook_fp ? levels(raw.orderbook_fp.yes_dollars) : levels(raw.orderbook?.yes, true);
  const noBids = raw.orderbook_fp ? levels(raw.orderbook_fp.no_dollars) : levels(raw.orderbook?.no, true);
  if (!yesBids.length && !noBids.length) return undefined;
  return { yesBids, noBids, observedAt };
}

export interface SelectedDepth {
  bestBidDepth?: number;
  bestAskDepth?: number;
  displayedAtLimit?: number;
  displayedAhead?: number;
  depthImbalance?: number;
}

function quantityAt(levels: OrderBookLevel[], price: number): number | undefined {
  const quantity = levels.find((level) => Math.abs(level.price - price) <= 1e-6)?.quantity;
  return quantity === undefined ? undefined : quantity;
}

/**
 * Kalshi publishes YES and NO bid ladders. The opposite side's bid maps to the selected side's ask.
 * `displayedAhead` is explicitly a proxy: displayed size at our price or better, not private queue rank.
 */
export function selectedSideDepth(
  book: BinaryOrderBook | undefined,
  side: PositionSide,
  selectedBid: number,
  selectedAsk: number,
  limitPrice?: number,
): SelectedDepth {
  if (!book) return {};
  const bids = side === 'UP' ? book.yesBids : book.noBids;
  const oppositeBids = side === 'UP' ? book.noBids : book.yesBids;
  const asks = oppositeBids.map((level) => ({ price: 1 - level.price, quantity: level.quantity }));
  const bestBidDepth = quantityAt(bids, selectedBid);
  const bestAskDepth = quantityAt(asks, selectedAsk);
  const displayedAtLimit = limitPrice === undefined ? undefined : quantityAt(bids, limitPrice);
  const displayedAhead = limitPrice === undefined ? undefined
    : bids.filter((level) => level.price + 1e-8 >= limitPrice).reduce((sum, level) => sum + level.quantity, 0);
  const total = (bestBidDepth ?? 0) + (bestAskDepth ?? 0);
  return {
    bestBidDepth, bestAskDepth, displayedAtLimit, displayedAhead,
    depthImbalance: total > 0 ? (bestBidDepth ?? 0) / total : undefined,
  };
}
