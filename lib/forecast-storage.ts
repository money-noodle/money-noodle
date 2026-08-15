import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { groupBy } from './group';
import { buildSummaryRollup, summarizeFromRollups, type ForecastSummaryRollup } from './forecast-rollup';
import { summarizePerformance } from './performance';
import type { PerformanceSummary, TrackedForecast } from './types';

export const FORECAST_STORAGE_VERSION = 'forecast-storage-v2';

export interface ForecastShardIndexEntry {
  shardId: string;
  file: string;
  rollupFile: string;
  rowCount: number;
  sha256: string;
  rollupSha256: string;
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
  shards: Array<{ entry: ForecastShardIndexEntry; rows: TrackedForecast[]; rollup: ForecastSummaryRollup }>;
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
function shardId(forecast: TrackedForecast): string {
  const timestamp = Date.parse(forecast.issuedAt);
  if (!Number.isFinite(timestamp)) return 'undated';
  return new Date(timestamp).toISOString().slice(0, 10);
}

function timeBounds(rows: TrackedForecast[]): { firstIssuedAt?: string; lastIssuedAt?: string } {
  const issued = rows.map((row) => row.issuedAt).filter(Boolean).sort();
  return { firstIssuedAt: issued[0], lastIssuedAt: issued.at(-1) };
}

export function buildForecastStoragePlan(forecasts: TrackedForecast[], generatedAt = new Date().toISOString()): ForecastStoragePlan {
  const open = forecasts.filter((forecast) => !terminal(forecast));
  // One bucket per day over the whole history is the coarse shape that makes copy-on-append quadratic;
  // grouping in place is what keeps the migration from reintroducing the stall it exists to remove.
  const terminalByShard = groupBy(forecasts.filter(terminal), shardId);

  const shards = [...terminalByShard.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => {
    const orderedRows = [...rows].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
    const content = json(orderedRows);
    const summaryRollup = buildSummaryRollup(id, orderedRows);
    const entry: ForecastShardIndexEntry = {
      shardId: id,
      file: `${id}.json`,
      rollupFile: `${id}.rollup.json`,
      rowCount: orderedRows.length,
      sha256: sha256(content),
      rollupSha256: sha256(json(summaryRollup)),
      ...timeBounds(orderedRows),
    };
    return { entry, rows: orderedRows, rollup: summaryRollup };
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
 * Combined absolute/relative tolerance for float aggregates over the same rows.
 *
 * Byte-identical output is not achievable: IEEE addition is not associative, and rollups sum shard
 * subtotals in a different order. A purely relative test becomes meaningless near zero — an absolute
 * difference of 1.45e-16 measured 2.2e-12 relative once mean return approached zero — so the bound is
 * `tolerance * max(1, |left|, |right|)`. At ordinary scale this is relative; near zero it is absolute.
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
      const difference = Math.abs(left - right);
      const bound = tolerance * Math.max(1, Math.abs(left), Math.abs(right));
      if (!(difference <= bound)) differences.push(`${path}: ${left} != ${right} (difference ${difference.toExponential(2)} exceeds ${bound.toExponential(2)})`);
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
  if (plan.index.shards.length !== plan.shards.length) errors.push(`Index listed ${plan.index.shards.length} shards but the plan contained ${plan.shards.length}.`);
  for (const shard of plan.shards) {
    const indexed = plan.index.shards.find((entry) => entry.shardId === shard.entry.shardId);
    if (!indexed) { errors.push(`Shard ${shard.entry.shardId} was missing from the index.`); continue; }
    if (indexed.rowCount !== shard.rows.length) errors.push(`Shard ${shard.entry.shardId} row count ${shard.rows.length} did not match index ${indexed.rowCount}.`);
    if (indexed.sha256 !== sha256(json(shard.rows))) errors.push(`Shard ${shard.entry.shardId} row checksum did not match its content.`);
    if (shard.rollup.shardId !== shard.entry.shardId) errors.push(`Shard ${shard.entry.shardId} rollup identified itself as ${shard.rollup.shardId}.`);
    if (indexed.rollupSha256 !== sha256(json(shard.rollup))) errors.push(`Shard ${shard.entry.shardId} rollup checksum did not match its content.`);
  }

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

  // The rollup path is the half that actually removes the residency, and it is where the correctness
  // risk of the whole design sits. It is proven here against the same rows rather than by inspection:
  // sufficient statistics per shard, merged, must reproduce the summary the rows produce directly.
  const rollups = [
    ...plan.shards.map((shard) => shard.rollup),
    buildSummaryRollup('open', plan.open),
  ];
  errors.push(...compareSummaries(originalFull, summarizeFromRollups(rollups)).map((difference) => `rollup ${difference}`));

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
