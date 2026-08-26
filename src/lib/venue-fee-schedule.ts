/**
 * The one place a venue's fee schedule is written down.
 *
 * §1 of the agent rules says fee models live in a single function, and until 2026-08-17 there were two:
 * `venueFeeCents` charged whole cents on a fill, and `venueFeeRate` charged a continuous rate inside the
 * entry gate's expected-value test. They agreed on the taker schedule by coincidence of having been
 * written from the same formula, not by construction, and only one of them learned that a maker pays
 * nothing. Both now derive from here.
 *
 * They are kept as two accessors rather than merged into one because they express different quantities:
 *
 * - `venueFeeFraction` is a **marginal rate** per $1 of payout — continuous, unrounded, and correct
 *   inside an expected-value comparison.
 * - `venueFeeCents` is the **amount actually charged** — whole cents, rounded up against us, with a 1c
 *   floor on the taker schedule.
 *
 * Deriving the rate from the cents function would import that floor and rounding into a continuous EV
 * calculation and distort the gate at small sizes far more than any fee error it could fix.
 *
 * Pure and I/O free.
 */

/** Which side of the book a fill took. On Kalshi the two schedules differ enormously. */
export type LiquidityRole = 'maker' | 'taker';

/**
 * **Kalshi charges nothing on a resting fill.** Across every live fill this desk has taken, the 497 the
 * venue reported as `maker` carry a mean fee of 0.000c and a maximum of 0.02c, against 0.682c for the 5
 * reported as `taker`. That is an authoritative API observation, not an inference from a published fee
 * table — but it is a modelled constant here, and it can go stale silently if Kalshi introduces a maker
 * fee. Live is self-correcting because it reads `average_fee_paid` per fill; every modelled path depends
 * on this number. See docs/paper-maker-fee-design.md §8.
 *
 * Polymarket is treated as a flat proportional cost on both roles: the zero-maker evidence above is a
 * Kalshi observation, and assuming it holds on a venue the desk has never filled on would be inventing a
 * rebate.
 */
export function venueFeeFraction(venue: 'polymarket' | 'kalshi', price: number, role: LiquidityRole): number {
  if (venue === 'polymarket') return 0.01 * price;
  return role === 'maker' ? 0 : 0.07 * price * (1 - price);
}
