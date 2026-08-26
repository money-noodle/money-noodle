import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cachedKalshiAgeMs, cachedKalshiRead, resetKalshiQuoteCache } from './kalshi-quote-cache';
import {
  initialRateLimitState, isRateLimited, rateLimitBackoffMs, rateLimitPaused, recordRateLimitSuccess,
  recordRateLimited,
} from './kalshi-rate-limit';

describe('quote cache', () => {
  beforeEach(() => resetKalshiQuoteCache());

  it('serves a value inside its max-age without a request', async () => {
    let calls = 0;
    const load = async () => { calls += 1; return calls; };
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 1_000 })).toBe(1);
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 1_000 })).toBe(1);
    expect(calls).toBe(1);
  });

  it('refetches once the caller\'s max-age has passed', async () => {
    let calls = 0;
    const load = async () => { calls += 1; return calls; };
    const start = 1_000_000;
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 1_000, nowMs: start })).toBe(1);
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 1_000, nowMs: start + 5_000 })).toBe(2);
    expect(calls).toBe(2);
  });

  it('lets each caller state its own freshness', async () => {
    // The point of per-call max-age: a one-second entry pass and a report that tolerates a minute share
    // one cache without either dictating to the other.
    let calls = 0;
    await cachedKalshiRead('k', async () => { calls += 1; return 'v'; }, { maxAgeMs: 60_000 });
    await cachedKalshiRead('k', async () => { calls += 1; return 'v'; }, { maxAgeMs: 60_000 });
    expect(calls).toBe(1);
  });

  it('makes one request when several callers miss at once', async () => {
    // Single flight. A value cache alone would let the entry pass and the exit poller each fetch the same
    // contract, which is exactly the duplication this exists to remove.
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'quote';
    };
    const results = await Promise.all([
      cachedKalshiRead('k', load, { maxAgeMs: 1_000 }),
      cachedKalshiRead('k', load, { maxAgeMs: 1_000 }),
      cachedKalshiRead('k', load, { maxAgeMs: 1_000 }),
    ]);
    expect(results).toEqual(['quote', 'quote', 'quote']);
    expect(calls).toBe(1);
  });

  it('does not cache a failure, so the next caller retries', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error('venue hiccup');
      return 'recovered';
    };
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 1_000 })).toBeUndefined();
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 1_000 })).toBe('recovered');
  });

  it('withholds a stale value from a caller that did not ask for one', async () => {
    // A decision that asked for a one-second quote must not silently receive a minute-old one.
    const start = 1_000_000;
    await cachedKalshiRead('k', async () => 'old', { maxAgeMs: 1_000, nowMs: start });
    const failing = async () => { throw new Error('down'); };
    expect(await cachedKalshiRead('k', failing, { maxAgeMs: 1_000, nowMs: start + 60_000 })).toBeUndefined();
    expect(await cachedKalshiRead('k', failing, { maxAgeMs: 1_000, nowMs: start + 60_000, allowStale: true })).toBe('old');
  });

  it('supports sub-second freshness, which the trailing entry needs', async () => {
    let calls = 0;
    const load = async () => { calls += 1; return calls; };
    const start = 1_000_000;
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 250, nowMs: start })).toBe(1);
    // Inside 250ms: served without a request.
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 250, nowMs: start + 200 })).toBe(1);
    // Past it: refetched.
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 250, nowMs: start + 300 })).toBe(2);
    expect(calls).toBe(2);
  });

  it('lets a fast and a slow caller share one entry without either being starved', async () => {
    // The trailing entry wants a quarter second; the one-second pass and the exit poller want more. The
    // fast caller drives the refresh and the slower ones ride it, which is why max-age is per call.
    let calls = 0;
    const load = async () => { calls += 1; return calls; };
    const start = 1_000_000;
    await cachedKalshiRead('k', load, { maxAgeMs: 250, nowMs: start });
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 1_000, nowMs: start + 400 })).toBe(1);
    expect(await cachedKalshiRead('k', load, { maxAgeMs: 250, nowMs: start + 400 })).toBe(2);
    expect(calls).toBe(2);
  });

  it('bounds a slow venue to one request in flight even when every tick misses', async () => {
    // Asking for less than a round trip means the cache never hits. Single flight makes that degrade to
    // the venue's response time rather than a pile of concurrent requests.
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'slow';
    };
    await Promise.all(Array.from({ length: 8 }, () => cachedKalshiRead('slow', load, { maxAgeMs: 5 })));
    expect(calls).toBe(1);
  });

  it('reports the age of what it holds', async () => {
    const start = 1_000_000;
    await cachedKalshiRead('k', async () => 'v', { maxAgeMs: 1_000, nowMs: start });
    expect(cachedKalshiAgeMs('k', Date.now() + 5_000)).toBeGreaterThan(0);
    expect(cachedKalshiAgeMs('absent')).toBeUndefined();
  });
});

describe('read rate limiting', () => {
  it('recognises the status Kalshi answers a breach with', () => {
    expect(isRateLimited(429)).toBe(true);
    expect(isRateLimited(500)).toBe(false);
  });

  it('backs off further on each consecutive strike, up to a cap', () => {
    const fixed = () => 1;
    expect(rateLimitBackoffMs(1, fixed)).toBe(250);
    expect(rateLimitBackoffMs(2, fixed)).toBe(500);
    expect(rateLimitBackoffMs(3, fixed)).toBe(1_000);
    expect(rateLimitBackoffMs(20, fixed)).toBe(8_000);
  });

  it('jitters, so simultaneous callers do not retry in one burst', () => {
    // Every caller backs off from the same venue at the same instant; a fixed delay would resynchronise
    // them and re-trip the limit.
    expect(rateLimitBackoffMs(4, () => 0)).toBeLessThan(rateLimitBackoffMs(4, () => 1));
  });

  it('pauses reads while backing off and clears on any success', () => {
    const now = 1_000_000;
    const limited = recordRateLimited(initialRateLimitState(), now, () => 1);
    expect(rateLimitPaused(limited, now)).toBe(true);
    expect(rateLimitPaused(limited, now + 10_000)).toBe(false);
    // The budget refills continuously, so one good read proves there is room again.
    expect(rateLimitPaused(recordRateLimitSuccess(limited), now)).toBe(false);
  });
});

describe('writes are never cached, and a refused write is retried', () => {
  it('caches no signed request path', async () => {
    // An account read must be authoritative and an order must reach the venue. Only quote reads are
    // cached, and this pins that: the signed client must not gain a cache by accident later.
    const { readFileSync } = await import('node:fs');
    const api = readFileSync(new URL('./kalshi-api.ts', import.meta.url), 'utf8');
    expect(api).not.toContain('cachedKalshiRead');
    expect(api).toContain('Never cached');
  });

  it('retries only an explicit 429, never an ambiguous failure', async () => {
    // A 429 is the venue refusing before processing, so no order can exist and retrying is safe. A
    // timeout may well have created one, and must keep the uncertain path that reconciles authoritatively.
    const { readFileSync } = await import('node:fs');
    const api = readFileSync(new URL('./kalshi-api.ts', import.meta.url), 'utf8');
    expect(api).toContain('error instanceof KalshiRateLimitError');
    // The retry loop must bail on anything else rather than looping over a real error.
    expect(api).toContain('if (!(error instanceof KalshiRateLimitError) || attempt >= RATE_LIMIT_ATTEMPTS) throw error;');
  });

  it('backs reads and writes off separately, because the buckets are separate', () => {
    // Kalshi refills 200 read tokens/s against 100 write tokens/s. A burst of quote reads must not delay
    // an order, and a busy order path must not stall reconciliation.
    const now = 1_000_000;
    const limited = recordRateLimited(initialRateLimitState(), now, () => 1);
    const fresh = initialRateLimitState();
    expect(rateLimitPaused(limited, now)).toBe(true);
    expect(rateLimitPaused(fresh, now)).toBe(false);
  });
});
