import { venueFeeFraction, type LiquidityRole } from './venue-fee-schedule';

export interface PaperFill {
  quantity: number;
  limitPriceCents: number;
  purchaseCents: number;
  feeCents: number;
  stakeCents: number;
  potentialPayoutCents: number;
}

/**
 * Venue fee and fill sizing. Pure and I/O free.
 *
 * Extracted from `paper-execution` so a second strategy can size an order without importing the execution
 * engine, which would form an import cycle. The implementations are unchanged: both policies must size
 * against one fee model, or their reported economics stop being comparable.
 */

/** Highest ask that can be treated as fillable at all. */
export const MAX_FILLABLE_ASK = 0.99;

/**
 * Venue trading fee, in whole cents, for one fill.
 *
 * The schedule itself lives in `venueFeeSchedule`; this is the charged amount over it — rounded up
 * against us with a 1c floor, per §1, because a fee is a cost.
 *
 * `role` is required rather than defaulted. A default would silently keep every call site on the taker
 * schedule, which is exactly the defect this parameter closed: paper charged a taker fee on managed
 * maker fills from the 2026-08-14 mirror alignment until 2026-08-17.
 */
export function venueFeeCents(venue: 'polymarket' | 'kalshi', limitPriceCents: number, quantity: number, role: LiquidityRole): number {
  const fraction = venueFeeFraction(venue, limitPriceCents / 100, role);
  // A free fill is free: a 1c minimum on it would be the same phantom cost in miniature.
  if (fraction === 0) return 0;
  // `Math.ceil(cost - 1e-9)`, per §1. Composing the schedule as a fraction and scaling back to cents
  // reintroduces float dust the single-expression form did not have: 0.07 * 0.5 * 0.5 * 400 is
  // 7.000000000000001, and a bare ceiling turns a clean 7c fee into 8c.
  return Math.max(1, Math.ceil(100 * quantity * fraction - 1e-9));
}

/**
 * Largest purchase that fits inside an all-in spend cap.
 *
 * The configured per-trade amount is what leaves the account in total, so the value sent to the venue
 * must be lower to leave room for fees. The limit price is rounded up to a whole cent so the order is
 * marketable against the quoted ask, and quantity is reduced until price x count plus fees fits.
 */
export function estimatePaperFill(stakeLimitCents: number, askPrice: number, venue: 'polymarket' | 'kalshi'): PaperFill | null {
  if (!Number.isInteger(stakeLimitCents) || stakeLimitCents <= 0 || !Number.isFinite(askPrice) || askPrice <= 0 || askPrice > MAX_FILLABLE_ASK) return null;
  const limitPriceCents = askPrice * 100;
  // Kalshi v2 supports 0.01-contract increments. Polymarket remains whole-contract only here.
  const quantityStep = venue === 'kalshi' ? 0.01 : 1;
  const maximumUnits = Math.floor((stakeLimitCents / limitPriceCents + 1e-9) / quantityStep);
  for (let units = maximumUnits; units > 0; units -= 1) {
    const quantity = Number((units * quantityStep).toFixed(2));
    const purchaseCents = Math.ceil(quantity * limitPriceCents - 1e-9);
    // Reserved at the taker schedule deliberately: at issuance neither track knows how it will fill,
    // and reserving low would breach the all-in cap. A maker fill releases the difference on settle.
    const feeCents = venueFeeCents(venue, limitPriceCents, quantity, 'taker');
    const stakeCents = purchaseCents + feeCents;
    if (stakeCents <= stakeLimitCents) return { quantity, limitPriceCents, purchaseCents, feeCents, stakeCents, potentialPayoutCents: Math.round(quantity * 100) };
  }
  return null;
}

export type { LiquidityRole };
