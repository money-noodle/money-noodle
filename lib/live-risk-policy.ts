import type { BudgetControl, LiveRiskStatus, PaperOrder } from './types';

export const DEFAULT_MAX_CURRENT_EPOCH_DRAWDOWN_PERCENT = 25;
export const DEFAULT_MAX_LIFETIME_LIVE_LOSS_CENTS = 50;

export interface LiveRiskLimits {
  maximumCurrentEpochDrawdownCents: number;
  maximumCurrentEpochDrawdownPercent: number;
  maximumLifetimeLossCents: number;
}

function boundedPositive(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, parsed) : fallback;
}

export function liveRiskLimits(startingBudgetCents: number, environment: NodeJS.ProcessEnv = process.env): LiveRiskLimits {
  const maximumCurrentEpochDrawdownPercent = boundedPositive(
    environment.MONEY_NOODLE_MAX_CURRENT_EPOCH_DRAWDOWN_PERCENT,
    DEFAULT_MAX_CURRENT_EPOCH_DRAWDOWN_PERCENT,
    100,
  );
  const maximumCurrentEpochDrawdownCents = Math.max(1, Math.floor(startingBudgetCents * maximumCurrentEpochDrawdownPercent / 100));
  const maximumLifetimeLossCents = boundedPositive(
    environment.MONEY_NOODLE_MAX_LIFETIME_LIVE_LOSS_CENTS,
    DEFAULT_MAX_LIFETIME_LIVE_LOSS_CENTS,
    1_000_000,
  );
  return { maximumCurrentEpochDrawdownCents, maximumCurrentEpochDrawdownPercent, maximumLifetimeLossCents };
}

export function lifetimeLiveRealizedPnlCents(orders: PaperOrder[]): number {
  return orders
    .filter((order) => order.executionMode === 'live' && ['won', 'lost', 'sold', 'invalid'].includes(order.status))
    .reduce((sum, order) => sum + (order.actualPnlCents ?? order.pnlCents ?? 0), 0);
}

/**
 * Loss limits are evaluated independently against the configured budget period and the immutable
 * lifetime execution ledger. Reconfiguring the budget may reset period presentation, but cannot
 * erase the lifetime stop.
 */
export function evaluateLiveRisk(control: BudgetControl, orders: PaperOrder[], environment: NodeJS.ProcessEnv = process.env): LiveRiskStatus {
  const limits = liveRiskLimits(control.startingBudgetCents, environment);
  const currentEquityCents = control.availableBudgetCents + control.reservedBudgetCents;
  const currentEpochDrawdownCents = Math.max(0, control.startingBudgetCents - currentEquityCents);
  const lifetimeRealizedPnlCents = lifetimeLiveRealizedPnlCents(orders);
  const lifetimeLossCents = Math.max(0, -lifetimeRealizedPnlCents);
  const reasons: string[] = [];
  if (currentEpochDrawdownCents >= limits.maximumCurrentEpochDrawdownCents) {
    reasons.push(`Current live budget drawdown ${currentEpochDrawdownCents.toFixed(2)}c reached the ${limits.maximumCurrentEpochDrawdownCents.toFixed(2)}c (${limits.maximumCurrentEpochDrawdownPercent.toFixed(1)}%) stop.`);
  }
  if (lifetimeLossCents >= limits.maximumLifetimeLossCents) {
    reasons.push(`Lifetime live loss ${lifetimeLossCents.toFixed(2)}c reached the ${limits.maximumLifetimeLossCents.toFixed(2)}c stop.`);
  }
  return {
    ...limits, allowed: reasons.length === 0, currentEpochDrawdownCents,
    lifetimeRealizedPnlCents, lifetimeLossCents, reasons,
  };
}
