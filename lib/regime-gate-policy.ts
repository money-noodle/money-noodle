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

const bounded = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

export function regimeGateSettings(environment: NodeJS.ProcessEnv = process.env): RegimeGateSettings {
  const pauseConfidence = bounded(environment.MONEY_NOODLE_REGIME_PAUSE_CONFIDENCE, 0.99, 0.9, 0.9999);
  return {
    enabled: environment.MONEY_NOODLE_REGIME_GATE_ENABLED === 'true',
    minimumPolicyWindows: Math.floor(bounded(environment.MONEY_NOODLE_REGIME_MIN_POLICY_WINDOWS, 12, 4, 500)),
    evidenceHalfLifeWindows: bounded(environment.MONEY_NOODLE_REGIME_EVIDENCE_HALF_LIFE_WINDOWS, 12, 2, 500),
    pauseConfidence,
    resumeConfidence: Math.min(pauseConfidence - 0.01, bounded(environment.MONEY_NOODLE_REGIME_RESUME_CONFIDENCE, 0.75, 0.5, 0.98)),
  };
}

// Abramowitz and Stegun 7.1.26; ample precision for a risk-gate confidence display.
function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

/**
 * Estimates recent fee-aware return without a fixed lookback. Observations decay continuously by
 * settlement window; the empirical variance and effective sample size grow from accumulated data.
 * A small zero-mean bounded-return prior prevents a run of identical outcomes from claiming certainty.
 */
export function evaluateRegimeGate(
  observations: RegimeGateObservation[],
  policyVersion: string,
  previousPhase: RegimeGatePhase,
  settings: RegimeGateSettings,
): RegimeGateEvaluation {
  if (!settings.enabled) return {
    phase: 'disabled', allowsEntries: true, policyVersion, resolvedWindows: 0, effectiveWindows: 0,
    weightedMeanEdge: null, standardError: null, negativeReturnConfidence: null,
    reason: 'Adaptive regime gate is disabled.',
  };
  const current = observations.filter((item) => item.policyVersion === policyVersion && Number.isFinite(item.realizedEdge))
    .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
  if (!current.length) return {
    phase: 'warming', allowsEntries: true, policyVersion, resolvedWindows: 0, effectiveWindows: 0,
    weightedMeanEdge: null, standardError: null, negativeReturnConfidence: null,
    reason: `Adaptive regime gate warming: 0/${settings.minimumPolicyWindows} current-policy settlement windows.`,
  };
  const decay = Math.pow(0.5, 1 / settings.evidenceHalfLifeWindows);
  let sumWeights = 0, sumSquaredWeights = 0, weightedTotal = 0;
  current.forEach((item, index) => {
    const weight = Math.pow(decay, current.length - index - 1);
    sumWeights += weight;
    sumSquaredWeights += weight * weight;
    weightedTotal += weight * Math.max(-1, Math.min(1, item.realizedEdge));
  });
  const mean = weightedTotal / sumWeights;
  const effectiveWindows = sumWeights * sumWeights / sumSquaredWeights;
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
  if (!warmed) return {
    phase: 'warming', allowsEntries: true, policyVersion, resolvedWindows: current.length, effectiveWindows,
    weightedMeanEdge: mean, standardError, negativeReturnConfidence,
    reason: `Adaptive regime gate warming: ${current.length}/${settings.minimumPolicyWindows} current-policy settlement windows.`,
  };
  const wasClosed = previousPhase === 'closed';
  const closed = wasClosed
    ? negativeReturnConfidence >= settings.resumeConfidence
    : negativeReturnConfidence >= settings.pauseConfidence;
  const phase: RegimeGatePhase = closed ? 'closed' : 'open';
  return {
    phase, allowsEntries: !closed, policyVersion, resolvedWindows: current.length, effectiveWindows,
    weightedMeanEdge: mean, standardError, negativeReturnConfidence,
    reason: closed
      ? `New live entries are cooling off: ${(negativeReturnConfidence * 100).toFixed(1)}% confidence recent fee-aware return is negative. Sentinel evidence continues; entries reopen automatically below ${(settings.resumeConfidence * 100).toFixed(0)}%.`
      : wasClosed
        ? `Adaptive regime gate reopened automatically: negative-return confidence fell to ${(negativeReturnConfidence * 100).toFixed(1)}%.`
        : `Adaptive regime healthy: ${(negativeReturnConfidence * 100).toFixed(1)}% confidence recent fee-aware return is negative, below the ${(settings.pauseConfidence * 100).toFixed(1)}% pause threshold.`,
  };
}
