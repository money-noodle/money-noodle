import 'server-only';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PORTFOLIO_CHOICE_SET_VERSION, replayPortfolioChoiceSetEvents,
  type PortfolioChoiceSetEvent, type PortfolioChoiceSetRecord,
} from './portfolio-choice-set';
import type { PositionSide } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'portfolio-choice-sets.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'portfolio-choice-sets.journal.jsonl');
const JOURNAL_COMPACTION_BYTES = 50 * 1024 * 1024;
let operationQueue: Promise<void> = Promise.resolve();
let storeCache: Promise<PortfolioChoiceSetStore> | undefined;
let storeCacheFingerprint = '';

export interface PortfolioChoiceSetStore {
  version: 1;
  choiceSetVersion: typeof PORTFOLIO_CHOICE_SET_VERSION;
  startedAt: string;
  updatedAt: string;
  records: PortfolioChoiceSetRecord[];
}

function emptyStore(startedAt: string): PortfolioChoiceSetStore {
  return { version: 1, choiceSetVersion: PORTFOLIO_CHOICE_SET_VERSION, startedAt, updatedAt: startedAt, records: [] };
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function readSnapshot(startedAt: string): Promise<{ store: PortfolioChoiceSetStore; existed: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as Partial<PortfolioChoiceSetStore>;
    if (!Array.isArray(parsed.records) || !parsed.startedAt) throw new Error('Portfolio choice-set snapshot is missing required fields.');
    return { existed: true, store: {
      version: 1, choiceSetVersion: PORTFOLIO_CHOICE_SET_VERSION, startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt ?? parsed.startedAt, records: parsed.records,
    } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: emptyStore(startedAt), existed: false };
    await rename(SNAPSHOT_FILE, `${SNAPSHOT_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Portfolio choice-set snapshot was malformed and has been quarantined:', error);
    return { store: emptyStore(startedAt), existed: false };
  }
}

async function loadStore(startedAt: string): Promise<{ store: PortfolioChoiceSetStore; existed: boolean }> {
  const loaded = await readSnapshot(startedAt);
  let raw = '';
  try { raw = await readFile(JOURNAL_FILE, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events: PortfolioChoiceSetEvent[] = [];
  const valid: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as PortfolioChoiceSetEvent;
      events.push(event);
      valid.push(line);
    } catch {
      console.error('Portfolio choice-set journal had a damaged trailing event; preserving its valid prefix.');
      await writeFile(`${JOURNAL_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
      await atomicWrite(JOURNAL_FILE, valid.length ? `${valid.join('\n')}\n` : '');
      break;
    }
  }
  loaded.store.records = replayPortfolioChoiceSetEvents(loaded.store.records, events);
  return loaded;
}

async function storageFingerprint(): Promise<string> {
  const [snapshot, journal] = await Promise.all([
    stat(SNAPSHOT_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
    stat(JOURNAL_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
  ]);
  return `${snapshot}|${journal}`;
}

async function readStore(startedAt: string): Promise<{ store: PortfolioChoiceSetStore; existed: boolean }> {
  const fingerprint = await storageFingerprint();
  if (!storeCache || fingerprint !== storeCacheFingerprint) {
    const loaded = loadStore(startedAt);
    storeCache = loaded.then((value) => value.store);
    storeCacheFingerprint = fingerprint;
    return loaded;
  }
  return { store: await storeCache, existed: true };
}

async function cacheStore(store: PortfolioChoiceSetStore): Promise<void> {
  storeCache = Promise.resolve(store);
  storeCacheFingerprint = await storageFingerprint();
}

async function persistEvents(store: PortfolioChoiceSetStore, events: PortfolioChoiceSetEvent[]): Promise<void> {
  if (!events.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(JOURNAL_FILE, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const size = await stat(JOURNAL_FILE).then((value) => value.size).catch(() => 0);
  if (size >= JOURNAL_COMPACTION_BYTES) {
    await atomicWrite(SNAPSHOT_FILE, JSON.stringify(store));
    await atomicWrite(JOURNAL_FILE, '');
  }
  await cacheStore(store);
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureStore(observedAt: string): Promise<PortfolioChoiceSetStore> {
  const loaded = await readStore(observedAt);
  if (!loaded.existed) {
    await atomicWrite(SNAPSHOT_FILE, JSON.stringify(loaded.store));
    await cacheStore(loaded.store);
  }
  return loaded.store;
}

async function fetchOutcome(contractId: string): Promise<PositionSide | undefined> {
  const baseUrl = (process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/markets/${encodeURIComponent(contractId)}`, {
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
  });
  if (!response.ok) return undefined;
  const result = ((await response.json()) as { market?: { result?: string } }).market?.result?.toLowerCase();
  return result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : undefined;
}

/** Initializes the prospective boundary and resolves only choice sets committed after it. */
export function maintainPortfolioChoiceSets(observedAt: string): Promise<void> {
  return serialized(async () => {
    const store = await ensureStore(observedAt);
    const due = store.records.flatMap((record) => record.candidates
      .filter((candidate) => candidate.contractId && !candidate.resolvedAt
        && Date.parse(candidate.closesAt) <= Date.parse(observedAt))
      .map((candidate) => ({ record, candidate })));
    if (!due.length) return;
    const contractIds = [...new Set(due.map(({ candidate }) => candidate.contractId!))];
    const fetched = await Promise.allSettled(contractIds.map(async (contractId) => ({ contractId, outcome: await fetchOutcome(contractId) })));
    const outcomes = new Map<string, PositionSide>();
    for (const result of fetched) if (result.status === 'fulfilled' && result.value.outcome) outcomes.set(result.value.contractId, result.value.outcome);
    const events: PortfolioChoiceSetEvent[] = [];
    for (const { record, candidate } of due) {
      const outcome = outcomes.get(candidate.contractId!);
      if (outcome) events.push({ op: 'resolution', recordId: record.id, candidateId: candidate.id, outcome, resolvedAt: observedAt });
    }
    if (!events.length) return;
    store.records = replayPortfolioChoiceSetEvents(store.records, events);
    store.updatedAt = observedAt;
    await persistEvents(store, events);
  });
}

/** Detached after the authoritative order ledger has durably recorded the issued intent. */
export function recordPortfolioChoiceSet(record: PortfolioChoiceSetRecord): Promise<void> {
  return serialized(async () => {
    const store = await ensureStore(record.recordedAt);
    if (Date.parse(record.recordedAt) + 1e-9 < Date.parse(store.startedAt)) return;
    if (store.records.some((item) => item.id === record.id)) return;
    store.records.push(record);
    store.updatedAt = record.recordedAt;
    await persistEvents(store, [{ op: 'decision', value: record }]);
  });
}

export function getPortfolioChoiceSets(): Promise<{ startedAt: string; records: PortfolioChoiceSetRecord[] }> {
  return serialized(async () => {
    const store = await ensureStore(new Date().toISOString());
    return { startedAt: store.startedAt, records: store.records };
  });
}
