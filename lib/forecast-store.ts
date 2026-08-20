import 'server-only';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FORECAST_STORAGE_VERSION, buildForecastStoragePlan, writeForecastStoragePlan,
  type ForecastStorageIndex,
} from './forecast-storage';
import {
  FORECAST_ROLLUP_VERSION, LEGACY_FORECAST_ROLLUP_VERSION,
  buildSummaryRollup, summarizeFromRollups, type ForecastSummaryRollup,
} from './forecast-rollup';
import type { PerformanceSummary, TrackedForecast } from './types';

/**
 * Reader for the sharded forecast layout. See docs/forecast-storage-design.md §3.
 *
 * The point of the layout is residency, not latency: the process held roughly 396 MB of parsed history to
 * serve a hot set near a hundred rows, growing about 40 MB a day. Nothing on the fifteen-second path needs
 * a terminal row, and a terminal row is immutable, so the hot set is the only thing that stays resident.
 *
 * Three tiers, deliberately:
 *
 * - **open set** — every row not yet terminal, plus anything the journal has added since the last seal.
 *   Read and written every cycle.
 * - **rollups** — sufficient statistics per sealed shard. Small enough to hold, and enough to reproduce
 *   the whole performance summary without a single sealed row.
 * - **shard rows** — loaded only when something genuinely needs history, which today is the walk-forward
 *   evaluator. Never touched by the cycle.
 */
const DATA_DIR = path.resolve(process.cwd(), 'data');
const SHARD_DIR = path.join(DATA_DIR, 'forecast-history-shards');
const JOURNAL_FILE = path.join(DATA_DIR, 'forecast-history.journal.jsonl');
const INDEX_FILE = path.join(SHARD_DIR, 'index.json');
const OPEN_FILE = path.join(SHARD_DIR, 'open.json');

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Present and current only after a successful seal. Absent means the legacy snapshot is still authoritative. */
export async function readForecastStorageIndex(): Promise<ForecastStorageIndex | undefined> {
  const index = await readJson<ForecastStorageIndex>(INDEX_FILE);
  return index?.version === FORECAST_STORAGE_VERSION ? index : undefined;
}

export async function readOpenSet(): Promise<TrackedForecast[]> {
  return (await readJson<TrackedForecast[]>(OPEN_FILE)) ?? [];
}

/**
 * Sufficient statistics for every sealed shard.
 *
 * Roughly 8 MB standing in for about 200 MB of rows. This is what makes the lifetime summary a sum over
 * per-shard statistics rather than a scan, which is the property the residency win depends on.
 */
export async function readShardRollups(): Promise<ForecastSummaryRollup[]> {
  const index = await readForecastStorageIndex();
  if (!index) return [];
  const rollups: ForecastSummaryRollup[] = [];
  for (const entry of index.shards) {
    const rollup = await readJson<ForecastSummaryRollup>(path.join(SHARD_DIR, entry.rollupFile));
    // A missing or unknown rollup is reported by the caller as degraded rather than silently treated as
    // an empty shard. V1 remains readable because only its unscoped counterfactual column is unsafe; the
    // merge excludes that column while preserving every policy-independent lifetime statistic.
    if (rollup && (rollup.version === FORECAST_ROLLUP_VERSION || rollup.version === LEGACY_FORECAST_ROLLUP_VERSION)) {
      rollups.push(rollup);
    }
  }
  return rollups;
}

export async function readShardRows(shardId: string): Promise<TrackedForecast[]> {
  const index = await readForecastStorageIndex();
  const entry = index?.shards.find((shard) => shard.shardId === shardId);
  if (!entry) return [];
  return (await readJson<TrackedForecast[]>(path.join(SHARD_DIR, entry.file))) ?? [];
}

/**
 * Every sealed row plus the open set.
 *
 * Deliberately awkward to call: this is the shape that costs the residency the layout exists to remove, so
 * it belongs to the evaluator and to nothing on the cycle path.
 */
export async function readAllShardRows(): Promise<TrackedForecast[]> {
  const index = await readForecastStorageIndex();
  if (!index) return [];
  const rows: TrackedForecast[] = [];
  for (const entry of index.shards) {
    const shard = await readJson<TrackedForecast[]>(path.join(SHARD_DIR, entry.file));
    if (shard) rows.push(...shard);
  }
  return rows;
}

export interface ForecastSummarySource {
  summary: PerformanceSummary;
  /** Shards whose rollup could not be read. A lifetime figure missing a shard must say so. */
  missingRollups: number;
  shardRollups: number;
  openRows: number;
}

/**
 * The lifetime summary, from sealed statistics plus the open rows.
 *
 * This composition is not an approximation: `verifyForecastStoragePlan` proves it field-by-field against
 * `summarizePerformance` over the same rows, with counts exact and float aggregates inside a documented
 * tolerance. The open set is folded in as one more rollup rather than being special-cased.
 */
export async function summarizeFromStorage(openRows: TrackedForecast[]): Promise<ForecastSummarySource> {
  const index = await readForecastStorageIndex();
  const rollups = await readShardRollups();
  const missingRollups = Math.max(0, (index?.shards.length ?? 0) - rollups.length);
  return {
    summary: summarizeFromRollups([...rollups, buildSummaryRollup('open', openRows)]),
    missingRollups,
    shardRollups: rollups.length,
    openRows: openRows.length,
  };
}

/**
 * Seals the current history: writes shards, rollups, the open set, and the index, then clears the journal.
 *
 * Clearing the journal is part of sealing rather than a separate step. Without it the next read would
 * replay events for rows that are now inside a shard, and those rows would appear a second time in the
 * open set — double-counting every lifetime figure. The journal is truncated last, so a crash between the
 * two replays idempotent events over an already-sealed layout rather than losing them.
 *
 * The caller must hold the forecast write lock: this is a compaction, and a cycle appending mid-seal would
 * put rows in the journal that the open set does not contain.
 */
export async function sealForecastStorage(forecasts: TrackedForecast[]): Promise<ForecastStorageIndex> {
  const plan = buildForecastStoragePlan(forecasts);
  await writeForecastStoragePlan(SHARD_DIR, plan);
  const temporary = `${JOURNAL_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, '');
  await rename(temporary, JOURNAL_FILE);
  return plan.index;
}
