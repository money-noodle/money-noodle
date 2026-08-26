import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildSummaryRollup, legacyRollupNeedsReseal, summarizeFromRollups, type ForecastSummaryRollup,
} from '../src/lib/forecast-rollup';
import { BUY_POLICY_VERSION } from '../src/lib/prediction-policy';
import {
  FORECAST_STORAGE_VERSION,
  buildForecastStoragePlan,
  compareSummaries, forecastJournalAlreadyCompacted,
  verifyForecastStoragePlan,
  writeForecastStoragePlan,
  type ForecastStorageIndex,
} from '../src/lib/forecast-storage';
import { summarizePerformance } from '../src/lib/performance';
import type { TrackedForecast } from '../src/lib/types';

type ForecastJournalEvent =
  | { op: 'upsert'; forecast: TrackedForecast }
  | { op: 'patch'; id: string; changes: Partial<TrackedForecast> }
  | { op: 'delete'; id: string };

const DATA_DIR = path.resolve(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'forecast-history.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'forecast-history.journal.jsonl');
const SHARD_DIR = path.join(DATA_DIR, 'forecast-history-shards');

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readJournal(): Promise<ForecastJournalEvent[]> {
  let raw = '';
  try {
    raw = await readFile(JOURNAL_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').flatMap((line) => line ? [JSON.parse(line) as ForecastJournalEvent] : []);
}

function replay(snapshot: TrackedForecast[], events: ForecastJournalEvent[]): TrackedForecast[] {
  const records = new Map(snapshot.map((forecast) => [forecast.id, forecast]));
  for (const event of events) {
    if (event.op === 'delete') records.delete(event.id);
    else if (event.op === 'upsert' && event.forecast?.id) records.set(event.forecast.id, event.forecast);
    else if (event.op === 'patch') {
      const existing = records.get(event.id);
      if (existing) records.set(event.id, { ...existing, ...event.changes });
    }
  }
  return [...records.values()];
}

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const terminal = (forecast: TrackedForecast) => forecast.status === 'resolved' || forecast.status === 'invalid';

/**
 * Verifies the layout the running reader actually consumes: indexed sealed rows and rollups, plus the
 * open file with the current journal replayed on top. This is deliberately read-only. Only the collector's
 * forecast write lock may seal an active layout; a standalone verifier must never race it.
 */
async function verifyActive(index: ForecastStorageIndex, journal: ForecastJournalEvent[]) {
  const errors: string[] = [];
  const sealed: TrackedForecast[] = [];
  const rollups: ForecastSummaryRollup[] = [];
  let rollupBytes = 0;

  for (const entry of index.shards) {
    const rowFile = path.join(SHARD_DIR, entry.file);
    const rollupFile = path.join(SHARD_DIR, entry.rollupFile);
    let rowRaw = '', rollupRaw = '';
    try { rowRaw = await readFile(rowFile, 'utf8'); }
    catch (error) { errors.push(`Shard ${entry.shardId} could not be read: ${String(error)}`); continue; }
    try { rollupRaw = await readFile(rollupFile, 'utf8'); }
    catch (error) { errors.push(`Rollup ${entry.shardId} could not be read: ${String(error)}`); continue; }
    if (sha256(rowRaw) !== entry.sha256) errors.push(`Shard ${entry.shardId} checksum did not match the index.`);
    if (sha256(rollupRaw) !== entry.rollupSha256) errors.push(`Rollup ${entry.shardId} checksum did not match the index.`);
    const rows = JSON.parse(rowRaw) as TrackedForecast[];
    const rollup = JSON.parse(rollupRaw) as ForecastSummaryRollup;
    if (rows.length !== entry.rowCount) errors.push(`Shard ${entry.shardId} held ${rows.length} rows; index says ${entry.rowCount}.`);
    if (rows.some((row) => !terminal(row))) errors.push(`Shard ${entry.shardId} contains a non-terminal row.`);
    if (rollup.shardId !== entry.shardId) errors.push(`Rollup ${entry.shardId} identifies itself as ${rollup.shardId}.`);
    if (legacyRollupNeedsReseal(rollup, rows, BUY_POLICY_VERSION)) {
      errors.push(`Legacy rollup ${entry.shardId} contains active-policy rows and must be resealed by the forecast compactor.`);
    }
    sealed.push(...rows);
    rollups.push(rollup);
    rollupBytes += Buffer.byteLength(rollupRaw);
  }

  let openRaw = '';
  try { openRaw = await readFile(path.join(SHARD_DIR, index.openFile), 'utf8'); }
  catch (error) { errors.push(`Open artifact ${index.openFile} could not be read: ${String(error)}`); }
  if (openRaw && sha256(openRaw) !== index.openSha256) errors.push('Open artifact checksum did not match the index.');
  const sealedOpen = openRaw ? JSON.parse(openRaw) as TrackedForecast[] : [];
  if (sealed.length !== index.terminalRows) errors.push(`Indexed terminal rows ${index.terminalRows}; shard files held ${sealed.length}.`);
  if (sealedOpen.length !== index.openRows) errors.push(`Indexed open rows ${index.openRows}; open file held ${sealedOpen.length}.`);
  if (sealed.length + sealedOpen.length !== index.totalRows) errors.push(`Indexed total rows ${index.totalRows}; artifacts held ${sealed.length + sealedOpen.length}.`);

  const sealedIds = new Set<string>();
  for (const row of sealed) {
    if (sealedIds.has(row.id)) errors.push(`Duplicate sealed forecast id ${row.id}.`);
    sealedIds.add(row.id);
  }
  const currentOpen = replay(sealedOpen, journal);
  const openIds = new Set<string>();
  for (const row of currentOpen) {
    if (openIds.has(row.id)) errors.push(`Duplicate open forecast id ${row.id}.`);
    openIds.add(row.id);
  }
  const full = [...sealed.filter((row) => !openIds.has(row.id)), ...currentOpen];
  const direct = summarizePerformance(full);
  const fromStoredRollups = summarizeFromRollups([...rollups, buildSummaryRollup('open', currentOpen)]);
  errors.push(...compareSummaries(direct, fromStoredRollups).map((difference) => `active rollup ${difference}`));

  return {
    mode: 'active-sharded-layout', ok: errors.length === 0, errors,
    indexGeneratedAt: index.generatedAt, indexedRowsAtLastSeal: index.totalRows,
    sealedRows: sealed.length, openRowsAtLastSeal: sealedOpen.length,
    journalEvents: journal.length, currentOpenRows: currentOpen.length, currentTotalRows: full.length,
    shards: index.shards.length, rollupBytes, firstShard: index.shards[0], lastShard: index.shards.at(-1),
    summary: {
      issued: direct.issued, pending: direct.pending, resolved: direct.resolved, invalid: direct.invalid,
      cycles: direct.cycles, resolvedCycles: direct.resolvedCycles,
      resolvedWindows: direct.resolvedWindows, calibrationWindows: direct.calibrationWindows,
    },
    wrote: false, journalCleared: false, shardDir: SHARD_DIR,
  };
}

async function verifyLegacy(journal: ForecastJournalEvent[], write: boolean) {
  const snapshot = await readJsonFile<TrackedForecast[]>(HISTORY_FILE, []);
  const forecasts = replay(snapshot, journal);
  const plan = buildForecastStoragePlan(forecasts);
  const verification = verifyForecastStoragePlan(forecasts, plan);
  const result = {
    mode: 'legacy-migration-plan', ok: verification.ok, errors: verification.errors,
    snapshotRows: snapshot.length, journalEvents: journal.length,
    totalRows: plan.index.totalRows, openRows: plan.index.openRows, terminalRows: plan.index.terminalRows,
    shards: plan.index.shards.length,
    rollupBytes: plan.shards.reduce((sum, shard) => sum + Buffer.byteLength(`${JSON.stringify(shard.rollup)}\n`), 0),
    firstShard: plan.index.shards[0], lastShard: plan.index.shards.at(-1), summary: verification.summary,
    wrote: false, journalCleared: false, shardDir: SHARD_DIR,
  };
  if (verification.ok && write) {
    await writeForecastStoragePlan(SHARD_DIR, plan);
    const temporary = `${JOURNAL_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, '');
    await rename(temporary, JOURNAL_FILE);
    result.wrote = true;
    result.journalCleared = true;
  }
  return result;
}

async function main() {
  const write = process.argv.includes('--write');
  const journal = await readJournal();
  const journalRaw = await readFile(JOURNAL_FILE, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const index = await readJsonFile<ForecastStorageIndex | null>(path.join(SHARD_DIR, 'index.json'), null);
  const active = index?.version === FORECAST_STORAGE_VERSION;
  if (active && write) throw new Error('Refusing --write against an active sharded layout; only sealForecastStorage under the forecast write lock may write it.');
  const replayableJournal = active && forecastJournalAlreadyCompacted(index, journalRaw) ? [] : journal;
  const result = active ? await verifyActive(index, replayableJournal) : await verifyLegacy(journal, write);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
