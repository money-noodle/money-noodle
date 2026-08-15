import { drawdownReferenceCents } from './budget-ledger';
import { DEFAULT_STRATEGY_ID, STRATEGIES, normalizeStrategyId } from './strategy-registry';
import type { BudgetControl, LiveRiskStatus, PaperOrder, StrategyId } from './types';

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


/**
 * Current-epoch realized P&L per strategy.
 *
 * Reported beside the drawdown so the stop can be read honestly. The drawdown itself stays blended: one
 * pot of cash means one strategy's losses really do reduce the capital available to all of them, and a
 * capital-preservation stop that ignored that would not be preserving capital.
 */
export function currentEpochAttribution(orders: PaperOrder[], epochId: string | undefined): Array<{ strategyId: StrategyId; realizedPnlCents: number }> {
  const settled = orders.filter((order) => order.executionMode === 'live'
    && ['won', 'lost', 'sold', 'invalid'].includes(order.status)
    && (epochId === undefined || order.budgetEpochId === epochId));
  return STRATEGIES.map((strategy) => ({
    strategyId: strategy.id,
    realizedPnlCents: settled
      .filter((order) => normalizeStrategyId(order.strategyId) === strategy.id)
      .reduce((sum, order) => sum + (order.actualPnlCents ?? order.pnlCents ?? 0), 0),
  })).filter((entry) => entry.realizedPnlCents !== 0);
}

/**
 * Scoped to one strategy. A second strategy shares the venue account but not this breaker: blending them
 * would let one strategy's losses stop the other, and would let one strategy's gains mask the other's
 * losses, which is the more dangerous direction. Every order written before strategies were explicit
 * belongs to the edge policy, so the default preserves the existing lifetime figure exactly.
 */
export function lifetimeLiveRealizedPnlCents(orders: PaperOrder[], strategyId: StrategyId = DEFAULT_STRATEGY_ID): number {
  return orders
    .filter((order) => order.executionMode === 'live' && normalizeStrategyId(order.strategyId) === strategyId
      && ['won', 'lost', 'sold', 'invalid'].includes(order.status))
    .reduce((sum, order) => sum + (order.actualPnlCents ?? order.pnlCents ?? 0), 0);
}

/**
 * Loss limits are evaluated independently against the configured budget period and the immutable
 * lifetime execution ledger. Reconfiguring the budget may reset period presentation, but cannot
 * erase the lifetime stop.
 */
export function evaluateLiveRisk(
  control: BudgetControl, orders: PaperOrder[], environment: NodeJS.ProcessEnv = process.env,
  strategyId: StrategyId = DEFAULT_STRATEGY_ID,
): LiveRiskStatus {
  const limits = liveRiskLimits(control.startingBudgetCents, environment);
  const currentEquityCents = control.availableBudgetCents + control.reservedBudgetCents;
  // Measured from the epoch's peak equity, not the funded amount. Measuring from `starting` meant a run-up
  // masked a subsequent fall: fund 2000c, reach 3000c, drop to 2200c, and the old figure was 0 while the
  // real drawdown was 800c — so the stop could not fire after a gain, which is when the most is at risk.
  // The reference never goes below `startingBudgetCents`, so this can only tighten the stop, never loosen it.
  const currentEpochDrawdownCents = Math.max(0, drawdownReferenceCents(control) - currentEquityCents);
  const lifetimeRealizedPnlCents = lifetimeLiveRealizedPnlCents(orders, strategyId);
  const lifetimeLossCents = Math.max(0, -lifetimeRealizedPnlCents);
  const reasons: string[] = [];
  const attribution = currentEpochAttribution(orders, control.epochId);
  if (currentEpochDrawdownCents >= limits.maximumCurrentEpochDrawdownCents) {
    // Named account-wide, and attributed. Blended is correct for a capital stop, but the previous wording
    // read as though the strategy being blocked had caused it, which is not something the figure knows.
    const split = attribution.length > 1
      ? ` Account-wide across every strategy this epoch: ${attribution.map((entry) => `${entry.strategyId} ${entry.realizedPnlCents.toFixed(2)}c`).join(', ')}.`
      : '';
    reasons.push(`Account live drawdown ${currentEpochDrawdownCents.toFixed(2)}c reached the ${limits.maximumCurrentEpochDrawdownCents.toFixed(2)}c (${limits.maximumCurrentEpochDrawdownPercent.toFixed(1)}%) stop.${split}`);
  }
  if (lifetimeLossCents >= limits.maximumLifetimeLossCents) {
    reasons.push(`Lifetime live loss ${lifetimeLossCents.toFixed(2)}c reached the ${limits.maximumLifetimeLossCents.toFixed(2)}c stop.`);
  }
  return {
    ...limits, allowed: reasons.length === 0, currentEpochDrawdownCents,
    lifetimeRealizedPnlCents, lifetimeLossCents, currentEpochAttribution: attribution, reasons,
  };
}
