import { observationBucket } from './observation-window';

/** Switch evidence is required to persist on its own terms, independently of entry persistence. */
export const REQUIRED_SWITCH_SNAPSHOTS = 3;
export const REQUIRED_SWITCH_SPAN_MS = 30_000;

export interface SwitchPersistenceState {
  incumbentId: string;
  replacementId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observations: number;
  minimumDeltaCents: number;
}

export function advanceSwitchPersistence(previous: SwitchPersistenceState | undefined, input: {
  incumbentId: string;
  replacementId: string;
  observedAt: string;
  deltaCents: number;
  maximumGapMs?: number;
}): SwitchPersistenceState {
  const maximumGapMs = input.maximumGapMs ?? 35_000;
  const sameCandidate = previous?.incumbentId === input.incumbentId && previous.replacementId === input.replacementId;
  const gap = previous ? Date.parse(input.observedAt) - Date.parse(previous.lastSeenAt) : Number.POSITIVE_INFINITY;
  if (!previous || !sameCandidate || !Number.isFinite(gap) || gap < 0 || gap > maximumGapMs) return {
    incumbentId: input.incumbentId, replacementId: input.replacementId,
    firstSeenAt: input.observedAt, lastSeenAt: input.observedAt,
    observations: 1, minimumDeltaCents: input.deltaCents,
  };
  if (previous.lastSeenAt === input.observedAt) return previous;
  return {
    ...previous, lastSeenAt: input.observedAt, observations: previous.observations + 1,
    minimumDeltaCents: Math.min(previous.minimumDeltaCents, input.deltaCents),
  };
}

export function switchEvidenceSpanMs(state: SwitchPersistenceState): number {
  return observationBucket(Date.parse(state.lastSeenAt)) - observationBucket(Date.parse(state.firstSeenAt));
}

export function switchEvidenceReady(state: SwitchPersistenceState, input: { requiredObservations: number; requiredSpanMs: number; requiredGainCents: number }): boolean {
  return state.observations >= input.requiredObservations && switchEvidenceSpanMs(state) >= input.requiredSpanMs && state.minimumDeltaCents >= input.requiredGainCents;
}

export function switchCooldownRemainingMs(completedAt: string | undefined, nowMs: number, cooldownMs: number): number {
  if (!completedAt) return 0;
  const elapsed = nowMs - Date.parse(completedAt);
  if (!Number.isFinite(elapsed)) return cooldownMs;
  return Math.max(0, cooldownMs - elapsed);
}
