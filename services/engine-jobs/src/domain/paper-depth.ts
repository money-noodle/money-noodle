import type { PaperBook, PaperBookLevel, PaperSide } from './paper-pricing.js';
export interface SelectedDepth {
  bestBidDepth: number | undefined;
  bestAskDepth: number | undefined;
  displayedAtLimit: number | undefined;
  displayedAhead: number | undefined;
  depthImbalance: number | undefined;
}
function quantityAt(levels: PaperBookLevel[], price: number): number | undefined {
  const quantity = levels.find((level) => Math.abs(level.price - price) <= 1e-6)?.quantity;
  return quantity === undefined ? undefined : quantity;
}

/**
 * Kalshi publishes YES and NO bid ladders. The opposite side's bid maps to the selected side's ask.
 * `displayedAhead` is explicitly a proxy: displayed size at our price or better, not private queue rank.
 */
export function selectedSideDepth(
  book: PaperBook | undefined,
  side: PaperSide,
  selectedBid: number,
  selectedAsk: number,
  limitPrice?: number,
): SelectedDepth {
  if (!book)
    return {
      bestBidDepth: undefined,
      bestAskDepth: undefined,
      displayedAtLimit: undefined,
      displayedAhead: undefined,
      depthImbalance: undefined,
    };
  const bids = side === 'UP' ? book.yesBids : book.noBids;
  const oppositeBids = side === 'UP' ? book.noBids : book.yesBids;
  const asks = oppositeBids.map((level) => ({ price: 1 - level.price, quantity: level.quantity }));
  const bestBidDepth = quantityAt(bids, selectedBid);
  const bestAskDepth = quantityAt(asks, selectedAsk);
  const displayedAtLimit = limitPrice === undefined ? undefined : quantityAt(bids, limitPrice);
  const displayedAhead =
    limitPrice === undefined
      ? undefined
      : bids
          .filter((level) => level.price + 1e-8 >= limitPrice)
          .reduce((sum, level) => sum + level.quantity, 0);
  const total = (bestBidDepth ?? 0) + (bestAskDepth ?? 0);
  return {
    bestBidDepth,
    bestAskDepth,
    displayedAtLimit,
    displayedAhead,
    depthImbalance: total > 0 ? (bestBidDepth ?? 0) / total : undefined,
  };
}
