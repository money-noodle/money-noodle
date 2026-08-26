import type { BudgetControl, PaperOrder } from './types';

/**
 * Orders written before epochs existed. They are attributed to a single named epoch rather than to the
 * current one, because folding them into the live epoch would credit past results to a budget that never
 * funded them — the precise error that made reconstructed history disagree with the control record.
 */
export const LEGACY_BUDGET_EPOCH_ID = 'legacy-pre-epoch';

/**
 * Paper orders written before the bankroll had fundings of its own.
 *
 * Every one of them belongs to the original bankroll, because paper has never been reset — so naming
 * that funding is exact rather than a guess. Many of these records carry a `budgetEpochId` copied
 * from the live control, which never funded them; that stamp is ignored for paper and left in place,
 * because order records are evidence and are never rewritten.
 */
export const LEGACY_PAPER_BANKROLL_ID = 'paper-original';

export interface EpochResult {
  epochId: string;
  trades: number;
  settled: number;
  /**
   * Exact realized P&L, the reporting view. Load-bearing: `stake-expansion-policy` reads it, so its
   * definition must not drift without that gate being re-evidenced.
   */
  realizedPnlCents: number;
  /**
   * The same result in the whole cents the budget counters actually move in. This is the figure that
   * reconciles with a funding's starting balance and equity; the two differ by roughly 231c across
   * live's lifetime because a sold exit prices the exact view from a fractional net liquidation.
   */
  budgetPnlCents: number;
  stakedCents: number;
  firstAt?: string;
  lastAt?: string;
  /** True for the epoch the control is currently in; every other epoch is closed and immutable. */
  current: boolean;
}

const settledStatuses = new Set(['won', 'lost', 'invalid', 'sold']);
const pnl = (order: PaperOrder) => order.actualPnlCents ?? order.pnlCents ?? 0;
const stake = (order: PaperOrder) => order.actualStakeCents ?? order.stakeCents ?? 0;

/**
 * Which funding bought this order.
 *
 * Mode-aware because the two budgets are opened by different acts: live's by reconfiguring the trading
 * control, paper's by resetting the bankroll. Reading live's epoch for a paper order — which is what the
 * ledger did until 2026-08-17 — attributes a simulated result to a real funding that never paid for it.
 */
export function orderEpochId(order: PaperOrder): string {
  return order.executionMode === 'paper'
    ? order.paperBankrollId ?? LEGACY_PAPER_BANKROLL_ID
    : order.budgetEpochId ?? LEGACY_BUDGET_EPOCH_ID;
}

/** Mints the identity for a reconfiguration. Sequence increments so epochs order without timestamps. */
export function nextBudgetEpoch(previous: Pick<BudgetControl, 'epochSequence'>, now = new Date().toISOString()): {
  epochId: string; epochSequence: number; epochStartedAt: string;
} {
  const epochSequence = (previous.epochSequence ?? 0) + 1;
  return { epochId: `epoch-${epochSequence}-${now}`, epochSequence, epochStartedAt: now };
}

/**
 * Mints the identity for a paper bankroll reset. Namespaced apart from live's `epoch-` ids so the two can
 * never be confused in a stored record, and sequenced so fundings order without relying on timestamps.
 */
export function nextPaperBankrollFunding(previous: { fundingSequence?: number }, now = new Date().toISOString()): {
  fundingId: string; fundingSequence: number; startedAt: string;
} {
  const fundingSequence = (previous.fundingSequence ?? 1) + 1;
  return { fundingId: `paper-${fundingSequence}-${now}`, fundingSequence, startedAt: now };
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
      budgetPnlCents: settled.reduce((sum, order) => sum + (order.pnlCents ?? 0), 0),
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
