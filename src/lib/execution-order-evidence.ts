import type { PaperOrder } from './types';

export const EXECUTION_LEDGER_V9 = 9 as const;
export const EXECUTION_ORDER_EVIDENCE_BATCH_VERSION = 'execution-order-evidence-batch-v1' as const;
export const EXECUTION_ORDER_EVIDENCE_REF_VERSION = 'execution-order-evidence-ref-v1' as const;

export const EXECUTION_ORDER_EVIDENCE_KEYS = [
  'executionMirrorPair',
  'paperFillCalibration',
  'entryDecision',
  'makerFillEstimate',
  'settlementAverageEstimate',
  'entryExecutionObservations',
  'positionObservations',
  'entrySizingDecision',
  'quoteTrajectorySpread',
  'entryDirectionObservation',
  'entryExecutionDecision',
  'matchedLiveFill',
] as const satisfies readonly (keyof PaperOrder)[];

export type ExecutionOrderEvidenceKey = typeof EXECUTION_ORDER_EVIDENCE_KEYS[number];
export type ArchivedOrderEvidence = Partial<Pick<PaperOrder, ExecutionOrderEvidenceKey>>;

export interface ExecutionOrderEvidenceBatch {
  version: typeof EXECUTION_ORDER_EVIDENCE_BATCH_VERSION;
  createdAt: string;
  orders: Record<string, { orderId: string; evidence: ArchivedOrderEvidence }>;
}

const terminalStatuses = new Set<PaperOrder['status']>([
  'won', 'lost', 'invalid', 'sold', 'unfilled', 'rejected',
]);

/**
 * Conservative terminal seal boundary. Current-window and unresolved sale rows remain complete even when
 * their execution status is terminal because retry/counterfactual maintenance can still read or mutate them.
 */
export function executionOrderEvidenceSealEligible(
  order: PaperOrder,
  orders: readonly PaperOrder[],
  nowMs = Date.now(),
): boolean {
  if (!terminalStatuses.has(order.status) || order.exitPending) return false;
  const closesAtMs = Date.parse(order.closesAt);
  if (!Number.isFinite(closesAtMs) || closesAtMs > nowMs) return false;
  if (order.status !== 'sold' || order.id.includes(':exit:')) return true;
  if (!order.counterfactualHoldOutcome || order.counterfactualHoldPnlCents === undefined) return false;
  if (!order.switchedToOrderId) return true;
  if (order.switchVsHoldCents === undefined) return false;
  const replacement = orders.find((candidate) => candidate.id === order.switchedToOrderId);
  return Boolean(replacement && terminalStatuses.has(replacement.status));
}

export function archivedOrderEvidence(order: PaperOrder): ArchivedOrderEvidence {
  const result: ArchivedOrderEvidence = {};
  for (const key of EXECUTION_ORDER_EVIDENCE_KEYS) {
    const value = order[key];
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
}

export function hasArchivedOrderEvidence(evidence: ArchivedOrderEvidence): boolean {
  return EXECUTION_ORDER_EVIDENCE_KEYS.some((key) => evidence[key] !== undefined);
}

/** Populates direct safety/report fallbacks before their complete issuance snapshot moves out of the hot row. */
export function materializeExecutionOrderFallbacks(order: PaperOrder): PaperOrder {
  const copy = { ...order };
  copy.issuanceAskPrice ??= copy.entryDecision?.actionableAsk ?? copy.askPrice;
  copy.issuanceBidPrice ??= copy.entryDecision?.actionableBid ?? copy.bidPrice;
  copy.issuanceSpread ??= copy.entryDecision?.spread ?? copy.spread;
  copy.approvedMaximumPrice ??= copy.entryDecision?.actionableAsk ?? copy.askPrice;
  return copy;
}

export function compactExecutionOrder(
  order: PaperOrder,
  reference: Pick<NonNullable<PaperOrder['archivedEvidence']>, 'file' | 'sha256' | 'rowKey'>,
): PaperOrder {
  const compact = materializeExecutionOrderFallbacks(order);
  const summary: NonNullable<PaperOrder['archivedEvidence']>['summary'] = {};
  if (order.entryDecision?.netEdge !== undefined) summary.entryDecisionNetEdge = order.entryDecision.netEdge;
  if (order.entryExecutionDecision?.executedStyle) summary.entryExecutionStyle = order.entryExecutionDecision.executedStyle;
  compact.archivedEvidence = {
    version: EXECUTION_ORDER_EVIDENCE_REF_VERSION,
    file: reference.file,
    sha256: reference.sha256,
    rowKey: reference.rowKey,
    summary,
  };
  for (const key of EXECUTION_ORDER_EVIDENCE_KEYS) delete compact[key];
  return compact;
}

/** Hot fields win if a late reconciliation subsequently appended new evidence to a compact row. */
export function hydrateExecutionOrder(order: PaperOrder, evidence: ArchivedOrderEvidence): PaperOrder {
  const hydrated = { ...order };
  for (const key of EXECUTION_ORDER_EVIDENCE_KEYS) {
    if (hydrated[key] === undefined && evidence[key] !== undefined) Object.assign(hydrated, { [key]: evidence[key] });
  }
  return hydrated;
}

export function makerExecutionStyle(order: PaperOrder): 'maker' | 'taker' | undefined {
  return order.entryExecutionDecision?.executedStyle ?? order.archivedEvidence?.summary.entryExecutionStyle;
}

export function entryDecisionNetEdge(order: PaperOrder): number | undefined {
  return order.entryDecision?.netEdge ?? order.archivedEvidence?.summary.entryDecisionNetEdge;
}
