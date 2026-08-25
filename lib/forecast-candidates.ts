import { replayCalibrationProbability, PRODUCTION_REPLAY_PARAMETERS } from './calibration-replay';
import { combineForecastProbability, PRODUCTION_FORECAST_MODEL } from './forecast-model';
import { productionMarketCapability } from './market-registry';
import {
  bestEntry, BUY_POLICY_VERSION, downEntryEnabled, maximumNetEdge, qualifiesAsBuyEdge, venueEntryOptions,
} from './prediction-policy';
import { TRADING_PROVIDER_REGISTRY_VERSION } from './trading-provider-registry';
import type {
  CalibrationReplaySnapshot, ForecastCandidateDecision, ForecastCandidateEntryObservation,
  ForecastCandidateEvaluation, Prediction, WalkForwardParameters,
} from './types';

/**
 * Prospectively declared probability family. These identities are durable evidence, not tuning labels: changing
 * any definition requires a new candidate and registry version rather than mutating one already collecting.
 */
export const FORECAST_CANDIDATE_REGISTRY_VERSION = 'forecast-candidate-registry-v1';

export const FORECAST_CANDIDATE_REGISTRY = Object.freeze([
  Object.freeze({ id: 'production-control-v1', modelVersion: PRODUCTION_FORECAST_MODEL.version }),
  Object.freeze({ id: 'basis065-slow050-v1', modelVersion: 'basis065-slow050-v1' }),
  Object.freeze({ id: 'settlement-average-v1', modelVersion: 'settlement-average-diffusion-v1' }),
  Object.freeze({ id: 'basis-only-v1', modelVersion: 'basis-only-v1' }),
  Object.freeze({ id: 'basis-intraday-v1', modelVersion: 'basis-intraday-production-cap-v1' }),
  Object.freeze({ id: 'slow-half-v1', modelVersion: 'production-basis-slow050-v1' }),
] as const);

const LOCKED_PARAMETERS: Pick<WalkForwardParameters,
  'temperature' | 'basisWeight' | 'volatilityScale' | 'slowTiltScale' | 'probabilityCap'> = Object.freeze({
    ...PRODUCTION_REPLAY_PARAMETERS,
    basisWeight: 0.65,
    slowTiltScale: 0.5,
  });

const SLOW_HALF_PARAMETERS: typeof LOCKED_PARAMETERS = Object.freeze({
  ...PRODUCTION_REPLAY_PARAMETERS,
  slowTiltScale: 0.5,
});

function entryObservation(entry: ReturnType<typeof venueEntryOptions>[number] | undefined): ForecastCandidateEntryObservation | undefined {
  if (!entry) return undefined;
  return {
    venue: entry.venue, side: entry.side, price: entry.price, feeRate: entry.feeRate,
    probability: entry.probability, netEdge: entry.netEdge,
  };
}

function unavailable(candidateId: typeof FORECAST_CANDIDATE_REGISTRY[number]['id'], reason: string): ForecastCandidateDecision {
  const descriptor = FORECAST_CANDIDATE_REGISTRY.find((candidate) => candidate.id === candidateId)!;
  return {
    candidateId, candidateModelVersion: descriptor.modelVersion,
    status: 'unavailable', unavailableReason: reason,
  };
}

function decide(
  prediction: Prediction,
  candidateId: typeof FORECAST_CANDIDATE_REGISTRY[number]['id'],
  probabilityUp: number,
  replayError?: number,
): ForecastCandidateDecision {
  const descriptor = FORECAST_CANDIDATE_REGISTRY.find((candidate) => candidate.id === candidateId)!;
  if (!Number.isFinite(probabilityUp) || probabilityUp <= 0 || probabilityUp >= 1) {
    return unavailable(candidateId, 'Candidate probability was non-finite or outside (0, 1).');
  }
  // Candidate policy comparison is narrowed to providers with implemented funded capability. Configuration may
  // narrow it further, but it can never make an unimplemented adapter look funded-capable.
  const candidatePrediction: Prediction = {
    ...prediction,
    modelProbabilityUp: probabilityUp,
    enabledTradingVenues: prediction.enabledTradingVenues.filter((venue) => productionMarketCapability(venue).live),
  };
  const options = venueEntryOptions(candidatePrediction);
  return {
    candidateId,
    candidateModelVersion: descriptor.modelVersion,
    status: 'available',
    probabilityUp,
    replayError,
    bestOption: entryObservation(options[0]),
    selectedEntry: entryObservation(bestEntry(candidatePrediction)),
    qualified: qualifiesAsBuyEdge(candidatePrediction),
  };
}

function exactReplaySnapshot(prediction: Prediction): CalibrationReplaySnapshot | undefined {
  const snapshot = prediction.calibrationReplay;
  if (!snapshot || snapshot.source !== 'issuance-exact') return undefined;
  if (!Number.isFinite(snapshot.baselineReplayError) || snapshot.baselineReplayError > 1e-12) return undefined;
  return snapshot;
}

/**
 * Stamps the complete Phase 2 family at issuance. Pure, synchronous, and observation-only: callers persist the
 * return value beside a forecast, while no forecast, policy, portfolio, sizing, or order function imports it.
 */
export function evaluateForecastCandidates(prediction: Prediction): ForecastCandidateEvaluation {
  const snapshot = exactReplaySnapshot(prediction);
  const decisions: ForecastCandidateDecision[] = [
    decide(
      prediction,
      'production-control-v1',
      prediction.modelProbabilityUp,
      prediction.calibrationReplay?.baselineReplayError,
    ),
  ];

  if (!snapshot) {
    const reason = prediction.calibrationReplay
      ? `Issuance replay error ${prediction.calibrationReplay.baselineReplayError} exceeded 1e-12.`
      : 'Issuance-exact calibration replay was unavailable.';
    for (const candidate of FORECAST_CANDIDATE_REGISTRY.slice(1)) decisions.push(unavailable(candidate.id, reason));
  } else {
    decisions.push(decide(
      prediction,
      'basis065-slow050-v1',
      replayCalibrationProbability(snapshot, LOCKED_PARAMETERS),
    ));

    decisions.push(prediction.settlementAverageEstimate
      ? decide(prediction, 'settlement-average-v1', combineForecastProbability({
        basisProbabilityUp: prediction.settlementAverageEstimate.probabilityUp,
        slowTiltLogOdds: snapshot.slowTiltLogOdds,
      }, PRODUCTION_FORECAST_MODEL).probabilityUp)
      : unavailable('settlement-average-v1', 'Settlement-average estimate was unavailable at issuance.'));

    decisions.push(decide(prediction, 'basis-only-v1', replayCalibrationProbability({
      ...snapshot,
      slowTiltLogOdds: 0,
    }, PRODUCTION_REPLAY_PARAMETERS)));

    const intraday = snapshot.slowTerms.find((term) => term.id === 'intraday');
    decisions.push(intraday
      ? decide(prediction, 'basis-intraday-v1', replayCalibrationProbability({
        ...snapshot,
        // This candidate intentionally retains the issuance-time production-cap scaling applied to the term.
        slowTiltLogOdds: intraday.logOdds,
      }, PRODUCTION_REPLAY_PARAMETERS))
      : unavailable('basis-intraday-v1', 'Issuance replay did not contain the intraday slow term.'));

    decisions.push(decide(
      prediction,
      'slow-half-v1',
      replayCalibrationProbability(snapshot, SLOW_HALF_PARAMETERS),
    ));
  }

  return {
    registryVersion: FORECAST_CANDIDATE_REGISTRY_VERSION,
    providerRegistryVersion: TRADING_PROVIDER_REGISTRY_VERSION,
    productionModelVersion: PRODUCTION_FORECAST_MODEL.version,
    policyVersion: BUY_POLICY_VERSION,
    maximumNetEdge: maximumNetEdge(),
    downEntryEnabled: downEntryEnabled(),
    confidence: prediction.confidence,
    decisions,
  };
}
