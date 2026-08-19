import { MAX_ENTRY_EPISODES_PER_WINDOW } from './entry-execution-policy';
import type { ExecutionMode, PaperOrder } from './types';

export const MAX_MAKER_ATTEMPTS_PER_CONTRACT = 2;
export const MAKER_RETRY_COOLDOWN_MS = 30_000;
export const MAKER_RETRY_LATE_CUTOFF_MS = 120_000;

/** Maker-only mode retains its historical one-attempt default; adaptive episodes are versioned separately. */
export function maximumLiveMakerAttempts(): number {
  const configured = Number(process.env.MONEY_NOODLE_MAX_LIVE_MAKER_ATTEMPTS ?? 1);
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

export function entryEpisodeId(logicalOrderId: string, episodeNumber: number): string {
  return episodeNumber <= 1 ? logicalOrderId : `${logicalOrderId}:episode:${episodeNumber}`;
}

export function entryAttemptsForLogicalOrder(orders: PaperOrder[], logicalOrderId: string, mode: ExecutionMode = 'live'): PaperOrder[] {
  return orders.filter((order) => order.executionMode === mode
    && !order.id.includes(':exit:')
    && (order.logicalOrderId === logicalOrderId || order.id === logicalOrderId
      || order.id.startsWith(`${logicalOrderId}:retry:`) || order.id.startsWith(`${logicalOrderId}:episode:`)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

const orderExecutionPolicyVersion = (order: PaperOrder): string | undefined =>
  order.entryExecutionDecision?.policyVersion ?? order.entryDecision?.executionPolicyVersion;

/**
 * V5 re-arms only after an authoritative current-policy maker zero-fill. Persistence is evaluated by the
 * caller strictly after `makerCompletedAt`; this function owns terminal state, generation, and the cap.
 */
export function adaptiveEntryEpisodeDecision(
  attempts: PaperOrder[], currentPolicyVersion: string, maximumEpisodes = MAX_ENTRY_EPISODES_PER_WINDOW,
): MakerRetryDecision {
  const ordered = [...attempts].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!ordered.length) return { allowed: true, attemptNumber: 1, reason: 'First entry episode for this contract window.' };
  if (ordered.some((order) => order.status === 'open' || order.status === 'pending_reservation'
    || order.status === 'uncertain' || (order.filledCount ?? 0) > 0)) {
    return { allowed: false, attemptNumber: ordered.length + 1, reason: 'A filled, open, working, or uncertain entry already exists for this contract window.' };
  }
  if (ordered.some((order) => orderExecutionPolicyVersion(order) !== currentPolicyVersion)) return {
    allowed: false, attemptNumber: ordered.length + 1,
    reason: 'A prior execution-policy generation cannot authorize a current entry episode.',
  };
  const effectiveMaximum = Math.max(1, Math.min(MAX_ENTRY_EPISODES_PER_WINDOW, Math.floor(maximumEpisodes)));
  if (ordered.length >= effectiveMaximum) return {
    allowed: false, attemptNumber: ordered.length + 1,
    reason: `Maximum ${effectiveMaximum} entry episodes reached for this asset/side/window.`,
  };
  const latest = ordered.at(-1)!;
  if (latest.status !== 'unfilled' || latest.entryExecutionDecision?.executedStyle === 'taker'
    || latest.liquidityRole !== 'maker' || !Number.isFinite(Date.parse(latest.makerCompletedAt ?? ''))) {
    return {
      allowed: false, attemptNumber: ordered.length + 1,
      reason: 'A new episode requires an authoritative completed maker zero-fill.',
    };
  }
  return {
    allowed: true, attemptNumber: ordered.length + 1, retryOfOrderId: latest.id,
    reason: `Fresh post-completion persistence may authorize entry episode ${ordered.length + 1}/${effectiveMaximum}.`,
  };
}

/** A bounded maker retry is a new fully validated intent, never a continuation of stale authority. */
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
  // Waiting from submission shortens the intended pause by however long the order spent resting.
  // New attempts record the terminal cancellation time; legacy records retain the old fallback.
  const completedAtMs = Date.parse(latest.makerCompletedAt ?? latest.createdAt);
  const retryAtMs = completedAtMs + MAKER_RETRY_COOLDOWN_MS;
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
