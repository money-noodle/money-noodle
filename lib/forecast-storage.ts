import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { groupBy } from './group';
import { summarizePerformance } from './performance';
import type { PerformanceSummary, TrackedForecast } from './types';

export const FORECAST_STORAGE_VERSION = 'forecast-storage-v1';

export interface ForecastShardRollup {
  shardId: string;
  rowCount: number;
  resolved: number;
  invalid: number;
  pending: number;
  qualified: number;
  unqualified: number;
  distinctCycles: string[];
  distinctResolvedCycles: string[];
  distinctResolvedWindows: string[];
  cycleOutcomes: Array<{ cycleId: string; correct: number; total: number }>;
}

export interface ForecastShardIndexEntry {
  shardId: string;
  file: string;
  rollupFile: string;
  rowCount: number;
  sha256: string;
  firstIssuedAt?: string;
  lastIssuedAt?: string;
}

export interface ForecastStorageIndex {
  version: typeof FORECAST_STORAGE_VERSION;
  generatedAt: string;
  totalRows: number;
  openRows: number;
  terminalRows: number;
  shards: ForecastShardIndexEntry[];
}

export interface ForecastStoragePlan {
  index: ForecastStorageIndex;
  open: TrackedForecast[];
  shards: Array<{ entry: ForecastShardIndexEntry; rows: TrackedForecast[]; rollup: ForecastShardRollup }>;
}

export interface ForecastStorageVerification {
  ok: boolean;
  errors: string[];
  summary: {
    original: Pick<PerformanceSummary, 'issued' | 'pending' | 'resolved' | 'invalid' | 'cycles' | 'resolvedCycles' | 'resolvedWindows' | 'calibrationWindows'>;
    planned: Pick<PerformanceSummary, 'issued' | 'pending' | 'resolved' | 'invalid' | 'cycles' | 'resolvedCycles' | 'resolvedWindows' | 'calibrationWindows'>;
  };
}

const terminal = (forecast: TrackedForecast) => forecast.status === 'resolved' || forecast.status === 'invalid';
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const qualified = (forecast: TrackedForecast) => forecast.qualified !== false;

function cycleKey(forecast: TrackedForecast): string {
  if (forecast.cycleId) return forecast.cycleId;
  const slug = forecast.marketUrl.split('/').filter(Boolean).at(-1) ?? forecast.symbol;
  return `${slug}:${forecast.closesAt}`;
}

function settlementWindowKey(forecast: TrackedForecast): string {
  const timestamp = Date.parse(forecast.closesAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : forecast.closesAt;
}

function shardId(forecast: TrackedForecast): string {
  const timestamp = Date.parse(forecast.issuedAt);
  if (!Number.isFinite(timestamp)) return 'undated';
  return new Date(timestamp).toISOString().slice(0, 10);
}

function timeBounds(rows: TrackedForecast[]): { firstIssuedAt?: string; lastIssuedAt?: string } {
  const issued = rows.map((row) => row.issuedAt).filter(Boolean).sort();
  return { firstIssuedAt: issued[0], lastIssuedAt: issued.at(-1) };
}

function rollup(shard: string, rows: TrackedForecast[]): ForecastShardRollup {
  const policy = rows.filter(qualified);
  const resolved = policy.filter((forecast) => forecast.status === 'resolved');
  const resolvedCycles = new Map<string, { correct: number; total: number }>();
  for (const forecast of resolved) {
    const key = cycleKey(forecast);
    const current = resolvedCycles.get(key) ?? { correct: 0, total: 0 };
    resolvedCycles.set(key, { correct: current.correct + (forecast.correct ? 1 : 0), total: current.total + 1 });
  }
  return {
    shardId: shard,
    rowCount: rows.length,
    resolved: resolved.length,
    invalid: policy.filter((forecast) => forecast.status === 'invalid').length,
    pending: policy.filter((forecast) => forecast.status === 'pending').length,
    qualified: policy.length,
    unqualified: rows.length - policy.length,
    distinctCycles: [...new Set(policy.map(cycleKey))].sort(),
    distinctResolvedCycles: [...resolvedCycles.keys()].sort(),
    distinctResolvedWindows: [...new Set(resolved.map(settlementWindowKey))].sort(),
    cycleOutcomes: [...resolvedCycles.entries()]
      .map(([cycleId, counts]) => ({ cycleId, ...counts }))
      .sort((a, b) => a.cycleId.localeCompare(b.cycleId)),
  };
}

export function buildForecastStoragePlan(forecasts: TrackedForecast[], generatedAt = new Date().toISOString()): ForecastStoragePlan {
  const open = forecasts.filter((forecast) => !terminal(forecast));
  // One bucket per day over the whole history is the coarse shape that makes copy-on-append quadratic;
  // grouping in place is what keeps the migration from reintroducing the stall it exists to remove.
  const terminalByShard = groupBy(forecasts.filter(terminal), shardId);

  const shards = [...terminalByShard.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => {
    const orderedRows = [...rows].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
    const content = json(orderedRows);
    const entry: ForecastShardIndexEntry = {
      shardId: id,
      file: `${id}.json`,
      rollupFile: `${id}.rollup.json`,
      rowCount: orderedRows.length,
      sha256: sha256(content),
      ...timeBounds(orderedRows),
    };
    return { entry, rows: orderedRows, rollup: rollup(id, orderedRows) };
  });

  return {
    index: {
      version: FORECAST_STORAGE_VERSION,
      generatedAt,
      totalRows: forecasts.length,
      openRows: open.length,
      terminalRows: forecasts.length - open.length,
      shards: shards.map((shard) => shard.entry),
    },
    open: [...open].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id)),
    shards,
  };
}

/**
 * Relative tolerance for float aggregates when comparing two summaries of the same rows.
 *
 * Byte-identical output is not achievable and the gate must not demand it. IEEE addition is not
 * associative, so summing ~30k terms in a different row order moves the last digits; a rollup that sums
 * per-shard subtotals will do the same. Measured across the sharded layout the largest relative
 * deviation is 6.3e-15, about 28x double epsilon. This bound is ~160x that observed noise and still far
 * tighter than anything that could change a reading, let alone a decision.
 *
 * It applies only to non-integer numbers. Counts, cardinalities, labels, and array lengths are compared
 * exactly, because those are the values that gate calibration readiness and must never drift.
 */
export const SUMMARY_FLOAT_TOLERANCE = 1e-12;

/**
 * Field-by-field comparison of two performance summaries: exact for anything countable, tolerant for
 * float aggregates. Returns one message per difference, deepest path first, capped so a systematic
 * divergence reports its shape rather than thousands of lines.
 */
export function compareSummaries(
  original: PerformanceSummary, planned: PerformanceSummary, tolerance = SUMMARY_FLOAT_TOLERANCE, limit = 20,
): string[] {
  const differences: string[] = [];
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (differences.length >= limit) return;
    if (typeof left === 'number' && typeof right === 'number') {
      if (Number.isInteger(left) && Number.isInteger(right)) {
        if (left !== right) differences.push(`${path}: ${left} != ${right}`);
        return;
      }
      if (Number.isNaN(left) && Number.isNaN(right)) return;
      const scale = Math.max(Math.abs(left), Math.abs(right));
      const relative = scale === 0 ? Math.abs(left - right) : Math.abs(left - right) / scale;
      if (!(relative <= tolerance)) differences.push(`${path}: ${left} != ${right} (relative ${relative.toExponential(2)} exceeds ${tolerance.toExponential(2)})`);
      return;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) return void differences.push(`${path}: array shape differs`);
      if (left.length !== right.length) return void differences.push(`${path}: length ${left.length} != ${right.length}`);
      left.forEach((item, index) => visit(item, right[index], `${path}[${index}]`));
      return;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        visit((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return;
    }
    if (left !== right) differences.push(`${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  };
  visit(original, planned, 'summary');
  return differences;
}

function summaryShape(summary: PerformanceSummary): ForecastStorageVerification['summary']['original'] {
  return {
    issued: summary.issued,
    pending: summary.pending,
    resolved: summary.resolved,
    invalid: summary.invalid,
    cycles: summary.cycles,
    resolvedCycles: summary.resolvedCycles,
    resolvedWindows: summary.resolvedWindows,
    calibrationWindows: summary.calibrationWindows,
  };
}

export function verifyForecastStoragePlan(original: TrackedForecast[], plan: ForecastStoragePlan): ForecastStorageVerification {
  const planned = [...plan.open, ...plan.shards.flatMap((shard) => shard.rows)];
  const errors: string[] = [];
  if (planned.length !== original.length) errors.push(`Planned rows ${planned.length} did not match original rows ${original.length}.`);
  if (plan.index.totalRows !== original.length) errors.push(`Index totalRows ${plan.index.totalRows} did not match original rows ${original.length}.`);
  if (plan.index.openRows !== plan.open.length) errors.push(`Index openRows ${plan.index.openRows} did not match open rows ${plan.open.length}.`);
  if (plan.index.terminalRows !== plan.shards.reduce((sum, shard) => sum + shard.rows.length, 0)) errors.push('Index terminalRows did not match shard row counts.');

  const originalIds = new Set(original.map((forecast) => forecast.id));
  const plannedIds = new Set<string>();
  for (const forecast of planned) {
    if (plannedIds.has(forecast.id)) errors.push(`Duplicate planned forecast id ${forecast.id}.`);
    plannedIds.add(forecast.id);
    if (!originalIds.has(forecast.id)) errors.push(`Planned forecast id ${forecast.id} was not in original history.`);
  }
  for (const forecast of original) {
    if (!plannedIds.has(forecast.id)) errors.push(`Original forecast id ${forecast.id} is missing from planned storage.`);
  }

  // Full field-by-field equality, not just the headline counters: the statistics most likely to be got
  // wrong by a layout change are the order-dependent ones (`timeline`, both streaks), and they are
  // invisible in the counters. Countable values must match exactly; float aggregates get the documented
  // tolerance because summation order legitimately differs. See docs/forecast-storage-design.md §4.
  const originalFull = summarizePerformance(original);
  const plannedFull = summarizePerformance(planned);
  errors.push(...compareSummaries(originalFull, plannedFull));

  return { ok: errors.length === 0, errors, summary: { original: summaryShape(originalFull), planned: summaryShape(plannedFull) } };
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

export async function writeForecastStoragePlan(root: string, plan: ForecastStoragePlan): Promise<void> {
  await mkdir(root, { recursive: true });
  await atomicWrite(path.join(root, 'open.json'), json(plan.open));
  for (const shard of plan.shards) {
    await atomicWrite(path.join(root, shard.entry.file), json(shard.rows));
    await atomicWrite(path.join(root, shard.entry.rollupFile), json(shard.rollup));
  }
  await atomicWrite(path.join(root, 'index.json'), json(plan.index));
}
