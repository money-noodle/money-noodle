import { BUY_POLICY_VERSION, MIN_CALIBRATION_SAMPLE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY, MIN_NET_EDGE, MIN_SELECTED_SIDE_PROBABILITY, venueFeeRate } from './prediction-policy';
import type { BenchmarkScore, CalibrationBin, EdgeBucket, LeadTimeSlice, MissedBuyCounterfactual, PerformanceSlice, PerformanceSummary, PerformanceTimelinePoint, SegmentGroup, SegmentStat, TrackedForecast } from './types';

export const MAX_PERFORMANCE_TIMELINE_POINTS = 500;

/** Preserve the complete statistics while bounding chart serialization and browser rendering cost. */
export function downsamplePerformanceTimeline(points: PerformanceTimelinePoint[], maximum = MAX_PERFORMANCE_TIMELINE_POINTS): PerformanceTimelinePoint[] {
  if (points.length <= maximum) return points;
  if (maximum <= 1) return [points.at(-1)!];
  return Array.from({ length: maximum }, (_, index) => points[Math.floor(index * (points.length - 1) / (maximum - 1))]);
}

/** Records written before all-calculation logging existed were qualifying signals by construction. */
function isQualified(forecast: TrackedForecast): boolean {
  return forecast.qualified !== false;
}

function slices(forecasts: TrackedForecast[], key: (forecast: TrackedForecast) => string): PerformanceSlice[] {
  const groups = new Map<string, TrackedForecast[]>();
  for (const forecast of forecasts.filter((item) => item.status === 'resolved')) {
    const label = key(forecast);
    groups.set(label, [...(groups.get(label) ?? []), forecast]);
  }
  return [...groups.entries()].map(([label, items]) => {
    const correct = items.filter((item) => item.correct).length;
    return { label, resolved: items.length, correct, accuracy: correct / items.length };
  }).sort((a, b) => b.resolved - a.resolved || b.accuracy - a.accuracy);
}

function cycleKey(forecast: TrackedForecast): string {
  if (forecast.cycleId) return forecast.cycleId;
  const slug = forecast.marketUrl.split('/').filter(Boolean).at(-1) ?? forecast.symbol;
  return `${slug}:${forecast.closesAt}`;
}

/** Venue/asset identifiers are intentionally excluded: one timestamp is one correlated crypto window. */
function settlementWindowKey(forecast: TrackedForecast): string {
  const timestamp = Date.parse(forecast.closesAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : forecast.closesAt;
}

const clampProbability = (value: number) => Math.min(0.999999, Math.max(0.000001, value));

function score(label: string, forecasts: TrackedForecast[], probability: (forecast: TrackedForecast) => number | undefined): BenchmarkScore {
  const usable = forecasts.filter((forecast) => Number.isFinite(probability(forecast) as number));
  if (!usable.length) return { label, resolved: 0, accuracy: null, brierScore: null, logLoss: null };
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  for (const forecast of usable) {
    const p = clampProbability(probability(forecast)!);
    const actual = forecast.outcome === 'UP' ? 1 : 0;
    // A 50/50 forecast is scored as a half-credit coin flip rather than an arbitrary direction.
    correct += p === 0.5 ? 0.5 : (p > 0.5 ? 1 : 0) === actual ? 1 : 0;
    brier += (p - actual) ** 2;
    logLoss += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
  }
  return { label, resolved: usable.length, accuracy: correct / usable.length, brierScore: brier / usable.length, logLoss: logLoss / usable.length };
}

const LEAD_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '0–30s', min: 0, max: 30 },
  { label: '30–120s', min: 30, max: 120 },
  { label: '2–5m', min: 120, max: 300 },
  { label: '5–10m', min: 300, max: 600 },
  { label: '10m+', min: 600, max: Number.POSITIVE_INFINITY },
];

function leadTimeSlices(resolved: TrackedForecast[]): LeadTimeSlice[] {
  return LEAD_BUCKETS.map(({ label, min, max }) => {
    const items = resolved.filter((forecast) => {
      const seconds = forecast.secondsRemaining ?? (new Date(forecast.closesAt).getTime() - new Date(forecast.issuedAt).getTime()) / 1000;
      return seconds >= min && seconds < max;
    });
    const correct = items.filter((item) => item.correct).length;
    return {
      label, resolved: items.length, correct,
      accuracy: items.length ? correct / items.length : 0,
      brierScore: items.length ? items.reduce((sum, item) => sum + (item.brierScore ?? 0), 0) / items.length : null,
    };
  }).filter((slice) => slice.resolved > 0);
}

function calibrationBins(resolved: TrackedForecast[]): CalibrationBin[] {
  const edges = [0, 0.2, 0.35, 0.45, 0.55, 0.65, 0.8, 1.0001];
  return edges.slice(0, -1).map((low, index) => {
    const high = edges[index + 1];
    const items = resolved.filter((forecast) => forecast.probabilityUp >= low && forecast.probabilityUp < high);
    return {
      label: `${Math.round(low * 100)}–${Math.round(Math.min(high, 1) * 100)}%`,
      resolved: items.length,
      meanForecast: items.length ? items.reduce((sum, item) => sum + item.probabilityUp, 0) / items.length : 0,
      observedRate: items.length ? items.filter((item) => item.outcome === 'UP').length / items.length : 0,
    };
  }).filter((bin) => bin.resolved > 0);
}

/**
 * Distinct settlement windows below which no metric here should be read as evidence. Crypto assets
 * move together, so seven assets in one window is closer to one observation than to seven.
 */
export const MIN_EVALUATION_WINDOWS = 20;

/**
 * Groups resolved calculations by the edge they claimed and reports what that edge actually returned.
 * Accuracy can look fine while every trade still loses money, so this is the profitability metric.
 */
/**
 * Tracks apparent positive-edge sides that v11 intentionally rejects only because our independent
 * selected-side estimate is below 55%. One issuance nearest five minutes remains per asset/window;
 * window-level results then choose the strongest candidate to avoid treating correlated assets as
 * independent proof. This is outcome measurement, never an authorization path.
 */
function missedBuyCounterfactual(forecasts: TrackedForecast[]): MissedBuyCounterfactual {
  const label = '55% selected-side floor rejects';
  const description = 'Exact-Kalshi fee-aware counterfactuals for sides that passed quality, price, and 5pp edge but were rejected only because independent selected-side probability was below 55%.';
  const byAssetWindow = new Map<string, TrackedForecast[]>();
  for (const forecast of forecasts.filter((item) => item.status === 'resolved' && item.policyVersion === BUY_POLICY_VERSION)) {
    const outcome = forecast.venueOutcomes?.kalshi?.outcome;
    if (!outcome || !forecast.venueContracts?.kalshi || forecast.venueOutcomes?.kalshi?.contractId !== forecast.venueContracts.kalshi.contractId) continue;
    const key = `${forecast.symbol}:${settlementWindowKey(forecast)}`;
    byAssetWindow.set(key, [...(byAssetWindow.get(key) ?? []), forecast]);
  }
  const candidates: Array<{ closesAt: string; edge: number; returnValue: number }> = [];
  for (const snapshots of byAssetWindow.values()) {
    const nearest = [...snapshots].sort((a, b) => {
      const left = Math.abs((a.secondsRemaining ?? (Date.parse(a.closesAt) - Date.parse(a.issuedAt)) / 1000) - 300);
      const right = Math.abs((b.secondsRemaining ?? (Date.parse(b.closesAt) - Date.parse(b.issuedAt)) / 1000) - 300);
      return left - right || Date.parse(a.issuedAt) - Date.parse(b.issuedAt);
    })[0];
    const seconds = nearest.secondsRemaining ?? (Date.parse(nearest.closesAt) - Date.parse(nearest.issuedAt)) / 1000;
    // Fixed five-minute snapshots avoid update-count inflation and retain the ordinary execution horizon.
    if (Math.abs(seconds - 300) > 90 || nearest.confidence < MIN_ESTIMATE_QUALITY) continue;
    const outcome = nearest.venueOutcomes!.kalshi!.outcome!;
    for (const quote of nearest.actionableVenuePrices?.filter((item) => item.venue === 'kalshi') ?? []) {
      const probability = quote.side === 'UP' ? nearest.probabilityUp : 1 - nearest.probabilityUp;
      const fee = venueFeeRate('kalshi', quote.price);
      const edge = probability - quote.price - fee;
      if (quote.price < MIN_ENTRY_PRICE || quote.price > 0.97 || edge < MIN_NET_EDGE || probability >= MIN_SELECTED_SIDE_PROBABILITY) continue;
      candidates.push({ closesAt: settlementWindowKey(nearest), edge, returnValue: (outcome === quote.side ? 1 : 0) - quote.price - fee });
    }
  }
  const windowValues = new Map<string, number[]>();
  for (const candidate of candidates) windowValues.set(candidate.closesAt, [...(windowValues.get(candidate.closesAt) ?? []), candidate.returnValue]);
  const clustered = [...windowValues.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  const mean = clustered.length ? clustered.reduce((sum, value) => sum + value, 0) / clustered.length : null;
  const standardError = mean !== null && clustered.length > 1
    ? Math.sqrt(clustered.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clustered.length - 1) / clustered.length)
    : null;
  const best = new Map<string, { edge: number; returnValue: number }>();
  for (const candidate of candidates) {
    const prior = best.get(candidate.closesAt);
    if (!prior || candidate.edge > prior.edge) best.set(candidate.closesAt, candidate);
  }
  const bestValues = [...best.values()].map((item) => item.returnValue);
  return {
    label, description, candidates: candidates.length, windows: windowValues.size,
    profitableCandidates: candidates.filter((item) => item.returnValue > 0).length,
    meanCandidateReturn: mean, standardError,
    bestPerWindowCandidates: bestValues.length,
    bestPerWindowWins: bestValues.filter((value) => value > 0).length,
    bestPerWindowMeanReturn: bestValues.length ? bestValues.reduce((sum, value) => sum + value, 0) / bestValues.length : null,
    bestPerWindowTotalReturn: bestValues.length ? bestValues.reduce((sum, value) => sum + value, 0) : null,
  };
}

function edgeBuckets(resolved: TrackedForecast[]): EdgeBucket[] {
  const edges = [
    { label: 'below 0', min: -Infinity, max: 0 },
    { label: '0–5pp', min: 0, max: 0.05 },
    { label: '5–10pp', min: 0.05, max: 0.10 },
    { label: '10–20pp', min: 0.10, max: 0.20 },
    { label: '20pp+', min: 0.20, max: Infinity },
  ];
  // Only buys the policy would actually have placed. Including rejected calculations was mixing
  // hypothetical negative-edge entries into a metric that answers "did our trades pay".
  const usable = resolved.filter((forecast) => isQualified(forecast) && forecast.predictedEdge !== undefined && forecast.realizedReturn !== undefined);
  return edges.map(({ label, min, max }) => {
    const items = usable.filter((forecast) => forecast.predictedEdge! >= min && forecast.predictedEdge! < max);
    return {
      label, trades: items.length,
      predictedEdge: items.length ? items.reduce((sum, item) => sum + item.predictedEdge!, 0) / items.length : 0,
      realizedReturn: items.length ? items.reduce((sum, item) => sum + item.realizedReturn!, 0) / items.length : 0,
      winRate: items.length ? items.filter((item) => item.outcome === (item.entrySide ?? 'UP')).length / items.length : 0,
    };
  }).filter((bucket) => bucket.trades > 0);
}

/**
 * Realized performance of one segment, clustered by settlement window.
 *
 * Trades inside a window share the same market move, so treating them as independent would overstate
 * significance exactly as the raw update counts did. Each window contributes one observation, and the
 * standard error is taken across windows.
 */
function segmentStat(label: string, items: TrackedForecast[]): SegmentStat {
  const windows = new Map<string, TrackedForecast[]>();
  for (const item of items) windows.set(item.closesAt, [...(windows.get(item.closesAt) ?? []), item]);
  const windowReturns = [...windows.values()].map((group) => group.reduce((sum, item) => sum + (item.realizedReturn ?? 0), 0) / group.length);
  const mean = windowReturns.reduce((sum, value) => sum + value, 0) / windowReturns.length;
  const standardError = windowReturns.length > 1
    ? Math.sqrt(windowReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (windowReturns.length - 1) / windowReturns.length)
    : null;
  return {
    label, trades: items.length, windows: windows.size,
    meanPredictedEdge: items.reduce((sum, item) => sum + (item.predictedEdge ?? 0), 0) / items.length,
    meanRealizedReturn: mean, standardError,
    winRate: items.filter((item) => item.outcome === (item.entrySide ?? 'UP')).length / items.length,
  };
}

function bucketed(dimension: string, description: string, items: TrackedForecast[], key: (forecast: TrackedForecast) => string | null): SegmentGroup {
  const groups = new Map<string, TrackedForecast[]>();
  for (const item of items) {
    const label = key(item);
    if (label === null) continue;
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return {
    dimension, description,
    segments: [...groups.entries()].map(([label, group]) => segmentStat(label, group)).sort((a, b) => b.meanRealizedReturn - a.meanRealizedReturn),
  };
}

const band = (value: number | undefined, edges: Array<{ max: number; label: string }>): string | null =>
  value === undefined || !Number.isFinite(value) ? null : (edges.find((edge) => value < edge.max)?.label ?? edges.at(-1)!.label);

/**
 * Mines the recorded buys for conditions that actually paid, rather than assuming the model has edge.
 * Every dimension here is observable at decision time, so a segment that proves profitable can be
 * turned directly into a policy rule.
 */
function buildSegments(resolved: TrackedForecast[]): SegmentGroup[] {
  const tradable = resolved.filter((forecast) => forecast.realizedReturn !== undefined);
  if (!tradable.length) return [];
  return [
    bucketed('Asset', 'Which markets pay', tradable, (forecast) => forecast.symbol),
    bucketed('Entry direction', 'Which binary side was purchased', tradable, (forecast) => forecast.entrySide ?? 'UP'),
    bucketed('Entry venue', 'Where the fill happened', tradable, (forecast) => forecast.entryVenue ?? null),
    bucketed('Target integrity', 'Whether entry price and settlement outcome come from the same immutable venue contract', tradable, (forecast) => forecast.targetIntegrity ?? 'legacy-polymarket'),
    bucketed('Entry price', 'Cheap contracts are where model error dominates', tradable, (forecast) => band(forecast.entryAsk, [
      { max: 0.10, label: '<10¢' }, { max: 0.25, label: '10–25¢' },
      { max: 0.35, label: '25–35¢' }, { max: 0.45, label: '35–45¢' },
      { max: 0.55, label: '45–55¢' }, { max: 0.65, label: '55–65¢' },
      { max: 0.75, label: '65–75¢' }, { max: Infinity, label: '75¢+' },
    ])),
    bucketed('Time to settlement', 'Later entries are more predictable', tradable, (forecast) => band(forecast.secondsRemaining, [
      { max: 120, label: '<2m' }, { max: 300, label: '2–5m' }, { max: 600, label: '5–10m' }, { max: Infinity, label: '10m+' },
    ])),
    bucketed('Volatility ratio', 'Our σ versus the σ the venue price implies', tradable, (forecast) => band(forecast.volatilityRatio, [
      { max: 0.5, label: '<0.5× (we underestimate)' }, { max: 0.8, label: '0.5–0.8×' }, { max: 1.25, label: '0.8–1.25× (agree)' }, { max: 2, label: '1.25–2×' }, { max: Infinity, label: '2×+ (we overestimate)' },
    ])),
    bucketed('Venue divergence', 'Disagreement between Polymarket and Kalshi', tradable, (forecast) =>
      forecast.kalshiProbabilityUp === undefined ? null : band(Math.abs(forecast.polymarketProbabilityUp - forecast.kalshiProbabilityUp), [
        { max: 0.05, label: '<5pp' }, { max: 0.20, label: '5–20pp' }, { max: Infinity, label: '20pp+' },
      ])),
    bucketed('Settlement-average disagreement', 'Observation model versus production P(UP); not used by the live gate', tradable, (forecast) => forecast.settlementAverageEstimate ? band(Math.abs(forecast.settlementAverageEstimate.probabilityUp - forecast.probabilityUp), [
      { max: 0.03, label: '<3pp' }, { max: 0.08, label: '3–8pp' }, { max: 0.15, label: '8–15pp' }, { max: Infinity, label: '15pp+' },
    ]) : null),
    bucketed('Observed cycle regime', 'Observation-only path shape at issuance; not used by the live gate', tradable, (forecast) => forecast.cycleRegime?.regime ?? null),
    bucketed('Trend efficiency', 'Net displacement divided by total path movement', tradable, (forecast) => band(forecast.cycleRegime?.trendEfficiency ?? undefined, [
      { max: 0.25, label: '<0.25 choppy' }, { max: 0.55, label: '0.25–0.55 mixed' }, { max: 0.8, label: '0.55–0.80 directional' }, { max: Infinity, label: '0.80+ efficient trend' },
    ])),
    bucketed('Sign-flip rate', 'How often nonzero 15-second moves reverse sign', tradable, (forecast) => band(forecast.cycleRegime?.signFlipRate ?? undefined, [
      { max: 0.25, label: '<0.25 persistent' }, { max: 0.55, label: '0.25–0.55 mixed' }, { max: 0.8, label: '0.55–0.80 alternating' }, { max: Infinity, label: '0.80+ highly alternating' },
    ])),
    bucketed('Cycle-local volatility', 'Quadratic path variation scaled to a 15-minute move', tradable, (forecast) => band(forecast.cycleRegime?.localVolatility15mPercent ?? undefined, [
      { max: 0.2, label: '<0.20%' }, { max: 0.4, label: '0.20–0.40%' }, { max: 0.7, label: '0.40–0.70%' }, { max: Infinity, label: '0.70%+' },
    ])),
  ].filter((group) => group.segments.length > 0);
}

export function summarizePerformance(forecasts: TrackedForecast[]): PerformanceSummary {
  // Calibration evidence uses every recorded resolved calculation but collapses correlated assets and
  // repeated updates to one aligned settlement timestamp. Track-record metrics below remain limited
  // to qualifying buys so hypothetical rejected calculations are never presented as traded results.
  const allResolvedForCalibration = forecasts.filter((forecast) => forecast.status === 'resolved');
  const calibrationWindows = new Set(allResolvedForCalibration.map(settlementWindowKey)).size;
  const policy = forecasts.filter(isQualified);
  const resolved = policy.filter((forecast) => forecast.status === 'resolved');
  const withRealized = resolved.filter((forecast) => forecast.predictedEdge !== undefined && forecast.realizedReturn !== undefined);
  const resolvedWindows = new Set(resolved.map((forecast) => forecast.closesAt)).size;
  const correct = resolved.filter((forecast) => forecast.correct).length;
  const allCycles = new Set(policy.map(cycleKey));
  const resolvedCycleGroups = new Map<string, TrackedForecast[]>();
  for (const forecast of resolved) {
    const key = cycleKey(forecast);
    resolvedCycleGroups.set(key, [...(resolvedCycleGroups.get(key) ?? []), forecast]);
  }
  const cycleAccuracies = [...resolvedCycleGroups.values()].map((items) => items.filter((item) => item.correct).length / items.length);
  const cycleBalancedAccuracy = cycleAccuracies.length ? cycleAccuracies.reduce((sum, value) => sum + value, 0) / cycleAccuracies.length : null;

  const orderedResolved = [...resolved].sort((a, b) => new Date(b.resolvedAt ?? b.closesAt).getTime() - new Date(a.resolvedAt ?? a.closesAt).getTime());
  let currentStreak = 0;
  if (orderedResolved.length) {
    const target = Boolean(orderedResolved[0].correct);
    for (const forecast of orderedResolved) {
      if (Boolean(forecast.correct) !== target) break;
      currentStreak += target ? 1 : -1;
    }
  }
  // Update-level streaks over-count a single contract, so cycles are streaked independently.
  const cycleOutcomes = [...resolvedCycleGroups.values()]
    .map((items) => [...items].sort((a, b) => new Date(a.issuedAt).getTime() - new Date(b.issuedAt).getTime())[0])
    .sort((a, b) => new Date(b.closesAt).getTime() - new Date(a.closesAt).getTime());
  let currentCycleStreak = 0;
  if (cycleOutcomes.length) {
    const target = Boolean(cycleOutcomes[0].correct);
    for (const forecast of cycleOutcomes) {
      if (Boolean(forecast.correct) !== target) break;
      currentCycleStreak += target ? 1 : -1;
    }
  }

  const chronological = [...resolved].sort((a, b) => new Date(a.resolvedAt ?? a.closesAt).getTime() - new Date(b.resolvedAt ?? b.closesAt).getTime());
  let cumulativeCorrect = 0;
  let cumulativeBrier = 0;
  const timeline = chronological.map((forecast, index) => {
    cumulativeCorrect += forecast.correct ? 1 : 0;
    cumulativeBrier += forecast.brierScore ?? 0;
    const rolling = chronological.slice(Math.max(0, index - 24), index + 1);
    return {
      time: forecast.resolvedAt ?? forecast.closesAt,
      resolved: index + 1,
      cumulativeAccuracy: cumulativeCorrect / (index + 1),
      rollingAccuracy: rolling.filter((item) => item.correct).length / rolling.length,
      cumulativeBrier: cumulativeBrier / (index + 1),
    };
  });

  return {
    issued: policy.length,
    pending: policy.filter((forecast) => forecast.status === 'pending').length,
    resolved: resolved.length, correct,
    cycles: allCycles.size,
    resolvedCycles: resolvedCycleGroups.size,
    cycleBalancedAccuracy,
    invalid: policy.filter((forecast) => forecast.status === 'invalid').length,
    accuracy: resolved.length ? correct / resolved.length : null,
    brierScore: resolved.length ? resolved.reduce((sum, forecast) => sum + (forecast.brierScore ?? 0), 0) / resolved.length : null,
    logLoss: resolved.length ? resolved.reduce((sum, forecast) => sum + (forecast.logLoss ?? 0), 0) / resolved.length : null,
    currentStreak,
    currentCycleStreak,
    observedCalculations: policy.length,
    resolvedCalculations: resolved.length,
    benchmarks: [
      // Scored on the buys taken, which asks the question that matters: on the contracts we chose,
      // did our estimate beat the price we paid?
      score('Money Noodle model', resolved, (forecast) => forecast.probabilityUp),
      score('Model + venue blend', resolved, (forecast) => forecast.blendedProbabilityUp),
      score('Contract basis only', resolved, (forecast) => forecast.basisProbabilityUp),
      score('Settlement-average observation model', resolved, (forecast) => forecast.settlementAverageEstimate?.probabilityUp),
      score('Polymarket price', resolved, (forecast) => forecast.polymarketProbabilityUp),
      score('Kalshi price', resolved, (forecast) => forecast.kalshiProbabilityUp),
      score('Coin flip (50/50)', resolved, () => 0.5),
    ].filter((benchmark) => benchmark.resolved > 0),
    edgeBuckets: edgeBuckets(resolved),
    segments: buildSegments(resolved),
    missedBuyCounterfactual: missedBuyCounterfactual(forecasts),
    resolvedWindows,
    evaluationMinimumWindows: MIN_EVALUATION_WINDOWS,
    evaluationMeaningful: resolvedWindows >= MIN_EVALUATION_WINDOWS,
    realizedEdgeTrades: withRealized.length,
    meanPredictedEdge: withRealized.length ? withRealized.reduce((sum, item) => sum + item.predictedEdge!, 0) / withRealized.length : null,
    meanRealizedReturn: withRealized.length ? withRealized.reduce((sum, item) => sum + item.realizedReturn!, 0) / withRealized.length : null,
    byLeadTime: leadTimeSlices(resolved),
    calibrationBins: calibrationBins(resolved),
    calibrationWindows,
    calibrationMinimum: MIN_CALIBRATION_SAMPLE,
    calibrationProgress: Math.min(1, calibrationWindows / MIN_CALIBRATION_SAMPLE),
    calibrationReady: calibrationWindows >= MIN_CALIBRATION_SAMPLE,
    byAsset: slices(resolved, (forecast) => forecast.symbol),
    byDirection: slices(resolved, (forecast) => forecast.direction),
    byModelVersion: slices(resolved, (forecast) => forecast.modelVersion),
    byConfidenceBucket: slices(resolved, (forecast) => forecast.confidence >= 0.75 ? '75%+' : forecast.confidence >= 0.65 ? '65–74%' : forecast.confidence >= 0.57 ? '57–64%' : '<57%'),
    timeline: downsamplePerformanceTimeline(timeline),
    recent: [...policy].sort((a, b) => new Date(b.resolvedAt ?? b.issuedAt).getTime() - new Date(a.resolvedAt ?? a.issuedAt).getTime()).slice(0, 8),
  };
}
