import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EDGE_SPIKE_SENTINEL_VERSION, buildEdgeSpikeSentinelReport,
  type EdgeSpikeSentinel, type EdgeSpikeSentinelReport,
} from './edge-spike-sentinel';
import { BUY_POLICY_VERSION } from './prediction-policy';

/**
 * Durable store for the edge-spike freshness sentinel.
 *
 * Places no order and holds no budget. Records are immutable once written — only the settlement outcome
 * is ever patched in, and only once. See docs/edge-spike-sentinel-design.md §4.
 */
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'edge-spike-sentinels.json');
const MAX_SENTINELS = 20_000;

let storeQueue: Promise<void> = Promise.resolve();

interface EdgeSpikeSentinelStore {
  version: 1;
  sentinelVersion: string;
  startedAt: string;
  updatedAt: string;
  sentinels: EdgeSpikeSentinel[];
}

const emptyStore = (): EdgeSpikeSentinelStore => ({
  version: 1,
  sentinelVersion: EDGE_SPIKE_SENTINEL_VERSION,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sentinels: [],
});

async function readStore(): Promise<EdgeSpikeSentinelStore> {
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8')) as Partial<EdgeSpikeSentinelStore>;
    if (!Array.isArray(parsed.sentinels)) throw new Error('Edge spike sentinel store has no sentinel collection.');
    return {
      version: 1,
      sentinelVersion: parsed.sentinelVersion ?? EDGE_SPIKE_SENTINEL_VERSION,
      startedAt: parsed.startedAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      sentinels: parsed.sentinels,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    await rename(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Edge spike sentinel store was malformed and has been quarantined:', error);
    return emptyStore();
  }
}

async function writeStore(store: EdgeSpikeSentinelStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2));
  await rename(temporary, STORE_FILE);
}

/**
 * Resolves one due sentinel against the venue's settled result.
 *
 * Matches the resolution already used by the regime-gate, persistence-candidate and calendar-evaluation
 * stores. Deliberately not factored into a shared helper as part of this change: six live settlement
 * paths read this shape today and consolidating them is its own change with its own risk.
 */
async function resolveSentinel(sentinel: EdgeSpikeSentinel): Promise<boolean> {
  if (sentinel.resolvedAt || sentinel.invalidReason || Date.parse(sentinel.closesAt) > Date.now()) return false;
  const baseUrl = (process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/markets/${encodeURIComponent(sentinel.contractId)}`, {
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
  });
  if (!response.ok) return false;
  const body = await response.json() as { market?: { result?: string } };
  const result = body.market?.result?.toLowerCase();
  const outcome = result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : undefined;
  if (!outcome) return false;
  sentinel.outcome = outcome;
  sentinel.resolvedAt = new Date().toISOString();
  // Per $1 of payout, not capital ROI: a cheap contract's enormous percentage return would otherwise
  // dominate the mean, which is exactly the skew the 2026-08-17 review found on cheap cohorts.
  sentinel.realizedEdge = (outcome === sentinel.side ? 1 : 0) - sentinel.askPrice - sentinel.estimatedFeeRate;
  return true;
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation);
  storeQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Resolves due sentinels and appends this cycle's decisions, at most one per (policy, symbol, side, window). */
export function updateEdgeSpikeSentinels(observed: EdgeSpikeSentinel[]): Promise<void> {
  return serialized(async () => {
    const store = await readStore();
    let changed = false;
    for (const pending of store.sentinels.filter((item) => !item.resolvedAt && !item.invalidReason && Date.parse(item.closesAt) <= Date.now())) {
      try { changed = await resolveSentinel(pending) || changed; }
      catch (error) { console.error(`Edge spike sentinel settlement failed for ${pending.id}:`, error); }
    }
    const known = new Set(store.sentinels.map((item) => item.id));
    for (const sentinel of observed) {
      if (known.has(sentinel.id)) continue;
      store.sentinels.push(sentinel);
      known.add(sentinel.id);
      changed = true;
    }
    if (!changed) return;
    store.sentinels = store.sentinels.slice(-MAX_SENTINELS);
    store.updatedAt = new Date().toISOString();
    await writeStore(store);
  });
}

export function getEdgeSpikeSentinelReport(policyVersion: string = BUY_POLICY_VERSION): Promise<EdgeSpikeSentinelReport> {
  return serialized(async () => buildEdgeSpikeSentinelReport((await readStore()).sentinels, policyVersion));
}

export function getEdgeSpikeSentinels(): Promise<EdgeSpikeSentinel[]> {
  return serialized(async () => (await readStore()).sentinels);
}
