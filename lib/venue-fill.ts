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

/** Conservative taker-fee reserve; actual maker fees come from Kalshi fill records and unused cash is released. */
export function venueFeeCents(venue: 'polymarket' | 'kalshi', limitPriceCents: number, quantity: number): number {
  const price = limitPriceCents / 100;
  if (venue === 'kalshi') return Math.max(1, Math.ceil(7 * quantity * price * (1 - price)));
  return Math.max(1, Math.ceil(quantity * limitPriceCents * 0.01));
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
    const feeCents = venueFeeCents(venue, limitPriceCents, quantity);
    const stakeCents = purchaseCents + feeCents;
    if (stakeCents <= stakeLimitCents) return { quantity, limitPriceCents, purchaseCents, feeCents, stakeCents, potentialPayoutCents: Math.round(quantity * 100) };
  }
  return null;
}
