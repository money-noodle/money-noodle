import { calibrationReplayForForecast, replayCalibrationProbability } from './calibration-replay';
import type { CalibrationReplaySnapshot, TrackedForecast, WalkForwardEvaluationRun, WalkForwardParameters, WalkForwardScore } from './types';

export const WALK_FORWARD_POLICY_VERSION = 'expanding-window-v2-replay';
export const WALK_FORWARD_ACTIVATION_WINDOWS = 100;
export const WALK_FORWARD_CHECKPOINT_WINDOWS = 25;
export const WALK_FORWARD_FOLDS = 5;
export const WALK_FORWARD_TARGET_SECONDS_REMAINING = 300;

export interface EvaluationRow {
  id: string;
  symbol: string;
  closesAt: string;
  probabilityUp: number;
  basisProbabilityUp?: number;
  calibrationReplay: CalibrationReplaySnapshot;
  confidence: number;
  entrySide: 'UP' | 'DOWN';
  entryAsk?: number;
  entryFeeRate: number;
  entryVenue?: 'polymarket' | 'kalshi';
  evaluationVenue: 'polymarket' | 'kalshi';
  targetIntegrity: 'venue-specific' | 'legacy-polymarket' | 'missing-provenance' | 'mismatched-outcome';
  outcome: 'UP' | 'DOWN';
}

export interface EvaluationWindow {
  closesAt: string;
  rows: EvaluationRow[];
}

export const PRODUCTION_BASELINE_PARAMETERS: WalkForwardParameters = {
  temperature: 1,
  basisWeight: 0.55,
  volatilityScale: 1,
  slowTiltScale: 1,
  probabilityCap: 0.03,
  minimumEdge: 0.05,
  minimumQuality: 0.5,
};

const temperatures = [0.9, 1, 1.1];
const basisWeights = [0.45, 0.55, 0.65];
const volatilityScales = [0.8, 1, 1.2];
const slowTiltScales = [0.5, 1, 1.5];
const probabilityCaps = [0.03, 0.05];
const minimumEdges = [0.05, 0.08];
const minimumQualities = [0.5, 0.6];
export const WALK_FORWARD_CANDIDATES: WalkForwardParameters[] = temperatures.flatMap((temperature) =>
  basisWeights.flatMap((basisWeight) => volatilityScales.flatMap((volatilityScale) =>
    slowTiltScales.flatMap((slowTiltScale) => probabilityCaps.flatMap((probabilityCap) =>
      minimumEdges.flatMap((minimumEdge) => minimumQualities.map((minimumQuality) => ({
        temperature, basisWeight, volatilityScale, slowTiltScale, probabilityCap, minimumEdge, minimumQuality,
      }))))))));

const clampProbability = (value: number) => Math.min(0.999999, Math.max(0.000001, value));

export function candidateProbability(row: EvaluationRow, parameters: WalkForwardParameters): number {
  return clampProbability(replayCalibrationProbability(row.calibrationReplay, parameters));
}

/** One fixed-horizon snapshot per asset/window prevents repeated updates from becoming fake samples. */
export function buildWalkForwardDataset(forecasts: TrackedForecast[]): EvaluationWindow[] {
  const assetWindows = new Map<string, TrackedForecast[]>();
  for (const forecast of forecasts) {
    if (forecast.status !== 'resolved' || (forecast.outcome !== 'UP' && forecast.outcome !== 'DOWN')) continue;
    const timestamp = Date.parse(forecast.closesAt);
    if (!Number.isFinite(timestamp)) continue;
    const closesAt = new Date(timestamp).toISOString();
    const key = `${forecast.symbol}:${closesAt}`;
    assetWindows.set(key, [...(assetWindows.get(key) ?? []), forecast]);
  }
  const windows = new Map<string, EvaluationRow[]>();
  for (const forecastsInAssetWindow of assetWindows.values()) {
    const selected = [...forecastsInAssetWindow].sort((a, b) => {
      const aRemaining = a.secondsRemaining ?? (Date.parse(a.closesAt) - Date.parse(a.issuedAt)) / 1000;
      const bRemaining = b.secondsRemaining ?? (Date.parse(b.closesAt) - Date.parse(b.issuedAt)) / 1000;
      return Math.abs(aRemaining - WALK_FORWARD_TARGET_SECONDS_REMAINING) - Math.abs(bRemaining - WALK_FORWARD_TARGET_SECONDS_REMAINING)
        || Date.parse(a.issuedAt) - Date.parse(b.issuedAt);
    })[0];
    const closesAt = new Date(Date.parse(selected.closesAt)).toISOString();
    windows.set(closesAt, [...(windows.get(closesAt) ?? []), {
      id: selected.id, symbol: selected.symbol, closesAt,
      probabilityUp: selected.probabilityUp, basisProbabilityUp: selected.basisProbabilityUp,
      calibrationReplay: calibrationReplayForForecast(selected),
      confidence: selected.confidence, entrySide: selected.entrySide ?? 'UP', entryAsk: selected.entryAsk, entryFeeRate: selected.entryFeeRate ?? 0,
      entryVenue: selected.entryVenue, evaluationVenue: selected.evaluationVenue ?? 'polymarket',
      targetIntegrity: selected.targetIntegrity ?? 'legacy-polymarket', outcome: selected.outcome!,
    }]);
  }
  return [...windows.entries()].map(([closesAt, rows]) => ({ closesAt, rows: rows.sort((a, b) => a.symbol.localeCompare(b.symbol)) }))
    .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
}

interface SelectedTrade { result: number }

function selectedTrade(window: EvaluationWindow, parameters: WalkForwardParameters): SelectedTrade | null {
  const candidates = window.rows.flatMap((row) => {
    // Real production rows with an identified entry venue must have a venue-specific matching target.
    // Synthetic evaluator fixtures without an entry venue remain useful for pure scoring tests.
    if (row.entryVenue && (row.targetIntegrity !== 'venue-specific' || row.evaluationVenue !== row.entryVenue)) return [];
    if (row.entryAsk === undefined || row.entryAsk < 0.05 || row.entryAsk > 0.97 || row.confidence < parameters.minimumQuality) return [];
    const probability = candidateProbability(row, parameters);
    const cost = row.entryAsk + row.entryFeeRate;
    const sideProbability = row.entrySide === 'UP' ? probability : 1 - probability;
    const edge = sideProbability - cost;
    return edge >= parameters.minimumEdge ? [{ edge, result: (row.outcome === row.entrySide ? 1 : 0) - cost }] : [];
  });
  // Select only the largest apparent edge in each correlated window. This makes the winner's curse
  // part of the out-of-sample result rather than treating all selected assets as independent wins.
  return candidates.sort((a, b) => b.edge - a.edge)[0] ?? null;
}

export function scoreWalkForward(windows: EvaluationWindow[], parameters: WalkForwardParameters): WalkForwardScore {
  let observations = 0;
  let brier = 0;
  let logLoss = 0;
  let winningTrades = 0;
  const returns: number[] = [];
  for (const window of windows) {
    for (const row of window.rows) {
      const probability = candidateProbability(row, parameters);
      const actual = row.outcome === 'UP' ? 1 : 0;
      brier += (probability - actual) ** 2;
      logLoss += -(actual * Math.log(probability) + (1 - actual) * Math.log(1 - probability));
      observations += 1;
    }
    const trade = selectedTrade(window, parameters);
    returns.push(trade?.result ?? 0);
    if (trade && trade.result > 0) winningTrades += 1;
  }
  let cumulative = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const result of returns) {
    cumulative += result;
    peak = Math.max(peak, cumulative);
    maximumDrawdown = Math.max(maximumDrawdown, peak - cumulative);
  }
  const trades = returns.filter((value) => value !== 0).length;
  return {
    windows: windows.length, observations, trades, winningTrades,
    meanWindowReturn: windows.length ? returns.reduce((sum, value) => sum + value, 0) / windows.length : 0,
    brierScore: observations ? brier / observations : null,
    logLoss: observations ? logLoss / observations : null,
    maximumDrawdown,
  };
}

function parameterKey(parameters: WalkForwardParameters): string {
  return `${parameters.temperature}:${parameters.basisWeight}:${parameters.volatilityScale}:${parameters.slowTiltScale}:${parameters.probabilityCap}:${parameters.minimumEdge}:${parameters.minimumQuality}`;
}

function minimumTrainingTrades(windows: number): number {
  return Math.max(5, Math.floor(windows * 0.1));
}

export function fitWalkForwardCandidate(training: EvaluationWindow[]): WalkForwardParameters {
  return [...WALK_FORWARD_CANDIDATES].sort((a, b) => {
    const aScore = scoreWalkForward(training, a);
    const bScore = scoreWalkForward(training, b);
    const aEligible = aScore.trades >= minimumTrainingTrades(training.length);
    const bEligible = bScore.trades >= minimumTrainingTrades(training.length);
    if (aEligible !== bEligible) return aEligible ? -1 : 1;
    return bScore.meanWindowReturn - aScore.meanWindowReturn
      || (aScore.brierScore ?? Infinity) - (bScore.brierScore ?? Infinity)
      || parameterKey(a).localeCompare(parameterKey(b));
  })[0];
}

function combineScores(scores: WalkForwardScore[]): WalkForwardScore {
  const windows = scores.reduce((sum, score) => sum + score.windows, 0);
  const observations = scores.reduce((sum, score) => sum + score.observations, 0);
  const trades = scores.reduce((sum, score) => sum + score.trades, 0);
  return {
    windows, observations, trades,
    winningTrades: scores.reduce((sum, score) => sum + score.winningTrades, 0),
    meanWindowReturn: windows ? scores.reduce((sum, score) => sum + score.meanWindowReturn * score.windows, 0) / windows : 0,
    brierScore: observations ? scores.reduce((sum, score) => sum + (score.brierScore ?? 0) * score.observations, 0) / observations : null,
    logLoss: observations ? scores.reduce((sum, score) => sum + (score.logLoss ?? 0) * score.observations, 0) / observations : null,
    maximumDrawdown: Math.max(0, ...scores.map((score) => score.maximumDrawdown)),
  };
}

function fingerprint(windows: EvaluationWindow[]): string {
  const text = windows.flatMap((window) => window.rows.map((row) => `${row.id}|${row.outcome}|${row.probabilityUp}|${JSON.stringify(row.calibrationReplay)}`)).join('\n');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function runWalkForwardEvaluation(dataset: EvaluationWindow[], checkpointWindows: number, generatedAt = new Date().toISOString()): WalkForwardEvaluationRun {
  if (checkpointWindows < WALK_FORWARD_ACTIVATION_WINDOWS || dataset.length < checkpointWindows) throw new Error(`Walk-forward evaluation requires ${checkpointWindows} resolved windows.`);
  const windows = dataset.slice(0, checkpointWindows);
  const initialTrainingWindows = Math.floor(windows.length / 2);
  const remaining = windows.length - initialTrainingWindows;
  const baseFoldSize = Math.floor(remaining / WALK_FORWARD_FOLDS);
  const extra = remaining % WALK_FORWARD_FOLDS;
  let testStart = initialTrainingWindows;
  const folds = [];
  for (let index = 0; index < WALK_FORWARD_FOLDS; index += 1) {
    const testSize = baseFoldSize + (index < extra ? 1 : 0);
    const training = windows.slice(0, testStart);
    const testing = windows.slice(testStart, testStart + testSize);
    const selectedParameters = fitWalkForwardCandidate(training);
    folds.push({
      index: index + 1, trainingWindows: training.length, testingWindows: testing.length,
      testStartsAt: testing[0].closesAt, testEndsAt: testing.at(-1)!.closesAt,
      selectedParameters,
      baseline: scoreWalkForward(testing, PRODUCTION_BASELINE_PARAMETERS),
      candidate: scoreWalkForward(testing, selectedParameters),
    });
    testStart += testSize;
  }
  const baseline = combineScores(folds.map((fold) => fold.baseline));
  const candidate = combineScores(folds.map((fold) => fold.candidate));
  const selectionMap = new Map<string, { parameters: WalkForwardParameters; folds: number }>();
  for (const fold of folds) {
    const key = parameterKey(fold.selectedParameters);
    const current = selectionMap.get(key);
    selectionMap.set(key, { parameters: fold.selectedParameters, folds: (current?.folds ?? 0) + 1 });
  }
  const parameterSelectionCounts = [...selectionMap.values()].sort((a, b) => b.folds - a.folds || parameterKey(a.parameters).localeCompare(parameterKey(b.parameters)));
  const positiveCandidateFolds = folds.filter((fold) => fold.candidate.meanWindowReturn > 0).length;
  const candidateBeatBaselineFolds = folds.filter((fold) => fold.candidate.meanWindowReturn > fold.baseline.meanWindowReturn).length;
  const enoughTrades = candidate.trades >= 10;
  const passed = enoughTrades && candidate.meanWindowReturn > 0 && candidate.meanWindowReturn > baseline.meanWindowReturn
    && positiveCandidateFolds >= 4 && candidateBeatBaselineFolds >= 3 && (parameterSelectionCounts[0]?.folds ?? 0) >= 3;
  const decision = !enoughTrades ? 'insufficient_test_trades' : passed ? 'candidate_passed_review_thresholds' : 'baseline_retained';
  const reason = !enoughTrades
    ? `Only ${candidate.trades} out-of-sample candidate trades; at least 10 are required.`
    : passed
      ? `Candidate selection beat baseline in ${candidateBeatBaselineFolds}/${WALK_FORWARD_FOLDS} folds, was positive in ${positiveCandidateFolds}/${WALK_FORWARD_FOLDS}, and its modal parameters appeared in ${parameterSelectionCounts[0].folds}/${WALK_FORWARD_FOLDS} folds. Manual review is required; production was not changed.`
      : `Candidate selection did not clear profitability and stability thresholds: beat baseline ${candidateBeatBaselineFolds}/${WALK_FORWARD_FOLDS}, positive ${positiveCandidateFolds}/${WALK_FORWARD_FOLDS}, modal parameters ${parameterSelectionCounts[0]?.folds ?? 0}/${WALK_FORWARD_FOLDS}.`;
  const replayRows = windows.flatMap((window) => window.rows);
  return {
    id: `walk-forward:${checkpointWindows}:${fingerprint(windows)}`,
    policyVersion: WALK_FORWARD_POLICY_VERSION, generatedAt, checkpointWindows,
    datasetFingerprint: fingerprint(windows), datasetStartsAt: windows[0].closesAt, datasetEndsAt: windows.at(-1)!.closesAt,
    exactReplayObservations: replayRows.filter((row) => row.calibrationReplay.source === 'issuance-exact').length,
    reconstructedReplayObservations: replayRows.filter((row) => row.calibrationReplay.source === 'historical-reconstruction').length,
    maximumBaselineReplayError: Math.max(0, ...replayRows.map((row) => row.calibrationReplay.baselineReplayError)),
    exactConfidenceReplayObservations: replayRows.filter((row) => row.calibrationReplay.confidenceSource === 'issuance-exact').length,
    absentConfidenceReplayObservations: replayRows.filter((row) => row.calibrationReplay.confidenceSource !== 'issuance-exact').length,
    maximumConfidenceReplayError: Math.max(0, ...replayRows.map((row) => row.calibrationReplay.confidenceReplayError ?? 0)),
    folds, baseline, candidate,
    recommendedParameters: fitWalkForwardCandidate(windows), parameterSelectionCounts,
    positiveCandidateFolds, candidateBeatBaselineFolds, decision, reason, productionChanged: false,
  };
}
