import { MAX_ENTRY_PRICE } from './prediction-policy';
import { venueFeeCents } from './venue-fill';

export const MAKER_MISS_RELATIVE_PRICE_CEILING = 1.25;
export const MAKER_MISS_TAKER_CUSHION_TICKS = 2;

export function makerMissTakerHardCeiling(finalMakerLimit: number): number | null {
  if (!Number.isFinite(finalMakerLimit) || !(finalMakerLimit > 0)) return null;
  return Math.min(MAX_ENTRY_PRICE, finalMakerLimit * MAKER_MISS_RELATIVE_PRICE_CEILING);
}

export function makerMissTakerNetEdge(input: { probability: number; quantity: number; limit: number }): number {
  if (![input.probability, input.quantity, input.limit].every(Number.isFinite) || input.quantity <= 0 || input.limit <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const feeCents = venueFeeCents('kalshi', input.limit * 100, input.quantity, 'taker');
  return input.probability - input.limit - feeCents / (input.quantity * 100);
}

export function makerMissTakerQuoteRefusal(input: {
  probability: number;
  quantity: number;
  referenceMidpoint: number;
  quote: { bid: number; ask: number; spread: number; limit: number; tickSize: number };
}): string | undefined {
  const { quote } = input;
  if (![input.probability, input.quantity, input.referenceMidpoint, quote.bid, quote.ask, quote.spread, quote.limit, quote.tickSize].every(Number.isFinite)
    || input.quantity <= 0
    || quote.bid <= 0 || quote.ask <= quote.bid || quote.limit + 1e-9 < quote.ask || quote.tickSize <= 0) {
    return 'The refreshed fallback quote is malformed.';
  }
  const midpoint = (quote.bid + quote.ask) / 2;
  if (midpoint + quote.tickSize + 1e-9 < input.referenceMidpoint) {
    return `Selected-side midpoint ${(midpoint * 100).toFixed(1)}c declined by more than one venue tick from the prior ${(input.referenceMidpoint * 100).toFixed(1)}c reference.`;
  }
  const netEdge = makerMissTakerNetEdge({ probability: input.probability, quantity: input.quantity, limit: quote.limit });
  if (!(netEdge > 1e-12)) return `Worst-limit fee-adjusted edge ${(netEdge * 100).toFixed(2)}pp is not positive.`;
  return undefined;
}

/** Maximum selected-side ask movement accepted between issuance and the signed taker refresh. */
export const MAX_TAKER_QUOTE_MOVEMENT = 0.01;

export interface TakerQuoteCap {
  issuanceAsk: number;
  maximumPrice: number;
  movementLimit: number;
}

/**
 * Caps one-cent quote tolerance at the buy policy's own price ceiling. The caller sizes at
 * `maximumPrice`, then the signed path submits only at the refreshed ask actually observed.
 */
export function takerQuoteCap(issuanceAsk: number): TakerQuoteCap | null {
  if (!Number.isFinite(issuanceAsk) || !(issuanceAsk > 0) || issuanceAsk > MAX_ENTRY_PRICE + 1e-12) return null;
  const maximumPrice = Math.min(MAX_ENTRY_PRICE, issuanceAsk + MAX_TAKER_QUOTE_MOVEMENT);
  return { issuanceAsk, maximumPrice, movementLimit: maximumPrice - issuanceAsk };
}

export function refreshedAskFitsTakerCap(freshAsk: number, cap: TakerQuoteCap): boolean {
  return Number.isFinite(freshAsk) && freshAsk > 0 && !(cap.maximumPrice + 1e-9 < freshAsk);
}
