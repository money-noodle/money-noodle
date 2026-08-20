import { DATA_FRESHNESS } from './freshness';
import type {
  PositionSide, QuoteTrajectoryFeature, QuoteTrajectorySpreadObservation, TradingVenue,
  TrajectoryCoverage, TrajectoryHorizons, UnderlyingTrajectoryFeature,
} from './types';

export const QUOTE_TRAJECTORY_SPREAD_VERSION = 'quote-trajectory-spread-observation-v1' as const;
export const TRAJECTORY_TRAILING_WINDOW_MS = 60_000;
export const TRAJECTORY_MINIMUM_OBSERVATIONS = 4;
export const TRAJECTORY_MINIMUM_COVERAGE_MS = 45_000;
export const TRAJECTORY_MAXIMUM_GAP_MS = DATA_FRESHNESS.observationBucketMs * 2;
const PRICE_EPSILON = 1e-9;

export interface UnderlyingPathSample {
  sourceObservedAt: number;
  price: number;
}

/** Normalized from an already-fetched provider response. This type grants no authority to fetch it. */
export interface QuotePathSample {
  providerId: TradingVenue;
  symbol: string;
  contractId: string;
  closesAt: string;
  sourceObservedAt: number;
  bidUp: number;
  askUp: number;
  bidDown: number;
  askDown: number;
}

interface TimedValue<T> { atMs: number; value: T | null }
interface PreparedPath<T> { points: Array<{ atMs: number; value: T }>; reason?: string }

function closeNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= PRICE_EPSILON;
}

function coverage<T>(points: Array<{ atMs: number; value: T }>): TrajectoryCoverage {
  let maximumGapMs = 0;
  for (let index = 1; index < points.length; index += 1) {
    maximumGapMs = Math.max(maximumGapMs, points[index].atMs - points[index - 1].atMs);
  }
  return {
    sourceStartedAt: new Date(points[0].atMs).toISOString(),
    sourceEndedAt: new Date(points.at(-1)!.atMs).toISOString(),
    observationCount: points.length,
    coverageSeconds: (points.at(-1)!.atMs - points[0].atMs) / 1_000,
    maximumGapSeconds: maximumGapMs / 1_000,
  };
}

function signedEfficiency(netChange: number, pathDistance: number): number | null {
  if (!(pathDistance > PRICE_EPSILON)) return null;
  return Math.max(-1, Math.min(1, netChange / pathDistance));
}

function preparePath<T>(input: {
  samples: Array<{ sourceObservedAt: number }>;
  calculationAtMs: number;
  cycleStartedAtMs: number;
  value: (sample: { sourceObservedAt: number }) => T | null;
  equal: (left: T, right: T) => boolean;
}): PreparedPath<T> {
  if (![input.calculationAtMs, input.cycleStartedAtMs].every(Number.isFinite)) {
    return { points: [], reason: 'Calculation or cycle time is invalid.' };
  }
  const relevant = input.samples
    .filter((sample) => Number.isFinite(sample.sourceObservedAt) && sample.sourceObservedAt >= input.cycleStartedAtMs)
    .sort((left, right) => left.sourceObservedAt - right.sourceObservedAt);
  if (!relevant.length) return { points: [], reason: 'No source-timestamped observations exist for this contract window.' };
  if (relevant.some((sample) => sample.sourceObservedAt > input.calculationAtMs)) {
    return { points: [], reason: 'A source observation is future-dated.' };
  }

  const grouped = new Map<number, T | null>();
  for (const sample of relevant) {
    const next = input.value(sample);
    const existing = grouped.get(sample.sourceObservedAt);
    if (existing === undefined) grouped.set(sample.sourceObservedAt, next);
    else if (existing === null || next === null || !input.equal(existing, next)) grouped.set(sample.sourceObservedAt, null);
  }
  const values: TimedValue<T>[] = [...grouped.entries()]
    .map(([atMs, value]) => ({ atMs, value }))
    .sort((left, right) => left.atMs - right.atMs);
  const latest = values.at(-1)!;
  if (input.calculationAtMs - latest.atMs > DATA_FRESHNESS.observationBucketMs) {
    return { points: [], reason: 'Latest source observation is stale.' };
  }
  if (latest.value === null) return { points: [], reason: 'Latest source observation is malformed or contradictory.' };

  let contiguous: Array<{ atMs: number; value: T }> = [];
  for (const point of values) {
    if (point.value === null) {
      contiguous = [];
      continue;
    }
    if (contiguous.length && point.atMs - contiguous.at(-1)!.atMs > TRAJECTORY_MAXIMUM_GAP_MS) contiguous = [];
    contiguous.push({ atMs: point.atMs, value: point.value });
  }
  return contiguous.length
    ? { points: contiguous }
    : { points: [], reason: 'No contiguous valid source observations are available.' };
}

function horizon<T, R>(
  prepared: PreparedPath<T>, calculationAtMs: number, summarize: (points: Array<{ atMs: number; value: T }>) => R,
): TrajectoryHorizons<R> {
  const result: TrajectoryHorizons<R> = {};
  const add = (key: 'trailing60Seconds' | 'cycleToDate', points: Array<{ atMs: number; value: T }>) => {
    const reasonKey = `${key}UnavailableReason` as const;
    if (prepared.reason) {
      result[reasonKey] = prepared.reason;
      return;
    }
    const coverageMs = points.length > 1 ? points.at(-1)!.atMs - points[0].atMs : 0;
    if (points.length < TRAJECTORY_MINIMUM_OBSERVATIONS) {
      result[reasonKey] = `Only ${points.length}/${TRAJECTORY_MINIMUM_OBSERVATIONS} unique source observations are available.`;
      return;
    }
    if (coverageMs < TRAJECTORY_MINIMUM_COVERAGE_MS) {
      result[reasonKey] = `Source observations span ${Math.max(0, coverageMs / 1_000)}/${TRAJECTORY_MINIMUM_COVERAGE_MS / 1_000} seconds.`;
      return;
    }
    result[key] = summarize(points);
  };
  add('trailing60Seconds', prepared.points.filter((point) => point.atMs >= calculationAtMs - TRAJECTORY_TRAILING_WINDOW_MS));
  add('cycleToDate', prepared.points);
  return result;
}

function summarizeUnderlying(points: Array<{ atMs: number; value: number }>): UnderlyingTrajectoryFeature {
  const startPrice = points[0].value;
  const endPrice = points.at(-1)!.value;
  let pathDistance = 0;
  for (let index = 1; index < points.length; index += 1) pathDistance += Math.abs(points[index].value - points[index - 1].value);
  const netChange = endPrice - startPrice;
  return {
    ...coverage(points), startPrice, endPrice,
    netChangePercent: (netChange / startPrice) * 100,
    pathDistancePercent: (pathDistance / startPrice) * 100,
    signedTrendEfficiency: signedEfficiency(netChange, pathDistance),
  };
}

interface QuoteValue { midpoint: number; spread: number }

function summarizeQuote(points: Array<{ atMs: number; value: QuoteValue }>): QuoteTrajectoryFeature {
  const first = points[0].value;
  const last = points.at(-1)!.value;
  let midpointDistance = 0;
  let spreadDistance = 0;
  for (let index = 1; index < points.length; index += 1) {
    midpointDistance += Math.abs(points[index].value.midpoint - points[index - 1].value.midpoint);
    spreadDistance += Math.abs(points[index].value.spread - points[index - 1].value.spread);
  }
  const midpointChange = last.midpoint - first.midpoint;
  const spreadChange = last.spread - first.spread;
  return {
    ...coverage(points),
    startMidpoint: first.midpoint,
    endMidpoint: last.midpoint,
    midpointChangeCents: midpointChange * 100,
    midpointPathDistanceCents: midpointDistance * 100,
    midpointSignedTrendEfficiency: signedEfficiency(midpointChange, midpointDistance),
    startSpread: first.spread,
    endSpread: last.spread,
    spreadChangeCents: spreadChange * 100,
    spreadPathDistanceCents: spreadDistance * 100,
    spreadSignedEfficiency: signedEfficiency(spreadChange, spreadDistance),
  };
}

function quoteValue(sample: QuotePathSample, side: PositionSide): QuoteValue | null {
  const bid = side === 'UP' ? sample.bidUp : sample.bidDown;
  const ask = side === 'UP' ? sample.askUp : sample.askDown;
  if (![bid, ask].every(Number.isFinite) || !(bid > 0) || !(ask > 0) || bid >= 1 || ask >= 1) return null;
  if (bid > ask + PRICE_EPSILON) return null;
  const spread = ask < bid ? 0 : ask - bid;
  return { midpoint: (bid + ask) / 2, spread };
}

export function buildQuoteTrajectorySpreadObservation(input: {
  calculationAtMs: number;
  symbol: string;
  providerId: TradingVenue;
  contractId: string;
  side: PositionSide;
  closesAt: string;
  underlyingSamples: UnderlyingPathSample[];
  quoteSamples: QuotePathSample[];
}): QuoteTrajectorySpreadObservation {
  const closesAtMs = Date.parse(input.closesAt);
  const cycleStartedAtMs = closesAtMs - 15 * 60_000;
  const underlying = preparePath<number>({
    samples: input.underlyingSamples,
    calculationAtMs: input.calculationAtMs,
    cycleStartedAtMs,
    value: (sample) => {
      const price = (sample as UnderlyingPathSample).price;
      return Number.isFinite(price) && price > 0 ? price : null;
    },
    equal: closeNumber,
  });
  const exactQuotes = input.quoteSamples.filter((sample) => sample.providerId === input.providerId
    && sample.symbol === input.symbol && sample.contractId === input.contractId && sample.closesAt === input.closesAt);
  const quotes = preparePath<QuoteValue>({
    samples: exactQuotes,
    calculationAtMs: input.calculationAtMs,
    cycleStartedAtMs,
    value: (sample) => quoteValue(sample as QuotePathSample, input.side),
    equal: (left, right) => closeNumber(left.midpoint, right.midpoint) && closeNumber(left.spread, right.spread),
  });
  return {
    version: QUOTE_TRAJECTORY_SPREAD_VERSION,
    calculationAt: new Date(input.calculationAtMs).toISOString(),
    symbol: input.symbol,
    providerId: input.providerId,
    contractId: input.contractId,
    side: input.side,
    closesAt: input.closesAt,
    underlying: horizon(underlying, input.calculationAtMs, summarizeUnderlying),
    quote: horizon(quotes, input.calculationAtMs, summarizeQuote),
  };
}

function cloneHorizons<T extends object>(value: TrajectoryHorizons<T>): TrajectoryHorizons<T> {
  return {
    ...value,
    trailing60Seconds: value.trailing60Seconds ? { ...value.trailing60Seconds } : undefined,
    cycleToDate: value.cycleToDate ? { ...value.cycleToDate } : undefined,
  };
}

/** Entry decisions are immutable evidence and must not alias the mutable dashboard prediction. */
export function cloneQuoteTrajectorySpreadObservation(
  value: QuoteTrajectorySpreadObservation,
): QuoteTrajectorySpreadObservation {
  return { ...value, underlying: cloneHorizons(value.underlying), quote: cloneHorizons(value.quote) };
}
