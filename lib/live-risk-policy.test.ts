import { describe, expect, it } from 'vitest';
import { evaluateLiveRisk, lifetimeLiveRealizedPnlCents, liveRiskLimits } from './live-risk-policy';
import type { BudgetControl, PaperOrder } from './types';

const control = (patch: Partial<BudgetControl> = {}): BudgetControl => ({
  revision: 1, state: 'paused', mode: 'live', startingBudgetCents: 40,
  availableBudgetCents: 20, reservedBudgetCents: 10, realizedPnlCents: -10,
  perTradeCents: 10, purchasePercent: 1, enabledVenues: ['kalshi'],
  operatorIntent: 'paused', updatedAt: '2026-01-01T00:00:00Z', ...patch,
});

const order = (id: string, pnl: number, patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id, executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: 'TEST', side: 'UP', status: pnl >= 0 ? 'won' : 'lost',
  createdAt: '2026-01-01T00:00:00Z', calculationAt: '2026-01-01T00:00:00Z', closesAt: '2026-01-01T00:15:00Z',
  modelProbabilityUp: 0.6, confidence: 0.6, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
  quantity: 1, stakeCents: 40, feeCents: 1, potentialPayoutCents: 100, actualPnlCents: pnl, ...patch,
});

const environment = {
  MONEY_NOODLE_MAX_CURRENT_EPOCH_DRAWDOWN_PERCENT: '25',
  MONEY_NOODLE_MAX_LIFETIME_LIVE_LOSS_CENTS: '50',
} as unknown as NodeJS.ProcessEnv;

describe('live loss circuit breaker', () => {
  it('uses a proportional current-period stop and an absolute lifetime stop', () => {
    expect(liveRiskLimits(40, environment)).toEqual({
      maximumCurrentEpochDrawdownCents: 10,
      maximumCurrentEpochDrawdownPercent: 25,
      maximumLifetimeLossCents: 50,
    });
  });

  it('stops at the current-period boundary even while stake remains reserved', () => {
    const result = evaluateLiveRisk(control(), [], environment);
    expect(result.allowed).toBe(false);
    expect(result.currentEpochDrawdownCents).toBe(10);
    // Named account-wide rather than "current live budget": the drawdown is blended across strategies,
    // and the old wording read as though the strategy being blocked had caused it.
    expect(result.reasons[0]).toContain('Account live drawdown');
  });

  it('preserves lifetime evidence independently of budget reconfiguration', () => {
    const orders = [order('a', -30), order('b', -25), order('paper', 500, { executionMode: 'paper' })];
    expect(lifetimeLiveRealizedPnlCents(orders)).toBe(-55);
    const result = evaluateLiveRisk(control({ startingBudgetCents: 100, availableBudgetCents: 100, reservedBudgetCents: 0, realizedPnlCents: 0 }), orders, environment);
    expect(result.currentEpochDrawdownCents).toBe(0);
    expect(result.lifetimeLossCents).toBe(55);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('Lifetime live loss');
  });

  it('allows live execution only while both limits remain clear', () => {
    const result = evaluateLiveRisk(
      control({ startingBudgetCents: 100, availableBudgetCents: 85, reservedBudgetCents: 0, realizedPnlCents: -15 }),
      [order('a', -20)], environment,
    );
    expect(result.allowed).toBe(true);
  });
});
