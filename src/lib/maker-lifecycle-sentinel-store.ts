import 'server-only';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MAKER_LIFECYCLE_SENTINEL_VERSION, buildMakerLifecycleSentinelReport,
  makerLifecycleSentinelFromOrder, type MakerLifecycleSentinel, type MakerLifecycleSentinelReport,
} from './maker-lifecycle-sentinel';
import type { PaperOrder, PositionSide } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'maker-lifecycle-sentinels.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'maker-lifecycle-sentinels.journal.jsonl');
const JOURNAL_COMPACTION_BYTES = 50 * 1024 * 1024;
let operationQueue: Promise<void> = Promise.resolve();
let storeCache: Promise<MakerLifecycleSentinelStore> | undefined;
let storeCacheFingerprint = '';

export interface MakerLifecycleSentinelStore {
  version: 1;
  sentinelVersion: typeof MAKER_LIFECYCLE_SENTINEL_VERSION;
  startedAt: string;
  updatedAt: string;
  sentinels: MakerLifecycleSentinel[];
}

export type MakerLifecycleSentinelEvent =
  | { op: 'decision'; value: MakerLifecycleSentinel }
  | { op: 'resolution'; value: MakerLifecycleSentinel };

function emptyStore(startedAt: string): MakerLifecycleSentinelStore {
  return {
    version: 1, sentinelVersion: MAKER_LIFECYCLE_SENTINEL_VERSION,
    startedAt, updatedAt: startedAt, sentinels: [],
  };
}

export function replayMakerLifecycleSentinelEvents(
  initial: MakerLifecycleSentinel[], events: MakerLifecycleSentinelEvent[],
): MakerLifecycleSentinel[] {
  const byId = new Map(initial.map((sentinel) => [sentinel.id, sentinel]));
  for (const event of events) {
    if (!event.value?.id) continue;
    if (event.op === 'decision') {
      if (!byId.has(event.value.id)) byId.set(event.value.id, event.value);
      continue;
    }
    const existing = byId.get(event.value.id);
    if (!existing || existing.resolvedAt) continue;
    // Resolution may add settlement fields only. Decision-time evidence always comes from the first row.
    byId.set(existing.id, {
      ...existing,
      outcome: event.value.outcome,
      resolvedAt: event.value.resolvedAt,
    });
  }
  return [...byId.values()];
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function readSnapshot(startedAt: string): Promise<{ store: MakerLifecycleSentinelStore; existed: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as Partial<MakerLifecycleSentinelStore>;
    if (!Array.isArray(parsed.sentinels) || !parsed.startedAt) throw new Error('Maker lifecycle snapshot is missing required fields.');
    return {
      existed: true,
      store: {
        version: 1,
        sentinelVersion: MAKER_LIFECYCLE_SENTINEL_VERSION,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt ?? parsed.startedAt,
        sentinels: parsed.sentinels,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: emptyStore(startedAt), existed: false };
    await rename(SNAPSHOT_FILE, `${SNAPSHOT_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Maker lifecycle sentinel snapshot was malformed and has been quarantined:', error);
    return { store: emptyStore(startedAt), existed: false };
  }
}

async function loadStore(startedAt: string): Promise<{ store: MakerLifecycleSentinelStore; existed: boolean }> {
  const loaded = await readSnapshot(startedAt);
  let raw = '';
  try { raw = await readFile(JOURNAL_FILE, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events: MakerLifecycleSentinelEvent[] = [];
  const valid: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as MakerLifecycleSentinelEvent;
      events.push(event);
      valid.push(line);
    } catch {
      console.error('Maker lifecycle sentinel journal had a damaged trailing event; preserving its valid prefix.');
      await writeFile(`${JOURNAL_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
      await atomicWrite(JOURNAL_FILE, valid.length ? `${valid.join('\n')}\n` : '');
      break;
    }
  }
  loaded.store.sentinels = replayMakerLifecycleSentinelEvents(loaded.store.sentinels, events);
  return loaded;
}

async function storageFingerprint(): Promise<string> {
  const [snapshot, journal] = await Promise.all([
    stat(SNAPSHOT_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
    stat(JOURNAL_FILE).then((value) => `${value.size}:${value.mtimeMs}`).catch(() => 'missing'),
  ]);
  return `${snapshot}|${journal}`;
}

async function readStore(startedAt: string): Promise<{ store: MakerLifecycleSentinelStore; existed: boolean }> {
  const fingerprint = await storageFingerprint();
  if (!storeCache || fingerprint !== storeCacheFingerprint) {
    const loaded = loadStore(startedAt);
    storeCache = loaded.then((value) => value.store);
    storeCacheFingerprint = fingerprint;
    const result = await loaded;
    return result;
  }
  return { store: await storeCache, existed: true };
}

async function cacheStore(store: MakerLifecycleSentinelStore): Promise<void> {
  storeCache = Promise.resolve(store);
  storeCacheFingerprint = await storageFingerprint();
}

async function persistEvents(store: MakerLifecycleSentinelStore, events: MakerLifecycleSentinelEvent[]): Promise<void> {
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

async function ensureStore(observedAt: string): Promise<MakerLifecycleSentinelStore> {
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

/** Initializes the prospective boundary and resolves only records already committed after it. */
export function maintainMakerLifecycleSentinels(observedAt: string): Promise<void> {
  return serialized(async () => {
    const store = await ensureStore(observedAt);
    const due = store.sentinels.filter((sentinel) => !sentinel.resolvedAt
      && Date.parse(sentinel.closesAt) <= Date.parse(observedAt));
    if (!due.length) return;
    const events: MakerLifecycleSentinelEvent[] = [];
    const outcomes = new Map<string, PositionSide>();
    const contractIds = [...new Set(due.map((sentinel) => sentinel.contractId))];
    const fetched = await Promise.allSettled(contractIds.map(async (contractId) => ({ contractId, outcome: await fetchOutcome(contractId) })));
    for (const result of fetched) if (result.status === 'fulfilled' && result.value.outcome) outcomes.set(result.value.contractId, result.value.outcome);
    for (const sentinel of due) {
      const outcome = outcomes.get(sentinel.contractId);
      if (!outcome) continue;
      sentinel.outcome = outcome;
      sentinel.resolvedAt = observedAt;
      events.push({ op: 'resolution', value: sentinel });
    }
    if (!events.length) return;
    store.updatedAt = observedAt;
    await persistEvents(store, events);
  });
}

/**
 * Detached decision-time write. The caller persists the order first and never awaits this from execution.
 * The store's first initialized timestamp is the prospective boundary; older rows cannot be backfilled.
 */
export function recordMakerLifecycleOrder(order: PaperOrder, recordedAt = new Date().toISOString()): Promise<void> {
  // Build the small immutable record synchronously; do not clone the growing execution ledger row.
  const sentinel = makerLifecycleSentinelFromOrder(order, recordedAt);
  return serialized(async () => {
    // A terminal maker that yields no record is an engine fault, not an absence of evidence. Both callers
    // only pass makers, so silence here would hide a whole track the way it hid paper on first release.
    if (!sentinel) {
      console.error(`Maker lifecycle sentinel could not build a record for ${order.id}; its observation vocabulary is unrecognized.`);
      return;
    }
    const store = await ensureStore(sentinel.recordedAt);
    if (Date.parse(sentinel.recordedAt) + 1e-9 < Date.parse(store.startedAt)) return;
    if (store.sentinels.some((item) => item.id === sentinel.id)) return;
    store.sentinels.push(sentinel);
    store.updatedAt = sentinel.recordedAt;
    await persistEvents(store, [{ op: 'decision', value: sentinel }]);
  });
}

export function getMakerLifecycleSentinels(): Promise<{ startedAt: string; sentinels: MakerLifecycleSentinel[] }> {
  return serialized(async () => {
    const store = await ensureStore(new Date().toISOString());
    return { startedAt: store.startedAt, sentinels: store.sentinels };
  });
}

export function getMakerLifecycleSentinelReport(orders: PaperOrder[]): Promise<MakerLifecycleSentinelReport> {
  return serialized(async () => {
    const store = await ensureStore(new Date().toISOString());
    return buildMakerLifecycleSentinelReport({ startedAt: store.startedAt, sentinels: store.sentinels, orders });
  });
}
