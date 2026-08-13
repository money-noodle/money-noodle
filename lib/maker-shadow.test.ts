import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildMakerShadow } from './maker-shadow';
import type { PaperOrder } from './types';

let seq = 0;
const order = (over: Partial<PaperOrder> = {}): PaperOrder => {
  seq += 1;
  return {
    id: `o${seq}`, executionMode: 'paper', symbol: 'BTC', venue: 'kalshi', contractId: `c${seq}`,
    side: 'UP', status: 'won', createdAt: '2026-08-13T00:00:00Z', calculationAt: '2026-08-13T00:00:00Z',
    closesAt: `2026-08-13T00:${String(seq % 60).padStart(2, '0')}:00Z`,
    modelProbabilityUp: 0.6, confidence: 0.7,
    askPrice: 0.50, bidPrice: 0.40, spread: 0.10, quantity: 10,
    stakeCents: 500, feeCents: 17, potentialPayoutCents: 1_000,
    payoutCents: 1_000, pnlCents: 500, settledAt: '2026-08-13T00:15:00Z', outcome: 'UP',
    makerFillEstimate: { probability: 0.5, horizonSeconds: 12, quoteDistance: 0.1, quoteVolatilityPerSecond: 0.01, samples: 40, model: 'quote-first-passage-v1' },
    ...over,
  } as PaperOrder;
};

describe('maker-execution shadow', () => {
  it('prices the same settled outcome at the bid, which beats the ask on a winner', () => {
    const [row] = buildMakerShadow([order()], 'paper').rows;
    expect(row.askReturn).toBeCloseTo(1.0, 2);          // 500c staked, 1000c returned
    expect(row.makerReturn!).toBeGreaterThan(row.askReturn); // cheaper entry, same payout
  });

  it('discounts by the chance the resting order never traded', () => {
    const [row] = buildMakerShadow([order()], 'paper').rows;
    expect(row.expectedMakerReturn!).toBeCloseTo(row.makerReturn! * 0.5, 6);
  });

  it('treats an unfilled maker order as earning nothing rather than losing', () => {
    const never = order({ makerFillEstimate: { probability: 0, horizonSeconds: 12, quoteDistance: 0.2, quoteVolatilityPerSecond: 0.01, samples: 40, model: 'quote-first-passage-v1' } });
    expect(buildMakerShadow([never], 'paper').rows[0].expectedMakerReturn).toBe(0);
  });

  it('improves a loser too, since a cheaper entry loses less', () => {
    const loser = order({ status: 'lost', outcome: 'DOWN', payoutCents: 0, pnlCents: -500 });
    const [row] = buildMakerShadow([loser], 'paper').rows;
    expect(row.askReturn).toBeCloseTo(-1, 6);
    expect(row.makerReturn!).toBeCloseTo(-1, 6); // a total loss is total either way
  });

  it('reports no maker figure when the bid is unusable rather than guessing one', () => {
    const noBid = order({ bidPrice: 0 });
    const [row] = buildMakerShadow([noBid], 'paper').rows;
    expect(row.makerReturn).toBeNull();
    expect(row.expectedMakerReturn).toBeNull();
  });

  it('excludes orders with no recorded fill estimate from the weighted figures', () => {
    const report = buildMakerShadow([order(), order({ makerFillEstimate: undefined })], 'paper');
    expect(report.settled).toBe(2);
    expect(report.modelled).toBe(1);
  });

  it('clusters by settlement window, so one window is one observation', () => {
    const shared = '2026-08-13T01:00:00Z';
    const report = buildMakerShadow([order({ closesAt: shared }), order({ closesAt: shared }), order({ closesAt: '2026-08-13T02:00:00Z' })], 'paper');
    expect(report.settled).toBe(3);
    expect(report.windows).toBe(2);
  });

  it('never mixes execution modes', () => {
    const report = buildMakerShadow([order({ executionMode: 'live' })], 'paper');
    expect(report.settled).toBe(0);
  });

  it('ignores exit legs, which are reduce-only rather than maker entries', () => {
    expect(buildMakerShadow([order({ id: 'x:exit:1' })], 'paper').settled).toBe(0);
  });
});
