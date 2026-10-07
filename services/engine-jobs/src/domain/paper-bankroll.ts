// The paper bankroll's realized P&L recomputed from its orders and its three
// correction classes. Ported from the v1 archive's paper-execution module
// (`correctedPaperPnlCents`) and budget-epoch module (funding scoping),
// sanitized. The three classes relate to the order-derived figure differently,
// and keeping them apart is the whole reason they exist:
//
// - maker-fee corrections returned taker fees charged on paper maker fills; the
//   fee is still inside the orders' `pnlCents`, so the figure must add them back;
// - strategy-leak corrections removed another strategy's payouts wrongly credited
//   to this bankroll; the orders already exclude them, so adding them would count
//   them twice;
// - reconciliation corrections adjust the bankroll's own counters out of band and
//   are likewise not part of the order-derived realized figure.

import type { BankrollCorrection, LedgerOrder, PaperBudget } from './ledger-v9.js';

export const LEGACY_PAPER_BANKROLL_ID = 'paper-original';

const SETTLED = new Set(['won', 'lost', 'invalid', 'sold', 'exited', 'settled']);

export function paperFundingId(order: LedgerOrder): string {
  return order.paperBankrollId ?? LEGACY_PAPER_BANKROLL_ID;
}

export function isSettledPaperOrder(order: LedgerOrder): boolean {
  return (
    order.executionMode === 'paper' && (SETTLED.has(order.status) || order.pnlCents !== undefined)
  );
}

export interface BankrollRecomputation {
  fundingId: string;
  settledOrders: number;
  orderPnlCents: number;
  makerFeeCorrectionCents: number;
  strategyLeakCorrectionCents: number;
  reconciliationCorrectionCents: number;
  recomputedRealizedPnlCents: number;
  restoredRealizedPnlCents: number;
  discrepancyCents: number;
}

const sum = (entries: readonly BankrollCorrection[] | undefined, since?: string) =>
  (entries ?? [])
    .filter((entry) => !since || entry.at >= since)
    .reduce((total, entry) => total + entry.realizedPnlCents, 0);

export function recomputePaperBankroll(
  orders: readonly LedgerOrder[],
  budget: PaperBudget,
): BankrollRecomputation {
  const fundingId = budget.fundingId ?? LEGACY_PAPER_BANKROLL_ID;
  const since = budget.startedAt;
  const settled = orders.filter(
    (order) => isSettledPaperOrder(order) && paperFundingId(order) === fundingId,
  );
  const orderPnlCents = settled.reduce((total, order) => total + (order.pnlCents ?? 0), 0);
  const makerFeeCorrectionCents = sum(budget.makerFeeCorrections, since);
  const strategyLeakCorrectionCents = sum(budget.strategyLeakCorrections, since);
  const reconciliationCorrectionCents = sum(budget.reconciliationCorrections, since);
  const recomputedRealizedPnlCents = orderPnlCents + makerFeeCorrectionCents;
  return {
    fundingId,
    settledOrders: settled.length,
    orderPnlCents,
    makerFeeCorrectionCents,
    strategyLeakCorrectionCents,
    reconciliationCorrectionCents,
    recomputedRealizedPnlCents,
    restoredRealizedPnlCents: budget.realizedPnlCents,
    discrepancyCents: recomputedRealizedPnlCents - budget.realizedPnlCents,
  };
}
