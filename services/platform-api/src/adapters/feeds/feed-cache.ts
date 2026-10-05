// One refresh policy for every caller, and one honest answer about how old it is.
//
// Four properties, each a decision recorded on #211:
//
//   * **A time to live per feed**, from the registry. Inside it the stored value is
//     served without touching the upstream; past it the upstream is asked once.
//   * **Single flight per feed.** Concurrent requests for the same feed join one
//     in-flight refresh. Without this a burst of callers fans out to a provider that
//     has done nothing to deserve it, and a public endpoint makes bursts easy.
//   * **No cache bypass.** v1 honoured an unauthenticated `refresh` parameter, so any
//     caller could force up to twenty-three upstream calls. There is no such
//     parameter here and no way to ask for one.
//   * **Last good value, then nothing.** A failed refresh serves the previous value
//     marked stale with its age. Once that value is older than the maximum it is
//     dropped and the feed is unavailable, because an old price with no label is the
//     thing v1 served indefinitely and nobody could tell.
//
// In-process only. Nothing is persisted, so a cold start has no values and says so,
// and two instances answer independently — which is the honest consequence of having
// no shared store rather than a problem to paper over.

import { FEED_CACHE_MAX_ENTRIES, FEED_MAX_STALE_MS } from '../../domain/market-registry.js';
import type { FeedFailureCode, FeedReading } from '../../domain/market-feeds.js';
import { feedFailureCode } from './feed-failure.js';

export interface Clock {
  now(): Date;
}

export interface FeedCache {
  /** Reads `key`, refreshing through `load` when the stored value is past `ttlMs`. */
  readonly read: <T>(key: string, ttlMs: number, load: () => Promise<T>) => Promise<FeedReading<T>>;
}

export interface FeedCacheOptions {
  readonly clock?: Clock;
  readonly maxEntries?: number;
  readonly maxStaleMs?: number;
}

interface Entry {
  readonly fetchedAtMs: number;
  readonly value: unknown;
}

const seconds = (milliseconds: number): number => Math.max(0, milliseconds) / 1000;

export function createFeedCache(options: FeedCacheOptions = {}): FeedCache {
  const clock = options.clock ?? { now: () => new Date() };
  const maxEntries = options.maxEntries ?? FEED_CACHE_MAX_ENTRIES;
  const maxStaleMs = options.maxStaleMs ?? FEED_MAX_STALE_MS;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<FeedReading<unknown>>>();

  const store = (key: string, value: unknown, fetchedAtMs: number): void => {
    // Delete first so the re-insert moves the key to the end: eviction then drops the
    // least recently written key rather than the first one ever written.
    entries.delete(key);
    entries.set(key, { fetchedAtMs, value });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };

  const reading = <T>(
    state: 'fresh' | 'stale',
    value: T,
    fetchedAtMs: number,
    nowMs: number,
    reason?: FeedFailureCode,
  ): FeedReading<T> =>
    Object.freeze({
      ageSeconds: seconds(nowMs - fetchedAtMs),
      fetchedAt: new Date(fetchedAtMs),
      ...(reason === undefined ? {} : { reason }),
      state,
      value,
    });

  const refresh = async <T>(
    key: string,
    load: () => Promise<T>,
    previous: Entry | undefined,
  ): Promise<FeedReading<T>> => {
    try {
      const value = await load();
      const nowMs = clock.now().getTime();
      store(key, value, nowMs);
      return reading('fresh', value, nowMs, nowMs);
    } catch (error) {
      const nowMs = clock.now().getTime();
      // Anything that is not one of this service's own feed failures is reported as
      // unreachable rather than inspected: a message from an unexpected throw is
      // exactly the text that must not reach a response.
      const reason: FeedFailureCode = feedFailureCode(error) ?? 'upstream-unavailable';
      if (previous !== undefined && nowMs - previous.fetchedAtMs <= maxStaleMs) {
        return reading('stale', previous.value as T, previous.fetchedAtMs, nowMs, reason);
      }
      // Past the maximum age the value is dropped, so a later caller cannot be served
      // something this one already refused to publish.
      if (previous !== undefined) entries.delete(key);
      return Object.freeze({
        ageSeconds: 0,
        fetchedAt: new Date(nowMs),
        reason,
        state: 'unavailable' as const,
      });
    }
  };

  return Object.freeze({
    read: async <T>(
      key: string,
      ttlMs: number,
      load: () => Promise<T>,
    ): Promise<FeedReading<T>> => {
      const nowMs = clock.now().getTime();
      const previous = entries.get(key);

      if (previous !== undefined && nowMs - previous.fetchedAtMs < ttlMs) {
        return reading('fresh', previous.value as T, previous.fetchedAtMs, nowMs);
      }

      const joined = inFlight.get(key);
      if (joined !== undefined) return (await joined) as FeedReading<T>;

      const work = refresh(key, load, previous).finally(() => {
        inFlight.delete(key);
      }) as Promise<FeedReading<unknown>>;
      inFlight.set(key, work);
      return (await work) as FeedReading<T>;
    },
  });
}

/**
 * One reading for a value assembled from several.
 *
 * The overview's price feed is one ticker call plus one call per asset, and its
 * Polymarket feed is one call per asset plus a book batch. A caller is owed one
 * freshness statement about the result, and the only honest one is the worst state,
 * the oldest fetch time and the first reason — anything kinder would describe the
 * freshest part of a half-stale answer.
 */
export function combineFeedReadings<T>(
  readings: readonly FeedReading<unknown>[],
  value: T,
  at: Date,
): FeedReading<T> {
  const usable = readings.filter((entry) => entry.state !== 'unavailable');
  if (usable.length === 0) {
    const reason = readings.find((entry) => entry.reason !== undefined)?.reason;
    return Object.freeze({
      ageSeconds: 0,
      fetchedAt: at,
      ...(reason === undefined ? {} : { reason }),
      state: 'unavailable' as const,
    });
  }

  const oldest = usable.reduce(
    (worst, entry) => (entry.fetchedAt.getTime() < worst.fetchedAt.getTime() ? entry : worst),
    usable[0]!,
  );
  const degraded = readings.find((entry) => entry.state !== 'fresh');

  return Object.freeze({
    ageSeconds: seconds(at.getTime() - oldest.fetchedAt.getTime()),
    fetchedAt: oldest.fetchedAt,
    ...(degraded?.reason === undefined ? {} : { reason: degraded.reason }),
    state: degraded === undefined ? ('fresh' as const) : ('stale' as const),
    value,
  });
}
