import { describe, expect, it } from 'vitest';
import { planPaperSale, type PaperSaleTerms, type PaperSaleEvidence } from './domain/paper-sale.js';
const now = Date.parse('2026-10-11T02:00:00Z');
const base: PaperSaleTerms = {
  position: {
    identity: {
      orderId: 'synthetic-original',
      originalLedgerPosition: 9,
      epoch: 1,
      fundingId: 'synthetic-funding',
      contractId: 'synthetic-ticker',
      side: 'UP',
      venue: 'kalshi',
    },
    quantity: 4,
    reservedStakeCents: 207,
    actualStakeCents: 207,
    actualPurchaseCents: 200,
    actualFeeCents: 7,
  },
  evidence: { kind: 'unavailable' },
  nowMs: now,
  maximumBookAgeMs: 1000,
  authorizedMinimumPrice: 0.5,
  saleEventId: 'synthetic-sale',
};
const observed = (quantity: number, price: number): PaperSaleEvidence => ({
  kind: 'observed',
  contractId: 'synthetic-ticker',
  side: 'UP',
  observedAtMs: now,
  fill: {
    filledCount: quantity,
    averagePrice: price,
    cashCents: quantity * price * 100,
    displayedAtLimit: quantity,
    levelsConsumed: quantity > 0 ? 1 : 0,
  },
});
describe('pure sale rounding/cost planes, no funding replenishment or state mutation', () => {
  it('partial1of4 at60c conserves cash+reserved and preserves original concrete identity', () => {
    const p = planPaperSale({ ...base, evidence: observed(1, 0.6) });
    if (p.kind !== 'sold') throw new Error('No sale plan');
    expect(p.identity).toEqual(base.position.identity);
    expect(p.sold.exitFeeCents).toBe(2);
    expect(p.sold.integerBudgetCreditCents).toBe(58);
    expect(p.sold.reservedStakeCents).toBe(51);
    expect(p.sold.realizedDeltaCents).toBe(7);
    expect(p.sold.actualStakeCents).toBe(51.75);
    expect(p.sold.actualPnlCents).toBe(6.25);
    expect(p.remaining).toEqual({
      quantity: 3,
      reservedStakeCents: 156,
      actualStakeCents: 155.25,
      actualPurchaseCents: 150,
      actualFeeCents: 5.25,
      potentialPayoutCents: 300,
    });
    expect(1000 - 207 + 58 + 156).toBe(1000 + 7);
    expect(p.clearEntryPersistence).toBe(false);
    expect(p.countsForReentryGeneration).toBe(false);
    expect(base.position.quantity).toBe(4);
  });
  it('full sale pays7c fee returns233c realizes26c and clears persistence without remainder', () => {
    const p = planPaperSale({ ...base, evidence: observed(4, 0.6) });
    if (p.kind !== 'sold') throw new Error('No sale');
    expect(p.sold.exitFeeCents).toBe(7);
    expect(p.sold.integerBudgetCreditCents).toBe(233);
    expect(p.sold.realizedDeltaCents).toBe(26);
    expect(p.remaining).toBeNull();
    expect(p.clearEntryPersistence).toBe(true);
    expect(p.countsForReentryGeneration).toBe(true);
  });
  it('unavailable defers without attempt while observed zero retains inventory and disables automatic retry', () => {
    expect(planPaperSale(base)).toEqual({
      kind: 'deferred',
      identity: base.position.identity,
      recordAttempt: false,
    });
    expect(planPaperSale({ ...base, evidence: observed(0, 0) })).toEqual({
      kind: 'no-fill',
      identity: base.position.identity,
      recordAttempt: true,
      disableAutomaticRetry: true,
    });
  });
  it('never credits rounded-up fractional proceeds or negative net proceeds', () => {
    const p = planPaperSale({ ...base, evidence: observed(1, 0.605) });
    if (p.kind !== 'sold') throw new Error('No sale');
    expect(p.sold.rawSaleProceedsCents).toBe(58.5);
    expect(p.sold.integerBudgetCreditCents).toBe(58);
    const tiny = {
      ...base,
      authorizedMinimumPrice: 0.01,
      position: {
        ...base.position,
        quantity: 0.01,
        reservedStakeCents: 2,
        actualStakeCents: 2,
        actualPurchaseCents: 1,
        actualFeeCents: 1,
      },
      evidence: observed(0.01, 0.01),
    };
    const t = planPaperSale(tiny);
    if (t.kind !== 'sold') throw new Error('No sale');
    expect(t.sold.rawSaleProceedsCents).toBeCloseTo(-0.99);
    expect(t.sold.integerBudgetCreditCents).toBe(0);
    expect(t.sold.realizedDeltaCents).toBe(-2);
  });
  it('refuses excess/offlattice/inconsistent/wrong-contract/stale evidence and cost planes', () => {
    for (const evidence of [observed(4.01, 0.6), observed(0.015, 0.6)])
      expect(() => planPaperSale({ ...base, evidence })).toThrow();
    const e = observed(1, 0.6);
    if (e.kind !== 'observed') throw new Error('No evidence');
    for (const patch of [
      { contractId: 'other' },
      { observedAtMs: now - 1001 },
      { side: 'DOWN' as const },
      { fill: { ...e.fill, cashCents: 61 } },
    ])
      expect(() => planPaperSale({ ...base, evidence: { ...e, ...patch } })).toThrow();
    expect(() =>
      planPaperSale({ ...base, position: { ...base.position, actualFeeCents: 8 } }),
    ).toThrow();
  });
});
