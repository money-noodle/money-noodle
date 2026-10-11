// Selected historical pure arithmetic only; no environment/store/sentinel/network imports.
export const REGIME_GATE_POLICY_VERSION = 'adaptive-fee-edge-window-v1';

export type RegimeGatePhase = 'disabled' | 'warming' | 'open' | 'closed';

export interface RegimeGateObservation {
  id: string;
  policyVersion: string;
  closesAt: string;
  resolvedAt: string;
  realizedEdge: number;
}

export interface RegimeGateSettings {
  enabled: boolean;
  minimumPolicyWindows: number;
  evidenceHalfLifeWindows: number;
  pauseConfidence: number;
  resumeConfidence: number;
}

export interface RegimeGateEvaluation {
  phase: RegimeGatePhase;
  allowsEntries: boolean;
  policyVersion: string;
  resolvedWindows: number;
  effectiveWindows: number;
  weightedMeanEdge: number | null;
  standardError: number | null;
  negativeReturnConfidence: number | null;
  reason: string;
}

// Abramowitz and Stegun 7.1.26; ample precision for a risk-gate confidence display.
function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    sign *
    (1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

/**
 * Estimates recent fee-aware return without a fixed lookback. Observations decay continuously by
 * settlement window; the empirical variance and effective sample size grow from accumulated data.
 * A small zero-mean bounded-return prior prevents a run of identical outcomes from claiming certainty.
 */
function evaluateRegimeGate(
  observations: RegimeGateObservation[],
  policyVersion: string,
  previousPhase: RegimeGatePhase,
  settings: RegimeGateSettings,
): RegimeGateEvaluation {
  if (!settings.enabled)
    return {
      phase: 'disabled',
      allowsEntries: true,
      policyVersion,
      resolvedWindows: 0,
      effectiveWindows: 0,
      weightedMeanEdge: null,
      standardError: null,
      negativeReturnConfidence: null,
      reason: 'Adaptive regime gate is disabled.',
    };
  const current = observations
    .filter((item) => item.policyVersion === policyVersion && Number.isFinite(item.realizedEdge))
    .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
  if (!current.length)
    return {
      phase: 'warming',
      allowsEntries: true,
      policyVersion,
      resolvedWindows: 0,
      effectiveWindows: 0,
      weightedMeanEdge: null,
      standardError: null,
      negativeReturnConfidence: null,
      reason: `Adaptive regime gate warming: 0/${settings.minimumPolicyWindows} current-policy settlement windows.`,
    };
  const decay = Math.pow(0.5, 1 / settings.evidenceHalfLifeWindows);
  let sumWeights = 0,
    sumSquaredWeights = 0,
    weightedTotal = 0;
  current.forEach((item, index) => {
    const weight = Math.pow(decay, current.length - index - 1);
    sumWeights += weight;
    sumSquaredWeights += weight * weight;
    weightedTotal += weight * Math.max(-1, Math.min(1, item.realizedEdge));
  });
  const mean = weightedTotal / sumWeights;
  const effectiveWindows = (sumWeights * sumWeights) / sumSquaredWeights;
  let weightedSquaredError = 0;
  current.forEach((item, index) => {
    const weight = Math.pow(decay, current.length - index - 1);
    weightedSquaredError += weight * (Math.max(-1, Math.min(1, item.realizedEdge)) - mean) ** 2;
  });
  // Two prior window-equivalents with the variance of a broad bounded-return distribution.
  const priorWeight = 2;
  const variance = (weightedSquaredError + priorWeight * 0.25) / (sumWeights + priorWeight);
  const standardError = Math.sqrt(variance / (effectiveWindows + priorWeight));
  const negativeReturnConfidence = normalCdf((0 - mean) / Math.max(1e-9, standardError));
  const warmed = current.length >= settings.minimumPolicyWindows;
  if (!warmed)
    return {
      phase: 'warming',
      allowsEntries: true,
      policyVersion,
      resolvedWindows: current.length,
      effectiveWindows,
      weightedMeanEdge: mean,
      standardError,
      negativeReturnConfidence,
      reason: `Adaptive regime gate warming: ${current.length}/${settings.minimumPolicyWindows} current-policy settlement windows.`,
    };
  const wasClosed = previousPhase === 'closed';
  const closed = wasClosed
    ? negativeReturnConfidence >= settings.resumeConfidence
    : negativeReturnConfidence >= settings.pauseConfidence;
  const phase: RegimeGatePhase = closed ? 'closed' : 'open';
  return {
    phase,
    allowsEntries: !closed,
    policyVersion,
    resolvedWindows: current.length,
    effectiveWindows,
    weightedMeanEdge: mean,
    standardError,
    negativeReturnConfidence,
    reason: closed
      ? `New paper entries are paused: estimated negative-return probability is ${(negativeReturnConfidence * 100).toFixed(1)}%. Entry admission reopens below ${(settings.resumeConfidence * 100).toFixed(0)}%.`
      : wasClosed
        ? `Entry permission reopened automatically: estimated negative-return probability fell to ${(negativeReturnConfidence * 100).toFixed(1)}%.`
        : `Entry permission remains open: estimated negative-return probability is ${(negativeReturnConfidence * 100).toFixed(1)}%; pausing requires ${(settings.pauseConfidence * 100).toFixed(1)}%.`,
  };
}

export const PAPER_REGIME_EVIDENCE_CONTRACT = 'paper-regime-explicit-evidence-v1';
export const PAPER_REGIME_SAMPLE_BUY_POLICY =
  'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
export const PAPER_RESTRICTIVE_REGIME_PROPOSAL = 'paper-regime-restrictive-evidence-proposal-v1';
export interface PaperRegimeIdentity {
  epoch: number;
  configIntentId: string;
  evidenceGenerationId: string;
  bundleId: typeof PAPER_RESTRICTIVE_REGIME_PROPOSAL;
  gateFormula: typeof REGIME_GATE_POLICY_VERSION;
  settingsIdentity: string;
}
export function paperRegimeSettingsIdentity(settings: RegimeGateSettings): string {
  return [
    'regime-settings-v1',
    settings.enabled,
    settings.minimumPolicyWindows,
    settings.evidenceHalfLifeWindows,
    settings.pauseConfidence,
    settings.resumeConfidence,
  ].join(':');
}

export interface PaperRegimeEvidence {
  identity: PaperRegimeIdentity;
  sourceKind: 'prospective-engine-run';
  sourceId: string;
  policyVersion: string;
  complete: boolean;
  observedAtMs: number;
  previousPhase: RegimeGatePhase;
  previousPhasePolicyVersion: string;
  observations: RegimeGateObservation[];
}
/** No store or collector. All snapshot facts are required caller evidence, not proven by this helper.
 * Disabled or insufficient evidence refuses instead of inheriting permissive disabled/warm-up authority.
 */
export function evaluatePaperRegimeEvidence(
  evidence: PaperRegimeEvidence | undefined,
  policyVersion: string,
  settings: RegimeGateSettings,
  nowMs: number,
  maximumEvidenceAgeMs: number,
  expectedIdentity: PaperRegimeIdentity,
): RegimeGateEvaluation {
  const refuse = (reason: string): RegimeGateEvaluation => ({
    phase: 'closed',
    allowsEntries: false,
    policyVersion,
    resolvedWindows: 0,
    effectiveWindows: 0,
    weightedMeanEdge: null,
    standardError: null,
    negativeReturnConfidence: null,
    reason,
  });
  if (
    policyVersion !== PAPER_REGIME_SAMPLE_BUY_POLICY ||
    !settings ||
    settings.enabled !== true ||
    !Number.isSafeInteger(settings.minimumPolicyWindows) ||
    settings.minimumPolicyWindows < 4 ||
    settings.minimumPolicyWindows > 500 ||
    !Number.isFinite(settings.evidenceHalfLifeWindows) ||
    settings.evidenceHalfLifeWindows < 2 ||
    settings.evidenceHalfLifeWindows > 500 ||
    !Number.isFinite(settings.pauseConfidence) ||
    settings.pauseConfidence < 0.9 ||
    settings.pauseConfidence > 0.9999 ||
    !Number.isFinite(settings.resumeConfidence) ||
    settings.resumeConfidence < 0.5 ||
    settings.resumeConfidence > 0.98 ||
    settings.resumeConfidence > settings.pauseConfidence - 0.01
  )
    return refuse('Unsupported explicit paper regime settings.');
  const identityValid =
    expectedIdentity &&
    Number.isSafeInteger(expectedIdentity.epoch) &&
    expectedIdentity.epoch >= 1 &&
    expectedIdentity.bundleId === PAPER_RESTRICTIVE_REGIME_PROPOSAL &&
    expectedIdentity.gateFormula === REGIME_GATE_POLICY_VERSION &&
    expectedIdentity.settingsIdentity === paperRegimeSettingsIdentity(settings) &&
    [expectedIdentity.configIntentId, expectedIdentity.evidenceGenerationId].every(
      (s) => typeof s === 'string' && s.length > 0 && s.length <= 120,
    );
  if (
    !identityValid ||
    !evidence?.identity ||
    evidence.identity.epoch !== expectedIdentity.epoch ||
    evidence.identity.configIntentId !== expectedIdentity.configIntentId ||
    evidence.identity.evidenceGenerationId !== expectedIdentity.evidenceGenerationId ||
    evidence.identity.bundleId !== expectedIdentity.bundleId ||
    evidence.identity.gateFormula !== expectedIdentity.gateFormula ||
    evidence.identity.settingsIdentity !== expectedIdentity.settingsIdentity
  )
    return refuse('Regime identity or generation mismatch.');
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(maximumEvidenceAgeMs) ||
    maximumEvidenceAgeMs <= 0 ||
    !evidence ||
    evidence.sourceKind !== 'prospective-engine-run' ||
    typeof evidence.sourceId !== 'string' ||
    evidence.sourceId.length < 1 ||
    evidence.sourceId.length > 120 ||
    evidence.complete !== true ||
    evidence.policyVersion !== policyVersion ||
    evidence.previousPhasePolicyVersion !== policyVersion ||
    !['warming', 'open', 'closed'].includes(evidence.previousPhase) ||
    !Number.isSafeInteger(evidence.observedAtMs) ||
    evidence.observedAtMs > nowMs ||
    nowMs - evidence.observedAtMs > maximumEvidenceAgeMs ||
    !Array.isArray(evidence.observations) ||
    evidence.observations.length > 5000
  )
    return refuse('Missing, stale, unsupported or incomplete regime evidence.');
  const ids = new Set<string>(),
    windows = new Set<string>();
  for (const observation of evidence.observations) {
    if (!observation || typeof observation !== 'object')
      return refuse('Invalid regime observation record.');
    const close = Date.parse(observation.closesAt),
      resolved = Date.parse(observation.resolvedAt);
    if (
      typeof observation.id !== 'string' ||
      observation.id.length < 1 ||
      observation.id.length > 256 ||
      ids.has(observation.id) ||
      windows.has(observation.closesAt) ||
      observation.policyVersion !== policyVersion ||
      !Number.isFinite(observation.realizedEdge) ||
      observation.realizedEdge < -1 ||
      observation.realizedEdge > 1 ||
      !Number.isSafeInteger(close) ||
      !Number.isSafeInteger(resolved) ||
      observation.closesAt !== new Date(close).toISOString() ||
      observation.resolvedAt !== new Date(resolved).toISOString() ||
      close % 900000 !== 0 ||
      close > resolved ||
      resolved > evidence.observedAtMs ||
      !/Z$/.test(observation.closesAt) ||
      !/Z$/.test(observation.resolvedAt)
    )
      return refuse('Invalid current-policy regime observation.');
    ids.add(observation.id);
    windows.add(observation.closesAt);
  }
  if (evidence.observations.length < settings.minimumPolicyWindows)
    return refuse('Current-policy regime evidence is not warmed.');
  return evaluateRegimeGate(evidence.observations, policyVersion, evidence.previousPhase, settings);
}
