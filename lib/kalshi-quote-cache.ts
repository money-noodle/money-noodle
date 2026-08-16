import 'server-only';

/**
 * Shared in-memory cache for Kalshi reads, with per-call freshness.
 *
 * Two properties, and the second is the one that matters:
 *
 * - **Per-call max-age.** A caller states how fresh it needs a value to be. The one-second entry pass and
 *   a report that tolerates half a minute share the same cache without either dictating to the other.
 * - **Single flight.** The *promise* is cached, not the value, so simultaneous misses on one ticker
 *   produce one request. A value cache alone would let the entry pass and the exit poller each fetch the
 *   same quote, which is precisely the duplication this exists to remove.
 *
 * Kalshi's basic tier refills 200 read tokens per second at 10 tokens a request — 20 requests per second
 * sustained — so quotes and depth are cached separately: the entry trigger reads only the two asks and
 * has no use for a twenty-level book, and pairing them would double its cost for nothing.
 */
interface Entry<T> {
  value?: T;
  observedAtMs: number;
  inFlight?: Promise<T | undefined>;
}

const entries = new Map<string, Entry<unknown>>();

/** Cleared between tests, and after a rate-limit pause, so a stale value cannot outlive its meaning. */
export function resetKalshiQuoteCache(): void {
  entries.clear();
}

export interface CachedReadOptions {
  /** Oldest acceptable value. A cached value at or under this age is returned without a request. */
  maxAgeMs: number;
  /**
   * Serve a value older than `maxAgeMs` rather than failing, when a refresh cannot be made. Off by
   * default: a trading decision that asked for a one-second quote must not silently receive a minute-old
   * one. Reporting paths that would rather show something old than nothing turn it on.
   */
  allowStale?: boolean;
  nowMs?: number;
}

/**
 * Reads through the cache, deduplicating concurrent misses.
 *
 * A failed load resolves to `undefined` rather than throwing: every caller here is a poll that will ask
 * again shortly, and a rejected promise sitting in the map would turn one bad response into a cascade.
 */
export async function cachedKalshiRead<T>(
  key: string, load: () => Promise<T>, options: CachedReadOptions,
): Promise<T | undefined> {
  const now = options.nowMs ?? Date.now();
  const existing = entries.get(key) as Entry<T> | undefined;

  if (existing?.value !== undefined && now - existing.observedAtMs <= options.maxAgeMs) return existing.value;
  if (existing?.inFlight) return existing.inFlight;

  // Stamped with the time the request *started*, not finished. A slow fetch returns a quote the venue
  // held when it was asked, so dating it at completion would make a stale price look fresh — the caller
  // would then act on a one-second quote that was really a second and a half old. It is also the clock
  // the caller supplied, so the same instant governs both storing and expiring.
  const inFlight = load()
    .then((value) => {
      entries.set(key, { value, observedAtMs: now });
      return value;
    })
    .catch((error) => {
      // The failed attempt is dropped, not cached: the next caller should retry rather than inherit it.
      const current = entries.get(key) as Entry<T> | undefined;
      if (current) entries.set(key, { value: current.value, observedAtMs: current.observedAtMs });
      throw error;
    })
    .catch(() => undefined)
    .finally(() => {
      const current = entries.get(key) as Entry<T> | undefined;
      if (current?.inFlight) entries.set(key, { value: current.value, observedAtMs: current.observedAtMs });
    });

  entries.set(key, { value: existing?.value, observedAtMs: existing?.observedAtMs ?? 0, inFlight });
  const value = await inFlight;
  if (value !== undefined) return value;
  // The refresh failed. Only now does staleness become a question, and only if the caller allows it.
  return options.allowStale ? existing?.value : undefined;
}

/** Age of a cached value in milliseconds, or undefined if nothing is held. For reporting freshness. */
export function cachedKalshiAgeMs(key: string, nowMs = Date.now()): number | undefined {
  const entry = entries.get(key);
  return entry?.value === undefined ? undefined : nowMs - entry.observedAtMs;
}

export function cachedKalshiEntryCount(): number {
  return entries.size;
}
