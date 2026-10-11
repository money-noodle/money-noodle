import { MAX_ENTRY_EPISODES_PER_WINDOW } from './paper-entry-route.js';
export interface PaperAttempt {
  id: string;
  createdAt: string;
  status: string;
  executionPolicyVersion: string;
  filledCount?: number;
  makerCompletedAt?: string;
  liquidityRole?: 'maker' | 'taker';
  noFillReason?: string;
  fallbackSequenceEndedAt?: string;
  fallbackSequenceEndReason?: string;
  entryExecutionDecision?: { executedStyle: 'maker' | 'taker' };
}
export interface MakerRetryDecision {
  allowed: boolean;
  attemptNumber: number;
  retryOfOrderId?: string | undefined;
  takerFallback?: boolean;
  reason: string;
}
const orderExecutionPolicyVersion = (order: PaperAttempt) => order.executionPolicyVersion;
// Paper-only maker -> IOC -> IOC episodes; no live client or configuration defaults.
export function adaptiveEntryEpisodeDecision(
  attempts: PaperAttempt[],
  currentPolicyVersion: string,
  maximumEpisodes: number,
): MakerRetryDecision {
  if (
    !currentPolicyVersion ||
    !Number.isSafeInteger(maximumEpisodes) ||
    maximumEpisodes < 1 ||
    maximumEpisodes > 3 ||
    attempts.some((a) => !Number.isFinite(Date.parse(a.createdAt)))
  )
    throw new Error('Invalid paper episode authority.');
  const ordered = [...attempts].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!ordered.length)
    return {
      allowed: true,
      attemptNumber: 1,
      takerFallback: false,
      reason: 'First managed-maker intent for this contract window.',
    };
  const nextAttempt = ordered.length + 1;
  if (
    ordered.some(
      (order) =>
        order.status === 'open' ||
        order.status === 'pending_reservation' ||
        order.status === 'uncertain' ||
        (order.filledCount ?? 0) > 0,
    )
  ) {
    return {
      allowed: false,
      attemptNumber: nextAttempt,
      reason:
        'A filled, open, working, or uncertain entry already exists for this contract window.',
    };
  }
  if (ordered.some((order) => orderExecutionPolicyVersion(order) !== currentPolicyVersion))
    return {
      allowed: false,
      attemptNumber: nextAttempt,
      reason: 'A prior execution-policy generation cannot authorize a current fallback.',
    };
  const effectiveMaximum = Math.max(
    1,
    Math.min(MAX_ENTRY_EPISODES_PER_WINDOW, Math.floor(maximumEpisodes)),
  );
  if (ordered.length >= effectiveMaximum)
    return {
      allowed: false,
      attemptNumber: nextAttempt,
      reason: `Maximum ${effectiveMaximum} entry intents reached for this asset/side/window.`,
    };
  const latest = ordered.at(-1)!;
  if (latest.fallbackSequenceEndedAt)
    return {
      allowed: false,
      attemptNumber: nextAttempt,
      reason:
        latest.fallbackSequenceEndReason ??
        'The bounded fallback sequence ended without another venue intent.',
    };
  if (latest.status !== 'unfilled' || !Number.isFinite(Date.parse(latest.makerCompletedAt ?? '')))
    return {
      allowed: false,
      attemptNumber: nextAttempt,
      reason: 'A fallback requires a definitive terminal zero-spend result.',
    };
  if (ordered.length === 1) {
    if (
      latest.entryExecutionDecision?.executedStyle !== 'maker' ||
      latest.liquidityRole !== 'maker' ||
      latest.noFillReason !== 'rested_no_fill'
    )
      return {
        allowed: false,
        attemptNumber: nextAttempt,
        reason: 'The first taker requires an authoritative managed-maker zero-fill.',
      };
  } else if (ordered.length === 2) {
    if (
      latest.entryExecutionDecision?.executedStyle !== 'taker' ||
      latest.noFillReason !== 'ioc_no_fill'
    )
      return {
        allowed: false,
        attemptNumber: nextAttempt,
        reason: 'The final taker requires an authoritative accepted IOC zero-fill.',
      };
  }
  return {
    allowed: true,
    attemptNumber: nextAttempt,
    retryOfOrderId: latest.id,
    takerFallback: true,
    reason: `Fresh checks may authorize taker fallback ${nextAttempt - 1}/2.`,
  };
}
