// Versioned historical simulation assumptions, NOT a statement of current venue
// charges. No cap/default here grants spending permission. Caller must supply a
// currently authorized all-in cap; the paper runtime is still unimplemented.
export const PAPER_FEE_MODEL = 'historical-v1-paper-fee-model';
export type PaperVenue = 'kalshi' | 'polymarket';
export type PaperLiquidityRole = 'maker' | 'taker';
export interface PaperFill {
  quantity: number;
  limitPriceCents: number;
  purchaseCents: number;
  feeCents: number;
  stakeCents: number;
  potentialPayoutCents: number;
}
export function venueFeeFraction(
  venue: PaperVenue,
  price: number,
  role: PaperLiquidityRole,
): number {
  if (
    (venue !== 'kalshi' && venue !== 'polymarket') ||
    (role !== 'maker' && role !== 'taker') ||
    !Number.isFinite(price) ||
    price <= 0 ||
    price >= 1
  )
    throw new Error('Invalid paper fee input.');
  return venue === 'polymarket' ? 0.01 * price : role === 'maker' ? 0 : 0.07 * price * (1 - price);
}
export function venueFeeCents(
  venue: PaperVenue,
  limitPriceCents: number,
  quantity: number,
  role: PaperLiquidityRole,
): number {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Invalid paper fee quantity.');
  const fraction = venueFeeFraction(venue, limitPriceCents / 100, role);
  return fraction === 0 ? 0 : Math.max(1, Math.ceil(100 * quantity * fraction - 1e-9));
}
/** Historical maximum affordable quantity, with logarithmic instead of unbounded decrement search. */
export function estimatePaperFill(
  stakeLimitCents: number,
  askPrice: number,
  venue: PaperVenue,
): PaperFill | null {
  if (
    !Number.isSafeInteger(stakeLimitCents) ||
    stakeLimitCents <= 0 ||
    !Number.isFinite(askPrice) ||
    askPrice <= 0 ||
    askPrice > 0.99 ||
    (venue !== 'kalshi' && venue !== 'polymarket')
  )
    return null;
  const limitPriceCents = askPrice * 100;
  const step = venue === 'kalshi' ? 0.01 : 1;
  const maximumUnits = Math.floor((stakeLimitCents / limitPriceCents + 1e-9) / step);
  if (!Number.isSafeInteger(maximumUnits) || maximumUnits < 1) return null;
  const atUnits = (units: number): PaperFill => {
    const quantity = Number((units * step).toFixed(2));
    const purchaseCents = Math.ceil(quantity * limitPriceCents - 1e-9);
    const feeCents = venueFeeCents(venue, limitPriceCents, quantity, 'taker');
    return {
      quantity,
      limitPriceCents,
      purchaseCents,
      feeCents,
      stakeCents: purchaseCents + feeCents,
      potentialPayoutCents: Math.round(quantity * 100),
    };
  };
  let low = 1,
    high = maximumUnits;
  let best: PaperFill | null = null;
  while (low <= high) {
    const units = low + Math.floor((high - low) / 2);
    const fill = atUnits(units);
    if (
      Number.isSafeInteger(fill.stakeCents) &&
      Number.isSafeInteger(fill.potentialPayoutCents) &&
      fill.stakeCents <= stakeLimitCents
    ) {
      best = fill;
      low = units + 1;
    } else high = units - 1;
  }
  return best;
}
/** Reduce-only historical policy; base is explicit caller authority, never a default. */
export function paperEntryStakeLimit(baseCents: number, netEdge: number): number | null {
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0 || !Number.isFinite(netEdge)) return null;
  return netEdge + 1e-12 >= 0.3 ? baseCents : Math.ceil(baseCents * 0.3 - 1e-9);
}
export interface MakerAccounting {
  status: 'open' | 'unfilled' | 'rejected';
  stakeCents: number;
  feeCents: number;
  releasedCents: number;
  potentialPayoutCents: number;
}
/** Pure transition plan only. The store must apply it exactly once with order/budget/event atomically. */
export function paperMakerAccounting(input: {
  reservationCents: number;
  filledCount: number;
  purchaseCents: number;
  averagePrice: number;
  evidenceComplete: boolean;
  venue: PaperVenue;
}): MakerAccounting {
  if (
    !Number.isSafeInteger(input.reservationCents) ||
    input.reservationCents <= 0 ||
    !Number.isFinite(input.filledCount) ||
    input.filledCount < 0 ||
    !Number.isFinite(input.purchaseCents) ||
    input.purchaseCents < 0
  )
    throw new Error('Invalid paper fill accounting.');
  if (input.filledCount === 0) {
    if (input.purchaseCents !== 0) throw new Error('Zero paper fill cannot carry a purchase.');
    return {
      status: input.evidenceComplete ? 'unfilled' : 'rejected',
      stakeCents: 0,
      feeCents: 0,
      releasedCents: input.reservationCents,
      potentialPayoutCents: 0,
    };
  }
  if (
    input.purchaseCents <= 0 ||
    !Number.isFinite(input.averagePrice) ||
    Math.abs(input.purchaseCents - input.filledCount * input.averagePrice * 100) > 1e-6
  ) {
    throw new Error('Inconsistent paper fill purchase evidence.');
  }
  const purchaseCents = Math.ceil(input.purchaseCents - 1e-9);
  const feeCents = venueFeeCents(input.venue, input.averagePrice * 100, input.filledCount, 'maker');
  const stakeCents = purchaseCents + feeCents;
  const potentialPayoutCents = Math.round(input.filledCount * 100);
  if (
    !Number.isSafeInteger(stakeCents) ||
    !Number.isSafeInteger(potentialPayoutCents) ||
    stakeCents > input.reservationCents
  )
    throw new Error('Paper fill exceeded its reservation.');
  return {
    status: 'open',
    stakeCents,
    feeCents,
    releasedCents: input.reservationCents - stakeCents,
    potentialPayoutCents,
  };
}
/** Edge-bankroll settlement terms; no lookup, no mutation, no duplicate-credit authority. */
export function paperSettlementTerms(
  stakeCents: number,
  potentialPayoutCents: number,
  side: 'UP' | 'DOWN',
  outcome: 'UP' | 'DOWN' | 'INVALID',
) {
  if (
    ![stakeCents, potentialPayoutCents].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    (side !== 'UP' && side !== 'DOWN') ||
    !['UP', 'DOWN', 'INVALID'].includes(outcome)
  ) {
    throw new Error('Invalid paper settlement terms.');
  }
  const payoutCents =
    outcome === 'INVALID' ? stakeCents : outcome === side ? potentialPayoutCents : 0;
  return {
    status: outcome === 'INVALID' ? 'invalid' : outcome === side ? 'won' : 'lost',
    payoutCents,
    pnlCents: payoutCents - stakeCents,
  } as const;
}
