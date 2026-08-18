import 'server-only';
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import {
  CONTRACT_PATH_DENSE_BUCKET_MS, CONTRACT_PATH_FINE_RETENTION_DAYS, CONTRACT_PATH_VERSION,
  decodeContractPath, emptyContractPath, encodeContractPath, observeContractPath, summarizeContractPath,
  thinToCoarseGrid, type ContractPathRecord, type ContractPathRollup,
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

/**
 * Retention. Roughly 672 windows a day at about 700 bytes each is half a megabyte daily, so an unbounded
 * journal reaches a couple of hundred megabytes within a year — the shape the forecast-storage work is
 * currently undoing elsewhere in this repo, and not worth recreating here.
 *
 * 45 days is deliberately longer than any review this policy has: 60 attempts is days to weeks, and the
 * entry-window and exit-mark questions are answered from windows near the decision rather than from a full
 * history. Retention is a bound on observation-only telemetry, never on the sentinels or the order ledger,
 * which are evidence and are not pruned here.
 */
export const CONTRACT_PATH_RETENTION_DAYS = 45;
/** Compaction is checked by size rather than every append, so the common path stays a plain append. */
const JOURNAL_COMPACT_BYTES = 32 * 1024 * 1024;

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
  await compactJournalIfLarge();
}

/** Windows closing before this instant are dropped at the next compaction. */
export function contractPathRetentionCutoffMs(nowMs = Date.now()): number {
  return nowMs - CONTRACT_PATH_RETENTION_DAYS * 24 * 60 * 60_000;
}

/**
 * Rewrites the journal keeping only windows inside the retention horizon.
 *
 * Written to a temporary file and renamed, so an interrupted compaction leaves the original intact rather
 * than a half-written journal. A row that cannot be decoded is dropped rather than carried forward: it
 * could not be read by any consumer anyway.
 */
async function compactJournalIfLarge(nowMs = Date.now()): Promise<void> {
  let size = 0;
  try { size = (await stat(JOURNAL_FILE)).size; } catch { return; }
  if (size < JOURNAL_COMPACT_BYTES) return;

  const cutoff = contractPathRetentionCutoffMs(nowMs);
  const fineCutoff = nowMs - CONTRACT_PATH_FINE_RETENTION_DAYS * 24 * 60 * 60_000;
  const temporary = `${JOURNAL_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let kept = 0;
  let dropped = 0;
  let thinned = 0;
  const handle = await open(temporary, 'w');
  try {
    const stream = readline.createInterface({ input: createReadStream(JOURNAL_FILE) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { dropped += 1; continue; }
      const record = decodeContractPath(parsed);
      if (!record || Date.parse(record.closesAt) < cutoff) { dropped += 1; continue; }
      // Fine sampling is kept only while it is recent. Older windows are written back on the coarse grid,
      // which is exactly what they would have contained before fine recording existed, so no analysis
      // written against that grid loses history.
      if (Date.parse(record.closesAt) < fineCutoff) {
        const coarse = thinToCoarseGrid(record);
        if (coarse.points.length < record.points.length) thinned += 1;
        await handle.write(`${JSON.stringify(encodeContractPath(coarse))}\n`);
      } else {
        await handle.write(`${line}\n`);
      }
      kept += 1;
    }
  } finally {
    await handle.close();
  }
  await rename(temporary, JOURNAL_FILE);
  console.log(`Contract path journal compacted: kept ${kept} window(s), thinned ${thinned} to the coarse grid, dropped ${dropped} older than ${CONTRACT_PATH_RETENTION_DAYS} days.`);
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

async function updateDenseQuote(
  input: { contractId: string; symbol: string; closesAt: string; askUpCents: number; askDownCents: number },
  observedAt: number,
  bucketMs: number,
): Promise<void> {
  const store = await readActive();
  const key = `${input.contractId}:${input.closesAt}`;
  const existing = store.active.find((record) => `${record.contractId}:${record.closesAt}` === key)
    ?? emptyContractPath(input);
  const updated = observeContractPath(existing, {
    atMs: observedAt, askUpCents: input.askUpCents, askDownCents: input.askDownCents,
  }, bucketMs);
  await writeActive({
    version: 1, pathVersion: CONTRACT_PATH_VERSION,
    active: [...store.active.filter((record) => `${record.contractId}:${record.closesAt}` !== key), updated],
  });
}

/**
 * Records one contract at the dense bucket, for a candidate being watched to settlement.
 *
 * The sweep asks whether a bid ever reached the exit mark, and a fifteen-second path cannot answer it: a
 * spike lasting eight seconds falls between samples. Measured against a case where the answer is known —
 * every contract settling in the money must pass through 90¢ — the coarse path sees 68.4% of touches.
 * That missing third is the whole distance between the strategy reading dead and reading marginal.
 *
 * Applied only to contracts that became candidates, which is the population the sweep analyses. Doing it
 * for every window would be a hundredfold more data for paths nothing reads.
 */
export function recordDenseContractQuote(
  input: { contractId: string; symbol: string; closesAt: string; askUpCents: number; askDownCents: number },
  observedAt = Date.now(),
  bucketMs = CONTRACT_PATH_DENSE_BUCKET_MS,
): Promise<void> {
  const operation = pathQueue.then(() => updateDenseQuote(input, observedAt, bucketMs));
  pathQueue = operation.then(() => undefined, () => undefined);
  return operation;
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
