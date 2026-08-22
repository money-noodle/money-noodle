import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { summarize } from './paper-execution';
import type { ExecutionMode, PaperOrder } from './types';

/**
 * The two P&L figures on a budget panel are different quantities and must never be conflated.
 *
 * `realizedPnlCents` is the one that reconciles: `startingCents + realizedPnlCents` is the equity shown
 * beside it. On live that means the current funding epoch and the whole account, because live cash is one
 * real Kalshi balance settled through a shared control whatever strategy spent it. `lifetimePnlCents`
 * spans every epoch and deliberately ties to nothing.
 */
const EPOCH = 'epoch-1-2026-08-15T08:15:43.046Z';

const order = (over: Partial<PaperOrder> & { status: string }): PaperOrder => ({
  executionMode: 'live' as ExecutionMode, strategyId: 'edge-binary-buy',
  pnlCents: 0, stakeCents: 100, closesAt: '2026-08-17T00:00:00Z', symbol: 'BTC', side: 'UP',
  ...over,
} as PaperOrder);

const figures = { startingCents: 2000, availableCents: 2152, reservedCents: 0, proposedStakeCents: 100 };
const live = (orders: PaperOrder[], scope: { epochId?: string; startedAt?: string } = { epochId: EPOCH, startedAt: '2026-08-15T08:15:43.046Z' }) =>
  summarize(orders, 'live', true, 2152, figures, undefined, 'edge-binary-buy', scope);

describe('the P&L that reconciles with the budget beside it', () => {
  it('covers only the current funding epoch, so an earlier epoch cannot inflate it', () => {
    const orders = [
      order({ status: 'won', pnlCents: 152, budgetEpochId: EPOCH }),
      order({ status: 'won', pnlCents: 900, budgetEpochId: 'epoch-0-older' }),
      order({ status: 'lost', pnlCents: -866 }),
    ];
    const summary = live(orders);
    expect(summary.realizedPnlCents).toBe(152);
    expect(summary.lifetimePnlCents).toBe(186);
    expect(summary.pnlScope).toBe('budget-epoch');
    expect(figures.startingCents + summary.realizedPnlCents).toBe(summary.equityCents);
  });

  /**
   * The mistake this pins. Narrowing live's P&L by strategy reads a figure the account-wide counter
   * beside it can never equal, because a second strategy draws on the same real balance.
   */
  it('counts every strategy on live, because the balance it mirrors is account-wide', () => {
    const orders = [
      order({ status: 'won', pnlCents: 183, budgetEpochId: EPOCH }),
      order({ status: 'lost', pnlCents: -31, budgetEpochId: EPOCH, strategyId: 'long-shot-round-trip' }),
    ];
    const summary = live(orders);
    expect(summary.realizedPnlCents).toBe(152);
    // Counts, wins and losses stay narrowed to the strategy whose ledger this card describes.
    expect(summary.settledOrders).toBe(1);
    expect(summary.wins).toBe(1);
  });

  it('uses whole-cent pnlCents and never the exact reporting view', () => {
    // A sold exit prices actualPnlCents from a fractional net liquidation; summing it into a budget
    // figure is what made the paper panel disagree with itself by ~100c over 205 exits.
    const orders = [
      order({ status: 'sold', pnlCents: 25, actualPnlCents: 25.32, budgetEpochId: EPOCH }),
      order({ status: 'sold', pnlCents: 6, actualPnlCents: 6.48, budgetEpochId: EPOCH }),
    ];
    const summary = live(orders);
    expect(summary.realizedPnlCents).toBe(31);
    expect(Number.isInteger(summary.realizedPnlCents)).toBe(true);
    expect(Number.isInteger(summary.lifetimePnlCents)).toBe(true);
  });

  it('reports a lifetime scope when no epoch is given, and then the two figures agree', () => {
    const orders = [order({ status: 'won', pnlCents: 40 }), order({ status: 'lost', pnlCents: -15 })];
    const summary = live(orders, {});
    expect(summary.pnlScope).toBe('lifetime');
    expect(summary.epochStartedAt).toBeUndefined();
    expect(summary.realizedPnlCents).toBe(25);
    expect(summary.lifetimePnlCents).toBe(25);
  });

  it('carries the epoch start so the label can say what the figure covers', () => {
    expect(live([order({ status: 'won', pnlCents: 1, budgetEpochId: EPOCH })]).epochStartedAt)
      .toBe('2026-08-15T08:15:43.046Z');
  });

  it('keeps scheduled control detail to open intents instead of terminal history', () => {
    const orders = [
      order({ id: 'terminal', createdAt: '2026-08-17T00:00:00Z', status: 'won', pnlCents: 10, budgetEpochId: EPOCH }),
      order({ id: 'open', createdAt: '2026-08-17T00:01:00Z', status: 'open', pnlCents: undefined, budgetEpochId: EPOCH }),
    ];
    const summary = summarize(orders, 'live', true, 2152, figures, undefined, 'edge-binary-buy',
      { epochId: EPOCH }, 'open');
    expect(summary.recentOrders.map((row) => row.id)).toEqual(['open']);
    expect(summary.openOrders).toBe(1);
    expect(summary.settledOrders).toBe(1);
  });

  it('does not expose internal v9 evidence references in recent order presentation', () => {
    const archivedEvidence = {
      version: 'execution-order-evidence-ref-v1' as const,
      file: `batch.${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), rowKey: 'b'.repeat(64), summary: {},
    };
    const summary = live([order({ id: 'archived', createdAt: '2026-08-17T00:00:00Z', status: 'won', archivedEvidence })], {});
    expect(summary.recentOrders[0].id).toBe('archived');
    expect(summary.recentOrders[0].archivedEvidence).toBeUndefined();
  });

  it('leaves paper narrowed to its own strategy, whose bankroll is not shared', () => {
    const orders = [
      order({ executionMode: 'paper', status: 'won', pnlCents: 100 }),
      order({ executionMode: 'paper', status: 'lost', pnlCents: -500, strategyId: 'long-shot-round-trip' }),
    ];
    const summary = summarize(orders, 'paper', true, 9900, { startingCents: 10_000, availableCents: 9900, reservedCents: 0, proposedStakeCents: 100 },
      { startingCents: 10_000, availableCents: 9900, realizedPnlCents: 100 });
    // The other strategy's 500c loss must not reach the edge policy's published bankroll.
    expect(summary.realizedPnlCents).toBe(100);
    expect(summary.lifetimePnlCents).toBe(100);
  });
});
