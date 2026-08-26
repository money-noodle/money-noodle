import { drawdownReferenceCents } from './budget-ledger';
import { epochResults, orderEpochId } from './budget-epoch';
import type { BudgetControl, PaperOrder } from './types';

/**
 * Whether the per-trade stake may be raised. Evaluation only: nothing here changes a limit. Stake
 * increases stay a manual, audited act, in the same spirit as model promotion — the point is that the
 * decision is made against stated criteria rather than against a good week.
 *
 * The bar is deliberately the project's own evidence standard rather than a softer one. Returns are
 * clustered by settlement window because correlated assets in one window are a single bet, and the mean
 * must clear two standard errors, which is the same test applied to segments and maker cohorts. At the
 * roughly 98-percentage-point per-window spread observed on this book, that bar is hard to clear by luck.
 */

export const DEFAULT_MIN_SETTLED_WINDOWS = 30;
export const DEFAULT_MAX_DRAWDOWN_PERCENT = 10;
export const DEFAULT_EXPANSION_FACTOR = 1.5;

export interface StakeExpansionCriterion {
  id: 'window-evidence' | 'positive-clustered-return' | 'drawdown-from-peak' | 'lifetime-not-negative' | 'automation-healthy';
  met: boolean;
  detail: string;
}

export interface StakeExpansionAssessment {
  eligible: boolean;
  criteria: StakeExpansionCriterion[];
  currentPerTradeCents: number;
  /** What the cap would become if the operator chose to expand. Never applied automatically. */
  proposedPerTradeCents: number;
  epochId: string;
  settledWindows: number;
  meanWindowReturn: number | null;
  standardError: number | null;
  drawdownPercent: number;
  lifetimeRealizedPnlCents: number;
}

const settledStatuses = new Set(['won', 'lost', 'invalid', 'sold']);
const pnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const stake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents ?? 0;

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Per-settlement-window returns for one epoch, which is the independent unit for this book. */
function windowReturns(orders: PaperOrder[], epochId: string): number[] {
  const rows = orders.filter((order) => order.executionMode === 'live'
    && orderEpochId(order) === epochId && settledStatuses.has(order.status));
  const byWindow = new Map<string, PaperOrder[]>();
  for (const order of rows) byWindow.set(order.closesAt, [...(byWindow.get(order.closesAt) ?? []), order]);
  return [...byWindow.values()].map((group) =>
    group.reduce((sum, order) => sum + pnl(order), 0) / Math.max(1, group.reduce((sum, order) => sum + stake(order), 0)));
}

export function evaluateStakeExpansion(
  control: BudgetControl,
  orders: PaperOrder[],
  environment: NodeJS.ProcessEnv = process.env,
): StakeExpansionAssessment {
  const minWindows = bounded(environment.MONEY_NOODLE_STAKE_EXPANSION_MIN_WINDOWS, DEFAULT_MIN_SETTLED_WINDOWS, 10, 1_000);
  const maxDrawdownPercent = bounded(environment.MONEY_NOODLE_STAKE_EXPANSION_MAX_DRAWDOWN_PERCENT, DEFAULT_MAX_DRAWDOWN_PERCENT, 1, 50);
  const factor = bounded(environment.MONEY_NOODLE_STAKE_EXPANSION_FACTOR, DEFAULT_EXPANSION_FACTOR, 1.01, 3);

  const epochId = control.epochId ?? 'legacy-pre-epoch';
  const returns = windowReturns(orders, epochId);
  const settledWindows = returns.length;
  const mean = settledWindows ? returns.reduce((sum, value) => sum + value, 0) / settledWindows : null;
  const standardError = settledWindows > 1 && mean !== null
    ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (settledWindows - 1) / settledWindows)
    : null;

  const equity = control.availableBudgetCents + control.reservedBudgetCents;
  const reference = drawdownReferenceCents(control);
  const drawdownPercent = reference > 0 ? Math.max(0, (reference - equity) / reference) * 100 : 0;
  const lifetime = epochResults(orders, 'live').reduce((sum, epoch) => sum + epoch.realizedPnlCents, 0);

  const criteria: StakeExpansionCriterion[] = [
    {
      id: 'window-evidence', met: settledWindows >= minWindows,
      detail: `${settledWindows}/${minWindows} settled settlement windows in the current epoch.`,
    },
    {
      id: 'positive-clustered-return',
      met: mean !== null && standardError !== null && mean > 0 && mean > 2 * standardError,
      detail: mean === null || standardError === null
        ? 'Not enough settled windows to estimate a clustered return.'
        : `Mean window return ${(mean * 100).toFixed(1)}% ±${(standardError * 100).toFixed(1)}; must be positive and clear two standard errors.`,
    },
    {
      id: 'drawdown-from-peak', met: drawdownPercent <= maxDrawdownPercent,
      detail: `Drawdown from peak equity ${drawdownPercent.toFixed(1)}%, limit ${maxDrawdownPercent.toFixed(1)}%.`,
    },
    {
      id: 'lifetime-not-negative', met: lifetime >= 0,
      detail: `Lifetime live realized P&L ${(lifetime / 100).toFixed(2)} dollars across every epoch.`,
    },
    {
      id: 'automation-healthy', met: control.state === 'active' || control.state === 'paused',
      detail: `Automation state ${control.state}; a depleted or unconfigured budget may never expand.`,
    },
  ];

  const eligible = criteria.every((criterion) => criterion.met);
  return {
    eligible, criteria,
    currentPerTradeCents: control.perTradeCents,
    // Reported whether or not eligible, so the operator can see what a qualifying expansion would be.
    proposedPerTradeCents: Math.max(control.perTradeCents, Math.floor(control.perTradeCents * factor)),
    epochId, settledWindows, meanWindowReturn: mean, standardError, drawdownPercent,
    lifetimeRealizedPnlCents: lifetime,
  };
}
