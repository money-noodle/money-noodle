import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildForecastStoragePlan,
  verifyForecastStoragePlan,
  writeForecastStoragePlan,
} from '../lib/forecast-storage';
import type { TrackedForecast } from '../lib/types';

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

async function main() {
  const write = process.argv.includes('--write');
  const snapshot = await readJsonFile<TrackedForecast[]>(HISTORY_FILE, []);
  const journal = await readJournal();
  const forecasts = replay(snapshot, journal);
  const plan = buildForecastStoragePlan(forecasts);
  const verification = verifyForecastStoragePlan(forecasts, plan);
  const result = {
    ok: verification.ok,
    errors: verification.errors,
    snapshotRows: snapshot.length,
    journalEvents: journal.length,
    totalRows: plan.index.totalRows,
    openRows: plan.index.openRows,
    terminalRows: plan.index.terminalRows,
    shards: plan.index.shards.length,
    rollupBytes: plan.shards.reduce((sum, shard) => sum + Buffer.byteLength(`${JSON.stringify(shard.rollup)}\n`), 0),
    firstShard: plan.index.shards[0],
    lastShard: plan.index.shards.at(-1),
    summary: verification.summary,
    wrote: false,
    journalCleared: false,
    shardDir: SHARD_DIR,
  };
  if (!verification.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  if (write) {
    await writeForecastStoragePlan(SHARD_DIR, plan);
    // Clearing the journal is part of sealing, not an afterthought. The plan was built from the snapshot
    // plus this journal, so every one of those events is now inside a shard or the open set. Leaving them
    // would make the next read replay sealed rows back into the open set and double-count every lifetime
    // figure. Truncated last, so a crash between the two replays idempotent events over a sealed layout.
    const temporary = `${JOURNAL_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, '');
    await rename(temporary, JOURNAL_FILE);
    result.wrote = true;
    result.journalCleared = true;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
