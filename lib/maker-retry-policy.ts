import type { PaperOrder } from './types';

export const MAX_MAKER_ATTEMPTS_PER_CONTRACT = 2;
export const MAKER_RETRY_COOLDOWN_MS = 30_000;
export const MAKER_RETRY_LATE_CUTOFF_MS = 120_000;

/** Live defaults to one attempt while retry adverse-selection evidence is negative. */
export function maximumLiveMakerAttempts(): number {
  const configured = Number(process.env.SIGNAL_DESK_MAX_LIVE_MAKER_ATTEMPTS ?? 1);
  return Number.isSafeInteger(configured) && configured >= 1
    ? Math.min(MAX_MAKER_ATTEMPTS_PER_CONTRACT, configured)
    : 1;
}

export interface MakerRetryDecision {
  allowed: boolean;
  attemptNumber: number;
  retryOfOrderId?: string;
  reason: string;
  retryAt?: string;
}

export function makerAttemptId(logicalOrderId: string, attemptNumber: number): string {
  return attemptNumber <= 1 ? logicalOrderId : `${logicalOrderId}:retry:${attemptNumber}`;
}

export function entryAttemptsForLogicalOrder(orders: PaperOrder[], logicalOrderId: string): PaperOrder[] {
  return orders.filter((order) => order.executionMode === 'live'
    && !order.id.includes(':exit:')
    && (order.logicalOrderId === logicalOrderId || order.id === logicalOrderId || order.id.startsWith(`${logicalOrderId}:retry:`)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** A bounded retry is a new fully validated intent, never a continuation of stale authority. */
export function makerRetryDecision(attempts: PaperOrder[], nowMs: number, closesAt: string, maximumAttempts = MAX_MAKER_ATTEMPTS_PER_CONTRACT): MakerRetryDecision {
  const ordered = [...attempts].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!ordered.length) return { allowed: true, attemptNumber: 1, reason: 'First maker attempt for this contract window.' };
  const latest = ordered.at(-1)!;
  if (ordered.some((order) => order.status === 'open' || order.status === 'pending_reservation' || order.status === 'uncertain' || (order.filledCount ?? 0) > 0)) {
    return { allowed: false, attemptNumber: ordered.length + 1, reason: 'A filled, open, working, or uncertain entry already exists for this contract window.' };
  }
  const effectiveMaximum = Math.max(1, Math.min(MAX_MAKER_ATTEMPTS_PER_CONTRACT, Math.floor(maximumAttempts)));
  if (ordered.length >= effectiveMaximum) return {
    allowed: false, attemptNumber: ordered.length + 1,
    reason: `Maximum ${effectiveMaximum} maker attempt${effectiveMaximum === 1 ? '' : 's'} reached for this asset/contract window.`,
  };
  if (latest.status !== 'unfilled') return { allowed: false, attemptNumber: ordered.length + 1, reason: `Latest entry state ${latest.status} is not safely retryable.` };
  const retryAtMs = Date.parse(latest.createdAt) + MAKER_RETRY_COOLDOWN_MS;
  if (nowMs < retryAtMs) return {
    allowed: false, attemptNumber: ordered.length + 1, retryOfOrderId: latest.id,
    reason: `Maker retry cooldown has ${Math.ceil((retryAtMs - nowMs) / 1000)}s remaining.`, retryAt: new Date(retryAtMs).toISOString(),
  };
  const remainingMs = Date.parse(closesAt) - nowMs;
  if (remainingMs <= MAKER_RETRY_LATE_CUTOFF_MS) return {
    allowed: false, attemptNumber: ordered.length + 1, retryOfOrderId: latest.id,
    reason: `Inside the final ${MAKER_RETRY_LATE_CUTOFF_MS / 1000}s; no maker retry is allowed.`,
  };
  return {
    allowed: true, attemptNumber: ordered.length + 1, retryOfOrderId: latest.id,
    reason: `Fresh policy, persistence, portfolio, quote, and budget checks may authorize bounded attempt ${ordered.length + 1}/${effectiveMaximum}.`,
  };
}
