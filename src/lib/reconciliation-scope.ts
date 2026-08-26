import { createHash } from 'node:crypto';
import type { KalshiReconciliationCheckpoint } from './reconciliation-checkpoint';
import type { PaperOrder } from './types';

export const RECONCILIATION_OVERLAP_SECONDS = 120;

export interface LocalReconciliationPlan {
  authorityFingerprint: string;
  trackedVenueOrderIds: string[];
  earliestRequiredAtMs?: number;
}

export function liveReconciliationAuthorityFingerprint(orders: PaperOrder[]): string {
  const live = orders.filter((order) => order.executionMode === 'live' && order.venue === 'kalshi');
  return createHash('sha256').update(JSON.stringify(live)).digest('hex');
}

export function localReconciliationPlan(orders: PaperOrder[]): LocalReconciliationPlan {
  const tracked = orders.filter((order) => order.executionMode === 'live' && order.venue === 'kalshi'
    && (order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain'
      || order.exitPending));
  const relevantTimes = tracked.flatMap((order) => [order.createdAt, order.exitRequestedAt])
    .filter((value): value is string => Boolean(value)).map(Date.parse).filter(Number.isFinite);
  return {
    authorityFingerprint: liveReconciliationAuthorityFingerprint(orders),
    trackedVenueOrderIds: [...new Set(tracked.flatMap((order) => [order.venueOrderId, order.exitVenueOrderId])
      .filter((id): id is string => Boolean(id)))],
    earliestRequiredAtMs: relevantTimes.length ? Math.min(...relevantTimes) : undefined,
  };
}

export function incrementalReconciliationInterval(
  checkpoint: KalshiReconciliationCheckpoint,
  plan: LocalReconciliationPlan,
  completedThroughTs: number,
): { minTs: number; maxTs: number } {
  const checkpointMinTs = checkpoint.completedThroughTs - RECONCILIATION_OVERLAP_SECONDS;
  const activeMinTs = plan.earliestRequiredAtMs === undefined ? Number.POSITIVE_INFINITY
    : Math.floor(plan.earliestRequiredAtMs / 1_000) - RECONCILIATION_OVERLAP_SECONDS;
  return {
    minTs: Math.max(1, Math.min(checkpointMinTs, activeMinTs)),
    maxTs: completedThroughTs,
  };
}
