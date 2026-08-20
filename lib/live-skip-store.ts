import 'server-only';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LIVE_SKIP_JOURNAL_VERSION, replayLiveSkipEvents,
  type LiveSkipClass, type LiveSkipEvent, type LiveSkipRecord,
} from './live-skip';
import type { PositionSide } from './types';

/**
 * Worker-local durable store for live skip episodes (SPEC §12.8 step 2).
 *
 * Append-only journal plus a compacted snapshot, the same shape as the other decision journals. It has
 * no execution authority and nothing on a money path reads it: a failed write is logged and dropped
 * rather than allowed to stall or fail a trading cycle, because a missing observation is a gap in
 * evidence while a stalled cycle is a gap in risk control.
 */

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'live-skips.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'live-skips.journal.jsonl');
const JOURNAL_COMPACTION_BYTES = 50 * 1024 * 1024;

let operationQueue: Promise<void> = Promise.resolve();
let cached: LiveSkipStore | undefined;

export interface LiveSkipStore {
  version: 1;
  journalVersion: typeof LIVE_SKIP_JOURNAL_VERSION;
  startedAt: string;
  updatedAt: string;
  records: LiveSkipRecord[];
}

function emptyStore(startedAt: string): LiveSkipStore {
  return { version: 1, journalVersion: LIVE_SKIP_JOURNAL_VERSION, startedAt, updatedAt: startedAt, records: [] };
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function readSnapshot(startedAt: string): Promise<LiveSkipStore> {
  try {
    const parsed = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as Partial<LiveSkipStore>;
    if (!Array.isArray(parsed.records) || !parsed.startedAt) throw new Error('Live skip snapshot is missing required fields.');
    return {
      version: 1, journalVersion: LIVE_SKIP_JOURNAL_VERSION, startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt ?? parsed.startedAt, records: parsed.records,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore(startedAt);
    // Per AGENTS.md §3 a corrupt durable file is quarantined, never deleted.
    await rename(SNAPSHOT_FILE, `${SNAPSHOT_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Live skip snapshot was malformed and has been quarantined:', error);
    return emptyStore(startedAt);
  }
}

async function loadStore(): Promise<LiveSkipStore> {
  if (cached) return cached;
  const startedAt = new Date().toISOString();
  const store = await readSnapshot(startedAt);
  let raw = '';
  try { raw = await readFile(JOURNAL_FILE, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events: LiveSkipEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // A truncated tail is expected after an unclean shutdown and is skipped, not fatal.
    try { events.push(JSON.parse(line) as LiveSkipEvent); } catch { continue; }
  }
  store.records = replayLiveSkipEvents(events, store.records);
  cached = store;
  return store;
}

/**
 * Compacts the journal into the snapshot once it crosses the size ceiling.
 *
 * The snapshot is written first and only then is the journal truncated, so a crash between the two
 * leaves duplicate evidence rather than missing evidence — replay is idempotent on episodes because an
 * already-folded record simply extends.
 */
async function compactIfNeeded(store: LiveSkipStore): Promise<void> {
  let size = 0;
  try { size = (await stat(JOURNAL_FILE)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return; }
  if (size < JOURNAL_COMPACTION_BYTES) return;
  await atomicWrite(SNAPSHOT_FILE, JSON.stringify(store));
  await atomicWrite(JOURNAL_FILE, '');
}

/**
 * Records one live-cycle skip observation. Consecutive identical observations fold into one episode.
 *
 * Never throws into the caller: the live cycle must not be able to fail because an observation could not
 * be written.
 */
export async function recordLiveSkip(input: {
  classification: LiveSkipClass;
  reason: string;
  windows: string[];
  symbol?: string;
  side?: PositionSide;
  at?: string;
}): Promise<void> {
  const event: LiveSkipEvent = {
    at: input.at ?? new Date().toISOString(),
    classification: input.classification,
    reason: input.reason,
    windows: [...new Set(input.windows.filter(Boolean))],
    symbol: input.symbol, side: input.side,
  };
  const run = operationQueue.then(async () => {
    const store = await loadStore();
    store.records = replayLiveSkipEvents([event], store.records);
    store.updatedAt = event.at;
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(JOURNAL_FILE, `${JSON.stringify(event)}\n`);
    await compactIfNeeded(store);
  }).catch((error) => { console.error('Live skip journal write failed:', error); });
  operationQueue = run;
  return run;
}

/** Read-only view for reporting surfaces. Never used by execution. */
export async function readLiveSkips(): Promise<LiveSkipStore> {
  const store = await loadStore();
  return { ...store, records: store.records.map((record) => ({ ...record, windows: [...record.windows] })) };
}

/** Test seam only: drops the in-process cache so a fresh read replays from disk. */
export function resetLiveSkipCacheForTests(): void {
  cached = undefined;
}
