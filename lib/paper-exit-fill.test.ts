import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PAPER_EXIT_FILL_VERSION, executePaperStandaloneExit } from './paper-execution';
import type { BinaryOrderBook, PaperOrder } from './types';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');

const book = (yesBids: Array<[number, number]>): BinaryOrderBook => ({
  yesBids: yesBids.map(([price, quantity]) => ({ price, quantity })),
  noBids: [{ price: 0.30, quantity: 50 }],
  observedAt: '2026-08-20T12:00:00.000Z',
});

const order = (overrides: Partial<PaperOrder> = {}): PaperOrder => ({
  id: 'paper:BTC:UP:2026-08-20T12:15:00Z', executionMode: 'paper', strategyId: 'edge-binary-buy',
  marketId: 'crypto-15m', providerId: 'kalshi', venue: 'kalshi', symbol: 'BTC', side: 'UP',
  contractId: 'KXBTC15M-TEST', status: 'open', createdAt: '2026-08-20T12:05:00.000Z',
  closesAt: '2026-08-20T12:15:00Z', quantity: 2, filledCount: 2, requestedQuantity: 2,
  stakeCents: 90, actualStakeCents: 90, actualPurchaseCents: 90, feeCents: 0, actualFeeCents: 0,
  authoritativeFillPrice: 0.45, askPrice: 0.46, bidPrice: 0.44, liquidityRole: 'maker',
  ...overrides,
} as PaperOrder);

const decision = (executableBid: number) => ({
  policy: 'strict-value-v1', reason: 'Executable cash exceeds optimistic hold value.',
  executableBid, exitFeeCents: 2, netLiquidationCents: executableBid * 200 - 2,
  holdValueCents: 100, optimisticHoldValueCents: 110, netProfitPercent: 0.2,
} as never);

const ledger = () => ({
  paperBudget: { startingCents: 10_000, availableCents: 1_000, realizedPnlCents: 0 },
  orders: [] as PaperOrder[], signalPersistence: {}, portfolioDecisions: {}, switchPersistence: {},
} as never);

describe('paper standalone exit is an IOC, not a guaranteed sale', () => {
  it('retains the position when nothing is displayed at or above the exit limit', () => {
    // This is the case the old simulator could not express: it marked every exit `sold` at the modelled
    // net liquidation value, while live's reduce-only IOC completed 57.5% of the time.
    const position = order();
    const book_ = book([[0.44, 100]]);
    const state = ledger();
    executePaperStandaloneExit(position, decision(0.50), state, book_, NOW);
    expect(position.status).toBe('open');
    expect(position.quantity).toBe(2);
    expect(position.settledAt).toBeUndefined();
    expect(position.reason).toContain('no fill');
    expect((state as never as { paperBudget: { availableCents: number } }).paperBudget.availableCents).toBe(1_000);
  });

  it('still records the attempt, so neither track automatically retries', () => {
    const position = order();
    executePaperStandaloneExit(position, decision(0.50), ledger(), book([[0.44, 100]]), NOW);
    expect(position.standaloneExitAttemptedAt).toBe(new Date(NOW).toISOString());
    expect(position.standaloneExitPolicy).toBe('strict-value-v1');
    expect(position.paperExitFillVersion).toBe(PAPER_EXIT_FILL_VERSION);
    expect(position.paperExitDisplayedAtLimit).toBe(0);
  });

  it('sells the whole position when displayed depth covers it, paying the taker fee', () => {
    const position = order();
    const state = ledger();
    executePaperStandaloneExit(position, decision(0.50), state, book([[0.55, 10]]), NOW);
    expect(position.status).toBe('sold');
    expect(position.exitPrice).toBeCloseTo(0.55, 12);
    // 2 contracts at 55c = 110c gross. An IOC sell lifts a resting bid, so it is charged the taker
    // schedule: ceil(100 * 2 * 0.07 * 0.55 * 0.45) = 4c.
    expect(position.exitFeeCents).toBe(4);
    expect(position.saleProceedsCents).toBeCloseTo(106, 9);
    expect(position.actualPnlCents).toBeCloseTo(16, 9);
    const budget = (state as never as { paperBudget: { availableCents: number; realizedPnlCents: number } }).paperBudget;
    expect(budget.availableCents).toBe(1_106);
    expect(budget.realizedPnlCents).toBe(16);
  });

  it('walks the ladder rather than assuming the whole size clears at the touch', () => {
    const position = order();
    executePaperStandaloneExit(position, decision(0.50), ledger(), book([[0.60, 1], [0.52, 5]]), NOW);
    // 1 at 60c + 1 at 52c = 112c, not 2 at 60c.
    expect(position.status).toBe('sold');
    expect(position.exitPrice).toBeCloseTo(0.56, 12);
  });

  it('splits a partial fill into a sold row and a retained remainder, like live does', () => {
    const position = order();
    const state = ledger();
    executePaperStandaloneExit(position, decision(0.50), state, book([[0.55, 0.5]]), NOW);
    const orders = (state as never as { orders: PaperOrder[] }).orders;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'sold', quantity: 0.5 });
    expect(orders[0].id).toContain(':exit:');
    // The remainder keeps riding and is not retried.
    expect(position.status).toBe('open');
    expect(position.quantity).toBeCloseTo(1.5, 9);
    expect(position.reason).toContain('partially');
    // Stake splits with the position: nothing is created or destroyed by the partial.
    expect(orders[0].stakeCents + position.stakeCents).toBe(90);
  });

  it('refuses to sell below the exit limit even when deep liquidity sits just under it', () => {
    const position = order();
    executePaperStandaloneExit(position, decision(0.50), ledger(), book([[0.49, 1_000]]), NOW);
    expect(position.status).toBe('open');
  });

  it('defers rather than recording a fill miss when no order book is available', () => {
    // An absent book is not an empty book. Classifying it as a no-fill would understate paper's exit
    // completion rate, and because `standaloneExitAttemptedAt` permanently disables retry it would
    // strand the position with exits switched off for the rest of the window.
    const position = order();
    const state = ledger();
    executePaperStandaloneExit(position, decision(0.50), state, undefined, NOW);
    expect(position.status).toBe('open');
    expect(position.standaloneExitAttemptedAt).toBeUndefined();
    expect(position.paperExitFillVersion).toBeUndefined();
    expect(position.reason).toContain('deferred');
    expect((state as never as { orders: PaperOrder[] }).orders).toHaveLength(0);
  });

  it('reads the correct ladder for a DOWN position', () => {
    const position = order({ side: 'DOWN' });
    // NO bids are the DOWN side's own bids; the deep YES ladder must not be sold into.
    executePaperStandaloneExit(position, decision(0.25), ledger(), book([[0.90, 500]]), NOW);
    expect(position.status).toBe('sold');
    expect(position.exitPrice).toBeCloseTo(0.30, 12);
  });
});
