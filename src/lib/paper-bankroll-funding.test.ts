import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  LEGACY_BUDGET_EPOCH_ID, LEGACY_PAPER_BANKROLL_ID, epochResults, lifetimeRealizedPnlCents,
  nextPaperBankrollFunding, orderEpochId,
} from './budget-epoch';
import type { PaperOrder } from './types';

/**
 * The two budgets are opened by different acts — reconfiguring the trading control for live, resetting
 * the bankroll for paper — so they must never share a funding identity. Until 2026-08-17 `buildOrder`
 * stamped live's epoch onto paper orders, attributing a simulated result to a real funding that never
 * paid for it, and those records are permanent because order records are never rewritten.
 */
const order = (over: Partial<PaperOrder>): PaperOrder => ({
  executionMode: 'paper', status: 'won', pnlCents: 10, actualPnlCents: 10.4,
  stakeCents: 100, actualStakeCents: 100, createdAt: '2026-08-16T00:00:00Z',
  symbol: 'BTC', side: 'UP',
  ...over,
} as PaperOrder);

describe('funding identity per track', () => {
  it('reads the paper bankroll funding for paper and the live epoch for live', () => {
    expect(orderEpochId(order({ executionMode: 'paper', paperBankrollId: 'paper-2-x' }))).toBe('paper-2-x');
    expect(orderEpochId(order({ executionMode: 'live', budgetEpochId: 'epoch-1-y' }))).toBe('epoch-1-y');
  });

  /** The defect this exists to close: a paper order carrying live's epoch is not attributed to it. */
  it('ignores a live epoch stamped on a paper order', () => {
    const stray = order({ executionMode: 'paper', budgetEpochId: 'epoch-1-2026-08-15T08:15:43.046Z' });
    expect(orderEpochId(stray)).toBe(LEGACY_PAPER_BANKROLL_ID);
  });

  it('falls back to the right legacy identity on each track', () => {
    expect(orderEpochId(order({ executionMode: 'paper' }))).toBe(LEGACY_PAPER_BANKROLL_ID);
    expect(orderEpochId(order({ executionMode: 'live' }))).toBe(LEGACY_BUDGET_EPOCH_ID);
    expect(LEGACY_PAPER_BANKROLL_ID).not.toBe(LEGACY_BUDGET_EPOCH_ID);
  });

  it('never lets a paper funding collide with a live epoch id', () => {
    const minted = nextPaperBankrollFunding({ fundingSequence: 1 }, '2026-08-18T00:00:00.000Z');
    expect(minted.fundingId).toBe('paper-2-2026-08-18T00:00:00.000Z');
    expect(minted.fundingId.startsWith('epoch-')).toBe(false);
    expect(minted.fundingSequence).toBe(2);
  });

  it('treats the original never-reset bankroll as funding 1', () => {
    expect(nextPaperBankrollFunding({}).fundingSequence).toBe(2);
  });
});

describe('history grouped by funding', () => {
  const orders = [
    order({ pnlCents: 40, actualPnlCents: 40.5, createdAt: '2026-08-10T00:00:00Z' }),
    order({ pnlCents: -15, actualPnlCents: -15.2, createdAt: '2026-08-11T00:00:00Z', budgetEpochId: 'epoch-1-live' }),
    order({ pnlCents: 7, actualPnlCents: 7.3, createdAt: '2026-08-18T00:00:00Z', paperBankrollId: 'paper-2-x' }),
    order({ executionMode: 'live', pnlCents: 100, actualPnlCents: 100.9, budgetEpochId: 'epoch-1-live' }),
  ];

  it('puts every pre-reset paper order in one funding regardless of a stray live stamp', () => {
    const paper = epochResults(orders, 'paper', LEGACY_PAPER_BANKROLL_ID);
    expect(paper.map((epoch) => epoch.epochId)).toEqual([LEGACY_PAPER_BANKROLL_ID, 'paper-2-x']);
    expect(paper[0].settled).toBe(2);
    expect(paper[0].budgetPnlCents).toBe(25);
    expect(paper[0].current).toBe(true);
    expect(paper[1].current).toBe(false);
  });

  it('reports the whole-cent budget view beside the exact reporting view', () => {
    const [first] = epochResults(orders, 'paper', LEGACY_PAPER_BANKROLL_ID);
    // The exact view is what stake-expansion reads; the budget view is what reconciles with a balance.
    expect(first.realizedPnlCents).toBeCloseTo(25.3, 10);
    expect(first.budgetPnlCents).toBe(25);
    expect(Number.isInteger(first.budgetPnlCents)).toBe(true);
  });

  it('keeps live attribution untouched by paper fundings', () => {
    const live = epochResults(orders, 'live', 'epoch-1-live');
    expect(live).toHaveLength(1);
    expect(live[0].epochId).toBe('epoch-1-live');
    expect(live[0].budgetPnlCents).toBe(100);
  });

  it('spans every funding in the lifetime total, which no reset may erase', () => {
    expect(lifetimeRealizedPnlCents(orders, 'paper')).toBeCloseTo(32.6, 10);
    expect(lifetimeRealizedPnlCents(orders, 'live')).toBeCloseTo(100.9, 10);
  });
});
