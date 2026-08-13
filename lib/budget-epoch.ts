import type { BudgetControl, PaperOrder } from './types';

/**
 * Orders written before epochs existed. They are attributed to a single named epoch rather than to the
 * current one, because folding them into the live epoch would credit past results to a budget that never
 * funded them — the precise error that made reconstructed history disagree with the control record.
 */
export const LEGACY_BUDGET_EPOCH_ID = 'legacy-pre-epoch';

export interface EpochResult {
  epochId: string;
  trades: number;
  settled: number;
  realizedPnlCents: number;
  stakedCents: number;
  firstAt?: string;
  lastAt?: string;
  /** True for the epoch the control is currently in; every other epoch is closed and immutable. */
  current: boolean;
}

const settledStatuses = new Set(['won', 'lost', 'invalid', 'sold']);
const pnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const stake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents ?? 0;

export function orderEpochId(order: PaperOrder): string {
  return order.budgetEpochId ?? LEGACY_BUDGET_EPOCH_ID;
}

/** Mints the identity for a reconfiguration. Sequence increments so epochs order without timestamps. */
export function nextBudgetEpoch(previous: Pick<BudgetControl, 'epochSequence'>, now = new Date().toISOString()): {
  epochId: string; epochSequence: number; epochStartedAt: string;
} {
  const epochSequence = (previous.epochSequence ?? 0) + 1;
  return { epochId: `epoch-${epochSequence}-${now}`, epochSequence, epochStartedAt: now };
}

/**
 * Realized results per epoch for one execution mode. Closed epochs are reported separately from the
 * current one so a reconfiguration restarts current-epoch P&L without erasing what came before.
 */
export function epochResults(orders: PaperOrder[], mode: PaperOrder['executionMode'], currentEpochId?: string): EpochResult[] {
  const groups = new Map<string, PaperOrder[]>();
  for (const order of orders.filter((item) => item.executionMode === mode)) {
    const id = orderEpochId(order);
    groups.set(id, [...(groups.get(id) ?? []), order]);
  }
  return [...groups.entries()].map(([epochId, rows]) => {
    const settled = rows.filter((order) => settledStatuses.has(order.status));
    const times = rows.map((order) => order.createdAt).filter(Boolean).sort();
    return {
      epochId,
      trades: rows.length,
      settled: settled.length,
      realizedPnlCents: settled.reduce((sum, order) => sum + pnl(order), 0),
      stakedCents: settled.reduce((sum, order) => sum + stake(order), 0),
      firstAt: times[0],
      lastAt: times.at(-1),
      current: epochId === currentEpochId,
    };
  }).sort((a, b) => (a.firstAt ?? '').localeCompare(b.firstAt ?? ''));
}

/** Lifetime realized P&L across every epoch, which no reconfiguration may reset. */
export function lifetimeRealizedPnlCents(orders: PaperOrder[], mode: PaperOrder['executionMode']): number {
  return epochResults(orders, mode).reduce((sum, epoch) => sum + epoch.realizedPnlCents, 0);
}
