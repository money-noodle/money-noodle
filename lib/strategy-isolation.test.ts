import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { orderStrategyId, strategyOrders } from './execution-report';
import { makerCohortEvidence } from './entry-execution-policy';
import { evaluateLiveRisk, lifetimeLiveRealizedPnlCents } from './live-risk-policy';
import { countFilledLiveVenueOrders } from './order-rate-limit';
import { DEFAULT_STRATEGY_ID, EDGE_BINARY_BUY, LONG_SHOT_ROUND_TRIP, isStrategyId, normalizeStrategyId, strategyDescriptor } from './strategy-registry';
import type { BudgetControl, PaperOrder } from './types';

/**
 * SPEC §12.10: two strategies share one venue account and one order ledger, and must not share money.
 *
 * The ledger is deliberately not split into two files, because reconciliation is an account-wide concern:
 * a separate file would leave real resting orders unmatched and fail closed. The cost of that choice is
 * that every money aggregation has to re-narrow by strategy, and forgetting one is silent — long-shot
 * losses would trip the edge policy's breaker, or long-shot gains would mask edge losses, which is worse.
 * These tests pin the boundary in both directions.
 */
const order = (id: string, pnl: number, patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id, executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: 'TEST', side: 'UP',
  status: pnl >= 0 ? 'won' : 'lost',
  createdAt: '2026-08-15T00:00:00Z', calculationAt: '2026-08-15T00:00:00Z', closesAt: '2026-08-15T00:15:00Z',
  modelProbabilityUp: 0.6, confidence: 0.6, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
  quantity: 1, stakeCents: 40, feeCents: 1, potentialPayoutCents: 100, actualPnlCents: pnl, ...patch,
});

const control = (patch: Partial<BudgetControl> = {}): BudgetControl => ({
  revision: 1, state: 'active', mode: 'live', startingBudgetCents: 2_000,
  availableBudgetCents: 2_000, reservedBudgetCents: 0, realizedPnlCents: 0,
  perTradeCents: 200, purchasePercent: 10, enabledVenues: ['kalshi'],
  operatorIntent: 'active', updatedAt: '2026-08-15T00:00:00Z', ...patch,
});

const environment = {
  MONEY_NOODLE_MAX_CURRENT_EPOCH_DRAWDOWN_PERCENT: '25',
  MONEY_NOODLE_MAX_LIFETIME_LIVE_LOSS_CENTS: '50',
} as unknown as NodeJS.ProcessEnv;

describe('strategy registry', () => {
  it('attributes every pre-existing record to the strategy that wrote it', () => {
    // Every order in the ledger up to 2026-08-15 came from the edge policy, which was the only thing
    // trading, so an absent field is unambiguous rather than a guess.
    expect(DEFAULT_STRATEGY_ID).toBe(EDGE_BINARY_BUY);
    expect(normalizeStrategyId(undefined)).toBe(EDGE_BINARY_BUY);
    expect(orderStrategyId(order('legacy', -10))).toBe(EDGE_BINARY_BUY);
    expect(orderStrategyId(order('new', -10, { strategyId: LONG_SHOT_ROUND_TRIP }))).toBe(LONG_SHOT_ROUND_TRIP);
  });

  it('refuses to silently attribute an unknown id to the incumbent strategy', () => {
    expect(isStrategyId('long-shot-round-trip')).toBe(true);
    expect(isStrategyId('something-else')).toBe(false);
    expect(() => strategyDescriptor('something-else' as never)).toThrow();
  });

  it('describes the long-shot policy as taking no model probability', () => {
    expect(strategyDescriptor(LONG_SHOT_ROUND_TRIP).signalSource).toBe('venue-price');
    expect(strategyDescriptor(EDGE_BINARY_BUY).signalSource).toBe('model-probability');
  });
});

describe('money never crosses the strategy boundary', () => {
  const mixed = [
    order('edge-1', -30),
    order('edge-2', -25),
    order('shot-1', -400, { strategyId: LONG_SHOT_ROUND_TRIP }),
    order('shot-2', 900, { strategyId: LONG_SHOT_ROUND_TRIP }),
  ];

  it('keeps each strategy lifetime P&L to its own orders', () => {
    expect(lifetimeLiveRealizedPnlCents(mixed)).toBe(-55);
    expect(lifetimeLiveRealizedPnlCents(mixed, LONG_SHOT_ROUND_TRIP)).toBe(500);
  });

  it('does not let a long-shot drawdown trip the edge policy breaker', () => {
    // The 400c long-shot loss is more than eight times the 50c lifetime stop. Blended, it would pause a
    // strategy that has done nothing wrong.
    const risk = evaluateLiveRisk(control(), mixed, environment);
    expect(risk.lifetimeLossCents).toBe(55);
    expect(risk.allowed).toBe(false);
    expect(risk.reasons.join(' ')).toContain('Lifetime live loss 55.00c');
  });

  it('does not let long-shot gains mask an edge policy breach, which is the worse direction', () => {
    const edgeLosses = [order('edge-1', -60), order('shot-win', 5_000, { strategyId: LONG_SHOT_ROUND_TRIP })];
    expect(lifetimeLiveRealizedPnlCents(edgeLosses)).toBe(-60);
    expect(evaluateLiveRisk(control(), edgeLosses, environment).allowed).toBe(false);
  });

  it('splits a mixed ledger cleanly and loses nothing', () => {
    const edge = strategyOrders(mixed, EDGE_BINARY_BUY);
    const longShot = strategyOrders(mixed, LONG_SHOT_ROUND_TRIP);
    expect(edge).toHaveLength(2);
    expect(longShot).toHaveLength(2);
    expect(edge.length + longShot.length).toBe(mixed.length);
  });

  it('keeps the maker fill cohort from pooling two different executions in one price band', () => {
    // Both policies trade cheap contracts, so they land in the same band. A resting limit at a fixed mark
    // and a repriced managed maker are not comparable attempts.
    const attempts = [
      order('edge-fill', 0, { askPrice: 0.10, spread: 0.01, venueOrderId: 'v1', filledCount: 1 }),
      order('edge-miss', 0, { askPrice: 0.10, spread: 0.01, venueOrderId: 'v2', filledCount: 0 }),
      order('shot-a', 0, { askPrice: 0.10, spread: 0.01, venueOrderId: 'v3', filledCount: 1, strategyId: LONG_SHOT_ROUND_TRIP }),
      order('shot-b', 0, { askPrice: 0.10, spread: 0.01, venueOrderId: 'v4', filledCount: 1, strategyId: LONG_SHOT_ROUND_TRIP }),
    ];
    expect(makerCohortEvidence(attempts, 0.10, 0.01)).toMatchObject({ accepted: 2, fills: 1, fillRate: 0.5 });
    expect(makerCohortEvidence(attempts, 0.10, 0.01, LONG_SHOT_ROUND_TRIP)).toMatchObject({ accepted: 2, fills: 2, fillRate: 1 });
  });
});

describe('the paper bankroll belongs to the edge policy alone', () => {
  it('is a counter, unlike live cash, so another strategy must not credit into it', () => {
    // Live cash is one real Kalshi balance and settles through the shared control whatever spent it. The
    // paper bankroll is the edge policy's own number: crediting a long-shot payout into it would inflate
    // the edge policy's paper equity and its published track record. Other strategies derive their paper
    // equity from their own orders instead, so there is nothing to credit.
    const source = readFileSync(new URL('./paper-execution.ts', import.meta.url), 'utf8');
    const settlement = source.slice(source.indexOf('async function settleDueOrders'), source.indexOf('async function updateSoldCounterfactuals'));
    expect(settlement).toContain('orderStrategyId(order) === EDGE_BINARY_BUY');
    // The guard must sit on the branch that mutates the bankroll, not merely appear somewhere nearby.
    const guardIndex = settlement.indexOf('orderStrategyId(order) === EDGE_BINARY_BUY');
    expect(settlement.indexOf('paperBudget.availableCents +=')).toBeGreaterThan(guardIndex);
  });
});

describe('account-wide limits deliberately do not scope by strategy', () => {
  it('counts both strategies against the shared venue order ceiling', () => {
    // The hourly ceiling is a property of the Kalshi account, not of a policy. Scoping it per strategy
    // would let two strategies each spend a full allowance of the same real limit.
    const filled = [
      order('edge', 0, { venueOrderId: 'v1', filledCount: 1 }),
      order('shot', 0, { venueOrderId: 'v2', filledCount: 1, strategyId: LONG_SHOT_ROUND_TRIP }),
    ];
    expect(countFilledLiveVenueOrders(filled, Date.parse('2026-08-14T00:00:00Z'))).toBe(2);
  });
});
