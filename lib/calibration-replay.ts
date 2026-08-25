import { basisProbability, clampProbability, logit, normalCdf, normalInverseCdf } from './basis-model';
import { combineForecastProbability, PRODUCTION_FORECAST_MODEL } from './forecast-model';
import type { CalibrationReplaySnapshot, ConfidenceReplayInput, ContractBasis, TrackedForecast, WalkForwardParameters } from './types';

export const CALIBRATION_REPLAY_VERSION = 'calibration-replay-v1';
/** Compatibility exports for manifests and existing analysis code; the production literals live once. */
export const PRODUCTION_BASIS_LOG_ODDS_WEIGHT = PRODUCTION_FORECAST_MODEL.basisLogOddsWeight;
export const PRODUCTION_PROBABILITY_CAP = PRODUCTION_FORECAST_MODEL.probabilityFloor;

/**
 * Estimate quality as an explicit parameter set rather than an expression.
 *
 * `clockPenaltyMax` over `clockHorizonSeconds` is the implicit elapsed-time lift: the penalty decays as
 * a window runs down, so quality rises on the clock alone by up to that much. Because quality gates
 * entry at 50%, that decay decides which late-window trades pass. Naming it here does not change it —
 * these values reproduce production exactly — but it makes a replacement expressible and scorable,
 * which it was not while the numbers lived inside one expression.
 */
export interface ConfidenceParameters {
  base: number;
  basisBonus: number;
  venueBonus: number;
  sampleQualityMax: number;
  sampleQualitySamples: number;
  clockPenaltyMax: number;
  clockHorizonSeconds: number;
  missingBasisPenalty: number;
  rangePenaltyMax: number;
  rangePenaltyDivisor: number;
  floor: number;
  ceiling: number;
}

export const PRODUCTION_CONFIDENCE_PARAMETERS: ConfidenceParameters = {
  base: 0.30,
  basisBonus: 0.20,
  venueBonus: 0.04,
  sampleQualityMax: 0.22,
  sampleQualitySamples: 60,
  clockPenaltyMax: 0.12,
  clockHorizonSeconds: 900,
  missingBasisPenalty: 0.16,
  rangePenaltyMax: 0.04,
  rangePenaltyDivisor: 60,
  floor: 0.25,
  ceiling: 0.86,
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Reproduces production's estimate quality from the inputs it read. Verified against the stored
 * production value at issuance, the same contract the probability replay holds itself to.
 */
export function replayConfidence(input: ConfidenceReplayInput, parameters: ConfidenceParameters = PRODUCTION_CONFIDENCE_PARAMETERS): number {
  const dataQuality = (input.basisPresent ? parameters.basisBonus : 0) + (input.venueProbabilityCount ? parameters.venueBonus : 0);
  const sampleQuality = input.basisPresent
    ? Math.min(1, input.volatilitySamples / parameters.sampleQualitySamples) * parameters.sampleQualityMax : 0;
  const uncertaintyPenalty = Math.min(parameters.clockPenaltyMax, (input.secondsRemaining / parameters.clockHorizonSeconds) * parameters.clockPenaltyMax)
    + (input.basisPresent ? 0 : parameters.missingBasisPenalty)
    + Math.min(parameters.rangePenaltyMax, input.rangePercent / parameters.rangePenaltyDivisor);
  return clamp(parameters.base + dataQuality + sampleQuality - uncertaintyPenalty, parameters.floor, parameters.ceiling);
}

export const PRODUCTION_REPLAY_PARAMETERS: Pick<WalkForwardParameters, 'temperature' | 'basisWeight' | 'volatilityScale' | 'slowTiltScale' | 'probabilityCap'> = {
  temperature: PRODUCTION_FORECAST_MODEL.temperature,
  basisWeight: PRODUCTION_BASIS_LOG_ODDS_WEIGHT,
  volatilityScale: 1,
  slowTiltScale: PRODUCTION_FORECAST_MODEL.slowTiltScale,
  probabilityCap: PRODUCTION_PROBABILITY_CAP,
};

function scaledBasisProbability(snapshot: CalibrationReplaySnapshot, volatilityScale: number): number | undefined {
  if (snapshot.basisInput) {
    return basisProbability({
      ...snapshot.basisInput,
      volatilityPerSecond: snapshot.basisInput.volatilityPerSecond * volatilityScale,
    })?.probabilityUp;
  }
  if (snapshot.baselineBasisProbability === undefined) return undefined;
  if (volatilityScale === 1) return snapshot.baselineBasisProbability;
  // Historical rows predate exact raw input persistence. Scaling the baseline z-score is the unique
  // reconstruction available from a probability and is explicitly tagged as reconstructed.
  const z = normalInverseCdf(clampProbability(snapshot.baselineBasisProbability, 1e-6, 1 - 1e-6));
  return Number.isFinite(z) ? clampProbability(normalCdf(z / volatilityScale)) : snapshot.baselineBasisProbability;
}

export function replayCalibrationProbability(
  snapshot: CalibrationReplaySnapshot,
  parameters: Pick<WalkForwardParameters, 'temperature' | 'basisWeight' | 'volatilityScale' | 'slowTiltScale' | 'probabilityCap'>,
): number {
  const basis = scaledBasisProbability(snapshot, parameters.volatilityScale);
  return combineForecastProbability({
    basisProbabilityUp: basis,
    slowTiltLogOdds: snapshot.slowTiltLogOdds,
  }, {
    basisLogOddsWeight: parameters.basisWeight,
    slowTiltScale: parameters.slowTiltScale,
    temperature: parameters.temperature,
    probabilityFloor: parameters.probabilityCap,
    probabilityCeiling: 1 - parameters.probabilityCap,
  }).probabilityUp;
}

export function createCalibrationReplaySnapshot(input: {
  basis?: ContractBasis;
  slowTiltLogOdds: number;
  slowTerms: Array<{ id: string; logOdds: number }>;
  productionProbabilityUp: number;
  confidence?: { input: ConfidenceReplayInput; productionConfidence: number };
}): CalibrationReplaySnapshot {
  const snapshot: CalibrationReplaySnapshot = {
    version: CALIBRATION_REPLAY_VERSION,
    source: 'issuance-exact',
    confidenceSource: input.confidence ? 'issuance-exact' : 'absent',
    confidenceInput: input.confidence?.input,
    productionConfidence: input.confidence?.productionConfidence,
    confidenceReplayError: input.confidence
      ? Math.abs(replayConfidence(input.confidence.input) - input.confidence.productionConfidence) : undefined,
    basisInput: input.basis ? {
      referencePrice: input.basis.referencePrice,
      currentPrice: input.basis.currentPrice,
      secondsRemaining: input.basis.secondsRemaining,
      volatilityPerSecond: input.basis.volatilityPerSecond,
      volatilitySamples: input.basis.volatilitySamples,
    } : undefined,
    baselineBasisProbability: input.basis?.probabilityUp,
    basisLogOddsWeight: PRODUCTION_BASIS_LOG_ODDS_WEIGHT,
    slowTiltLogOdds: input.slowTiltLogOdds,
    slowTerms: input.slowTerms,
    probabilityFloor: PRODUCTION_PROBABILITY_CAP,
    probabilityCeiling: 1 - PRODUCTION_PROBABILITY_CAP,
    productionProbabilityUp: input.productionProbabilityUp,
    baselineReplayError: 0,
  };
  snapshot.baselineReplayError = Math.abs(replayCalibrationProbability(snapshot, PRODUCTION_REPLAY_PARAMETERS) - input.productionProbabilityUp);
  return snapshot;
}

export function calibrationReplayForForecast(forecast: TrackedForecast): CalibrationReplaySnapshot {
  if (forecast.calibrationReplay?.version === CALIBRATION_REPLAY_VERSION) return forecast.calibrationReplay;
  const basisProbability = forecast.basisProbabilityUp;
  const basisLogOdds = basisProbability === undefined ? 0 : logit(basisProbability) * PRODUCTION_BASIS_LOG_ODDS_WEIGHT;
  const slowTiltLogOdds = logit(forecast.probabilityUp) - basisLogOdds;
  const snapshot: CalibrationReplaySnapshot = {
    version: CALIBRATION_REPLAY_VERSION,
    source: 'historical-reconstruction',
    // Quality is deliberately not reconstructed. Its inputs include a venue count and a 24-hour range
    // that were never stored, and one recorded quality value cannot identify two unknown terms — any
    // value produced here would be invented, not recovered.
    confidenceSource: 'absent',
    baselineBasisProbability: basisProbability,
    basisLogOddsWeight: PRODUCTION_BASIS_LOG_ODDS_WEIGHT,
    slowTiltLogOdds,
    slowTerms: [],
    probabilityFloor: PRODUCTION_PROBABILITY_CAP,
    probabilityCeiling: 1 - PRODUCTION_PROBABILITY_CAP,
    productionProbabilityUp: forecast.probabilityUp,
    baselineReplayError: 0,
  };
  snapshot.baselineReplayError = Math.abs(replayCalibrationProbability(snapshot, PRODUCTION_REPLAY_PARAMETERS) - forecast.probabilityUp);
  return snapshot;
}
