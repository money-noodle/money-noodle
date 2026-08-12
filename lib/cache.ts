import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_FRESHNESS } from './freshness';
import { isStatelessDeployment } from './runtime-environment';

const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const memoryCache = new Map<string, CacheEnvelope<unknown>>();

interface CacheEnvelope<T> {
  savedAt: number;
  value: T;
}

export async function readCache<T>(key: string): Promise<CacheEnvelope<T> | null> {
  const inMemory = memoryCache.get(key) as CacheEnvelope<T> | undefined;
  if (inMemory) return inMemory;
  if (isStatelessDeployment()) return null;
  try {
    const parsed = JSON.parse(await readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8')) as CacheEnvelope<T>;
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  const envelope: CacheEnvelope<T> = { savedAt: Date.now(), value };
  memoryCache.set(key, envelope);
  // Hosted/stateless dashboard requests retain only warm-instance cache and never write deployment files.
  if (isStatelessDeployment()) return;
  await mkdir(CACHE_DIR, { recursive: true });
  const target = path.join(CACHE_DIR, `${key}.json`);
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(envelope, null, 2));
  await rename(temporary, target);
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  force = false,
): Promise<{ value: T; fromCache: boolean }> {
  const previous = await readCache<T>(key);
  if (!force && previous && Date.now() - previous.savedAt < ttlMs) {
    return { value: previous.value, fromCache: true };
  }

  try {
    const value = await loader();
    await writeCache(key, value);
    return { value, fromCache: false };
  } catch (error) {
    if (previous) return { value: previous.value, fromCache: true };
    throw error;
  }
}

export interface PriceSnapshot {
  time: number;
  prices: Record<string, number>;
}

export interface VenueSnapshot {
  time: number;
  polymarket: Record<string, number>;
  kalshi: Record<string, number>;
  closesAt: Record<string, string>;
  polymarketBidUp?: Record<string, number>;
  polymarketAskUp?: Record<string, number>;
  kalshiBidUp?: Record<string, number>;
  kalshiAskUp?: Record<string, number>;
}

export async function recordVenueHistory(polymarket: Record<string, number>, kalshi: Record<string, number>, closesAt: Record<string, string>, books: Pick<VenueSnapshot, 'polymarketBidUp' | 'polymarketAskUp' | 'kalshiBidUp' | 'kalshiAskUp'> = {}): Promise<VenueSnapshot[]> {
  const existing = await readCache<VenueSnapshot[]>('venue-history');
  const history = existing?.value ?? [];
  const last = history.at(-1);
  if (!last || Date.now() - last.time >= DATA_FRESHNESS.venueHistoryMinimumSpacingMs) history.push({ time: Date.now(), polymarket, kalshi, closesAt, ...books });
  const trimmed = history.filter((point) => point.time >= Date.now() - 10 * 60 * 1000);
  await writeCache('venue-history', trimmed);
  return trimmed;
}

export interface OracleSnapshot {
  time: number;
  prices: Record<string, number>;
}

/**
 * Rolling samples of the venue oracle price. Realized volatility must be measured on the same series
 * the contract settles against; an illiquid spot feed understates it and makes the model overconfident.
 */
export async function recordOracleHistory(prices: Record<string, number>): Promise<OracleSnapshot[]> {
  const existing = await readCache<OracleSnapshot[]>('oracle-history');
  const history = existing?.value ?? [];
  const last = history.at(-1);
  if (Object.keys(prices).length && (!last || Date.now() - last.time >= DATA_FRESHNESS.oracleSampleMinimumSpacingMs)) {
    history.push({ time: Date.now(), prices });
  }
  const trimmed = history.filter((point) => point.time >= Date.now() - DATA_FRESHNESS.oracleHistoryWindowMs);
  await writeCache('oracle-history', trimmed);
  return trimmed;
}

export async function recordPriceHistory(prices: Record<string, number>): Promise<PriceSnapshot[]> {
  const existing = await readCache<PriceSnapshot[]>('price-history');
  const history = existing?.value ?? [];
  const last = history.at(-1);
  if (!last || Date.now() - last.time > DATA_FRESHNESS.localPriceSnapshotMs) {
    history.push({ time: Date.now(), prices });
  }
  const cutoff = Date.now() - 6 * 366 * 24 * 60 * 60 * 1000;
  const trimmed = history.filter((point) => point.time >= cutoff);
  await writeCache('price-history', trimmed);
  return trimmed;
}
