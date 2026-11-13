// Pure source block only. No sale/order/budget/store or environment authority.
export const SWITCH_POLICY_VERSION = 'future-wealth-side-gap-v1';
const observationBucket = (time: number) => Math.floor(time / 15000) * 15000;
const validIdentity = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 256;
export interface SwitchValueInput {
  incumbentQuantity: number;
  incumbentProbability: number;
  exitBid: number;
  exitFeeCents: number;
  replacementQuantity: number;
  replacementProbability: number;
  replacementAllInCostCents: number;
}

export interface SwitchProbabilityGateInput {
  incumbentSymbol: string;
  incumbentSide: 'UP' | 'DOWN';
  incumbentProbability: number;
  replacementSymbol: string;
  replacementSide: 'UP' | 'DOWN';
  replacementProbability: number;
  minimumAdvantage: number;
  minimumOppositeSideAdvantage: number;
}

export interface SwitchProbabilityGate {
  allowed: boolean;
  advantage: number;
  requiredAdvantage: number;
  oppositeSameAsset: boolean;
}

/**
 * Prevents churn out of a still-plausible incumbent. Same-asset reversals require the stricter gap;
 * this gate is additional to, never a substitute for, positive future-wealth switch value.
 */
export function evaluateSwitchProbabilityGate(
  input: SwitchProbabilityGateInput,
): SwitchProbabilityGate | null {
  const numeric = [
    input.incumbentProbability,
    input.replacementProbability,
    input.minimumAdvantage,
    input.minimumOppositeSideAdvantage,
  ];
  if (
    !numeric.every(Number.isFinite) ||
    input.incumbentProbability < 0 ||
    input.incumbentProbability > 1 ||
    input.replacementProbability < 0 ||
    input.replacementProbability > 1 ||
    input.minimumAdvantage < 0 ||
    input.minimumOppositeSideAdvantage < 0
  )
    return null;
  const oppositeSameAsset =
    input.incumbentSymbol === input.replacementSymbol &&
    input.incumbentSide !== input.replacementSide;
  const requiredAdvantage = oppositeSameAsset
    ? Math.max(input.minimumAdvantage, input.minimumOppositeSideAdvantage)
    : input.minimumAdvantage;
  const advantage = input.replacementProbability - input.incumbentProbability;
  return {
    allowed: advantage + 1e-12 >= requiredAdvantage,
    advantage,
    requiredAdvantage,
    oppositeSameAsset,
  };
}

export interface SwitchValue {
  holdValueCents: number;
  liquidationValueCents: number;
  replacementExpectedProfitCents: number;
  deltaCents: number;
}

export function valueSwitch(input: SwitchValueInput): SwitchValue | null {
  if (
    input.incumbentQuantity > 1000000 ||
    input.replacementQuantity > 1000000 ||
    input.exitFeeCents > 1000000 ||
    input.replacementAllInCostCents > 1000000
  )
    return null;
  const values = Object.values(input);
  if (
    !values.every(Number.isFinite) ||
    input.incumbentQuantity <= 0 ||
    input.replacementQuantity <= 0 ||
    input.incumbentProbability < 0 ||
    input.incumbentProbability > 1 ||
    input.replacementProbability < 0 ||
    input.replacementProbability > 1 ||
    input.exitBid < 0 ||
    input.exitBid > 1 ||
    input.exitFeeCents < 0 ||
    input.replacementAllInCostCents <= 0
  )
    return null;
  const holdValueCents = input.incumbentQuantity * 100 * input.incumbentProbability;
  const liquidationValueCents = input.incumbentQuantity * 100 * input.exitBid - input.exitFeeCents;
  const replacementExpectedProfitCents =
    input.replacementQuantity * 100 * input.replacementProbability -
    input.replacementAllInCostCents;
  return {
    holdValueCents,
    liquidationValueCents,
    replacementExpectedProfitCents,
    deltaCents: liquidationValueCents - holdValueCents + replacementExpectedProfitCents,
  };
}

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

export function advanceSwitchPersistence(
  previous: SwitchPersistenceState | undefined,
  input: {
    incumbentId: string;
    replacementId: string;
    observedAt: string;
    deltaCents: number;
    maximumGapMs: number;
  },
): SwitchPersistenceState {
  const maximumGapMs = input.maximumGapMs;
  const observedMs = Date.parse(input.observedAt);
  if (
    !validIdentity(input.incumbentId) ||
    !validIdentity(input.replacementId) ||
    !Number.isSafeInteger(observedMs) ||
    !Number.isFinite(input.deltaCents) ||
    !Number.isSafeInteger(maximumGapMs) ||
    maximumGapMs <= 0 ||
    maximumGapMs > 900000
  )
    throw new Error('Invalid explicit switch observation.');
  if (
    previous &&
    (!Number.isSafeInteger(Date.parse(previous.firstSeenAt)) ||
      !Number.isSafeInteger(Date.parse(previous.lastSeenAt)) ||
      !Number.isSafeInteger(previous.observations) ||
      previous.observations < 1 ||
      previous.observations >= 1000 ||
      !Number.isFinite(previous.minimumDeltaCents) ||
      Date.parse(previous.firstSeenAt) > Date.parse(previous.lastSeenAt) ||
      !validIdentity(previous.incumbentId) ||
      !validIdentity(previous.replacementId))
  )
    throw new Error('Invalid bounded prior switch evidence.');
  const sameCandidate =
    previous?.incumbentId === input.incumbentId && previous.replacementId === input.replacementId;
  const gap = previous
    ? Date.parse(input.observedAt) - Date.parse(previous.lastSeenAt)
    : Number.POSITIVE_INFINITY;
  if (!previous || !sameCandidate || !Number.isFinite(gap) || gap < 0 || gap > maximumGapMs)
    return {
      incumbentId: input.incumbentId,
      replacementId: input.replacementId,
      firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt,
      observations: 1,
      minimumDeltaCents: input.deltaCents,
    };
  // Timestamp aliases denote one observation, not two causal snapshots.
  if (gap === 0) return previous;
  return {
    ...previous,
    lastSeenAt: input.observedAt,
    observations: previous.observations + 1,
    minimumDeltaCents: Math.min(previous.minimumDeltaCents, input.deltaCents),
  };
}

export function switchEvidenceSpanMs(state: SwitchPersistenceState): number {
  return (
    observationBucket(Date.parse(state.lastSeenAt)) -
    observationBucket(Date.parse(state.firstSeenAt))
  );
}

export function switchEvidenceReady(
  state: SwitchPersistenceState,
  input: { requiredObservations: number; requiredSpanMs: number; requiredGainCents: number },
): boolean {
  if (
    !validIdentity(state.incumbentId) ||
    !validIdentity(state.replacementId) ||
    !Number.isSafeInteger(state.observations) ||
    state.observations < 1 ||
    state.observations > 1000 ||
    !Number.isFinite(state.minimumDeltaCents) ||
    !Number.isSafeInteger(Date.parse(state.firstSeenAt)) ||
    !Number.isSafeInteger(Date.parse(state.lastSeenAt)) ||
    Date.parse(state.lastSeenAt) < Date.parse(state.firstSeenAt)
  )
    return false;
  if (
    !Number.isSafeInteger(input.requiredObservations) ||
    input.requiredObservations < 1 ||
    input.requiredObservations > 1000 ||
    !Number.isSafeInteger(input.requiredSpanMs) ||
    input.requiredSpanMs < 0 ||
    !Number.isFinite(input.requiredGainCents) ||
    input.requiredGainCents < 0
  )
    return false;
  return (
    state.observations >= input.requiredObservations &&
    switchEvidenceSpanMs(state) >= input.requiredSpanMs &&
    state.minimumDeltaCents >= input.requiredGainCents
  );
}

export function switchCooldownRemainingMs(
  completedAt: string | undefined,
  nowMs: number,
  cooldownMs: number,
): number {
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(cooldownMs) ||
    cooldownMs < 0 ||
    cooldownMs > 3600000
  )
    throw new Error('Invalid explicit cooldown.');
  if (!completedAt) return 0;
  const elapsed = nowMs - Date.parse(completedAt);
  if (!Number.isFinite(elapsed)) return cooldownMs;
  return Math.max(0, cooldownMs - elapsed);
}
