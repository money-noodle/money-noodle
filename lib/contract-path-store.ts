import 'server-only';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import {
  CONTRACT_PATH_VERSION, decodeContractPath, emptyContractPath, encodeContractPath, observeContractPath,
  summarizeContractPath, type ContractPathRecord, type ContractPathRollup,
} from './contract-path';
import type { Prediction } from './types';

/**
 * Durable contract price paths. Observation only: nothing here may gate, size, price, or trade.
 *
 * Two files rather than one, deliberately. The active set holds only windows still open — at most one per
 * asset, so a handful of small records — and is rewritten each cycle. Closed windows are appended to a
 * journal and never rewritten. `cycle-path-store` keeps a single growing array and rewrites all of it on
 * every tick, which is why that file is already 9 MB and why the same shape is not repeated here.
 */
const DATA_DIR = path.resolve(process.cwd(), 'data');
const ACTIVE_FILE = path.join(DATA_DIR, 'contract-paths.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'contract-paths.journal.jsonl');
const CYCLE_DURATION_MS = 15 * 60_000;
/** Windows are retained for a bounded period after close so a late settlement can still be joined. */
const ACTIVE_GRACE_MS = 60_000;

let pathQueue: Promise<void> = Promise.resolve();

interface ActiveStore { version: 1; pathVersion: string; active: ContractPathRecord[] }

const emptyStore = (): ActiveStore => ({ version: 1, pathVersion: CONTRACT_PATH_VERSION, active: [] });

async function readActive(): Promise<ActiveStore> {
  try {
    const parsed = JSON.parse(await readFile(ACTIVE_FILE, 'utf8')) as Partial<ActiveStore>;
    if (!Array.isArray(parsed.active)) throw new Error('Contract path store has no active collection.');
    return { version: 1, pathVersion: CONTRACT_PATH_VERSION, active: parsed.active };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    // Observation-only data: quarantine and continue rather than blocking a trading cycle on it.
    await rename(ACTIVE_FILE, `${ACTIVE_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Contract path store was malformed and has been quarantined:', error);
    return emptyStore();
  }
}

async function writeActive(store: ActiveStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${ACTIVE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(store));
  await rename(temporary, ACTIVE_FILE);
}

async function appendClosed(records: ContractPathRecord[]): Promise<void> {
  if (!records.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  const lines = records.map((record) => `${JSON.stringify(encodeContractPath(record))}\n`).join('');
  await appendFile(JOURNAL_FILE, lines);
}

async function updateContractPaths(predictions: Prediction[], observedAt: number): Promise<void> {
  const store = await readActive();
  const byId = new Map(store.active.map((record) => [`${record.contractId}:${record.closesAt}`, record]));

  for (const prediction of predictions) {
    const quote = prediction.kalshi;
    if (!quote?.live || !quote.ticker) continue;
    const closeMs = Date.parse(quote.closesAt);
    // Only exact quarter-hour contracts are admitted, matching the rest of the 15-minute dataset.
    if (!Number.isFinite(closeMs) || closeMs % CYCLE_DURATION_MS !== 0) continue;
    if (observedAt < closeMs - CYCLE_DURATION_MS || observedAt > closeMs) continue;

    const key = `${quote.ticker}:${quote.closesAt}`;
    const existing = byId.get(key)
      ?? emptyContractPath({ contractId: quote.ticker, symbol: prediction.symbol, closesAt: quote.closesAt });
    byId.set(key, observeContractPath(existing, {
      atMs: observedAt,
      askUpCents: quote.askUp * 100,
      askDownCents: quote.askDown * 100,
    }));
  }

  const active: ContractPathRecord[] = [];
  const closed: ContractPathRecord[] = [];
  for (const record of byId.values()) {
    const closeMs = Date.parse(record.closesAt);
    if (Number.isFinite(closeMs) && observedAt > closeMs + ACTIVE_GRACE_MS) {
      // Sealed once and appended once. A window with no observations is not worth a journal line.
      if (record.points.length) closed.push(record);
    } else active.push(record);
  }

  await appendClosed(closed);
  await writeActive({ version: 1, pathVersion: CONTRACT_PATH_VERSION, active });
}

/**
 * Records both sides' Kalshi quotes for every active window, whether or not anything qualified.
 *
 * Serialized behind its own queue and never awaited by the trading path: this is evidence collection, and
 * a slow disk must not delay a cycle that has money in it.
 */
export function recordContractPaths(predictions: Prediction[], observedAt = Date.now()): Promise<void> {
  const operation = pathQueue.then(() => updateContractPaths(predictions, observedAt));
  pathQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Sealed windows from the journal plus anything still open, newest close first. */
export async function getContractPathRollups(limit = 500): Promise<ContractPathRollup[]> {
  const records: ContractPathRecord[] = [];
  try {
    const stream = readline.createInterface({ input: createReadStream(JOURNAL_FILE) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const record = decodeContractPath(parsed);
      if (record) records.push(record);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  records.push(...(await readActive()).active);
  return records
    .sort((left, right) => Date.parse(right.closesAt) - Date.parse(left.closesAt)
      || left.contractId.localeCompare(right.contractId))
    .slice(0, limit)
    .map(summarizeContractPath);
}

/** Full paths for one settlement window, for analysis that needs every sample rather than a summary. */
export async function getContractPath(contractId: string, closesAt: string): Promise<ContractPathRecord | undefined> {
  const active = (await readActive()).active.find((record) => record.contractId === contractId && record.closesAt === closesAt);
  if (active) return active;
  try {
    const stream = readline.createInterface({ input: createReadStream(JOURNAL_FILE) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const record = decodeContractPath(parsed);
      if (record?.contractId === contractId && record.closesAt === closesAt) return record;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return undefined;
}
