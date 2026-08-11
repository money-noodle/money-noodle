import { basisProbability, clampProbability, logit, normalCdf, normalInverseCdf, sigmoid } from './basis-model';
import type { CalibrationReplaySnapshot, ContractBasis, TrackedForecast, WalkForwardParameters } from './types';

export const CALIBRATION_REPLAY_VERSION = 'calibration-replay-v1';
export const PRODUCTION_BASIS_LOG_ODDS_WEIGHT = 0.55;
export const PRODUCTION_PROBABILITY_CAP = 0.03;

export const PRODUCTION_REPLAY_PARAMETERS: Pick<WalkForwardParameters, 'temperature' | 'basisWeight' | 'volatilityScale' | 'slowTiltScale' | 'probabilityCap'> = {
  temperature: 1,
  basisWeight: PRODUCTION_BASIS_LOG_ODDS_WEIGHT,
  volatilityScale: 1,
  slowTiltScale: 1,
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
  const basisLogOdds = basis === undefined ? 0 : logit(basis) * parameters.basisWeight;
  const totalLogOdds = (basisLogOdds + snapshot.slowTiltLogOdds * parameters.slowTiltScale) * parameters.temperature;
  return clampProbability(sigmoid(totalLogOdds), parameters.probabilityCap, 1 - parameters.probabilityCap);
}

export function createCalibrationReplaySnapshot(input: {
  basis?: ContractBasis;
  slowTiltLogOdds: number;
  slowTerms: Array<{ id: string; logOdds: number }>;
  productionProbabilityUp: number;
}): CalibrationReplaySnapshot {
  const snapshot: CalibrationReplaySnapshot = {
    version: CALIBRATION_REPLAY_VERSION,
    source: 'issuance-exact',
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
