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
