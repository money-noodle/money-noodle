import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { epochResults, LEGACY_BUDGET_EPOCH_ID, lifetimeRealizedPnlCents, nextBudgetEpoch, orderEpochId } from './budget-epoch';
import type { PaperOrder } from './types';

let seq = 0;
const order = (over: Partial<PaperOrder> = {}): PaperOrder => {
  seq += 1;
  return {
    id: `o${seq}`, executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: `c${seq}`,
    side: 'UP', status: 'won', createdAt: `2026-08-1${(seq % 9) + 1}T00:00:00Z`,
    calculationAt: '2026-08-11T00:00:00Z', closesAt: '2026-08-11T00:15:00Z',
    modelProbabilityUp: 0.6, confidence: 0.7, askPrice: 0.5, bidPrice: 0.48, spread: 0.02,
    quantity: 10, stakeCents: 500, feeCents: 10, potentialPayoutCents: 1_000,
    payoutCents: 700, pnlCents: 200, settledAt: '2026-08-11T00:15:05Z', outcome: 'UP', ...over,
  };
};

describe('budget epochs', () => {
  it('mints an increasing sequence so epochs order without relying on timestamps', () => {
    const first = nextBudgetEpoch({ epochSequence: undefined }, '2026-08-13T00:00:00.000Z');
    const second = nextBudgetEpoch({ epochSequence: first.epochSequence }, '2026-08-13T01:00:00.000Z');
    expect(first.epochSequence).toBe(1);
    expect(second.epochSequence).toBe(2);
    expect(second.epochId).not.toBe(first.epochId);
  });

  it('attributes pre-epoch orders to a named legacy epoch, never to the current one', () => {
    expect(orderEpochId(order({ budgetEpochId: undefined }))).toBe(LEGACY_BUDGET_EPOCH_ID);
    const results = epochResults([order({ budgetEpochId: undefined })], 'live', 'epoch-2-x');
    expect(results[0].epochId).toBe(LEGACY_BUDGET_EPOCH_ID);
    expect(results[0].current).toBe(false);
  });

  it('keeps each epoch P&L separate, which is what a reconfiguration used to erase', () => {
    const rows = [
      order({ budgetEpochId: 'epoch-1', pnlCents: -300, createdAt: '2026-08-09T00:00:00Z' }),
      order({ budgetEpochId: 'epoch-1', pnlCents: -200, createdAt: '2026-08-09T01:00:00Z' }),
      order({ budgetEpochId: 'epoch-2', pnlCents: 400, createdAt: '2026-08-12T00:00:00Z' }),
    ];
    const results = epochResults(rows, 'live', 'epoch-2');
    expect(results.map((r) => r.epochId)).toEqual(['epoch-1', 'epoch-2']);
    expect(results[0]).toMatchObject({ realizedPnlCents: -500, settled: 2, current: false });
    expect(results[1]).toMatchObject({ realizedPnlCents: 400, settled: 1, current: true });
  });

  it('reports a lifetime total that no reconfiguration can reset', () => {
    const rows = [
      order({ budgetEpochId: 'epoch-1', pnlCents: -500 }),
      order({ budgetEpochId: 'epoch-2', pnlCents: 400 }),
      order({ budgetEpochId: undefined, pnlCents: 100 }),
    ];
    expect(lifetimeRealizedPnlCents(rows, 'live')).toBe(0);
    // the current epoch alone would have reported only +400
    expect(epochResults(rows, 'live', 'epoch-2').find((r) => r.current)!.realizedPnlCents).toBe(400);
  });

  it('never mixes execution modes, so a paper epoch cannot flatter a live one', () => {
    const rows = [
      order({ budgetEpochId: 'epoch-1', executionMode: 'live', pnlCents: -500 }),
      order({ budgetEpochId: 'epoch-1', executionMode: 'paper', pnlCents: 900 }),
    ];
    expect(lifetimeRealizedPnlCents(rows, 'live')).toBe(-500);
    expect(lifetimeRealizedPnlCents(rows, 'paper')).toBe(900);
  });

  it('counts only settled orders toward realized P&L', () => {
    const rows = [
      order({ budgetEpochId: 'e', status: 'open', pnlCents: undefined }),
      order({ budgetEpochId: 'e', status: 'won', pnlCents: 250 }),
    ];
    const [result] = epochResults(rows, 'live', 'e');
    expect(result.trades).toBe(2);
    expect(result.settled).toBe(1);
    expect(result.realizedPnlCents).toBe(250);
  });
});
