import { describe, expect, it } from 'vitest';
import { requalifyPaperFallback, paperIocAccountingPlan } from './domain/paper-ioc-policy.js';
const plan = (reservation: number, result: Parameters<typeof paperIocAccountingPlan>[1]) =>
  paperIocAccountingPlan(reservation, result, 4, 0.5);
const now = Date.parse('2026-10-11T02:00:00Z');
const base = {
  contractId: 'synthetic-ticker',
  side: 'UP' as const,
  quote: {
    contractId: 'synthetic-ticker',
    side: 'UP' as const,
    observedAtMs: now,
    bid: 0.48,
    ask: 0.5,
  },
  nowMs: now,
  maximumQuoteAgeMs: 1000,
  probability: 0.6,
  quantity: 4,
  referenceMidpoint: 0.49,
  finalMakerLimit: 0.44,
  approvedMaximum: 0.55,
  maximumEntryPrice: 0.75,
};
const fill = {
  filledCount: 1.25,
  averagePrice: 0.5,
  cashCents: 62.5,
  displayedAtLimit: 1.25,
  levelsConsumed: 1,
};
describe('pure exact quote fallback and IOC plans, no order or budget writes', () => {
  it('caps fallback at two ticks and charges worst-limit fee with independent arithmetic', () => {
    const result = requalifyPaperFallback(base);
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error(result.reason);
    expect(result.limit).toBe(0.52);
    expect(result.tickSize).toBe(0.01);
    // ceil(100*4*.07*.52*.48)=7c => .60-.52-7/400=.0625.
    expect(result.netEdge).toBeCloseTo(0.0625, 12);
  });
  it('rejects wrong contract/side, stale/future/malformed quote and nonpositive fee edge', () => {
    for (const quote of [
      { ...base.quote, contractId: 'other' },
      { ...base.quote, side: 'DOWN' as const },
      { ...base.quote, observedAtMs: now - 1001 },
      { ...base.quote, observedAtMs: now + 1 },
      { ...base.quote, bid: NaN },
    ])
      expect(requalifyPaperFallback({ ...base, quote }).allowed).toBe(false);
    expect(requalifyPaperFallback({ ...base, probability: 0.5375 }).allowed).toBe(false);
    expect(requalifyPaperFallback({ ...base, quantity: 0.015 }).allowed).toBe(false);
  });
  it('permits exactly one-tick midpoint decline but refuses greater and structural cap breach', () => {
    expect(requalifyPaperFallback({ ...base, referenceMidpoint: 0.5 }).allowed).toBe(true);
    expect(requalifyPaperFallback({ ...base, referenceMidpoint: 0.500001 }).allowed).toBe(false);
    expect(requalifyPaperFallback({ ...base, finalMakerLimit: 0.39 }).allowed).toBe(false);
  });
  it('distinguishes unavailable data from observed nofill and preserves full reservation release plans', () => {
    expect(plan(207, { kind: 'data-unavailable' })).toEqual({
      status: 'rejected',
      releasedCents: 207,
      noFillReason: 'data_unavailable',
    });
    expect(plan(207, { kind: 'quote-refused' })).toEqual({
      status: 'unfilled',
      releasedCents: 207,
      noFillReason: 'pre_submit_quote_moved',
    });
    expect(
      plan(207, {
        kind: 'observed',
        fill: { ...fill, filledCount: 0, cashCents: 0, averagePrice: 0 },
      }),
    ).toEqual({ status: 'unfilled', releasedCents: 207, noFillReason: 'ioc_no_fill' });
  });
  it('accounts positive IOC partial at taker fees, never overreservation or offlattice payout', () => {
    // ceil62.5=63 + ceil(100*1.25*.07*.5*.5)=3 =>66;207-66=141; payout125.
    expect(plan(207, { kind: 'observed', fill })).toEqual({
      status: 'open',
      stakeCents: 66,
      feeCents: 3,
      releasedCents: 141,
      filledCount: 1.25,
      potentialPayoutCents: 125,
    });
    expect(() => plan(65, { kind: 'observed', fill })).toThrow();
    expect(() =>
      plan(207, {
        kind: 'observed',
        fill: { ...fill, filledCount: 0.015, cashCents: 0.75 },
      }),
    ).toThrow();
    expect(() => plan(207, { kind: 'observed', fill: { ...fill, cashCents: 63 } })).toThrow();
  });
});

it('refuses positive IOC quantity beyond the explicit issued request', () => {
  expect(() => paperIocAccountingPlan(207, { kind: 'observed', fill }, 1, 0.5)).toThrow();
});
