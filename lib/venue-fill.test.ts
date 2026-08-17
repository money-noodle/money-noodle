import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { estimatePaperFill, venueFeeCents } from './venue-fill';

/**
 * The fee model is the one place a venue fee may be expressed, and it decides real money on both tracks.
 *
 * The schedules differ by liquidity role, and on Kalshi they differ enormously: across every live fill
 * the desk has taken, the 497 the venue reported as `maker` carry a mean fee of 0.000c against 0.682c
 * for the 5 reported as `taker`. Paper charged the taker schedule on managed maker fills from the
 * 2026-08-14 mirror alignment until 2026-08-17 — 694c it never owed. See docs/paper-maker-fee-design.md.
 */
describe('kalshi fee schedule', () => {
  it('charges nothing on a resting fill, at every price and size', () => {
    for (const priceCents of [1, 5, 22, 50, 73, 97, 99]) {
      for (const quantity of [0.01, 1, 2.43, 100]) {
        expect(venueFeeCents('kalshi', priceCents, quantity, 'maker')).toBe(0);
      }
    }
  });

  it('charges the quadratic taker fee, rounded up against us with a 1c floor', () => {
    // 0.07 * q * p * (1 - p), in cents, always rounded up: a fee is a cost and costs round against us.
    expect(venueFeeCents('kalshi', 50, 1, 'taker')).toBe(2); // 7 * 1 * 0.25 = 1.75 -> 2
    expect(venueFeeCents('kalshi', 50, 4, 'taker')).toBe(7); // 7 * 4 * 0.25 = 7
    expect(venueFeeCents('kalshi', 22, 3.78, 'taker')).toBe(5); // 7 * 3.78 * 0.1716 = 4.54 -> 5
    // The floor binds where the quadratic nearly vanishes, at the extremes of the price range.
    expect(venueFeeCents('kalshi', 1, 0.01, 'taker')).toBe(1);
    expect(venueFeeCents('kalshi', 99, 0.01, 'taker')).toBe(1);
  });

  it('never returns a fraction of a cent on either schedule', () => {
    for (const role of ['maker', 'taker'] as const) {
      for (const priceCents of [3, 17, 44, 61, 88]) {
        for (const quantity of [0.07, 1.13, 9.99]) {
          expect(Number.isInteger(venueFeeCents('kalshi', priceCents, quantity, role))).toBe(true);
        }
      }
    }
  });

  it('rounds up rather than to nearest on a value sitting just above a whole cent', () => {
    // 7 * 2 * 0.5 * 0.5 = 3.5 exactly: to-nearest would give 4 either way, so use a value that only
    // ceiling resolves upward. 7 * 1.01 * 0.5 * 0.5 = 1.7675 -> 2, never 1.
    expect(venueFeeCents('kalshi', 50, 1.01, 'taker')).toBe(2);
    // A float-representation edge: 0.07 * 0.29 * 0.71 does not land exactly on a cent boundary.
    expect(venueFeeCents('kalshi', 29, 1, 'taker')).toBe(2);
  });
});

describe('polymarket fee schedule', () => {
  it('is proportional on both roles, because no maker rebate has been observed there', () => {
    // Deliberately unchanged by role: the zero-maker evidence is a Kalshi observation, and assuming it
    // holds on a venue the desk has never filled on would be inventing a rebate.
    expect(venueFeeCents('polymarket', 50, 4, 'taker')).toBe(2);
    expect(venueFeeCents('polymarket', 50, 4, 'maker')).toBe(2);
  });
});

describe('sizing against the all-in cap', () => {
  it('reserves at the taker schedule, so neither track can breach the cap on a crossing fill', () => {
    const fill = estimatePaperFill(100, 0.5, 'kalshi');
    expect(fill).not.toBeNull();
    // price * count + fee must fit inside the cap, with the fee reserved conservatively.
    expect(fill!.purchaseCents + fill!.feeCents).toBe(fill!.stakeCents);
    expect(fill!.stakeCents).toBeLessThanOrEqual(100);
    expect(fill!.feeCents).toBe(venueFeeCents('kalshi', 50, fill!.quantity, 'taker'));
  });

  it('sizes identically for both tracks, which is what keeps the mirror comparable', () => {
    // Live and paper both size through this function; a role-dependent reserve here would make the two
    // tracks buy different quantities for the same decision, which is worse than an over-reserved fee.
    for (const cap of [25, 100, 137, 200]) {
      for (const ask of [0.12, 0.5, 0.87]) {
        const fill = estimatePaperFill(cap, ask, 'kalshi');
        if (!fill) continue;
        expect(fill.stakeCents).toBeLessThanOrEqual(cap);
        expect(Number.isInteger(fill.stakeCents)).toBe(true);
        expect(Number.isInteger(fill.feeCents)).toBe(true);
      }
    }
  });

  it('refuses a cap too small to buy the smallest increment', () => {
    expect(estimatePaperFill(1, 0.99, 'kalshi')).toBeNull();
  });
});
