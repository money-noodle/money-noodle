import { pushInto } from './group';
import {
  BENCHMARK_SOURCES,
  CALIBRATION_EDGES,
  EDGE_BUCKETS,
  LEAD_BUCKETS,
  MIN_EVALUATION_WINDOWS,
  SEGMENT_DIMENSIONS,
  byIdTieBreak,
  clampProbability,
  confidenceBucket,
  cycleKey,
  downsamplePerformanceTimeline,
  isQualified,
  settlementWindowKey,
} from './performance';
import { BUY_POLICY_VERSION, MIN_CALIBRATION_SAMPLE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY, MIN_NET_EDGE, MIN_SELECTED_SIDE_PROBABILITY, venueFeeRate } from './prediction-policy';
import type { PerformanceSlice, PerformanceSummary, PerformanceTimelinePoint, SegmentGroup, TrackedForecast } from './types';

/**
 * Sufficient statistics for one sealed shard: everything `summarizePerformance` needs from rows it will
 * no longer hold in memory. See docs/forecast-storage-design.md §4 for the algebra and §4.1 for the
 * measurements that decided its shape.
 *
 * The design constraint is that merging these must reproduce the current summary — exactly for anything
 * countable, within `SUMMARY_FLOAT_TOLERANCE` for float aggregates, because summing subtotals in a
 * different order moves the last digits and no amount of care removes that.
 */
export const FORECAST_ROLLUP_VERSION = 'forecast-rollup-v1';

/**
 * Run-length structure over a boolean sequence, enough to answer "how long is the run at the front"
 * after any number of merges.
 *
 * A streak cannot be read from the tail of the newest shard: the longest in the retained history is 268
 * rows and crosses shard boundaries. This monoid is exact and associative, so the answer does not depend
 * on how the history happens to be split.
 */
export interface RunMonoid {
  count: number;
  first: boolean;
  last: boolean;
  /** Length of the run at the start of the sequence. */
  prefix: number;
  /** Length of the run at the end, needed to join with whatever follows. */
  suffix: number;
  /** Whether the whole sequence is one run, in which case a merge can extend straight through it. */
  uniform: boolean;
}

export interface LabelledCount {
  label: string;
  resolved: number;
  correct: number;
}

/**
 * One point of the compact chronological column that reproduces `timeline`.
 *
 * `timeline` is per-row with a rolling 25-row window and its 500 reported points are chosen by index
 * into the whole sequence, so no fixed-size statistic reconstructs it. Storing three fields per row
 * costs about 60 bytes against the ~4 KB of a full row — roughly 2 MB for the whole history against
 * 198 MB — and buys exactness rather than an approximation.
 */
export interface TimelineCell {
  time: string;
  correct: 0 | 1;
  brier: number;
}

export interface ForecastSummaryRollup {
  version: typeof FORECAST_ROLLUP_VERSION;
  shardId: string;

  /**
   * Ranges of every ordering key the merge relies on, so the gate can assert that shards do not
   * overlap. Chronological order being a clean concatenation of issuance-day shards is a property of
   * the data (resolution lag under ~15 minutes against quarter-hour cycles), not of the code.
   */
  bounds: {
    resolvedFirst?: string;
    resolvedLast?: string;
    cycleClosesFirst?: string;
    cycleClosesLast?: string;
  };

  qualified: number;
  pending: number;
  resolved: number;
  invalid: number;
  correct: number;
  brierSum: number;
  logLossSum: number;

  realizedEdgeTrades: number;
  predictedEdgeSum: number;
  realizedReturnSum: number;

  cycleKeys: string[];
  resolvedCycleKeys: string[];
  /** Raw `closesAt`, matching what `resolvedWindows` counts. */
  resolvedWindowKeys: string[];
  /** Normalised key over *all* resolved rows including unqualified ones, which is a larger set. */
  calibrationWindowKeys: string[];

  cycleOutcomes: Array<{ cycleId: string; correct: number; total: number }>;

  /** In `orderedResolved` order: resolution time descending, id ascending. */
  resolvedRun: RunMonoid;
  /** In `cycleOutcomes` order: close time descending, id ascending. */
  cycleRun: RunMonoid;

  benchmarks: Array<{ label: string; resolved: number; correct: number; brierSum: number; logLossSum: number }>;
  edgeBuckets: Array<{ label: string; trades: number; edgeSum: number; returnSum: number; wins: number }>;
  leadTime: Array<{ label: string; resolved: number; correct: number; brierSum: number }>;
  calibrationBins: Array<{ label: string; resolved: number; forecastSum: number; upCount: number }>;
  byAsset: LabelledCount[];
  byDirection: LabelledCount[];
  byModelVersion: LabelledCount[];
  byConfidenceBucket: LabelledCount[];

  /**
   * Per (dimension, label). `windowMeans` holds one entry per settlement window in this shard, already
   * clustered, because windows never span shards (§4.1) and the standard error is taken across windows.
   */
  segments: Array<{ dimension: string; label: string; trades: number; predictedEdgeSum: number; wins: number; windowMeans: number[] }>;

  counterfactual: {
    candidates: number;
    profitableCandidates: number;
    windowMeans: number[];
    bestPerWindow: number[];
  };

  timeline: TimelineCell[];
  /** Top 8 qualifying rows by the order `recent` reports; a top-k merge needs no ordering assumption. */
  recent: TrackedForecast[];
}

const EMPTY_RUN: RunMonoid = { count: 0, first: false, last: false, prefix: 0, suffix: 0, uniform: true };

export function runFromSequence(values: boolean[]): RunMonoid {
  if (!values.length) return { ...EMPTY_RUN };
  let prefix = 1;
  while (prefix < values.length && values[prefix] === values[0]) prefix += 1;
  let suffix = 1;
  while (suffix < values.length && values[values.length - 1 - suffix] === values[values.length - 1]) suffix += 1;
  return {
    count: values.length,
    first: values[0],
    last: values[values.length - 1],
    prefix,
    suffix,
    uniform: prefix === values.length,
  };
}

export function mergeRuns(left: RunMonoid, right: RunMonoid): RunMonoid {
  if (!left.count) return { ...right };
  if (!right.count) return { ...left };
  const joins = left.last === right.first;
  return {
    count: left.count + right.count,
    first: left.first,
    last: right.last,
    // A prefix only grows past the boundary if the left side is entirely one run and the join matches.
    prefix: left.uniform && joins ? left.count + right.prefix : left.prefix,
    suffix: right.uniform && joins ? right.count + left.suffix : right.suffix,
    uniform: left.uniform && right.uniform && joins,
  };
}

const resolutionTime = (forecast: TrackedForecast) => forecast.resolvedAt ?? forecast.closesAt;
const leadSeconds = (forecast: TrackedForecast) =>
  forecast.secondsRemaining ?? (new Date(forecast.closesAt).getTime() - new Date(forecast.issuedAt).getTime()) / 1000;
const won = (forecast: TrackedForecast) => forecast.outcome === (forecast.entrySide ?? 'UP');

function labelledCounts(rows: TrackedForecast[], key: (forecast: TrackedForecast) => string): LabelledCount[] {
  const groups = new Map<string, TrackedForecast[]>();
  for (const row of rows) pushInto(groups, key(row), row);
  return [...groups.entries()].map(([label, items]) => ({
    label, resolved: items.length, correct: items.filter((item) => item.correct).length,
  }));
}

/**
 * The nearest-five-minute snapshot selection and the per-window clustering that
 * `missedBuyCounterfactual` performs, applied to one shard. Both are window-local, and windows never
 * span shards, so the shard's answer is final and the merge is concatenation.
 */
function counterfactualRollup(forecasts: TrackedForecast[]): ForecastSummaryRollup['counterfactual'] {
  const byAssetWindow = new Map<string, TrackedForecast[]>();
  for (const forecast of forecasts.filter((item) => item.status === 'resolved' && item.policyVersion === BUY_POLICY_VERSION)) {
    const outcome = forecast.venueOutcomes?.kalshi?.outcome;
    if (!outcome || !forecast.venueContracts?.kalshi || forecast.venueOutcomes?.kalshi?.contractId !== forecast.venueContracts.kalshi.contractId) continue;
    pushInto(byAssetWindow, `${forecast.symbol}:${settlementWindowKey(forecast)}`, forecast);
  }
  const candidates: Array<{ closesAt: string; edge: number; returnValue: number }> = [];
  for (const snapshots of byAssetWindow.values()) {
    const nearest = [...snapshots].sort((a, b) => {
      const left = Math.abs(leadSeconds(a) - 300);
      const right = Math.abs(leadSeconds(b) - 300);
      return left - right || Date.parse(a.issuedAt) - Date.parse(b.issuedAt);
    })[0];
    const seconds = leadSeconds(nearest);
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
  for (const candidate of candidates) pushInto(windowValues, candidate.closesAt, candidate.returnValue);
  const best = new Map<string, { edge: number; returnValue: number }>();
  for (const candidate of candidates) {
    const prior = best.get(candidate.closesAt);
    if (!prior || candidate.edge > prior.edge) best.set(candidate.closesAt, candidate);
  }
  return {
    candidates: candidates.length,
    profitableCandidates: candidates.filter((item) => item.returnValue > 0).length,
    windowMeans: [...windowValues.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length),
    bestPerWindow: [...best.values()].map((item) => item.returnValue),
  };
}

function segmentRollups(resolved: TrackedForecast[]): ForecastSummaryRollup['segments'] {
  const tradable = resolved.filter((forecast) => forecast.realizedReturn !== undefined);
  const out: ForecastSummaryRollup['segments'] = [];
  for (const { dimension, key } of SEGMENT_DIMENSIONS) {
    const groups = new Map<string, TrackedForecast[]>();
    for (const row of tradable) {
      const label = key(row);
      if (label === null) continue;
      pushInto(groups, label, row);
    }
    for (const [label, items] of groups) {
      const windows = new Map<string, TrackedForecast[]>();
      for (const item of items) pushInto(windows, item.closesAt, item);
      out.push({
        dimension, label, trades: items.length,
        predictedEdgeSum: items.reduce((sum, item) => sum + (item.predictedEdge ?? 0), 0),
        wins: items.filter(won).length,
        windowMeans: [...windows.values()].map((group) => group.reduce((sum, item) => sum + (item.realizedReturn ?? 0), 0) / group.length),
      });
    }
  }
  return out;
}

/** Sufficient statistics for one shard's rows. Open rows go through this too, so the merge is uniform. */
export function buildSummaryRollup(shardId: string, rows: TrackedForecast[]): ForecastSummaryRollup {
  const allResolved = rows.filter((forecast) => forecast.status === 'resolved');
  const policy = rows.filter(isQualified);
  const resolved = policy.filter((forecast) => forecast.status === 'resolved');
  const withRealized = resolved.filter((forecast) => forecast.predictedEdge !== undefined && forecast.realizedReturn !== undefined);

  const resolvedCycles = new Map<string, { correct: number; total: number }>();
  const cycleGroups = new Map<string, TrackedForecast[]>();
  for (const forecast of resolved) {
    const key = cycleKey(forecast);
    const current = resolvedCycles.get(key) ?? { correct: 0, total: 0 };
    resolvedCycles.set(key, { correct: current.correct + (forecast.correct ? 1 : 0), total: current.total + 1 });
    pushInto(cycleGroups, key, forecast);
  }

  // Descending resolution time with an ascending id tie-break: this is the order `currentStreak` reads,
  // and it is deliberately not the reverse of the chronological order, which breaks ties the same way.
  const orderedResolved = [...resolved].sort((a, b) =>
    new Date(resolutionTime(b)).getTime() - new Date(resolutionTime(a)).getTime() || byIdTieBreak(a, b));
  const cycleOutcomeRows = [...cycleGroups.values()]
    .map((items) => [...items].sort((a, b) => new Date(a.issuedAt).getTime() - new Date(b.issuedAt).getTime() || byIdTieBreak(a, b))[0])
    .sort((a, b) => new Date(b.closesAt).getTime() - new Date(a.closesAt).getTime() || byIdTieBreak(a, b));

  const chronological = [...resolved].sort((a, b) =>
    new Date(resolutionTime(a)).getTime() - new Date(resolutionTime(b)).getTime() || byIdTieBreak(a, b));

  return {
    version: FORECAST_ROLLUP_VERSION,
    shardId,
    bounds: {
      resolvedFirst: chronological.length ? resolutionTime(chronological[0]) : undefined,
      resolvedLast: chronological.length ? resolutionTime(chronological[chronological.length - 1]) : undefined,
      cycleClosesFirst: cycleOutcomeRows.length ? cycleOutcomeRows[cycleOutcomeRows.length - 1].closesAt : undefined,
      cycleClosesLast: cycleOutcomeRows.length ? cycleOutcomeRows[0].closesAt : undefined,
    },
    qualified: policy.length,
    pending: policy.filter((forecast) => forecast.status === 'pending').length,
    resolved: resolved.length,
    invalid: policy.filter((forecast) => forecast.status === 'invalid').length,
    correct: resolved.filter((forecast) => forecast.correct).length,
    brierSum: resolved.reduce((sum, forecast) => sum + (forecast.brierScore ?? 0), 0),
    logLossSum: resolved.reduce((sum, forecast) => sum + (forecast.logLoss ?? 0), 0),

    realizedEdgeTrades: withRealized.length,
    predictedEdgeSum: withRealized.reduce((sum, item) => sum + item.predictedEdge!, 0),
    realizedReturnSum: withRealized.reduce((sum, item) => sum + item.realizedReturn!, 0),

    cycleKeys: [...new Set(policy.map(cycleKey))].sort(),
    resolvedCycleKeys: [...resolvedCycles.keys()].sort(),
    resolvedWindowKeys: [...new Set(resolved.map((forecast) => forecast.closesAt))].sort(),
    calibrationWindowKeys: [...new Set(allResolved.map(settlementWindowKey))].sort(),

    cycleOutcomes: [...resolvedCycles.entries()]
      .map(([cycleId, counts]) => ({ cycleId, ...counts }))
      .sort((a, b) => a.cycleId.localeCompare(b.cycleId)),

    resolvedRun: runFromSequence(orderedResolved.map((forecast) => Boolean(forecast.correct))),
    cycleRun: runFromSequence(cycleOutcomeRows.map((forecast) => Boolean(forecast.correct))),

    benchmarks: BENCHMARK_SOURCES.map(({ label, probability }) => {
      const usable = resolved.filter((forecast) => Number.isFinite(probability(forecast) as number));
      let correct = 0;
      let brierSum = 0;
      let logLossSum = 0;
      for (const forecast of usable) {
        const p = clampProbability(probability(forecast)!);
        const actual = forecast.outcome === 'UP' ? 1 : 0;
        correct += p === 0.5 ? 0.5 : (p > 0.5 ? 1 : 0) === actual ? 1 : 0;
        brierSum += (p - actual) ** 2;
        logLossSum += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
      }
      return { label, resolved: usable.length, correct, brierSum, logLossSum };
    }),

    edgeBuckets: EDGE_BUCKETS.map(({ label, min, max }) => {
      const items = resolved.filter((forecast) =>
        isQualified(forecast) && forecast.predictedEdge !== undefined && forecast.realizedReturn !== undefined
        && forecast.predictedEdge >= min && forecast.predictedEdge < max);
      return {
        label, trades: items.length,
        edgeSum: items.reduce((sum, item) => sum + item.predictedEdge!, 0),
        returnSum: items.reduce((sum, item) => sum + item.realizedReturn!, 0),
        wins: items.filter((item) => item.outcome === (item.entrySide ?? 'UP')).length,
      };
    }),

    leadTime: LEAD_BUCKETS.map(({ label, min, max }) => {
      const items = resolved.filter((forecast) => leadSeconds(forecast) >= min && leadSeconds(forecast) < max);
      return {
        label, resolved: items.length,
        correct: items.filter((item) => item.correct).length,
        brierSum: items.reduce((sum, item) => sum + (item.brierScore ?? 0), 0),
      };
    }),

    calibrationBins: CALIBRATION_EDGES.slice(0, -1).map((low, index) => {
      const high = CALIBRATION_EDGES[index + 1];
      const items = resolved.filter((forecast) => forecast.probabilityUp >= low && forecast.probabilityUp < high);
      return {
        label: `${Math.round(low * 100)}–${Math.round(Math.min(high, 1) * 100)}%`,
        resolved: items.length,
        forecastSum: items.reduce((sum, item) => sum + item.probabilityUp, 0),
        upCount: items.filter((item) => item.outcome === 'UP').length,
      };
    }),

    byAsset: labelledCounts(resolved, (forecast) => forecast.symbol),
    byDirection: labelledCounts(resolved, (forecast) => forecast.direction),
    byModelVersion: labelledCounts(resolved, (forecast) => forecast.modelVersion),
    byConfidenceBucket: labelledCounts(resolved, confidenceBucket),

    segments: segmentRollups(resolved),
    counterfactual: counterfactualRollup(rows),

    timeline: chronological.map((forecast) => ({
      time: resolutionTime(forecast),
      correct: forecast.correct ? 1 : 0,
      brier: forecast.brierScore ?? 0,
    } as TimelineCell)),

    recent: [...policy]
      .sort((a, b) => new Date(b.resolvedAt ?? b.issuedAt).getTime() - new Date(a.resolvedAt ?? a.issuedAt).getTime() || byIdTieBreak(a, b))
      .slice(0, 8),
  };
}

function mergeCounts<T extends { label: string }>(rollups: T[][], merge: (into: T, from: T) => void): T[] {
  const out = new Map<string, T>();
  for (const list of rollups) {
    for (const item of list) {
      const existing = out.get(item.label);
      if (!existing) out.set(item.label, { ...item });
      else merge(existing, item);
    }
  }
  return [...out.values()];
}

const ratio = (numerator: number, denominator: number) => (denominator ? numerator / denominator : null);

function meanAndStandardError(values: number[]): { mean: number | null; standardError: number | null } {
  if (!values.length) return { mean: null, standardError: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const standardError = values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { mean, standardError };
}

function slicesFrom(counts: LabelledCount[]): PerformanceSlice[] {
  return counts
    .map(({ label, resolved, correct }) => ({ label, resolved, correct, accuracy: correct / resolved }))
    .sort((a, b) => b.resolved - a.resolved || b.accuracy - a.accuracy || a.label.localeCompare(b.label));
}

function timelineFrom(cells: TimelineCell[]): PerformanceTimelinePoint[] {
  let cumulativeCorrect = 0;
  let cumulativeBrier = 0;
  return downsamplePerformanceTimeline(cells.map((cell, index) => {
    cumulativeCorrect += cell.correct;
    cumulativeBrier += cell.brier;
    const rolling = cells.slice(Math.max(0, index - 24), index + 1);
    return {
      time: cell.time,
      resolved: index + 1,
      cumulativeAccuracy: cumulativeCorrect / (index + 1),
      rollingAccuracy: rolling.filter((item) => item.correct).length / rolling.length,
      cumulativeBrier: cumulativeBrier / (index + 1),
    };
  }));
}

/**
 * Reproduces `summarizePerformance` from sealed-shard statistics plus the rows still held resident.
 *
 * `rollups` must be in chronological shard order. The order-dependent statistics rely on shards not
 * overlapping in their ordering keys, which `assertRollupOrdering` checks rather than assumes.
 */
export function summarizeFromRollups(rollups: ForecastSummaryRollup[]): PerformanceSummary {
  const sum = (pick: (rollup: ForecastSummaryRollup) => number) => rollups.reduce((total, rollup) => total + pick(rollup), 0);
  const union = (pick: (rollup: ForecastSummaryRollup) => string[]) => new Set(rollups.flatMap(pick)).size;

  const issued = sum((rollup) => rollup.qualified);
  const resolved = sum((rollup) => rollup.resolved);
  const correct = sum((rollup) => rollup.correct);
  const resolvedWindows = union((rollup) => rollup.resolvedWindowKeys);
  const calibrationWindows = union((rollup) => rollup.calibrationWindowKeys);

  const cycleTotals = new Map<string, { correct: number; total: number }>();
  for (const rollup of rollups) {
    for (const outcome of rollup.cycleOutcomes) {
      const current = cycleTotals.get(outcome.cycleId) ?? { correct: 0, total: 0 };
      cycleTotals.set(outcome.cycleId, { correct: current.correct + outcome.correct, total: current.total + outcome.total });
    }
  }
  const cycleAccuracies = [...cycleTotals.values()].map((counts) => counts.correct / counts.total);

  // Both streaks read newest-first, so the runs merge in reverse chronological order and the answer is
  // the signed prefix of the merge.
  const reversed = [...rollups].reverse();
  const resolvedRun = reversed.map((rollup) => rollup.resolvedRun).reduce(mergeRuns, { ...EMPTY_RUN });
  const cycleRun = reversed.map((rollup) => rollup.cycleRun).reduce(mergeRuns, { ...EMPTY_RUN });

  const realizedEdgeTrades = sum((rollup) => rollup.realizedEdgeTrades);
  const counterfactualWindows = rollups.flatMap((rollup) => rollup.counterfactual.windowMeans);
  const counterfactualBest = rollups.flatMap((rollup) => rollup.counterfactual.bestPerWindow);
  const counterfactual = meanAndStandardError(counterfactualWindows);

  const segments = new Map<string, Map<string, { trades: number; predictedEdgeSum: number; wins: number; windowMeans: number[] }>>();
  for (const rollup of rollups) {
    for (const segment of rollup.segments) {
      if (!segments.has(segment.dimension)) segments.set(segment.dimension, new Map());
      const labels = segments.get(segment.dimension)!;
      const existing = labels.get(segment.label);
      if (!existing) labels.set(segment.label, { trades: segment.trades, predictedEdgeSum: segment.predictedEdgeSum, wins: segment.wins, windowMeans: [...segment.windowMeans] });
      else {
        existing.trades += segment.trades;
        existing.predictedEdgeSum += segment.predictedEdgeSum;
        existing.wins += segment.wins;
        existing.windowMeans.push(...segment.windowMeans);
      }
    }
  }
  const segmentGroups: SegmentGroup[] = SEGMENT_DIMENSIONS
    .map(({ dimension, description }) => ({
      dimension,
      description,
      segments: [...(segments.get(dimension) ?? new Map()).entries()]
        .map(([label, stat]) => {
          const { mean, standardError } = meanAndStandardError(stat.windowMeans);
          return {
            label, trades: stat.trades, windows: stat.windowMeans.length,
            meanPredictedEdge: stat.predictedEdgeSum / stat.trades,
            meanRealizedReturn: mean as number, standardError,
            winRate: stat.wins / stat.trades,
          };
        })
        .sort((a, b) => b.meanRealizedReturn - a.meanRealizedReturn || a.label.localeCompare(b.label)),
    }))
    .filter((group) => group.segments.length > 0);

  const brierSum = sum((rollup) => rollup.brierSum);
  const logLossSum = sum((rollup) => rollup.logLossSum);

  return {
    issued,
    pending: sum((rollup) => rollup.pending),
    resolved,
    correct,
    cycles: union((rollup) => rollup.cycleKeys),
    resolvedCycles: cycleTotals.size,
    cycleBalancedAccuracy: cycleAccuracies.length ? cycleAccuracies.reduce((total, value) => total + value, 0) / cycleAccuracies.length : null,
    invalid: sum((rollup) => rollup.invalid),
    accuracy: ratio(correct, resolved),
    brierScore: ratio(brierSum, resolved),
    logLoss: ratio(logLossSum, resolved),
    currentStreak: resolvedRun.count ? (resolvedRun.first ? resolvedRun.prefix : -resolvedRun.prefix) : 0,
    currentCycleStreak: cycleRun.count ? (cycleRun.first ? cycleRun.prefix : -cycleRun.prefix) : 0,
    observedCalculations: issued,
    resolvedCalculations: resolved,
    benchmarks: mergeCounts(rollups.map((rollup) => rollup.benchmarks), (into, from) => {
      into.resolved += from.resolved;
      into.correct += from.correct;
      into.brierSum += from.brierSum;
      into.logLossSum += from.logLossSum;
    })
      .filter((benchmark) => benchmark.resolved > 0)
      .map(({ label, resolved: usable, correct: hits, brierSum: brier, logLossSum: logLoss }) => ({
        label, resolved: usable, accuracy: hits / usable, brierScore: brier / usable, logLoss: logLoss / usable,
      })),
    edgeBuckets: mergeCounts(rollups.map((rollup) => rollup.edgeBuckets), (into, from) => {
      into.trades += from.trades;
      into.edgeSum += from.edgeSum;
      into.returnSum += from.returnSum;
      into.wins += from.wins;
    })
      .filter((bucket) => bucket.trades > 0)
      .map(({ label, trades, edgeSum, returnSum, wins }) => ({
        label, trades, predictedEdge: edgeSum / trades, realizedReturn: returnSum / trades, winRate: wins / trades,
      })),
    segments: segmentGroups,
    missedBuyCounterfactual: {
      label: `${Number((MIN_SELECTED_SIDE_PROBABILITY * 100).toFixed(2))}% selected-side floor rejects`,
      description: `Exact-Kalshi fee-aware counterfactuals for sides that passed quality, price, and 5pp edge but were rejected only because independent selected-side probability was below ${Number((MIN_SELECTED_SIDE_PROBABILITY * 100).toFixed(2))}%.`,
      candidates: sum((rollup) => rollup.counterfactual.candidates),
      windows: counterfactualWindows.length,
      profitableCandidates: sum((rollup) => rollup.counterfactual.profitableCandidates),
      meanCandidateReturn: counterfactual.mean,
      standardError: counterfactual.standardError,
      bestPerWindowCandidates: counterfactualBest.length,
      bestPerWindowWins: counterfactualBest.filter((value) => value > 0).length,
      bestPerWindowMeanReturn: counterfactualBest.length ? counterfactualBest.reduce((total, value) => total + value, 0) / counterfactualBest.length : null,
      bestPerWindowTotalReturn: counterfactualBest.length ? counterfactualBest.reduce((total, value) => total + value, 0) : null,
    },
    resolvedWindows,
    evaluationMinimumWindows: MIN_EVALUATION_WINDOWS,
    evaluationMeaningful: resolvedWindows >= MIN_EVALUATION_WINDOWS,
    realizedEdgeTrades,
    meanPredictedEdge: ratio(sum((rollup) => rollup.predictedEdgeSum), realizedEdgeTrades),
    meanRealizedReturn: ratio(sum((rollup) => rollup.realizedReturnSum), realizedEdgeTrades),
    byLeadTime: mergeCounts(rollups.map((rollup) => rollup.leadTime), (into, from) => {
      into.resolved += from.resolved;
      into.correct += from.correct;
      into.brierSum += from.brierSum;
    })
      .filter((slice) => slice.resolved > 0)
      .map(({ label, resolved: count, correct: hits, brierSum: brier }) => ({
        label, resolved: count, correct: hits, accuracy: hits / count, brierScore: brier / count,
      })),
    calibrationBins: mergeCounts(rollups.map((rollup) => rollup.calibrationBins), (into, from) => {
      into.resolved += from.resolved;
      into.forecastSum += from.forecastSum;
      into.upCount += from.upCount;
    })
      .filter((bin) => bin.resolved > 0)
      .map(({ label, resolved: count, forecastSum, upCount }) => ({
        label, resolved: count, meanForecast: forecastSum / count, observedRate: upCount / count,
      })),
    calibrationWindows,
    calibrationMinimum: MIN_CALIBRATION_SAMPLE,
    calibrationProgress: Math.min(1, calibrationWindows / MIN_CALIBRATION_SAMPLE),
    calibrationReady: calibrationWindows >= MIN_CALIBRATION_SAMPLE,
    byAsset: slicesFrom(mergeCounts(rollups.map((rollup) => rollup.byAsset), (into, from) => { into.resolved += from.resolved; into.correct += from.correct; })),
    byDirection: slicesFrom(mergeCounts(rollups.map((rollup) => rollup.byDirection), (into, from) => { into.resolved += from.resolved; into.correct += from.correct; })),
    byModelVersion: slicesFrom(mergeCounts(rollups.map((rollup) => rollup.byModelVersion), (into, from) => { into.resolved += from.resolved; into.correct += from.correct; })),
    byConfidenceBucket: slicesFrom(mergeCounts(rollups.map((rollup) => rollup.byConfidenceBucket), (into, from) => { into.resolved += from.resolved; into.correct += from.correct; })),
    timeline: timelineFrom(rollups.flatMap((rollup) => rollup.timeline)),
    recent: rollups.flatMap((rollup) => rollup.recent)
      .sort((a, b) => new Date(b.resolvedAt ?? b.issuedAt).getTime() - new Date(a.resolvedAt ?? a.issuedAt).getTime() || byIdTieBreak(a, b))
      .slice(0, 8),
  };
}

/**
 * Checks the property the ordered statistics depend on: that shards do not overlap in any ordering key
 * the merge reads. Chronological order being a clean concatenation of issuance-day shards holds because
 * resolution lag is under about fifteen minutes while cycles align to quarter-hours — a property of the
 * data, not of the code, so a future row with a longer lag must fail loudly rather than silently
 * corrupt both streaks and `timeline`. See docs/forecast-storage-design.md §4.1.
 */
export function assertRollupOrdering(rollups: ForecastSummaryRollup[]): string[] {
  const errors: string[] = [];
  const check = (label: string, last?: string, next?: string, shard?: string) => {
    if (last === undefined || next === undefined) return;
    // Ties fail as well as inversions. When two shards share a boundary timestamp the id tie-break
    // decides the global order, so it can interleave rows across the boundary and shard order stops
    // determining the sequence — which is exactly the assumption the run monoids rest on.
    if (next <= last) errors.push(`Shard ${shard} overlaps the previous shard on ${label}: ${next} does not follow ${last}.`);
  };
  let previous: ForecastSummaryRollup | undefined;
  for (const rollup of rollups) {
    if (previous) {
      check('resolution time', previous.bounds.resolvedLast, rollup.bounds.resolvedFirst, rollup.shardId);
      check('cycle close time', previous.bounds.cycleClosesLast, rollup.bounds.cycleClosesFirst, rollup.shardId);
    }
    if (rollup.bounds.resolvedFirst !== undefined || rollup.bounds.resolvedLast !== undefined) previous = rollup;
  }
  return errors;
}
