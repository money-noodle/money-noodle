import type { BinaryOrderBook, PositionSide } from './types';
import { MANAGED_MAKER_HORIZON_SECONDS } from './maker-fill-model';

export interface KalshiPriceRange { start: string; end: string; step: string }

export interface ManagedMakerQuote {
  bid: number;
  ask: number;
  ranges?: KalshiPriceRange[];
  orderBook?: BinaryOrderBook;
}

export const MAKER_MANAGEMENT_CHECKS = 6;
export const MAKER_MANAGEMENT_POLL_MS = MANAGED_MAKER_HORIZON_SECONDS * 1_000 / MAKER_MANAGEMENT_CHECKS;

/** Highest valid market price at or below a target across Kalshi's tapered ranges. */
export function floorToValidKalshiPrice(priceDollars: number, ranges?: KalshiPriceRange[]): number {
  let best = 0;
  for (const item of ranges ?? [{ start: '0', end: '1', step: '0.01' }]) {
    const start = Number(item.start), end = Number(item.end), step = Number(item.step);
    if (![start, end, step].every(Number.isFinite) || step <= 0 || priceDollars + 1e-10 < start) continue;
    const ceiling = Math.min(priceDollars, end);
    const candidate = start + Math.floor((ceiling - start + 1e-10) / step) * step;
    if (candidate <= priceDollars + 1e-9 && candidate <= end + 1e-9) best = Math.max(best, candidate);
  }
  return Number(best.toFixed(6));
}

/** Moves down by exact venue ticks, including across tapered 10c/90c boundaries. */
export function backOffValidKalshiPrice(priceDollars: number, ticks: number, ranges?: KalshiPriceRange[]): number {
  let result = floorToValidKalshiPrice(priceDollars, ranges);
  for (let index = 0; index < ticks && result > 0; index += 1) result = floorToValidKalshiPrice(result - 1e-8, ranges);
  return result;
}

/**
 * Pure initial-price decision shared by live and paper. It refreshes the exact contract first, joins
 * or improves the selected-side bid, remains below the ask, and never exceeds the issuance cap.
 */
export function initialManagedMakerPrice(input: {
  quote: ManagedMakerQuote;
  maximumPrice: number;
  requestedStart?: number;
  createAttempt?: number;
}): number {
  const passiveCeiling = floorToValidKalshiPrice(Math.min(input.maximumPrice, input.quote.ask - 1e-8), input.quote.ranges);
  if (!(passiveCeiling > 0)) return 0;
  const requestedStart = Number.isFinite(input.requestedStart) ? Number(input.requestedStart) : 0;
  const highestRequestedPassive = floorToValidKalshiPrice(
    Math.min(passiveCeiling, Math.max(input.quote.bid, requestedStart)), input.quote.ranges,
  );
  return backOffValidKalshiPrice(highestRequestedPassive, input.createAttempt ?? 0, input.quote.ranges);
}

/**
 * Pure managed reprice decision shared by live and paper. `managementAttempt` is zero-based and maps
 * exactly to live's first through fifth amend opportunities; the sixth check is terminal-only.
 */
export function nextManagedMakerPrice(input: {
  quote: ManagedMakerQuote;
  maximumPrice: number;
  currentPrice: number;
  managementAttempt: number;
  managementChecks?: number;
}): number {
  const checks = input.managementChecks ?? MAKER_MANAGEMENT_CHECKS;
  if (checks <= 1 || input.managementAttempt < 0 || input.managementAttempt >= checks - 1) return input.currentPrice;
  const passiveCeiling = floorToValidKalshiPrice(Math.min(input.maximumPrice, input.quote.ask - 1e-8), input.quote.ranges);
  if (!(passiveCeiling > 0)) return input.currentPrice;
  const progress = (input.managementAttempt + 1) / (checks - 1);
  const target = Math.min(passiveCeiling, input.quote.bid + (passiveCeiling - input.quote.bid) * progress);
  return Math.max(input.currentPrice, floorToValidKalshiPrice(target, input.quote.ranges));
}

export function selectedKalshiPriceRanges(side: PositionSide, ranges?: KalshiPriceRange[]): KalshiPriceRange[] | undefined {
  if (side === 'UP' || !ranges) return ranges;
  return ranges.map((range) => ({
    start: String(1 - Number(range.end)), end: String(1 - Number(range.start)), step: range.step,
  })).sort((a, b) => Number(a.start) - Number(b.start));
}

/** Converts an exact YES-book quote into the side the strategy owns. */
export function selectedManagedMakerQuote(input: {
  yesBid: number;
  yesAsk: number;
  side: PositionSide;
  ranges?: KalshiPriceRange[];
  orderBook?: BinaryOrderBook;
}): ManagedMakerQuote {
  return input.side === 'UP'
    ? { bid: input.yesBid, ask: input.yesAsk, ranges: selectedKalshiPriceRanges(input.side, input.ranges), orderBook: input.orderBook }
    : { bid: 1 - input.yesAsk, ask: 1 - input.yesBid, ranges: selectedKalshiPriceRanges(input.side, input.ranges), orderBook: input.orderBook };
}
