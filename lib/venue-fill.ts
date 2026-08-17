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

/** Which side of the book the fill took. The fee schedules differ, and on Kalshi they differ enormously. */
export type LiquidityRole = 'maker' | 'taker';

/**
 * Venue trading fee, in whole cents, for one fill.
 *
 * `role` is required rather than defaulted. A default would silently keep every call site on the taker
 * schedule, which is exactly the defect this parameter exists to close: paper charged a taker fee on
 * managed maker fills from the 2026-08-14 mirror alignment until 2026-08-17, while live read the real
 * figure from the venue and released the unused reserve.
 *
 * **Kalshi charges effectively nothing on a resting fill.** Across every live fill the desk has taken,
 * the 497 the venue reported as `maker` carry a mean fee of 0.000c and a maximum of 0.02c, against
 * 0.682c for the 5 reported as `taker`. That is an authoritative API response over 497 observations, not
 * an inference from a published fee table — but it is a modelled constant on the paper side and can go
 * stale silently if the schedule changes. Live is self-correcting because it reads `average_fee_paid`
 * per fill; only paper depends on this number. See docs/paper-maker-fee-design.md §8.
 *
 * Rounds up with a 1c floor on the taker schedule, per §1: a fee is a cost and costs round against us.
 */
export function venueFeeCents(venue: 'polymarket' | 'kalshi', limitPriceCents: number, quantity: number, role: LiquidityRole): number {
  // A resting fill is not charged, so there is no floor to apply: a 1c minimum on a free fill would be
  // the same phantom cost in miniature.
  if (role === 'maker') return venue === 'kalshi' ? 0 : Math.max(1, Math.ceil(quantity * limitPriceCents * 0.01));
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
    // Reserved at the taker schedule deliberately: at issuance neither track knows how it will fill,
    // and reserving low would breach the all-in cap. A maker fill releases the difference on settle.
    const feeCents = venueFeeCents(venue, limitPriceCents, quantity, 'taker');
    const stakeCents = purchaseCents + feeCents;
    if (stakeCents <= stakeLimitCents) return { quantity, limitPriceCents, purchaseCents, feeCents, stakeCents, potentialPayoutCents: Math.round(quantity * 100) };
  }
  return null;
}
