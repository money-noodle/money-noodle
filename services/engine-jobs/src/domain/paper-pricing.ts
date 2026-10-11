// Historical simulation pricing only; no venue client or execution authority.
export type PaperSide = 'UP' | 'DOWN';
export interface PaperBookLevel {
  price: number;
  quantity: number;
}
export interface PaperBook {
  yesBids: PaperBookLevel[];
  noBids: PaperBookLevel[];
  observedAt: string;
}
export interface KalshiPriceRange {
  start: string;
  end: string;
  step: string;
}

export interface ManagedMakerQuote {
  bid: number;
  ask: number;
  ranges?: KalshiPriceRange[] | undefined;
  orderBook?: PaperBook | undefined;
}

export const MAKER_MANAGEMENT_CHECKS = 6;
export const MAKER_MANAGEMENT_POLL_MS = 12_000 / MAKER_MANAGEMENT_CHECKS;

export const MAX_PAPER_PRICE_RANGES = 64;
export const MAX_PAPER_PRICE_TICKS = 1_000;
function validateTicks(ticks: number): void {
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > MAX_PAPER_PRICE_TICKS)
    throw new Error('Invalid bounded paper tick count.');
}
function validateRanges(ranges: readonly KalshiPriceRange[] | undefined): void {
  if (ranges === undefined) return;
  const representable = (n: number) =>
    Number.isFinite(n) && Math.abs(n * 1_000_000 - Math.round(n * 1_000_000)) <= 1e-7;
  if (
    ranges.length < 1 ||
    ranges.length > MAX_PAPER_PRICE_RANGES ||
    ranges.some((r) => {
      const start = Number(r.start),
        end = Number(r.end),
        step = Number(r.step);
      return (
        ![start, end, step].every(representable) ||
        start < 0 ||
        end > 1 ||
        end <= start ||
        step < 0.000001 ||
        step > end - start
      );
    })
  )
    throw new Error('Unrepresentable or unbounded paper price ladder.');
}
function validateQuote(quote: ManagedMakerQuote, maximum: number): void {
  if (
    ![quote.bid, quote.ask, maximum].every(Number.isFinite) ||
    quote.bid < 0 ||
    quote.ask <= 0 ||
    quote.ask > 1 ||
    quote.bid > quote.ask ||
    maximum <= 0 ||
    maximum >= 1
  )
    throw new Error('Invalid paper pricing quote.');
  validateRanges(quote.ranges);
}

/** Highest valid market price at or below a target across Kalshi's tapered ranges. */
export function floorToValidKalshiPrice(priceDollars: number, ranges?: KalshiPriceRange[]): number {
  if (!Number.isFinite(priceDollars) || priceDollars < 0 || priceDollars > 1)
    throw new Error('Invalid paper price.');
  validateRanges(ranges);
  let best = 0;
  for (const item of ranges ?? [{ start: '0', end: '1', step: '0.01' }]) {
    const start = Number(item.start),
      end = Number(item.end),
      step = Number(item.step);
    if (![start, end, step].every(Number.isFinite) || step <= 0 || priceDollars + 1e-10 < start)
      continue;
    const ceiling = Math.min(priceDollars, end);
    const candidate = start + Math.floor((ceiling - start + 1e-10) / step) * step;
    if (candidate <= priceDollars + 1e-9 && candidate <= end + 1e-9)
      best = Math.max(best, candidate);
  }
  return Number(best.toFixed(6));
}

/** Moves up by exact venue ticks, including across tapered 10c/90c boundaries. */
export function advanceValidKalshiPrice(
  priceDollars: number,
  ticks: number,
  ranges?: KalshiPriceRange[],
): number {
  validateTicks(ticks);
  let result = floorToValidKalshiPrice(priceDollars, ranges);
  const ladder = ranges ?? [{ start: '0', end: '1', step: '0.01' }];
  for (let index = 0; index < ticks; index += 1) {
    let next = Number.POSITIVE_INFINITY;
    for (const item of ladder) {
      const start = Number(item.start),
        end = Number(item.end),
        step = Number(item.step);
      if (![start, end, step].every(Number.isFinite) || step <= 0 || result >= end - 1e-10)
        continue;
      const stepIndex = Math.max(0, Math.floor((result - start + 1e-10) / step) + 1);
      const candidate = start + stepIndex * step;
      if (candidate > result + 1e-10 && candidate <= end + 1e-9) next = Math.min(next, candidate);
    }
    if (!Number.isFinite(next)) break;
    const rounded = Number(next.toFixed(6));
    if (!(rounded > result)) throw new Error('Paper price ladder made no progress.');
    result = rounded;
  }
  return Number(result.toFixed(6));
}

export function boundedTakerLimit(input: {
  ask: number;
  maximumPrice: number;
  cushionTicks: number;
  ranges?: KalshiPriceRange[];
}): { limit: number; tickSize: number } | null {
  if (
    ![input.ask, input.maximumPrice].every(Number.isFinite) ||
    input.ask <= 0 ||
    input.maximumPrice <= 0 ||
    !Number.isSafeInteger(input.cushionTicks) ||
    input.cushionTicks < 0 ||
    input.cushionTicks > 2
  )
    return null;
  const current = floorToValidKalshiPrice(input.ask, input.ranges);
  if (Math.abs(current - input.ask) > 1e-9) return null;
  const firstHigher = advanceValidKalshiPrice(input.ask, 1, input.ranges);
  const tickSize = Number((firstHigher - current).toFixed(6));
  const cushioned = advanceValidKalshiPrice(input.ask, input.cushionTicks, input.ranges);
  const limit = floorToValidKalshiPrice(Math.min(input.maximumPrice, cushioned), input.ranges);
  return tickSize > 0 && limit > 0 ? { limit, tickSize } : null;
}

/** Moves down by exact venue ticks, including across tapered 10c/90c boundaries. */
export function backOffValidKalshiPrice(
  priceDollars: number,
  ticks: number,
  ranges?: KalshiPriceRange[],
): number {
  validateTicks(ticks);
  let result = floorToValidKalshiPrice(priceDollars, ranges);
  for (let index = 0; index < ticks && result > 0; index += 1) {
    const next = floorToValidKalshiPrice(Math.max(0, result - 1e-8), ranges);
    if (!(next < result)) throw new Error('Paper price ladder made no progress.');
    result = next;
  }
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
  validateQuote(input.quote, input.maximumPrice);
  const passiveCeiling = floorToValidKalshiPrice(
    Math.min(input.maximumPrice, input.quote.ask - 1e-8),
    input.quote.ranges,
  );
  if (!(passiveCeiling > 0)) return 0;
  validateTicks(input.createAttempt ?? 0);
  if (input.requestedStart !== undefined && !Number.isFinite(input.requestedStart))
    throw new Error('Invalid requested paper start.');
  const requestedStart = Number.isFinite(input.requestedStart) ? Number(input.requestedStart) : 0;
  const highestRequestedPassive = floorToValidKalshiPrice(
    Math.min(passiveCeiling, Math.max(input.quote.bid, requestedStart)),
    input.quote.ranges,
  );
  return backOffValidKalshiPrice(
    highestRequestedPassive,
    input.createAttempt ?? 0,
    input.quote.ranges,
  );
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
  validateQuote(input.quote, input.maximumPrice);
  const checks = input.managementChecks ?? MAKER_MANAGEMENT_CHECKS;
  if (
    !Number.isSafeInteger(checks) ||
    checks < 1 ||
    checks > MAKER_MANAGEMENT_CHECKS ||
    !Number.isSafeInteger(input.managementAttempt) ||
    input.managementAttempt < 0 ||
    input.managementAttempt >= checks ||
    !Number.isFinite(input.currentPrice) ||
    input.currentPrice <= 0 ||
    input.currentPrice >= 1 ||
    input.currentPrice > input.maximumPrice + 1e-12
  )
    throw new Error('Invalid bounded paper amendment count.');
  if (
    Math.abs(floorToValidKalshiPrice(input.currentPrice, input.quote.ranges) - input.currentPrice) >
    1e-12
  )
    throw new Error('Resting paper price is off supported ladder.');
  if (checks <= 1 || input.managementAttempt < 0 || input.managementAttempt >= checks - 1)
    return input.currentPrice;
  const passiveCeiling = floorToValidKalshiPrice(
    Math.min(input.maximumPrice, input.quote.ask - 1e-8),
    input.quote.ranges,
  );
  if (!(passiveCeiling > 0)) return input.currentPrice;
  const progress = (input.managementAttempt + 1) / (checks - 1);
  const target = Math.min(
    passiveCeiling,
    input.quote.bid + (passiveCeiling - input.quote.bid) * progress,
  );
  return Math.max(input.currentPrice, floorToValidKalshiPrice(target, input.quote.ranges));
}

export function selectedKalshiPriceRanges(
  side: PaperSide,
  ranges?: KalshiPriceRange[],
): KalshiPriceRange[] | undefined {
  validateRanges(ranges);
  if (side === 'UP' || !ranges) return ranges;
  return ranges
    .map((range) => ({
      start: String(1 - Number(range.end)),
      end: String(1 - Number(range.start)),
      step: range.step,
    }))
    .sort((a, b) => Number(a.start) - Number(b.start));
}

/** Converts an exact YES-book quote into the side the strategy owns. */
export function selectedManagedMakerQuote(input: {
  yesBid: number;
  yesAsk: number;
  side: PaperSide;
  ranges?: KalshiPriceRange[] | undefined;
  orderBook?: PaperBook | undefined;
}): ManagedMakerQuote {
  if (
    ![input.yesBid, input.yesAsk].every(Number.isFinite) ||
    input.yesBid < 0 ||
    input.yesAsk <= 0 ||
    input.yesAsk > 1 ||
    input.yesBid > input.yesAsk ||
    !['UP', 'DOWN'].includes(input.side)
  )
    throw new Error('Invalid selected paper quote.');
  validateRanges(input.ranges);
  return input.side === 'UP'
    ? {
        bid: input.yesBid,
        ask: input.yesAsk,
        ranges: selectedKalshiPriceRanges(input.side, input.ranges),
        orderBook: input.orderBook,
      }
    : {
        bid: 1 - input.yesAsk,
        ask: 1 - input.yesBid,
        ranges: selectedKalshiPriceRanges(input.side, input.ranges),
        orderBook: input.orderBook,
      };
}
