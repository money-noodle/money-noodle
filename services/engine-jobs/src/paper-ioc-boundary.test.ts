import { describe, expect, it } from 'vitest';
import {
  immediateBuyFill,
  immediateSellFill,
  PAPER_IOC_EVIDENCE_VERSION,
} from './domain/paper-ioc.js';
import { paperIocAccountingPlan } from './domain/paper-ioc-policy.js';
import type { PaperSide } from './domain/paper-pricing.js';
const book = (quantity: number, noPrice = 0.5, yesPrice = 0.5) => ({
  observedAt: '2026-10-11T02:00:00Z',
  yesBids: [{ price: yesPrice, quantity }],
  noBids: [{ price: noPrice, quantity }],
});
describe('F1/F7 conservative IOC correction, no authority', () => {
  it('rejects overflow/invalid requests, side and timestamps before accumulation', () => {
    for (const q of [1e308, Infinity, NaN, 0.0099999999])
      expect(() => immediateBuyFill(book(1), 'UP', 0.5, q)).toThrow();
    expect(() => immediateSellFill(book(1e308), 'UP', 0.5, 1)).toThrow();
    expect(() => immediateBuyFill(book(1), 'invalid' as PaperSide, 0.5, 1)).toThrow();
    expect(() => immediateBuyFill({ ...book(1), observedAt: 'bad' }, 'UP', 0.5, 1)).toThrow();
  });
  it('never rounds tiny displayed evidence up and trims worst level preserving mixed cash', () => {
    expect(immediateBuyFill(book(0.0099999999), 'UP', 0.5, 0.01).filledCount).toBe(0);
    const mixed = {
      observedAt: '2026-10-11T02:00:00Z',
      yesBids: [],
      noBids: [
        { price: 0.6, quantity: 1 },
        { price: 0.5, quantity: 1.255 },
      ],
    };
    const fill = immediateBuyFill(mixed, 'UP', 0.5, 3);
    expect(fill.filledCount).toBe(2.25);
    expect(fill.cashCents).toBe(102.5);
    expect(fill.levelsConsumed).toBe(2);
    expect(immediateBuyFill(book(1.25), 'UP', 0.5, 2).cashCents).toBe(62.5);
  });
  it('rejects a worse legal microtick instead of spending208c behind a positive-edge .5 limit', () => {
    expect(PAPER_IOC_EVIDENCE_VERSION).toBe('paper-ioc-conservative-microprice-v2');
    expect(immediateBuyFill(book(4, 0.499999), 'UP', 0.5, 4).filledCount).toBe(0);
    expect(immediateSellFill(book(4, 0.5, 0.499999), 'UP', 0.5, 4).filledCount).toBe(0);
    // P=.5175001/authorized.5/fee7 on4 gives positive .0000001; worse.500001 flips negative.
    expect(() =>
      paperIocAccountingPlan(
        208,
        {
          kind: 'observed',
          fill: {
            filledCount: 4,
            averagePrice: 0.500001,
            cashCents: 200.0004,
            displayedAtLimit: 4,
            levelsConsumed: 1,
          },
        },
        4,
        0.5,
      ),
    ).toThrow();
  });
  it('preserves missing-book compatibility without manufacturing observed miss authority', () => {
    expect(immediateBuyFill(undefined, 'UP', 0.5, 1).filledCount).toBe(0);
    expect(paperIocAccountingPlan(207, { kind: 'data-unavailable' }, 4, 0.5).status).toBe(
      'rejected',
    );
  });
});
