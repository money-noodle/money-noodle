// The paper bankroll's realized P&L recomputed from its orders and its three
// correction classes, and the cross-check that its two counters agree with each
// other.
//
// The authoritative rule is the one the v1 archive's paper-bankroll drift
// correction script applied on 2026-08-17 — the run that made the counter
// reconcile — not the wider reading of `correctedPaperPnlCents` this module
// carried first. Four things were wrong, and the first real execution of the
// restore refused on them:
//
//  1. **No strategy narrowing.** Only the edge strategy's settled records ever
//     moved this counter. Summing every paper strategy's P&L adds long-shot
//     payouts that were never credited here.
//  2. **Exit records were included.** A record whose id carries `:exit:` is the
//     exit leg of a position already accounted for by its entry; its `pnlCents`
//     is not a second contribution.
//  3. **The settled set was too wide.** `exited` and `settled`, and "any order
//     with `pnlCents` defined", are not what the counter moved on. The edge
//     statuses are exactly `won`, `lost`, `invalid`, `sold`.
//  4. **Strategy-leak corrections were not added.** This module used to say that
//     adding them "would count them twice" because the orders already excluded
//     them. That is **wrong** once the rule is narrowed: a non-edge record is
//     contributing precisely when it is a `sold` standalone-exit-policy sale, so
//     the leaked sales *are* in the order-derived figure, and the corrections
//     that removed them from the counter have to be added back for the two to
//     agree. They net out; that is the point.
//
// How the three classes relate to the order-derived figure, as implemented:
//
// - maker-fee corrections returned taker fees charged on paper maker fills; the
//   fee is still inside the orders' `pnlCents`, so the figure adds them back;
// - strategy-leak corrections removed another strategy's payouts from the
//   counter while those sales remain in the contributing set, so the figure adds
//   them back too (they are negative, and they cancel);
// - reconciliation corrections adjusted the counter *to match this expectation*,
//   so adding them would double-count the very adjustment being verified. They
//   are reported and deliberately excluded.
//
// Two scoping choices, both deliberate:
//
// - **Funding scoping stays.** Only orders belonging to the budget's current
//   funding id count. Paper has never been reset, so today this selects every
//   paper order and is a no-op; it is what keeps the figure correct after a
//   reset, when older orders belong to a retired funding.
// - **`since` scoping is off.** The drift script sums every correction entry with
//   no `at` filter, and paper carries no `startedAt`-based reset to scope to.
//   Filtering by `budget.startedAt` would silently drop corrections the counter
//   already contains.
//
// Sign convention: `discrepancyCents` is `recomputed - restored`, so the v1
// script's `drift` (`restored - expected`) is its negation. Zero either way.

import type { BankrollCorrection, LedgerOrder, PaperBudget } from './ledger-v9.js';

export const LEGACY_PAPER_BANKROLL_ID = 'paper-original';

/** The one strategy whose settled records moved this bankroll's counter. */
export const EDGE_STRATEGY_ID = 'edge-binary-buy';

/** Edge statuses the counter moved on. Narrower than "has a P&L". */
const EDGE_SETTLED_STATUSES = new Set(['won', 'lost', 'invalid', 'sold']);

/** Statuses whose stake is still reserved against the available balance. */
const OPEN_STAKE_STATUSES = new Set(['open', 'pending_reservation', 'uncertain']);

/** The exit leg of a position its entry record already accounts for. */
const EXIT_RECORD_MARKER = ':exit:';

/** An order with no strategy recorded is an edge order; edge predates the field. */
export function strategyOf(order: LedgerOrder): string {
  return order.strategyId ?? EDGE_STRATEGY_ID;
}

export function isExitRecord(order: LedgerOrder): boolean {
  return order.id.includes(EXIT_RECORD_MARKER);
}

export function paperFundingId(order: LedgerOrder): string {
  return order.paperBankrollId ?? LEGACY_PAPER_BANKROLL_ID;
}

/** A paper record that is not an exit leg. Every rule below is over this set. */
function isPaperRecord(order: LedgerOrder): boolean {
  return order.executionMode === 'paper' && !isExitRecord(order);
}

/**
 * Whether this record's `pnlCents` moved the paper bankroll's realized counter:
 * an edge record in one of the four settled statuses, or another strategy's
 * standalone-exit-policy sale, which is the one way a non-edge payout reached
 * this bankroll (and is what the strategy-leak corrections removed again).
 */
export function isContributingPaperOrder(order: LedgerOrder): boolean {
  if (!isPaperRecord(order)) return false;
  if (strategyOf(order) === EDGE_STRATEGY_ID) return EDGE_SETTLED_STATUSES.has(order.status);
  return order.status === 'sold' && Boolean(order.standaloneExitPolicy);
}

/** Whether this record's stake is still held against the available balance. */
export function holdsOpenStake(order: LedgerOrder): boolean {
  return (
    isPaperRecord(order) &&
    strategyOf(order) === EDGE_STRATEGY_ID &&
    OPEN_STAKE_STATUSES.has(order.status)
  );
}

export interface BankrollRecomputation {
  fundingId: string;
  /** Records whose P&L moved the counter, in funding scope. */
  contributingOrders: number;
  /** Paper records excluded because they are an exit leg. */
  excludedExitRecords: number;
  /** Paper records excluded because another strategy's payout never reached here. */
  excludedOtherStrategyOrders: number;
  orderPnlCents: number;
  makerFeeCorrectionCents: number;
  strategyLeakCorrectionCents: number;
  reconciliationCorrectionCents: number;
  recomputedRealizedPnlCents: number;
  restoredRealizedPnlCents: number;
  /** `recomputed - restored`. Must be zero. */
  discrepancyCents: number;
  /** Stake still reserved by open edge records, in funding scope. */
  openStakeCents: number;
  /** `available - (starting + realized - openStake)`. Must be zero. */
  availableResidualCents: number;
}

const sum = (entries: readonly BankrollCorrection[] | undefined) =>
  (entries ?? []).reduce((total, entry) => total + entry.realizedPnlCents, 0);

export function recomputePaperBankroll(
  orders: readonly LedgerOrder[],
  budget: PaperBudget,
): BankrollRecomputation {
  const fundingId = budget.fundingId ?? LEGACY_PAPER_BANKROLL_ID;
  const inScope = orders.filter(
    (order) => order.executionMode === 'paper' && paperFundingId(order) === fundingId,
  );
  const contributing = inScope.filter(isContributingPaperOrder);
  const orderPnlCents = contributing.reduce((total, order) => total + (order.pnlCents ?? 0), 0);

  const makerFeeCorrectionCents = sum(budget.makerFeeCorrections);
  const strategyLeakCorrectionCents = sum(budget.strategyLeakCorrections);
  const reconciliationCorrectionCents = sum(budget.reconciliationCorrections);
  const recomputedRealizedPnlCents =
    orderPnlCents + makerFeeCorrectionCents + strategyLeakCorrectionCents;

  const openStakeCents = inScope
    .filter(holdsOpenStake)
    .reduce((total, order) => total + order.stakeCents, 0);

  return {
    fundingId,
    contributingOrders: contributing.length,
    excludedExitRecords: inScope.filter(isExitRecord).length,
    // Non-edge records that did *not* contribute. A standalone-exit-policy sale
    // is non-edge and contributing, so it is not an exclusion.
    excludedOtherStrategyOrders: inScope.filter(
      (order) =>
        isPaperRecord(order) &&
        strategyOf(order) !== EDGE_STRATEGY_ID &&
        !isContributingPaperOrder(order),
    ).length,
    orderPnlCents,
    makerFeeCorrectionCents,
    strategyLeakCorrectionCents,
    reconciliationCorrectionCents,
    recomputedRealizedPnlCents,
    restoredRealizedPnlCents: budget.realizedPnlCents,
    discrepancyCents: recomputedRealizedPnlCents - budget.realizedPnlCents,
    openStakeCents,
    availableResidualCents:
      budget.availableCents - (budget.startingCents + budget.realizedPnlCents - openStakeCents),
  };
}
