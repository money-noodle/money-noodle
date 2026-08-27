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
  /** True only for the two terminal IOC opportunities following the first authoritative maker miss. */
  takerFallback?: boolean;
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

/**
 * Each lane owns a different execution generation. Live's route generation is the funded implementation;
 * paper's entry-decision generation is the simulator. A production paper row carries both fields, so a
 * shared fallback order silently suppresses paper requalification whenever their names differ.
 */
const orderExecutionPolicyVersion = (order: PaperOrder): string | undefined => order.executionMode === 'paper'
  ? order.entryDecision?.executionPolicyVersion
  : order.entryExecutionDecision?.policyVersion ?? order.entryDecision?.executionPolicyVersion;

/**
 * The adaptive generation is one managed maker followed by at most two terminal IOC opportunities.
 * Every opportunity is a new durable intent. A partial fill, ambiguity, rejection, or old generation ends
 * the sequence; only authoritative maker/IOC zero-fill may advance it. A signed-path policy refusal is terminal.
 */
export function adaptiveEntryEpisodeDecision(
  attempts: PaperOrder[], currentPolicyVersion: string, maximumEpisodes = MAX_ENTRY_EPISODES_PER_WINDOW,
): MakerRetryDecision {
  const ordered = [...attempts].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!ordered.length) return { allowed: true, attemptNumber: 1, takerFallback: false, reason: 'First managed-maker intent for this contract window.' };
  const nextAttempt = ordered.length + 1;
  if (ordered.some((order) => order.status === 'open' || order.status === 'pending_reservation'
    || order.status === 'uncertain' || (order.filledCount ?? 0) > 0)) {
    return { allowed: false, attemptNumber: nextAttempt, reason: 'A filled, open, working, or uncertain entry already exists for this contract window.' };
  }
  if (ordered.some((order) => orderExecutionPolicyVersion(order) !== currentPolicyVersion)) return {
    allowed: false, attemptNumber: nextAttempt, reason: 'A prior execution-policy generation cannot authorize a current fallback.',
  };
  const effectiveMaximum = Math.max(1, Math.min(MAX_ENTRY_EPISODES_PER_WINDOW, Math.floor(maximumEpisodes)));
  if (ordered.length >= effectiveMaximum) return {
    allowed: false, attemptNumber: nextAttempt,
    reason: `Maximum ${effectiveMaximum} entry intents reached for this asset/side/window.`,
  };
  const latest = ordered.at(-1)!;
  if (latest.fallbackSequenceEndedAt) return {
    allowed: false, attemptNumber: nextAttempt,
    reason: latest.fallbackSequenceEndReason ?? 'The bounded fallback sequence ended without another venue intent.',
  };
  if (latest.status !== 'unfilled' || !Number.isFinite(Date.parse(latest.makerCompletedAt ?? ''))) return {
    allowed: false, attemptNumber: nextAttempt,
    reason: 'A fallback requires a definitive terminal zero-spend result.',
  };
  if (ordered.length === 1) {
    if (latest.entryExecutionDecision?.executedStyle !== 'maker' || latest.liquidityRole !== 'maker'
      || latest.noFillReason !== 'rested_no_fill') return {
      allowed: false, attemptNumber: nextAttempt,
      reason: 'The first taker requires an authoritative managed-maker zero-fill.',
    };
  } else if (ordered.length === 2) {
    if (latest.entryExecutionDecision?.executedStyle !== 'taker' || latest.noFillReason !== 'ioc_no_fill') return {
      allowed: false, attemptNumber: nextAttempt,
      reason: 'The final taker requires an authoritative accepted IOC zero-fill.',
    };
  }
  return {
    allowed: true, attemptNumber: nextAttempt, retryOfOrderId: latest.id, takerFallback: true,
    reason: `Fresh checks may authorize taker fallback ${nextAttempt - 1}/2.`,
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
