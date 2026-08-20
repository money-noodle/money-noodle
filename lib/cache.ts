import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_FRESHNESS } from './freshness';
import type { QuotePathSample } from './quote-trajectory-spread';
import { isStatelessDeployment } from './runtime-environment';

const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const memoryCache = new Map<string, CacheEnvelope<unknown>>();
/** Roughly a fifth of the calculation window: slow enough to matter, quiet on a healthy upstream. */
const SLOW_FEED_LOG_MS = 3_000;
/**
 * Whole-feed deadline, shorter than the lead the next calculation is started on.
 *
 * A per-request timeout cannot bound a feed that makes more than one round — Polymarket must read the
 * events before it can ask for their books — so two capped requests still exceed the window they serve.
 * This bounds the feed itself. It applies only when a previous value exists to fall back to, so it can
 * never turn a cold start into a failure; it only stops a warm cycle waiting on an answer it would
 * discard anyway.
 */
const FEED_BUDGET_MS = 6_000;

function withDeadline<T>(loader: () => Promise<T>, key: string): Promise<T> {
  return Promise.race([
    loader(),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Feed ${key} exceeded ${FEED_BUDGET_MS}ms`)), FEED_BUDGET_MS);
      timer.unref?.();
    }),
  ]);
}

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

export async function writeCache<T>(key: string, value: T, savedAt = Date.now()): Promise<void> {
  const envelope: CacheEnvelope<T> = { savedAt, value };
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
): Promise<{ value: T; fromCache: boolean; savedAt: number }> {
  const previous = await readCache<T>(key);
  if (!force && previous && Date.now() - previous.savedAt < ttlMs) {
    return { value: previous.value, fromCache: true, savedAt: previous.savedAt };
  }

  // Feeds run together and the calculation takes as long as the slowest, so one stalling upstream
  // delays everything. Naming it costs a timestamp and is the only way to tell which one is degrading.
  const started = Date.now();
  try {
    const value = previous ? await withDeadline(loader, key) : await loader();
    const savedAt = Date.now();
    await writeCache(key, value, savedAt);
    return { value, fromCache: false, savedAt };
  } catch (error) {
    if (previous) return { value: previous.value, fromCache: true, savedAt: previous.savedAt };
    throw error;
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed >= SLOW_FEED_LOG_MS) console.warn(`Slow feed: ${key} took ${elapsed}ms`);
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
  /** Source-timestamped exact books for observation-only trajectory calculation. */
  quotePathSamples?: QuotePathSample[];
}

type VenueHistoryBooks = Pick<VenueSnapshot, 'polymarketBidUp' | 'polymarketAskUp' | 'kalshiBidUp' | 'kalshiAskUp' | 'quotePathSamples'>;

function quotePathSampleKey(sample: QuotePathSample): string {
  return `${sample.providerId}:${sample.symbol}:${sample.contractId}:${sample.closesAt}:${sample.sourceObservedAt}`;
}

export async function recordVenueHistory(
  polymarket: Record<string, number>, kalshi: Record<string, number>, closesAt: Record<string, string>,
  books: VenueHistoryBooks = {},
): Promise<VenueSnapshot[]> {
  const existing = await readCache<VenueSnapshot[]>('venue-history');
  const history = existing?.value ?? [];
  const now = Date.now();
  const seen = new Set(history.flatMap((point) => point.quotePathSamples ?? []).map(quotePathSampleKey));
  const quotePathSamples = (books.quotePathSamples ?? []).filter((sample) => !seen.has(quotePathSampleKey(sample)));
  const last = history.at(-1);
  if (quotePathSamples.length || !last || now - last.time >= DATA_FRESHNESS.venueHistoryMinimumSpacingMs) {
    history.push({ ...books, time: now, polymarket, kalshi, closesAt, quotePathSamples: quotePathSamples.length ? quotePathSamples : undefined });
  }
  const trimmed = history.filter((point) => point.time >= now - DATA_FRESHNESS.quotePathHistoryWindowMs);
  await writeCache('venue-history', trimmed);
  return trimmed;
}

export interface OracleSnapshot {
  time: number;
  /** Absent on legacy cache rows, which are not source-timestamped trajectory evidence. */
  sourceObservedAt?: number;
  prices: Record<string, number>;
}

/**
 * Rolling samples of the venue oracle price. Realized volatility must be measured on the same series
 * the contract settles against; an illiquid spot feed understates it and makes the model overconfident.
 */
export async function recordOracleHistory(prices: Record<string, number>, sourceObservedAt = Date.now()): Promise<OracleSnapshot[]> {
  const existing = await readCache<OracleSnapshot[]>('oracle-history');
  const history = existing?.value ?? [];
  const alreadyRecorded = history.some((point) => point.sourceObservedAt === sourceObservedAt);
  if (Object.keys(prices).length && Number.isFinite(sourceObservedAt) && !alreadyRecorded) {
    history.push({ time: sourceObservedAt, sourceObservedAt, prices });
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
