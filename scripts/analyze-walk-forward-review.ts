/*
 * Measure: reproduce the latest immutable walk-forward run, then evaluate its baseline-versus-candidate
 * difference on every held-out settlement window rather than treating fold aggregates as independent.
 * Deciding correction: paired standard errors cluster on `closesAt`; the 648-parameter search is selected
 * only on each fold's training prefix, while repeated overlapping checkpoint reviews are reported as a
 * separate multiple-look cost rather than mistaken for new evidence.
 * Known biases: both arms buy the stored production-selected side at the issuance ask and hold; neither
 * models maker fills, exits, persistence, portfolio capacity or budget reuse. Matching selected rows to
 * actual orders is coverage telemetry only, not an execution counterfactual, because production chose
 * which intents could acquire execution evidence.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getForecastHistory } from '../lib/forecast-tracker';
import { evaluatePromotionEligibility } from '../lib/model-promotion';
import type { PaperOrder, WalkForwardEvaluationHistory, WalkForwardParameters } from '../lib/types';
import {
  PRODUCTION_BASELINE_PARAMETERS, WALK_FORWARD_CANDIDATES, WALK_FORWARD_FOLDS,
  buildWalkForwardDataset, candidateProbability, runWalkForwardEvaluation, selectedTrade,
} from '../lib/walk-forward';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'model-evaluations.json');
const ORDER_FILE = path.join(DATA_DIR, 'paper-orders.json');

interface WindowReview {
  closesAt: string;
  baselineReturn: number;
  candidateReturn: number;
  baselineBrier: number;
  candidateBrier: number;
  baselineLogLoss: number;
  candidateLogLoss: number;
  baselineTrade: ReturnType<typeof selectedTrade>;
  candidateTrade: ReturnType<typeof selectedTrade>;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardError(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function paired(values: WindowReview[], pick: (row: WindowReview) => number) {
  const differences = values.map(pick);
  return { windows: differences.length, meanDifference: mean(differences), standardError: standardError(differences) };
}

function contiguousMaximumDrawdown(returns: number[]): number {
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of returns) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    drawdown = Math.max(drawdown, peak - cumulative);
  }
  return drawdown;
}

function probabilityLosses(window: ReturnType<typeof buildWalkForwardDataset>[number], parameters: WalkForwardParameters) {
  const rows = window.rows.map((row) => {
    const probability = candidateProbability(row, parameters);
    const actual = row.outcome === 'UP' ? 1 : 0;
    return {
      brier: (probability - actual) ** 2,
      logLoss: -(actual * Math.log(probability) + (1 - actual) * Math.log(1 - probability)),
    };
  });
  return { brier: mean(rows.map((row) => row.brier)), logLoss: mean(rows.map((row) => row.logLoss)) };
}

function tradeKey(trade: NonNullable<ReturnType<typeof selectedTrade>>, closesAt: string): string {
  return `${trade.symbol}|${closesAt}|${trade.side}`;
}

const history = JSON.parse(await readFile(HISTORY_FILE, 'utf8')) as WalkForwardEvaluationHistory;
const stored = history.runs.at(-1);
if (!stored) throw new Error('No walk-forward run is stored.');

const dataset = buildWalkForwardDataset(await getForecastHistory());
const reproduced = runWalkForwardEvaluation(dataset, stored.checkpointWindows, stored.generatedAt);
const scoreFields = ['baseline', 'candidate', 'recommendedParameters', 'parameterSelectionCounts', 'positiveCandidateFolds', 'candidateBeatBaselineFolds', 'decision'] as const;
const differingFields = scoreFields.filter((field) => JSON.stringify(reproduced[field]) !== JSON.stringify(stored[field]));

const windows = dataset.slice(0, stored.checkpointWindows);
let cursor = Math.floor(windows.length / 2);
const reviews: WindowReview[] = [];
for (const fold of reproduced.folds) {
  const testing = windows.slice(cursor, cursor + fold.testingWindows);
  for (const window of testing) {
    const baselineTrade = selectedTrade(window, PRODUCTION_BASELINE_PARAMETERS);
    const candidateTrade = selectedTrade(window, fold.selectedParameters);
    const baselineLoss = probabilityLosses(window, PRODUCTION_BASELINE_PARAMETERS);
    const candidateLoss = probabilityLosses(window, fold.selectedParameters);
    reviews.push({
      closesAt: window.closesAt,
      baselineReturn: baselineTrade?.result ?? 0,
      candidateReturn: candidateTrade?.result ?? 0,
      baselineBrier: baselineLoss.brier,
      candidateBrier: candidateLoss.brier,
      baselineLogLoss: baselineLoss.logLoss,
      candidateLogLoss: candidateLoss.logLoss,
      baselineTrade,
      candidateTrade,
    });
  }
  cursor += fold.testingWindows;
}

type SelectionCategory = 'sameTrade' | 'differentTrade' | 'baselineOnly' | 'candidateOnly' | 'neither';
function selectionCategory(row: WindowReview): SelectionCategory {
  if (!row.baselineTrade && !row.candidateTrade) return 'neither';
  if (!row.baselineTrade) return 'candidateOnly';
  if (!row.candidateTrade) return 'baselineOnly';
  if (row.baselineTrade.rowId === row.candidateTrade.rowId && row.baselineTrade.side === row.candidateTrade.side) return 'sameTrade';
  return 'differentTrade';
}
const categoryNames: SelectionCategory[] = ['sameTrade', 'differentTrade', 'baselineOnly', 'candidateOnly', 'neither'];
const categories = Object.fromEntries(categoryNames.map((category) => [category, reviews.filter((row) => selectionCategory(row) === category).length]));
const returnDifferenceBySelection = Object.fromEntries(categoryNames.map((category) => {
  const differences = reviews.filter((row) => selectionCategory(row) === category)
    .map((row) => row.candidateReturn - row.baselineReturn);
  return [category, { windows: differences.length, totalDifference: differences.reduce((sum, value) => sum + value, 0), meanDifference: mean(differences) }];
}));

const orderLedger = JSON.parse(await readFile(ORDER_FILE, 'utf8')) as { orders: PaperOrder[] };
const orderKeys = new Map<'live' | 'paper', Set<string>>([['live', new Set()], ['paper', new Set()]]);
for (const order of orderLedger.orders) {
  if (order.strategyId !== 'edge-binary-buy') continue;
  orderKeys.get(order.executionMode)!.add(`${order.symbol}|${new Date(order.closesAt).toISOString()}|${order.side}`);
}
const candidateSelections = reviews.flatMap((row) => row.candidateTrade ? [{ row, trade: row.candidateTrade }] : []);

const priorPasses = history.runs.filter((run) => run.decision === 'candidate_passed_review_thresholds');
const latestParameters = JSON.stringify(stored.recommendedParameters);
const sameRecommendedCheckpoints = history.runs.filter((run) => JSON.stringify(run.recommendedParameters) === latestParameters);
const storedEligibility = evaluatePromotionEligibility(stored);
const reproducedEligibility = evaluatePromotionEligibility(reproduced);

const output = {
  generatedAt: new Date().toISOString(),
  reproduction: {
    storedId: stored.id,
    reproducedId: reproduced.id,
    storedFingerprint: stored.datasetFingerprint,
    reproducedFingerprint: reproduced.datasetFingerprint,
    checkpointWindows: reproduced.checkpointWindows,
    datasetWindowsAvailable: dataset.length,
    datasetStartsAt: reproduced.datasetStartsAt,
    datasetEndsAt: reproduced.datasetEndsAt,
    exactMatch: reproduced.id === stored.id && differingFields.length === 0,
    differingFields,
  },
  searchAndLooks: {
    candidateParameterSets: WALK_FORWARD_CANDIDATES.length,
    folds: WALK_FORWARD_FOLDS,
    durableCheckpointRuns: history.runs.length,
    checkpointRunsPassingReview: priorPasses.length,
    firstPassingCheckpoint: priorPasses[0]?.checkpointWindows ?? null,
    latestRecommendedParametersAppearedAt: sameRecommendedCheckpoints[0]?.checkpointWindows ?? null,
    latestRecommendedParametersCheckpoints: sameRecommendedCheckpoints.map((run) => run.checkpointWindows),
  },
  storedScores: { baseline: stored.baseline, candidate: stored.candidate },
  reproducedScores: { baseline: reproduced.baseline, candidate: reproduced.candidate },
  pairedWindowResults: {
    return: paired(reviews, (row) => row.candidateReturn - row.baselineReturn),
    brier: paired(reviews, (row) => row.candidateBrier - row.baselineBrier),
    logLoss: paired(reviews, (row) => row.candidateLogLoss - row.baselineLogLoss),
    contiguousMaximumDrawdown: {
      baseline: contiguousMaximumDrawdown(reviews.map((row) => row.baselineReturn)),
      candidate: contiguousMaximumDrawdown(reviews.map((row) => row.candidateReturn)),
      storedFoldMaximum: { baseline: reproduced.baseline.maximumDrawdown, candidate: reproduced.candidate.maximumDrawdown },
    },
  },
  selectionCoverage: {
    ...categories,
    returnDifferenceBySelection,
    baselineTradeWindows: reviews.filter((row) => row.baselineTrade).length,
    candidateTradeWindows: candidateSelections.length,
    candidateSelectionWithAnyLiveIntent: candidateSelections.filter(({ row, trade }) => orderKeys.get('live')!.has(tradeKey(trade, row.closesAt))).length,
    candidateSelectionWithAnyPaperIntent: candidateSelections.filter(({ row, trade }) => orderKeys.get('paper')!.has(tradeKey(trade, row.closesAt))).length,
    note: 'Intent overlap is not an execution arm: orders exist only where production policy and operational state issued them.',
  },
  replayCoverage: {
    exactProbability: reproduced.exactReplayObservations,
    reconstructedProbability: reproduced.reconstructedReplayObservations,
    exactConfidence: reproduced.exactConfidenceReplayObservations,
    absentConfidence: reproduced.absentConfidenceReplayObservations,
    maximumBaselineReplayError: reproduced.maximumBaselineReplayError,
    maximumConfidenceReplayError: reproduced.maximumConfidenceReplayError,
  },
  promotionEligibility: { stored: storedEligibility, reproduced: reproducedEligibility },
  limitations: [
    'The scorer reuses the stored production-selected entrySide, entryAsk, entryFeeRate and entryVenue; a candidate cannot choose the opposite side or another venue.',
    'The scorer hard-codes the 5-97c price band and therefore does not express current v22 10-75c admission.',
    'Return is ask-and-hold with no persistence, maker fill, IOC depth, exits, portfolio capacity, sizing or budget reuse.',
    'Combined maximum drawdown resets at fold boundaries; contiguous held-out drawdown is reported separately above.',
    'Overlapping checkpoint runs are repeated looks at mostly the same windows and are not independent confirmations.',
    'The stored checkpoint fingerprint is compared with a fresh rebuild; disagreement means late resolution changed a supposedly immutable historical checkpoint and blocks promotion independently.',
  ],
};

console.log(JSON.stringify(output, null, 2));
