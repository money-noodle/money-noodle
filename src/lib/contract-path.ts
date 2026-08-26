import type { PositionSide } from './types';

/**
 * Contract price paths: both sides' Kalshi quotes for every active window, sampled every 15 seconds,
 * regardless of whether anything qualified.
 *
 * This exists because the forecast journal cannot answer the questions this policy asks. It records
 * qualifying calculations every 15 seconds but everything else only about once a minute, and a side at 10¢
 * is precisely when the edge model does not qualify — so the long-shot candidates live in the sparse
 * sample. The blindness is real, though smaller than first thought: the original "winners were observed
 * reaching 90¢ in 68.4% of cases where the true figure must be 100%" reading is **withdrawn** — these
 * contracts settle on a close-price comparison, so ~10% of winners never trade near 90¢ at all (design
 * §14b). Measured like-for-like, 15-second sampling misses 0–25% of touches.
 *
 * Observation only. Nothing here may gate, size, price, or trade. Pure and I/O free.
 */
export const CONTRACT_PATH_VERSION = 'kalshi-both-sides-15s-observation-only-v1';

export const CONTRACT_PATH_BUCKET_MS = 15_000;
/** Bucket for a contract that has become a candidate and is being watched to settlement. */
export const CONTRACT_PATH_DENSE_BUCKET_MS = 1_000;
/**
 * Bucket for every live contract inside the entry window, whether or not it ever became a candidate.
 *
 * The dense bucket above only ever applied to contracts that had already fallen below the long-shot entry
 * mark, which is three to five minutes into a cycle with the book at roughly 9c/91c. Measured across 57
 * dense windows, **zero** had the 20-80c range inside the dense region — so the range an operator actually
 * watches has only ever been recorded at fifteen seconds, which was measured to hide about 37% of price
 * movement and to conceal a 2c-or-larger swing in 8.7% of intervals.
 *
 * Two seconds rather than one because the quotes are already being fetched at the entry cadence and this
 * costs no extra request either way; the constraint is storage, not the venue. See §18.
 */
export const CONTRACT_PATH_FINE_BUCKET_MS = 2_000;

/**
 * Windows older than this are thinned back to the fifteen-second grid at compaction.
 *
 * Fine sampling is roughly five times the points, which at the full retention would be a permanent
 * ~130 MB liability for a resolution only the most recent analysis needs. Thinning restores the coarse
 * sampling *density*, so every measurement written against the fifteen-second grid still reads its whole
 * history at the cost it always had.
 *
 * It does **not** reproduce the coarse recorder byte for byte: an observation is bucketed when it is
 * stored, so a fine sample lands on the two-second grid and survives thinning at, say, offset 16 where the
 * coarse recorder would have written 15. The offsets differ by less than one coarse bucket and carry the
 * same information, but a test asserting equality of offsets will fail, correctly.
 */
export const CONTRACT_PATH_FINE_RETENTION_DAYS = 3;

/**
 * Drops points that are not on the fifteen-second grid.
 *
 * Keeps the first sample in each fifteen-second bucket, which is the same rule the coarse recorder
 * applies — though not the same stored offset, since a fine sample was already bucketed to two seconds.
 */
export function thinToCoarseGrid(record: ContractPathRecord): ContractPathRecord {
  const seen = new Set<number>();
  const points: ContractPathPoint[] = [];
  for (const point of [...record.points].sort((left, right) => left.offsetSeconds - right.offsetSeconds)) {
    const bucket = Math.floor(point.offsetSeconds / (CONTRACT_PATH_BUCKET_MS / 1000));
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    points.push(point);
  }
  return { ...record, points };
}
const CYCLE_DURATION_MS = 15 * 60_000;

export interface ContractPathPoint {
  /** Seconds from cycle open. Integer bucket boundaries, so a restart cannot duplicate a sample. */
  offsetSeconds: number;
  askUpCents: number;
  askDownCents: number;
}

export interface ContractPathRecord {
  contractId: string;
  symbol: string;
  cycleStartedAt: string;
  closesAt: string;
  points: ContractPathPoint[];
}

export interface ContractSideRollup {
  minAskCents: number | null;
  minAskOffsetSeconds: number | null;
  maxBidCents: number | null;
  maxBidOffsetSeconds: number | null;
}

export interface ContractPathRollup {
  contractId: string;
  symbol: string;
  closesAt: string;
  samples: number;
  /** Seconds between the first and last sample; names how much of the window was actually observed. */
  coverageSeconds: number;
  up: ContractSideRollup;
  down: ContractSideRollup;
}

/**
 * Kalshi's two sides share one book, so the owned side's bid is the complement of the opposite ask. Both
 * bids are derived rather than stored: storing four numbers where two suffice would double a dataset that
 * already grows by roughly half a megabyte a day.
 */
export function sideAskCents(point: ContractPathPoint, side: PositionSide): number {
  return side === 'UP' ? point.askUpCents : point.askDownCents;
}

export function sideBidCents(point: ContractPathPoint, side: PositionSide): number {
  return 100 - (side === 'UP' ? point.askDownCents : point.askUpCents);
}

const bucketOffset = (offsetSeconds: number, bucketMs: number) =>
  Math.floor(offsetSeconds / (bucketMs / 1000)) * (bucketMs / 1000);

/**
 * Adds one observation, keyed by 15-second bucket so a repeated poll, a retry, or a restart cannot
 * manufacture extra samples. A later observation in the same bucket replaces the earlier one.
 */
/**
 * `bucketMs` is per observation, so one window can hold coarse samples for most of its life and dense ones
 * once it becomes a candidate. That asymmetry is the point: a fifteen-second path cannot answer whether a
 * bid ever touched the exit mark with confidence — measured like-for-like it misses 0–25% of them, on a
 * small sample (design §14b) — but paying for dense sampling on every contract would be a hundredfold more data
 * for windows no analysis ever looks at.
 */
export function observeContractPath(
  record: ContractPathRecord,
  observation: { atMs: number; askUpCents: number; askDownCents: number },
  bucketMs: number = CONTRACT_PATH_BUCKET_MS,
): ContractPathRecord {
  const cycleStartMs = Date.parse(record.cycleStartedAt);
  const closeMs = Date.parse(record.closesAt);
  if (!Number.isFinite(cycleStartMs) || !Number.isFinite(closeMs)) return record;
  if (observation.atMs < cycleStartMs || observation.atMs > closeMs) return record;
  // Fail closed on a missing quote rather than recording a zero, which would read as a free contract.
  if (!(observation.askUpCents > 0) || !(observation.askDownCents > 0)) return record;

  const offsetSeconds = bucketOffset((observation.atMs - cycleStartMs) / 1000, bucketMs);
  const points = record.points.filter((point) => point.offsetSeconds !== offsetSeconds);
  points.push({ offsetSeconds, askUpCents: observation.askUpCents, askDownCents: observation.askDownCents });
  points.sort((left, right) => left.offsetSeconds - right.offsetSeconds);
  return { ...record, points };
}

export function emptyContractPath(input: { contractId: string; symbol: string; closesAt: string }): ContractPathRecord {
  const closeMs = Date.parse(input.closesAt);
  return {
    contractId: input.contractId,
    symbol: input.symbol,
    cycleStartedAt: new Date(closeMs - CYCLE_DURATION_MS).toISOString(),
    closesAt: input.closesAt,
    points: [],
  };
}

function sideRollup(points: ContractPathPoint[], side: PositionSide): ContractSideRollup {
  let minAskCents: number | null = null;
  let minAskOffsetSeconds: number | null = null;
  let maxBidCents: number | null = null;
  let maxBidOffsetSeconds: number | null = null;
  for (const point of points) {
    const ask = sideAskCents(point, side);
    const bid = sideBidCents(point, side);
    if (minAskCents === null || ask < minAskCents) { minAskCents = ask; minAskOffsetSeconds = point.offsetSeconds; }
    if (maxBidCents === null || bid > maxBidCents) { maxBidCents = bid; maxBidOffsetSeconds = point.offsetSeconds; }
  }
  return { minAskCents, minAskOffsetSeconds, maxBidCents, maxBidOffsetSeconds };
}

export function summarizeContractPath(record: ContractPathRecord): ContractPathRollup {
  const offsets = record.points.map((point) => point.offsetSeconds);
  return {
    contractId: record.contractId,
    symbol: record.symbol,
    closesAt: record.closesAt,
    samples: record.points.length,
    coverageSeconds: offsets.length ? Math.max(...offsets) - Math.min(...offsets) : 0,
    up: sideRollup(record.points, 'UP'),
    down: sideRollup(record.points, 'DOWN'),
  };
}

/**
 * First offset at which this side was buyable at or below a mark, within an entry window.
 *
 * Deliberately a query rather than a rollup field. Baking one entry mark into the stored summary would
 * commit to the mark now, and re-choosing it later would need another month of collection — the exact
 * failure the recording is designed to avoid.
 */
export function firstEntryOffsetSeconds(
  record: ContractPathRecord, side: PositionSide,
  options: { markCents: number; withinSeconds: number },
): number | null {
  for (const point of record.points) {
    if (point.offsetSeconds > options.withinSeconds) break;
    if (sideAskCents(point, side) <= options.markCents) return point.offsetSeconds;
  }
  return null;
}

/**
 * Highest bid this side reached strictly after an offset. With the entry offset above, this is the whole
 * round-trip question — and because it takes the exit mark as a comparison rather than a parameter, every
 * candidate mark stays evaluable from one dataset.
 */
export function peakBidAfterOffset(record: ContractPathRecord, side: PositionSide, afterOffsetSeconds: number): number | null {
  let peak: number | null = null;
  for (const point of record.points) {
    if (point.offsetSeconds <= afterOffsetSeconds) continue;
    const bid = sideBidCents(point, side);
    if (peak === null || bid > peak) peak = bid;
  }
  return peak;
}

/**
 * Compact wire form: `[offsetSeconds, askUp, askDown]` triples.
 *
 * The journal is written once per window rather than rewritten per tick, and stores triples rather than
 * objects, because the alternative is the shape this repo has already had to migrate away from — a single
 * growing array rewritten on every observation. At roughly 672 windows a day this is about half a megabyte
 * daily; the same data as per-point objects would be nearer two.
 */
export function encodeContractPath(record: ContractPathRecord): unknown[] {
  return [
    record.contractId, record.symbol, record.closesAt,
    record.points.map((point) => [point.offsetSeconds, point.askUpCents, point.askDownCents]),
  ];
}

export function decodeContractPath(encoded: unknown): ContractPathRecord | null {
  if (!Array.isArray(encoded) || encoded.length < 4) return null;
  const [contractId, symbol, closesAt, rawPoints] = encoded;
  if (typeof contractId !== 'string' || typeof symbol !== 'string' || typeof closesAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(closesAt)) || !Array.isArray(rawPoints)) return null;
  const points: ContractPathPoint[] = [];
  for (const raw of rawPoints) {
    if (!Array.isArray(raw) || raw.length < 3) continue;
    const [offsetSeconds, askUpCents, askDownCents] = raw.map(Number);
    if (![offsetSeconds, askUpCents, askDownCents].every(Number.isFinite)) continue;
    points.push({ offsetSeconds, askUpCents, askDownCents });
  }
  return { ...emptyContractPath({ contractId, symbol, closesAt }), points };
}
