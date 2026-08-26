import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { IOC_QUANTITY_STEP, immediateBuyFill, immediateSellFill } from './ioc-fill-model';
import { selectedSideDepth } from './order-book-depth';
import type { BinaryOrderBook } from './types';

const book = (yesBids: Array<[number, number]>, noBids: Array<[number, number]>): BinaryOrderBook => ({
  yesBids: yesBids.map(([price, quantity]) => ({ price, quantity })),
  noBids: noBids.map(([price, quantity]) => ({ price, quantity })),
  observedAt: '2026-08-20T00:00:00.000Z',
});

describe('IOC sell against displayed depth', () => {
  it('fills inside the touch when the best bid is deep enough', () => {
    const result = immediateSellFill(book([[0.60, 5], [0.59, 20]], [[0.39, 5]]), 'UP', 0.60, 2);
    expect(result).toMatchObject({ filledCount: 2, levelsConsumed: 1 });
    expect(result.averagePrice).toBeCloseTo(0.60, 12);
    expect(result.cashCents).toBeCloseTo(120, 9);
  });

  it('walks down the ladder when the touch is too thin, and prices each level at its own price', () => {
    const result = immediateSellFill(book([[0.60, 1], [0.58, 1], [0.55, 10]], [[0.39, 5]]), 'UP', 0.50, 3);
    expect(result.filledCount).toBe(3);
    expect(result.levelsConsumed).toBe(3);
    // 1@60 + 1@58 + 1@55 = 173c, not 3@60.
    expect(result.cashCents).toBeCloseTo(173, 9);
    expect(result.averagePrice).toBeCloseTo(0.5766666666666667, 12);
  });

  it('stops at the limit rather than selling into a worse level', () => {
    const result = immediateSellFill(book([[0.60, 1], [0.40, 100]], [[0.39, 5]]), 'UP', 0.55, 5);
    expect(result).toMatchObject({ filledCount: 1, levelsConsumed: 1, displayedAtLimit: 1 });
    expect(result.cashCents).toBeCloseTo(60, 9);
  });

  it('cancels unfilled when nothing is displayed at or above the limit', () => {
    expect(immediateSellFill(book([[0.40, 100]], [[0.59, 5]]), 'UP', 0.55, 5))
      .toMatchObject({ filledCount: 0, averagePrice: 0, cashCents: 0, displayedAtLimit: 0 });
  });

  it('reads the NO ladder for a DOWN position', () => {
    const b = book([[0.60, 50]], [[0.35, 4]]);
    const down = immediateSellFill(b, 'DOWN', 0.35, 3);
    expect(down.filledCount).toBe(3);
    // Never `===` a computed price (AGENTS.md §1): 3 * 0.35 / 3 is 0.3499999999999999.
    expect(down.averagePrice).toBeCloseTo(0.35, 12);
    // The UP ladder is untouched by a DOWN sell even though it is deeper and better priced.
    expect(immediateSellFill(b, 'DOWN', 0.60, 3)).toMatchObject({ filledCount: 0 });
  });
});

describe('IOC buy against displayed depth', () => {
  it('lifts the complement of the opposite outcome bid, cheapest first', () => {
    // NO bid 0.55 -> UP ask 0.45; NO bid 0.52 -> UP ask 0.48.
    const result = immediateBuyFill(book([[0.44, 9]], [[0.55, 2], [0.52, 10]]), 'UP', 0.48, 4);
    expect(result.filledCount).toBe(4);
    expect(result.cashCents).toBeCloseTo(2 * 45 + 2 * 48, 9);
    expect(result.levelsConsumed).toBe(2);
  });

  it('refuses a level above the maximum price', () => {
    expect(immediateBuyFill(book([[0.44, 9]], [[0.40, 50]]), 'UP', 0.55, 3))
      .toMatchObject({ filledCount: 0, displayedAtLimit: 0 });
  });
});

describe('lattice and money discipline', () => {
  it('floors a partial fill onto the 0.01 lattice and drops the remainder cash with it', () => {
    const result = immediateSellFill(book([[0.60, 1.234]], [[0.39, 5]]), 'UP', 0.60, 5);
    expect(result.filledCount).toBe(1.23);
    // The dropped 0.004 contracts must not be paid for.
    expect(result.cashCents).toBeCloseTo(1.23 * 60, 9);
  });

  it('takes the sub-lattice remainder off the worst level reached, never the best', () => {
    // 0.5 at 60c then 0.755 at 50c sweeps to 1.255; the lattice keeps 1.25, and the 0.005 dropped
    // must come off the 50c level. Scaling total cash pro rata would credit part of it at 60c.
    const result = immediateSellFill(book([[0.60, 0.5], [0.50, 0.755]], [[0.39, 5]]), 'UP', 0.50, 2);
    expect(result.filledCount).toBe(1.25);
    expect(result.cashCents).toBeCloseTo(0.5 * 60 + 0.75 * 50, 9);
  });

  it('never returns more than was requested or more than was displayed', () => {
    for (const requested of [0.01, 0.5, 1, 2.5, 7, 100]) {
      for (const displayed of [0.01, 0.99, 1, 3.33, 50]) {
        const result = immediateSellFill(book([[0.60, displayed]], [[0.39, 1]]), 'UP', 0.60, requested);
        expect(result.filledCount).toBeLessThanOrEqual(requested + 1e-9);
        expect(result.filledCount).toBeLessThanOrEqual(displayed + 1e-9);
        expect(Math.round(result.filledCount / IOC_QUANTITY_STEP) * IOC_QUANTITY_STEP)
          .toBeCloseTo(result.filledCount, 9);
      }
    }
  });

  it('agrees with selectedSideDepth about what is displayed at the limit', () => {
    // The two modules must not disagree about the book: one reports it, the other consumes it.
    const b = book([[0.60, 4], [0.58, 6]], [[0.39, 5]]);
    const depth = selectedSideDepth(b, 'UP', 0.60, 0.61, 0.58);
    expect(immediateSellFill(b, 'UP', 0.58, 100).displayedAtLimit).toBeCloseTo(depth.displayedAhead!, 9);
  });

  it('fails closed on a missing book or a nonsensical limit', () => {
    expect(immediateSellFill(undefined, 'UP', 0.5, 1).filledCount).toBe(0);
    for (const limit of [0, 1, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(immediateSellFill(book([[0.60, 5]], [[0.39, 5]]), 'UP', limit, 1).filledCount).toBe(0);
      expect(immediateBuyFill(book([[0.60, 5]], [[0.39, 5]]), 'UP', limit, 1).filledCount).toBe(0);
    }
    expect(immediateSellFill(book([[0.60, 5]], [[0.39, 5]]), 'UP', 0.6, Number.NaN).filledCount).toBe(0);
    expect(immediateSellFill(book([[0.60, 5]], [[0.39, 5]]), 'UP', 0.6, -1).filledCount).toBe(0);
  });
});
