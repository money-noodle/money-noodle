import {
  basisProbability,
  combinedProbability,
  bestEntry,
  type Quote,
  type Entry,
} from './forecast.js';
export interface ConfidenceInput {
  basisPresent: boolean;
  venueProbabilityCount: number;
  volatilitySamples: number;
  secondsRemaining: number;
  rangePercent: number;
}
export interface BasisInput {
  referencePrice: number;
  currentPrice: number;
  secondsRemaining: number;
  volatilityPerSecond: number;
  volatilitySamples: number;
}
export interface CalibrationSnapshot {
  version: 'calibration-replay-v1';
  source: 'issuance-exact' | 'historical-reconstruction';
  confidenceSource: 'issuance-exact' | 'absent';
  confidenceInput?: ConfidenceInput;
  productionConfidence?: number;
  confidenceReplayError?: number;
  basisInput?: BasisInput;
  baselineBasisProbability?: number;
  basisLogOddsWeight: number;
  slowTiltLogOdds: number;
  slowTerms: readonly { id: string; logOdds: number }[];
  probabilityFloor: number;
  probabilityCeiling: number;
  productionProbabilityUp: number;
  baselineReplayError: number;
}
/** Separate replay consumes persisted raw inputs, not production's derived probability. */
export function replayConfidence(input: ConfidenceInput): number {
  const data = (input.basisPresent ? 0.2 : 0) + (input.venueProbabilityCount ? 0.04 : 0);
  const samples = input.basisPresent ? Math.min(1, input.volatilitySamples / 60) * 0.22 : 0;
  const penalty =
    Math.min(0.12, (input.secondsRemaining / 900) * 0.12) +
    (input.basisPresent ? 0 : 0.16) +
    Math.min(0.04, input.rangePercent / 60);
  return Math.max(0.25, Math.min(0.86, 0.3 + data + samples - penalty));
}
export function replayProbability(
  snapshot: CalibrationSnapshot,
  weight = 0.55,
  slowScale = 1,
): number {
  const raw = snapshot.basisInput;
  const basis = raw
    ? basisProbability(
        raw.referencePrice,
        raw.currentPrice,
        raw.secondsRemaining,
        raw.volatilityPerSecond,
      )
    : (snapshot.baselineBasisProbability ?? null);
  return combinedProbability(basis, snapshot.slowTiltLogOdds, weight, slowScale);
}
export function issuanceSnapshot(input: {
  basisInput?: BasisInput;
  basisProbability: number | null;
  slowTiltLogOdds: number;
  slowTerms: CalibrationSnapshot['slowTerms'];
  probability: number;
  confidence: number;
  confidenceInput: ConfidenceInput;
}): CalibrationSnapshot {
  const raw = input.basisInput;
  if (raw && Object.values(raw).some((n) => !Number.isFinite(n)))
    throw Error('Non-finite issuance basis evidence.');
  const snapshot: CalibrationSnapshot = {
    version: 'calibration-replay-v1',
    source: 'issuance-exact',
    confidenceSource: 'issuance-exact',
    confidenceInput: input.confidenceInput,
    productionConfidence: input.confidence,
    confidenceReplayError: Math.abs(replayConfidence(input.confidenceInput) - input.confidence),
    ...(raw
      ? { basisInput: { ...raw }, baselineBasisProbability: input.basisProbability ?? undefined }
      : {}),
    basisLogOddsWeight: 0.55,
    slowTiltLogOdds: input.slowTiltLogOdds,
    slowTerms: input.slowTerms,
    probabilityFloor: 0.03,
    probabilityCeiling: 0.97,
    productionProbabilityUp: input.probability,
    baselineReplayError: 0,
  };
  snapshot.baselineReplayError = Math.abs(replayProbability(snapshot) - input.probability);
  return snapshot;
}
/** Older rows are labelled reconstruction, never invented raw/confidence inputs. */
export function reconstructedSnapshot(probability: number, basis?: number): CalibrationSnapshot {
  const clamp = (p: number) => Math.max(1e-6, Math.min(1 - 1e-6, p));
  const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));
  const snapshot: CalibrationSnapshot = {
    version: 'calibration-replay-v1',
    source: 'historical-reconstruction',
    confidenceSource: 'absent',
    baselineBasisProbability: basis,
    basisLogOddsWeight: 0.55,
    slowTiltLogOdds: logit(probability) - (basis === undefined ? 0 : logit(basis) * 0.55),
    slowTerms: [],
    probabilityFloor: 0.03,
    probabilityCeiling: 0.97,
    productionProbabilityUp: probability,
    baselineReplayError: 0,
  };
  snapshot.baselineReplayError = Math.abs(replayProbability(snapshot) - probability);
  return snapshot;
}
export interface CandidateDecision {
  candidateId: string;
  candidateModelVersion: string;
  status: 'available' | 'unavailable';
  unavailableReason?: string;
  probabilityUp?: number;
  replayError?: number;
  selectedEntry?: Entry;
  qualified?: boolean;
}
export interface CandidateEvaluation {
  registryVersion: string;
  providerRegistryVersion: string;
  productionModelVersion: string;
  policyVersion: string;
  maximumNetEdge: number;
  downEntryEnabled: boolean;
  confidence: number;
  controlSource: 'restored-paper-registry';
  enabledResearchVenues: readonly string[];
  entrySemantics: 'public-quote-observation-only-v2';
  decisions: readonly CandidateDecision[];
}
const FAMILY = [
  ['production-control-v1', 'Blend 0.4'],
  ['basis065-slow050-observation-v2', 'basis065-slow050-v1'],
  ['settlement-average-observation-v2', 'settlement-average-diffusion-v1'],
  ['basis-only-observation-v2', 'basis-only-v1'],
  ['basis-intraday-observation-v2', 'basis-intraday-production-cap-v1'],
  ['slow-half-observation-v2', 'production-basis-slow050-v1'],
] as const;
export function candidateEvidence(
  snapshot: CalibrationSnapshot,
  quotes: readonly Quote[],
  settlement: number | null,
  confidence: number,
): CandidateEvaluation {
  const exact =
    snapshot.source === 'issuance-exact' &&
    Number.isFinite(snapshot.baselineReplayError) &&
    snapshot.baselineReplayError <= 1e-12 &&
    snapshot.confidenceSource === 'issuance-exact' &&
    Number.isFinite(snapshot.confidenceReplayError) &&
    snapshot.confidenceReplayError! <= 1e-12;
  const probabilities = [
    snapshot.productionProbabilityUp,
    replayProbability(snapshot, 0.65, 0.5),
    settlement === null ? null : combinedProbability(settlement, snapshot.slowTiltLogOdds),
    replayProbability({ ...snapshot, slowTiltLogOdds: 0 }),
    replayProbability({
      ...snapshot,
      slowTiltLogOdds: snapshot.slowTerms.find((t) => t.id === 'intraday')?.logOdds ?? 0,
    }),
    replayProbability(snapshot, 0.55, 0.5),
  ];
  const decisions = FAMILY.map(([candidateId, candidateModelVersion], index): CandidateDecision => {
    const reason =
      index > 0 && !exact
        ? 'Issuance-exact probability/confidence replay unavailable or error exceeded 1e-12.'
        : index === 2 && settlement === null
          ? 'Settlement-average estimate unavailable at issuance.'
          : index === 4 && !snapshot.slowTerms.some((t) => t.id === 'intraday')
            ? 'Intraday issuance term unavailable.'
            : undefined;
    if (reason)
      return {
        candidateId,
        candidateModelVersion,
        status: 'unavailable',
        unavailableReason: reason,
      };
    const probabilityUp = probabilities[index]!;
    if (probabilityUp === null || !Number.isFinite(probabilityUp))
      return {
        candidateId,
        candidateModelVersion,
        status: 'unavailable',
        unavailableReason: 'Invalid candidate probability.',
      };
    const selectedEntry = bestEntry(probabilityUp, quotes);
    return {
      candidateId,
      candidateModelVersion,
      status: 'available',
      probabilityUp,
      replayError: index === 0 ? snapshot.baselineReplayError : undefined,
      selectedEntry,
      qualified: confidence >= 0.5 && selectedEntry !== undefined && selectedEntry.netEdge >= 0.05,
    };
  });
  return {
    registryVersion: 'forecast-candidate-registry-observation-v2',
    providerRegistryVersion: 'restored-paper-provider-registry-observation-v2',
    productionModelVersion: 'Blend 0.4',
    policyVersion: 'binary-public-quote-research-net5-quality50-v2',
    maximumNetEdge: 1,
    downEntryEnabled: true,
    confidence,
    controlSource: 'restored-paper-registry',
    enabledResearchVenues: quotes.map((q) => q.contract.venue),
    entrySemantics: 'public-quote-observation-only-v2',
    decisions,
  };
}
