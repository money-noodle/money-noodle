import { contractProvenanceMatches } from './contract-provenance';
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
import { BUY_POLICY_VERSION, MAX_ENTRY_PRICE, MIN_CALIBRATION_SAMPLE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY, MIN_NET_EDGE, MIN_SELECTED_SIDE_PROBABILITY, venueFeeRate } from './prediction-policy';
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

/** One settlement window's contribution, kept unaveraged so windows split across shards can merge. */
export interface WindowTotal {
  key: string;
  sum: number;
  count: number;
}

export interface LabelledCount {
  label: string;
  resolved: number;
  correct: number;
}

export interface CounterfactualCandidate {
  key: string;
  windowKey: string;
  edge: number;
  returnValue: number;
}

/** Nearest-five-minute snapshot selected within one shard for an asset/window. */
export interface CounterfactualAssetWindow {
  key: string;
  distanceFromFiveMinutes: number;
  issuedAt: string;
  forecastId: string;
  candidates: CounterfactualCandidate[];
}

/**
 * One row of the compact column that reproduces `timeline` and both streaks.
 *
 * `timeline` is per-row with a rolling 25-row window and its 500 reported points are chosen by index
 * into the whole sequence, so no fixed-size statistic reconstructs it. Storing four fields per row
 * costs about 100 bytes against the ~4 KB of a full row — roughly 3 MB for the whole history against
 * 198 MB — and buys exactness rather than an approximation.
 *
 * `id` is carried because it is the tie-break on every ordering that feeds a reported statistic, and
 * ties are the ordinary case here. Without it the merge would have to assume shards do not overlap in
 * resolution time, which is not true: a row issued before midnight can resolve after one issued the
 * following day. Carrying the id makes the merge sort the rows itself and depend on nothing.
 */
export interface TimelineCell {
  id: string;
  time: string;
  correct: 0 | 1;
  brier: number;
}

/**
 * Per-cycle outcome, carrying the representative row's identity so cycles that span shards merge
 * correctly. The representative is the earliest-issued row of the cycle, and it decides both the
 * ordering and the outcome the cycle streak reads.
 */
export interface CycleOutcome {
  cycleId: string;
  correct: number;
  total: number;
  closesAt: string;
  representativeIssuedAt: string;
  representativeId: string;
  representativeCorrect: boolean;
}

export interface ForecastSummaryRollup {
  version: typeof FORECAST_ROLLUP_VERSION;
  shardId: string;

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

  cycleOutcomes: CycleOutcome[];

  benchmarks: Array<{ label: string; resolved: number; correct: number; brierSum: number; logLossSum: number }>;
  edgeBuckets: Array<{ label: string; trades: number; edgeSum: number; returnSum: number; wins: number }>;
  leadTime: Array<{ label: string; resolved: number; correct: number; brierSum: number }>;
  calibrationBins: Array<{ label: string; resolved: number; forecastSum: number; upCount: number }>;
  byAsset: LabelledCount[];
  byDirection: LabelledCount[];
  byModelVersion: LabelledCount[];
  byConfidenceBucket: LabelledCount[];

  /**
   * Per (dimension, label), with one entry per settlement window keyed by the window itself.
   *
   * Deliberately not pre-averaged. Clustering inside the shard would treat a window split across two
   * shards as two observations, which both inflates the window count and moves the standard error the
   * clustering exists to keep honest.
   */
  segments: Array<{ dimension: string; label: string; trades: number; predictedEdgeSum: number; wins: number; windows: WindowTotal[] }>;

  counterfactual: {
    /**
     * One shard-local nearest snapshot per asset/window. The merge re-selects globally before counting
     * candidates, so an asset/window split across shards cannot contribute twice.
     */
    assetWindows: CounterfactualAssetWindow[];
  };

  timeline: TimelineCell[];
  /** Top 8 qualifying rows by the order `recent` reports; a top-k merge needs no ordering assumption. */
  recent: TrackedForecast[];
}

/**
 * Length of the leading run of a sequence, signed the way both streaks report it: positive while the
 * most recent outcomes are correct, negative while they are wrong.
 */
export function leadingStreak(values: boolean[]): number {
  if (!values.length) return 0;
  let run = 1;
  while (run < values.length && values[run] === values[0]) run += 1;
  return values[0] ? run : -run;
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
 * Selects the nearest-five-minute snapshot per asset/window inside one shard. The merge repeats that
 * selection across shard candidates before calculating any statistic, because neither window nor
 * asset/window locality is a safe storage invariant.
 */
function counterfactualRollup(forecasts: TrackedForecast[]): ForecastSummaryRollup['counterfactual'] {
  const byAssetWindow = new Map<string, TrackedForecast[]>();
  for (const forecast of forecasts.filter((item) => item.status === 'resolved' && item.policyVersion === BUY_POLICY_VERSION)) {
    const resolution = forecast.venueOutcomes?.kalshi;
    const reference = forecast.venueContracts?.kalshi;
    if (!resolution?.outcome || !reference || !contractProvenanceMatches(reference, 'kalshi', resolution.contractId)) continue;
    pushInto(byAssetWindow, `${forecast.symbol}:${settlementWindowKey(forecast)}`, forecast);
  }
  const assetWindows: CounterfactualAssetWindow[] = [];
  for (const [key, snapshots] of byAssetWindow) {
    const nearest = [...snapshots].sort((a, b) => {
      const left = Math.abs(leadSeconds(a) - 300);
      const right = Math.abs(leadSeconds(b) - 300);
      return left - right || Date.parse(a.issuedAt) - Date.parse(b.issuedAt) || byIdTieBreak(a, b);
    })[0];
    const candidates: CounterfactualCandidate[] = [];
    const seconds = leadSeconds(nearest);
    if (Math.abs(seconds - 300) <= 90 && nearest.confidence >= MIN_ESTIMATE_QUALITY) {
      const outcome = nearest.venueOutcomes!.kalshi!.outcome!;
      for (const quote of nearest.actionableVenuePrices?.filter((item) => item.venue === 'kalshi') ?? []) {
        const probability = quote.side === 'UP' ? nearest.probabilityUp : 1 - nearest.probabilityUp;
        const fee = venueFeeRate('kalshi', quote.price, 'taker');
        const edge = probability - quote.price - fee;
        if (quote.price < MIN_ENTRY_PRICE || quote.price > MAX_ENTRY_PRICE || edge < MIN_NET_EDGE || probability >= MIN_SELECTED_SIDE_PROBABILITY) continue;
        candidates.push({
          key: `${nearest.id}:${quote.side}:${quote.price}`,
          windowKey: settlementWindowKey(nearest), edge,
          returnValue: (outcome === quote.side ? 1 : 0) - quote.price - fee,
        });
      }
    }
    assetWindows.push({
      key, distanceFromFiveMinutes: Math.abs(seconds - 300), issuedAt: nearest.issuedAt,
      forecastId: nearest.id, candidates,
    });
  }
  return { assetWindows };
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
        windows: [...windows.entries()].map(([key, group]) => ({
          key, sum: group.reduce((sum, item) => sum + (item.realizedReturn ?? 0), 0), count: group.length,
        })),
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

  const cycleGroups = new Map<string, TrackedForecast[]>();
  for (const forecast of resolved) pushInto(cycleGroups, cycleKey(forecast), forecast);

  const cycleOutcomes: CycleOutcome[] = [...cycleGroups.entries()].map(([cycleId, items]) => {
    const representative = [...items].sort((a, b) =>
      new Date(a.issuedAt).getTime() - new Date(b.issuedAt).getTime() || byIdTieBreak(a, b))[0];
    return {
      cycleId,
      correct: items.filter((item) => item.correct).length,
      total: items.length,
      closesAt: representative.closesAt,
      representativeIssuedAt: representative.issuedAt,
      representativeId: representative.id,
      representativeCorrect: Boolean(representative.correct),
    };
  }).sort((a, b) => a.cycleId.localeCompare(b.cycleId));

  return {
    version: FORECAST_ROLLUP_VERSION,
    shardId,
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
    resolvedCycleKeys: [...cycleGroups.keys()].sort(),
    resolvedWindowKeys: [...new Set(resolved.map((forecast) => forecast.closesAt))].sort(),
    calibrationWindowKeys: [...new Set(allResolved.map(settlementWindowKey))].sort(),

    cycleOutcomes,

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

    // Stored unordered; the merge sorts, because a shard's rows can interleave with another shard's.
    timeline: resolved.map((forecast) => ({
      id: forecast.id,
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

/** Merges window totals by key, then clusters, so a window split across shards stays one observation. */
function mergeWindows(lists: WindowTotal[][]): number[] {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const list of lists) {
    for (const window of list) {
      const current = totals.get(window.key) ?? { sum: 0, count: 0 };
      totals.set(window.key, { sum: current.sum + window.sum, count: current.count + window.count });
    }
  }
  return [...totals.values()].map((total) => total.sum / total.count);
}

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

  // Cycles merge by key rather than being assumed shard-local, and the representative is re-chosen
  // across the merge so a cycle split over two shards still reports the earliest-issued row.
  const cycleTotals = new Map<string, CycleOutcome>();
  for (const rollup of rollups) {
    for (const outcome of rollup.cycleOutcomes) {
      const current = cycleTotals.get(outcome.cycleId);
      if (!current) {
        cycleTotals.set(outcome.cycleId, { ...outcome });
        continue;
      }
      const earlier = outcome.representativeIssuedAt < current.representativeIssuedAt
        || (outcome.representativeIssuedAt === current.representativeIssuedAt && outcome.representativeId < current.representativeId)
        ? outcome : current;
      cycleTotals.set(outcome.cycleId, {
        ...earlier,
        correct: current.correct + outcome.correct,
        total: current.total + outcome.total,
      });
    }
  }
  const cycleAccuracies = [...cycleTotals.values()].map((counts) => counts.correct / counts.total);

  // Both streaks read newest-first. The merged column is sorted here rather than concatenated in shard
  // order, because shards genuinely do overlap in resolution time: a row issued before midnight can
  // resolve after one issued the following day. Ties fall to the id, exactly as the direct path does.
  const column = rollups.flatMap((rollup) => rollup.timeline);
  const chronological = [...column].sort((a, b) =>
    new Date(a.time).getTime() - new Date(b.time).getTime() || a.id.localeCompare(b.id));
  const newestFirst = [...column].sort((a, b) =>
    new Date(b.time).getTime() - new Date(a.time).getTime() || a.id.localeCompare(b.id));
  const cycleNewestFirst = [...cycleTotals.values()].sort((a, b) =>
    new Date(b.closesAt).getTime() - new Date(a.closesAt).getTime() || a.representativeId.localeCompare(b.representativeId));

  const realizedEdgeTrades = sum((rollup) => rollup.realizedEdgeTrades);

  // Re-select the nearest snapshot globally for every asset/window. Counting shard-local selections
  // directly would duplicate an asset/window split by the storage layout and could even select a farther
  // observation whose quote happened to qualify.
  const counterfactualAssetWindows = new Map<string, CounterfactualAssetWindow>();
  for (const item of rollups.flatMap((rollup) => rollup.counterfactual.assetWindows)) {
    const prior = counterfactualAssetWindows.get(item.key);
    const comparison = prior ? item.distanceFromFiveMinutes - prior.distanceFromFiveMinutes
      || Date.parse(item.issuedAt) - Date.parse(prior.issuedAt)
      || item.forecastId.localeCompare(prior.forecastId) : -1;
    if (!prior || comparison < 0) counterfactualAssetWindows.set(item.key, item);
  }
  const counterfactualCandidates = [...counterfactualAssetWindows.values()].flatMap((item) => item.candidates);
  const counterfactualWindowValues = new Map<string, number[]>();
  for (const candidate of counterfactualCandidates) pushInto(counterfactualWindowValues, candidate.windowKey, candidate.returnValue);
  const counterfactualWindowTotals: WindowTotal[] = [...counterfactualWindowValues.entries()].map(([key, values]) => ({
    key, sum: values.reduce((total, value) => total + value, 0), count: values.length,
  }));
  const counterfactualWindowReturns = mergeWindows([counterfactualWindowTotals]);
  const bestByWindow = new Map<string, CounterfactualCandidate>();
  for (const candidate of counterfactualCandidates) {
    const prior = bestByWindow.get(candidate.windowKey);
    if (!prior || candidate.edge > prior.edge || (candidate.edge === prior.edge && candidate.key < prior.key)) {
      bestByWindow.set(candidate.windowKey, candidate);
    }
  }
  const counterfactualBest = [...bestByWindow.values()].map((item) => item.returnValue);
  const counterfactual = meanAndStandardError(counterfactualWindowReturns);
  const counterfactualBestStats = meanAndStandardError(counterfactualBest);

  const segments = new Map<string, Map<string, { trades: number; predictedEdgeSum: number; wins: number; windows: WindowTotal[] }>>();
  for (const rollup of rollups) {
    for (const segment of rollup.segments) {
      if (!segments.has(segment.dimension)) segments.set(segment.dimension, new Map());
      const labels = segments.get(segment.dimension)!;
      const existing = labels.get(segment.label);
      if (!existing) labels.set(segment.label, { trades: segment.trades, predictedEdgeSum: segment.predictedEdgeSum, wins: segment.wins, windows: [...segment.windows] });
      else {
        existing.trades += segment.trades;
        existing.predictedEdgeSum += segment.predictedEdgeSum;
        existing.wins += segment.wins;
        existing.windows.push(...segment.windows);
      }
    }
  }
  const segmentGroups: SegmentGroup[] = SEGMENT_DIMENSIONS
    .map(({ dimension, description }) => ({
      dimension,
      description,
      segments: [...(segments.get(dimension) ?? new Map()).entries()]
        .map(([label, stat]) => {
          const windowReturns = mergeWindows([stat.windows]);
          const { mean, standardError } = meanAndStandardError(windowReturns);
          return {
            label, trades: stat.trades, windows: windowReturns.length,
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
    currentStreak: leadingStreak(newestFirst.map((cell) => cell.correct === 1)),
    currentCycleStreak: leadingStreak(cycleNewestFirst.map((cycle) => cycle.representativeCorrect)),
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
      candidates: counterfactualCandidates.length,
      windows: counterfactualWindowReturns.length,
      profitableCandidates: counterfactualCandidates.filter((item) => item.returnValue > 0).length,
      meanCandidateReturn: counterfactual.mean,
      standardError: counterfactual.standardError,
      bestPerWindowCandidates: counterfactualBest.length,
      bestPerWindowWins: counterfactualBest.filter((value) => value > 0).length,
      bestPerWindowMeanReturn: counterfactualBestStats.mean,
      bestPerWindowStandardError: counterfactualBestStats.standardError,
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
    timeline: timelineFrom(chronological),
    recent: rollups.flatMap((rollup) => rollup.recent)
      .sort((a, b) => new Date(b.resolvedAt ?? b.issuedAt).getTime() - new Date(a.resolvedAt ?? a.issuedAt).getTime() || byIdTieBreak(a, b))
      .slice(0, 8),
  };
}

