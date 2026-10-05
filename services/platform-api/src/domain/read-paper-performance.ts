// The stored performance document, read into the published views.
//
// One stored JSON document, written by a separate system, serves both the bounded
// summary and the full record. v1 validated thirteen scalars of it for the
// summary and nothing at all for the full record; this file validates every
// documented field of both, strips every key it does not document, and names the
// path of anything that fails (`read-record.ts`).
//
// Two members of the stored document are internal and are never published:
// `homepage`, which is the pre-computed bounded summary, and `fullGeneratedAt`,
// which is a timestamp this API republishes under its own name. Both are read
// here and neither appears in a response.
//
// The time semantics are the part most easily got wrong, so they are stated once:
//
//   * The bounded summary's `generatedAt` is when the source last wrote the
//     `homepage` member — minutes, usually.
//   * The full record's `generatedAt` is when the source last replaced the whole
//     document — a quarter of an hour at best, and much longer if its builder is
//     failing.
//   * `sourceUpdatedAt`, the row's own write time, tracks the first and overstates
//     the second. Both are published so the difference is visible rather than
//     hidden, and neither is ever this service's clock.

import type {
  PublishedActionCounterfactualArm,
  PublishedBankrollEpoch,
  PublishedBenchmarkScore,
  PublishedCalibrationBin,
  PublishedCyclePathLatest,
  PublishedCyclePathReport,
  PublishedCycleRegimeFeatures,
  PublishedEdgeBucket,
  PublishedForecast,
  PublishedForecastRecordSummary,
  PublishedForecastSignalSummary,
  PublishedForecastSlice,
  PublishedLeadTimeSlice,
  PublishedMissedBuyCounterfactual,
  PublishedPerformance,
  PublishedPerformanceSummary,
  PublishedProviderTrackRecord,
  PublishedSegmentGroup,
  PublishedSegmentStat,
  PublishedTimelinePoint,
  PublishedTrackRecord,
  PublishedTrackSummary,
} from './paper-dashboard.js';
import { PUBLISHED_RECENT_FORECAST_LIMIT } from './paper-dashboard.js';
import type { PaperJsonPayloadRow } from './paper-projection.js';
import {
  field,
  readArray,
  readArrayOrEmpty,
  readBoolean,
  readConstant,
  readCount,
  readInteger,
  readNullableNumber,
  readNumber,
  readObject,
  readOptional,
  readOptionalNullableNumber,
  readSourceTime,
  readString,
  type RecordReader,
} from './read-record.js';

const readForecast: RecordReader<PublishedForecast> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    confidence: readNumber(field(row, 'confidence'), `${path}.confidence`),
    // Absent while the forecast is pending, which is not an error.
    ...optionalKey('correct', readOptional(field(row, 'correct'), `${path}.correct`, readBoolean)),
    direction: readString(field(row, 'direction'), `${path}.direction`),
    directionalLikelihood: readNumber(
      field(row, 'directionalLikelihood'),
      `${path}.directionalLikelihood`,
    ),
    id: readString(field(row, 'id'), `${path}.id`),
    issuedAt: readSourceTime(field(row, 'issuedAt'), `${path}.issuedAt`),
    modelVersion: readString(field(row, 'modelVersion'), `${path}.modelVersion`),
    ...optionalKey('outcome', readOptional(field(row, 'outcome'), `${path}.outcome`, readString)),
    policyVersion: readString(field(row, 'policyVersion'), `${path}.policyVersion`),
    status: readString(field(row, 'status'), `${path}.status`),
    symbol: readString(field(row, 'symbol'), `${path}.symbol`),
  });
};

/** `{}` for an absent optional, so the key is absent from the JSON entirely. */
function optionalKey<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

const readForecastSlice: RecordReader<PublishedForecastSlice> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    accuracy: readNumber(field(row, 'accuracy'), `${path}.accuracy`),
    correct: readCount(field(row, 'correct'), `${path}.correct`),
    label: readString(field(row, 'label'), `${path}.label`),
    resolved: readCount(field(row, 'resolved'), `${path}.resolved`),
  });
};

const readLeadTimeSlice: RecordReader<PublishedLeadTimeSlice> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    ...readForecastSlice(value, path),
    brierScore: readNullableNumber(field(row, 'brierScore'), `${path}.brierScore`),
  });
};

const readCalibrationBin: RecordReader<PublishedCalibrationBin> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    label: readString(field(row, 'label'), `${path}.label`),
    meanForecast: readNumber(field(row, 'meanForecast'), `${path}.meanForecast`),
    observedRate: readNumber(field(row, 'observedRate'), `${path}.observedRate`),
    resolved: readCount(field(row, 'resolved'), `${path}.resolved`),
  });
};

const readBenchmarkScore: RecordReader<PublishedBenchmarkScore> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    accuracy: readNullableNumber(field(row, 'accuracy'), `${path}.accuracy`),
    brierScore: readNullableNumber(field(row, 'brierScore'), `${path}.brierScore`),
    label: readString(field(row, 'label'), `${path}.label`),
    logLoss: readNullableNumber(field(row, 'logLoss'), `${path}.logLoss`),
    resolved: readCount(field(row, 'resolved'), `${path}.resolved`),
  });
};

const readEdgeBucket: RecordReader<PublishedEdgeBucket> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    label: readString(field(row, 'label'), `${path}.label`),
    predictedEdge: readNumber(field(row, 'predictedEdge'), `${path}.predictedEdge`),
    realizedReturn: readNumber(field(row, 'realizedReturn'), `${path}.realizedReturn`),
    trades: readCount(field(row, 'trades'), `${path}.trades`),
    winRate: readNumber(field(row, 'winRate'), `${path}.winRate`),
  });
};

const readSegmentStat: RecordReader<PublishedSegmentStat> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    label: readString(field(row, 'label'), `${path}.label`),
    meanPredictedEdge: readNumber(field(row, 'meanPredictedEdge'), `${path}.meanPredictedEdge`),
    // Nullable on purpose: the source can compute this as not-a-number, which JSON
    // carries as null. Refusing it here would reject real records.
    meanRealizedReturn: readNullableNumber(
      field(row, 'meanRealizedReturn'),
      `${path}.meanRealizedReturn`,
    ),
    standardError: readNullableNumber(field(row, 'standardError'), `${path}.standardError`),
    trades: readCount(field(row, 'trades'), `${path}.trades`),
    windows: readCount(field(row, 'windows'), `${path}.windows`),
    winRate: readNumber(field(row, 'winRate'), `${path}.winRate`),
  });
};

const readSegmentGroup: RecordReader<PublishedSegmentGroup> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    description: readString(field(row, 'description'), `${path}.description`),
    dimension: readString(field(row, 'dimension'), `${path}.dimension`),
    segments: readArray(field(row, 'segments'), `${path}.segments`, readSegmentStat),
  });
};

const readMissedBuy: RecordReader<PublishedMissedBuyCounterfactual> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    bestPerWindowCandidates: readCount(
      field(row, 'bestPerWindowCandidates'),
      `${path}.bestPerWindowCandidates`,
    ),
    bestPerWindowMeanReturn: readNullableNumber(
      field(row, 'bestPerWindowMeanReturn'),
      `${path}.bestPerWindowMeanReturn`,
    ),
    bestPerWindowStandardError: readNullableNumber(
      field(row, 'bestPerWindowStandardError'),
      `${path}.bestPerWindowStandardError`,
    ),
    bestPerWindowTotalReturn: readNullableNumber(
      field(row, 'bestPerWindowTotalReturn'),
      `${path}.bestPerWindowTotalReturn`,
    ),
    bestPerWindowWins: readCount(field(row, 'bestPerWindowWins'), `${path}.bestPerWindowWins`),
    candidates: readCount(field(row, 'candidates'), `${path}.candidates`),
    description: readString(field(row, 'description'), `${path}.description`),
    label: readString(field(row, 'label'), `${path}.label`),
    meanCandidateReturn: readNullableNumber(
      field(row, 'meanCandidateReturn'),
      `${path}.meanCandidateReturn`,
    ),
    profitableCandidates: readCount(
      field(row, 'profitableCandidates'),
      `${path}.profitableCandidates`,
    ),
    standardError: readNullableNumber(field(row, 'standardError'), `${path}.standardError`),
    windows: readCount(field(row, 'windows'), `${path}.windows`),
  });
};

const readTimelinePoint: RecordReader<PublishedTimelinePoint> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    cumulativeAccuracy: readNumber(field(row, 'cumulativeAccuracy'), `${path}.cumulativeAccuracy`),
    cumulativeBrier: readNumber(field(row, 'cumulativeBrier'), `${path}.cumulativeBrier`),
    resolved: readCount(field(row, 'resolved'), `${path}.resolved`),
    rollingAccuracy: readNumber(field(row, 'rollingAccuracy'), `${path}.rollingAccuracy`),
    time: readSourceTime(field(row, 'time'), `${path}.time`),
  });
};

const readActionCounterfactualArm: RecordReader<PublishedActionCounterfactualArm> = (
  value,
  path,
) => {
  const row = readObject(value, path);
  return Object.freeze({
    action: readString(field(row, 'action'), `${path}.action`),
    alternative: readString(field(row, 'alternative'), `${path}.alternative`),
    alternativePnlCents: readNumber(
      field(row, 'alternativePnlCents'),
      `${path}.alternativePnlCents`,
    ),
    basis: readString(field(row, 'basis'), `${path}.basis`),
    credible: readBoolean(field(row, 'credible'), `${path}.credible`),
    decisions: readCount(field(row, 'decisions'), `${path}.decisions`),
    decisionsBeatingAlternative: readCount(
      field(row, 'decisionsBeatingAlternative'),
      `${path}.decisionsBeatingAlternative`,
    ),
    description: readString(field(row, 'description'), `${path}.description`),
    hitRate: readNullableNumber(field(row, 'hitRate'), `${path}.hitRate`),
    incrementalCents: readNumber(field(row, 'incrementalCents'), `${path}.incrementalCents`),
    incrementalReturnStandardError: readNullableNumber(
      field(row, 'incrementalReturnStandardError'),
      `${path}.incrementalReturnStandardError`,
    ),
    meanIncrementalCents: readNullableNumber(
      field(row, 'meanIncrementalCents'),
      `${path}.meanIncrementalCents`,
    ),
    meanIncrementalReturn: readNullableNumber(
      field(row, 'meanIncrementalReturn'),
      `${path}.meanIncrementalReturn`,
    ),
    policy: readString(field(row, 'policy'), `${path}.policy`),
    takenPnlCents: readNumber(field(row, 'takenPnlCents'), `${path}.takenPnlCents`),
    windows: readCount(field(row, 'windows'), `${path}.windows`),
  });
};

const readTrackRecord: RecordReader<PublishedTrackRecord> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    actionCounterfactuals: readArray(
      field(row, 'actionCounterfactuals'),
      `${path}.actionCounterfactuals`,
      readActionCounterfactualArm,
    ),
    actionCounterfactualVersion: readString(
      field(row, 'actionCounterfactualVersion'),
      `${path}.actionCounterfactualVersion`,
    ),
    invalid: readCount(field(row, 'invalid'), `${path}.invalid`),
    losses: readCount(field(row, 'losses'), `${path}.losses`),
    meanPredictedEdge: readNullableNumber(
      field(row, 'meanPredictedEdge'),
      `${path}.meanPredictedEdge`,
    ),
    meanPrincipalRecoveryVsFullExitCents: readNullableNumber(
      field(row, 'meanPrincipalRecoveryVsFullExitCents'),
      `${path}.meanPrincipalRecoveryVsFullExitCents`,
    ),
    meanRealizedReturn: readNullableNumber(
      field(row, 'meanRealizedReturn'),
      `${path}.meanRealizedReturn`,
    ),
    meanSwitchVsHoldCents: readNullableNumber(
      field(row, 'meanSwitchVsHoldCents'),
      `${path}.meanSwitchVsHoldCents`,
    ),
    // A record in any mode other than simulation is refused rather than served:
    // this API publishes no funded position, and a mislabelled record is the one
    // way one could arrive.
    mode: readConstant(field(row, 'mode'), `${path}.mode`, 'paper'),
    pending: readCount(field(row, 'pending'), `${path}.pending`),
    principalRecoveryExitsEvaluated: readCount(
      field(row, 'principalRecoveryExitsEvaluated'),
      `${path}.principalRecoveryExitsEvaluated`,
    ),
    principalRecoveryVsFullExitCents: readNullableNumber(
      field(row, 'principalRecoveryVsFullExitCents'),
      `${path}.principalRecoveryVsFullExitCents`,
    ),
    realizedPnlCents: readNumber(field(row, 'realizedPnlCents'), `${path}.realizedPnlCents`),
    rejected: readCount(field(row, 'rejected'), `${path}.rejected`),
    returnedCents: readNumber(field(row, 'returnedCents'), `${path}.returnedCents`),
    roi: readNullableNumber(field(row, 'roi'), `${path}.roi`),
    segments: readArray(field(row, 'segments'), `${path}.segments`, readSegmentGroup),
    settled: readCount(field(row, 'settled'), `${path}.settled`),
    sold: readCount(field(row, 'sold'), `${path}.sold`),
    stakedCents: readNumber(field(row, 'stakedCents'), `${path}.stakedCents`),
    standaloneExitsEvaluated: readCount(
      field(row, 'standaloneExitsEvaluated'),
      `${path}.standaloneExitsEvaluated`,
    ),
    standardError: readNullableNumber(field(row, 'standardError'), `${path}.standardError`),
    switchesEvaluated: readCount(field(row, 'switchesEvaluated'), `${path}.switchesEvaluated`),
    unfilled: readCount(field(row, 'unfilled'), `${path}.unfilled`),
    windows: readCount(field(row, 'windows'), `${path}.windows`),
    winRate: readNullableNumber(field(row, 'winRate'), `${path}.winRate`),
    wins: readCount(field(row, 'wins'), `${path}.wins`),
  });
};

const readProviderRecord: RecordReader<PublishedProviderTrackRecord> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    marketId: readString(field(row, 'marketId'), `${path}.marketId`),
    providerId: readString(field(row, 'providerId'), `${path}.providerId`),
    record: readTrackRecord(field(row, 'record'), `${path}.record`),
  });
};

const readBankrollEpoch: RecordReader<PublishedBankrollEpoch> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    budgetPnlCents: readNumber(field(row, 'budgetPnlCents'), `${path}.budgetPnlCents`),
    current: readBoolean(field(row, 'current'), `${path}.current`),
    epochId: readString(field(row, 'epochId'), `${path}.epochId`),
    ...optionalKey(
      'firstAt',
      readOptional(field(row, 'firstAt'), `${path}.firstAt`, readSourceTime),
    ),
    ...optionalKey('lastAt', readOptional(field(row, 'lastAt'), `${path}.lastAt`, readSourceTime)),
    realizedPnlCents: readNumber(field(row, 'realizedPnlCents'), `${path}.realizedPnlCents`),
    settled: readCount(field(row, 'settled'), `${path}.settled`),
    stakedCents: readNumber(field(row, 'stakedCents'), `${path}.stakedCents`),
    trades: readCount(field(row, 'trades'), `${path}.trades`),
  });
};

const readCycleRegimeFeatures: RecordReader<PublishedCycleRegimeFeatures> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    coverageSeconds: readNumber(field(row, 'coverageSeconds'), `${path}.coverageSeconds`),
    lagOneAutocorrelation: readNullableNumber(
      field(row, 'lagOneAutocorrelation'),
      `${path}.lagOneAutocorrelation`,
    ),
    localVolatility15mPercent: readNullableNumber(
      field(row, 'localVolatility15mPercent'),
      `${path}.localVolatility15mPercent`,
    ),
    localVolatilityPerSecond: readNullableNumber(
      field(row, 'localVolatilityPerSecond'),
      `${path}.localVolatilityPerSecond`,
    ),
    // Absent on older records *and* nullable on newer ones, so the two cases stay
    // distinct rather than collapsing into one.
    ...optionalKey(
      'netChangePercent',
      readOptionalNullableNumber(field(row, 'netChangePercent'), `${path}.netChangePercent`),
    ),
    observationCount: readCount(field(row, 'observationCount'), `${path}.observationCount`),
    observedAt: readSourceTime(field(row, 'observedAt'), `${path}.observedAt`),
    rangePercent: readNullableNumber(field(row, 'rangePercent'), `${path}.rangePercent`),
    regime: readString(field(row, 'regime'), `${path}.regime`),
    ...optionalKey(
      'signedTrendEfficiency',
      readOptionalNullableNumber(
        field(row, 'signedTrendEfficiency'),
        `${path}.signedTrendEfficiency`,
      ),
    ),
    signFlipRate: readNullableNumber(field(row, 'signFlipRate'), `${path}.signFlipRate`),
    trendEfficiency: readNullableNumber(field(row, 'trendEfficiency'), `${path}.trendEfficiency`),
  });
};

const readCyclePathLatest: RecordReader<PublishedCyclePathLatest> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    closesAt: readSourceTime(field(row, 'closesAt'), `${path}.closesAt`),
    features: readCycleRegimeFeatures(field(row, 'features'), `${path}.features`),
    symbol: readString(field(row, 'symbol'), `${path}.symbol`),
  });
};

const readCyclePathReport: RecordReader<PublishedCyclePathReport> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    completedCycles: readCount(field(row, 'completedCycles'), `${path}.completedCycles`),
    latestByAsset: readArray(
      field(row, 'latestByAsset'),
      `${path}.latestByAsset`,
      readCyclePathLatest,
    ),
    policyVersion: readString(field(row, 'policyVersion'), `${path}.policyVersion`),
    totalCycles: readCount(field(row, 'totalCycles'), `${path}.totalCycles`),
    totalPoints: readCount(field(row, 'totalPoints'), `${path}.totalPoints`),
  });
};

const readTrackSummary: RecordReader<PublishedTrackSummary> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    losses: readCount(field(row, 'losses'), `${path}.losses`),
    meanPredictedEdge: readNullableNumber(
      field(row, 'meanPredictedEdge'),
      `${path}.meanPredictedEdge`,
    ),
    meanRealizedReturn: readNullableNumber(
      field(row, 'meanRealizedReturn'),
      `${path}.meanRealizedReturn`,
    ),
    mode: readConstant(field(row, 'mode'), `${path}.mode`, 'paper'),
    realizedPnlCents: readNumber(field(row, 'realizedPnlCents'), `${path}.realizedPnlCents`),
    roi: readNullableNumber(field(row, 'roi'), `${path}.roi`),
    settled: readCount(field(row, 'settled'), `${path}.settled`),
    windows: readCount(field(row, 'windows'), `${path}.windows`),
    winRate: readNullableNumber(field(row, 'winRate'), `${path}.winRate`),
    wins: readCount(field(row, 'wins'), `${path}.wins`),
  });
};

const readSignalSummary: RecordReader<PublishedForecastSignalSummary> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    accuracy: readNullableNumber(field(row, 'accuracy'), `${path}.accuracy`),
    brierScore: readNullableNumber(field(row, 'brierScore'), `${path}.brierScore`),
    calibrationMinimum: readCount(field(row, 'calibrationMinimum'), `${path}.calibrationMinimum`),
    calibrationProgress: readNumber(
      field(row, 'calibrationProgress'),
      `${path}.calibrationProgress`,
    ),
    calibrationReady: readBoolean(field(row, 'calibrationReady'), `${path}.calibrationReady`),
    calibrationWindows: readCount(field(row, 'calibrationWindows'), `${path}.calibrationWindows`),
    currentCycleStreak: readInteger(field(row, 'currentCycleStreak'), `${path}.currentCycleStreak`),
    cycleBalancedAccuracy: readNullableNumber(
      field(row, 'cycleBalancedAccuracy'),
      `${path}.cycleBalancedAccuracy`,
    ),
    cycles: readCount(field(row, 'cycles'), `${path}.cycles`),
    issued: readCount(field(row, 'issued'), `${path}.issued`),
    // The source bounds this list itself; the bound is re-applied here so a
    // document written by a looser writer cannot widen a bounded response.
    recent: Object.freeze(
      readArray(field(row, 'recent'), `${path}.recent`, readForecast).slice(
        0,
        PUBLISHED_RECENT_FORECAST_LIMIT,
      ),
    ),
    resolved: readCount(field(row, 'resolved'), `${path}.resolved`),
    resolvedCycles: readCount(field(row, 'resolvedCycles'), `${path}.resolvedCycles`),
  });
};

const readRecordSummary: RecordReader<PublishedForecastRecordSummary> = (value, path) => {
  const row = readObject(value, path);
  return Object.freeze({
    accuracy: readNullableNumber(field(row, 'accuracy'), `${path}.accuracy`),
    benchmarks: readArray(field(row, 'benchmarks'), `${path}.benchmarks`, readBenchmarkScore),
    brierScore: readNullableNumber(field(row, 'brierScore'), `${path}.brierScore`),
    byAsset: readArray(field(row, 'byAsset'), `${path}.byAsset`, readForecastSlice),
    byConfidenceBucket: readArray(
      field(row, 'byConfidenceBucket'),
      `${path}.byConfidenceBucket`,
      readForecastSlice,
    ),
    byDirection: readArray(field(row, 'byDirection'), `${path}.byDirection`, readForecastSlice),
    byLeadTime: readArray(field(row, 'byLeadTime'), `${path}.byLeadTime`, readLeadTimeSlice),
    byModelVersion: readArray(
      field(row, 'byModelVersion'),
      `${path}.byModelVersion`,
      readForecastSlice,
    ),
    calibrationBins: readArray(
      field(row, 'calibrationBins'),
      `${path}.calibrationBins`,
      readCalibrationBin,
    ),
    calibrationMinimum: readCount(field(row, 'calibrationMinimum'), `${path}.calibrationMinimum`),
    calibrationProgress: readNumber(
      field(row, 'calibrationProgress'),
      `${path}.calibrationProgress`,
    ),
    calibrationReady: readBoolean(field(row, 'calibrationReady'), `${path}.calibrationReady`),
    calibrationWindows: readCount(field(row, 'calibrationWindows'), `${path}.calibrationWindows`),
    correct: readCount(field(row, 'correct'), `${path}.correct`),
    currentCycleStreak: readInteger(field(row, 'currentCycleStreak'), `${path}.currentCycleStreak`),
    currentStreak: readInteger(field(row, 'currentStreak'), `${path}.currentStreak`),
    cycleBalancedAccuracy: readNullableNumber(
      field(row, 'cycleBalancedAccuracy'),
      `${path}.cycleBalancedAccuracy`,
    ),
    cycles: readCount(field(row, 'cycles'), `${path}.cycles`),
    edgeBuckets: readArray(field(row, 'edgeBuckets'), `${path}.edgeBuckets`, readEdgeBucket),
    evaluationMeaningful: readBoolean(
      field(row, 'evaluationMeaningful'),
      `${path}.evaluationMeaningful`,
    ),
    evaluationMinimumWindows: readCount(
      field(row, 'evaluationMinimumWindows'),
      `${path}.evaluationMinimumWindows`,
    ),
    invalid: readCount(field(row, 'invalid'), `${path}.invalid`),
    issued: readCount(field(row, 'issued'), `${path}.issued`),
    logLoss: readNullableNumber(field(row, 'logLoss'), `${path}.logLoss`),
    meanPredictedEdge: readNullableNumber(
      field(row, 'meanPredictedEdge'),
      `${path}.meanPredictedEdge`,
    ),
    meanRealizedReturn: readNullableNumber(
      field(row, 'meanRealizedReturn'),
      `${path}.meanRealizedReturn`,
    ),
    missedBuyCounterfactual: readMissedBuy(
      field(row, 'missedBuyCounterfactual'),
      `${path}.missedBuyCounterfactual`,
    ),
    observedCalculations: readCount(
      field(row, 'observedCalculations'),
      `${path}.observedCalculations`,
    ),
    pending: readCount(field(row, 'pending'), `${path}.pending`),
    realizedEdgeTrades: readCount(field(row, 'realizedEdgeTrades'), `${path}.realizedEdgeTrades`),
    recent: readArray(field(row, 'recent'), `${path}.recent`, readForecast),
    resolved: readCount(field(row, 'resolved'), `${path}.resolved`),
    resolvedCalculations: readCount(
      field(row, 'resolvedCalculations'),
      `${path}.resolvedCalculations`,
    ),
    resolvedCycles: readCount(field(row, 'resolvedCycles'), `${path}.resolvedCycles`),
    resolvedWindows: readCount(field(row, 'resolvedWindows'), `${path}.resolvedWindows`),
    segments: readArray(field(row, 'segments'), `${path}.segments`, readSegmentGroup),
    timeline: readArray(field(row, 'timeline'), `${path}.timeline`, readTimelinePoint),
  });
};

/** The twelve scalar keys the bounded summary needs, plus `recent`. */
const SIGNAL_SUMMARY_KEYS = Object.freeze([
  'accuracy',
  'brierScore',
  'calibrationMinimum',
  'calibrationProgress',
  'calibrationReady',
  'calibrationWindows',
  'currentCycleStreak',
  'cycleBalancedAccuracy',
  'cycles',
  'issued',
  'resolved',
  'resolvedCycles',
] as const);

const TRACK_SUMMARY_KEYS = Object.freeze([
  'losses',
  'meanPredictedEdge',
  'meanRealizedReturn',
  'mode',
  'realizedPnlCents',
  'roi',
  'settled',
  'windows',
  'winRate',
  'wins',
] as const);

/** Projects the named keys out of a wider record, for the fallback below. */
function project(
  value: unknown,
  path: string,
  keys: readonly string[],
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const row = readObject(value, path);
  const projected: Record<string, unknown> = { ...extra };
  for (const key of keys) projected[key] = field(row, key);
  return projected;
}

/**
 * The bounded summary.
 *
 * The source pre-computes it under `homepage`, and that is what is read when it is
 * there. A document written before that member existed is still readable: the same
 * record is projected out of the full `summary` and `paperRecord` members, with
 * `recent` defaulting to empty. That fallback is why `generatedAt` has a fallback
 * too — a legacy document has no stamp of its own, so the row's write time stands
 * in, normalized like every other time here.
 */
export function readPaperPerformanceSummary(row: PaperJsonPayloadRow): PublishedPerformanceSummary {
  const payload = readObject(row.payload, 'payload');
  const sourceUpdatedAt = row.sourceUpdatedAt.toISOString();
  const homepage = field(payload, 'homepage');

  if (homepage !== undefined && homepage !== null) {
    const member = readObject(homepage, 'payload.homepage');
    return Object.freeze({
      durable: true as const,
      generatedAt:
        readOptional(
          field(member, 'generatedAt'),
          'payload.homepage.generatedAt',
          readSourceTime,
        ) ?? sourceUpdatedAt,
      paperRecord: readTrackSummary(field(member, 'paperRecord'), 'payload.homepage.paperRecord'),
      sourceUpdatedAt,
      summary: readSignalSummary(field(member, 'summary'), 'payload.homepage.summary'),
    });
  }

  // A legacy document: the same record, projected out of the wider members. The
  // source's own fallback treats a non-array `recent` as empty rather than failing,
  // and that tolerance is kept — a missing recent list is not a broken record.
  const wider = readObject(field(payload, 'summary'), 'payload.summary');
  const recent = field(wider, 'recent');

  return Object.freeze({
    durable: true as const,
    generatedAt: sourceUpdatedAt,
    paperRecord: readTrackSummary(
      project(field(payload, 'paperRecord'), 'payload.paperRecord', TRACK_SUMMARY_KEYS),
      'payload.paperRecord',
    ),
    sourceUpdatedAt,
    summary: readSignalSummary(
      project(wider, 'payload.summary', SIGNAL_SUMMARY_KEYS, {
        recent: Array.isArray(recent) ? recent : [],
      }),
      'payload.summary',
    ),
  });
}

/**
 * The full record, rebuilt member by member.
 *
 * Never spread. A field this contract withdrew cannot reappear from an older
 * stored document, and a field the source added is dropped rather than published
 * — which is the difference between publishing a document and publishing a
 * contract.
 */
export function readPaperPerformance(row: PaperJsonPayloadRow): PublishedPerformance {
  const payload = readObject(row.payload, 'payload');
  const sourceUpdatedAt = row.sourceUpdatedAt.toISOString();
  const cyclePaths = readOptional(
    field(payload, 'cyclePaths'),
    'payload.cyclePaths',
    readCyclePathReport,
  );

  return Object.freeze({
    ...optionalKey('cyclePaths', cyclePaths),
    durable: true as const,
    forecasts: readArrayOrEmpty(field(payload, 'forecasts'), 'payload.forecasts', readForecast),
    // The document's own stamp when it has one. The row's write time is bumped by
    // the far more frequent summary write, so it would overstate this.
    generatedAt:
      readOptional(field(payload, 'fullGeneratedAt'), 'payload.fullGeneratedAt', readSourceTime) ??
      sourceUpdatedAt,
    paperEpochs: readArrayOrEmpty(
      field(payload, 'paperEpochs'),
      'payload.paperEpochs',
      readBankrollEpoch,
    ),
    paperProviderRecords: readArrayOrEmpty(
      field(payload, 'paperProviderRecords'),
      'payload.paperProviderRecords',
      readProviderRecord,
    ),
    paperRecord: readTrackRecord(field(payload, 'paperRecord'), 'payload.paperRecord'),
    sourceUpdatedAt,
    summary: readRecordSummary(field(payload, 'summary'), 'payload.summary'),
  });
}
