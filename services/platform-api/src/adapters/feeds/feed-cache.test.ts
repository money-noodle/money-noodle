// The refresh policy, against a clock a test owns.
//
// Four behaviours are load-bearing for a public endpoint and all four are here: the
// lifetime, the single flight, the last-good window, and the drop at the end of it.
// The last one is the one worth being strict about — a value that outlives its window
// has to disappear rather than be served to the next caller.

import { describe, expect, it, vi } from 'vitest';

import { combineFeedReadings, createFeedCache } from './feed-cache.js';
import { FeedFailure } from './feed-failure.js';

/** A clock the test moves by hand. */
function testClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
    now: () => new Date(nowMs),
  };
}

describe('createFeedCache', () => {
  it('serves a stored value without touching the upstream inside its lifetime', async () => {
    const clock = testClock();
    const cache = createFeedCache({ clock });
    const load = vi.fn(async () => 'value');

    expect(await cache.read('k', 10_000, load)).toEqual({
      ageSeconds: 0,
      fetchedAt: clock.now(),
      state: 'fresh',
      value: 'value',
    });

    clock.advance(9_999);
    const second = await cache.read('k', 10_000, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(second.state).toBe('fresh');
    expect(second.ageSeconds).toBeCloseTo(9.999, 6);
  });

  it('refreshes once the lifetime has passed', async () => {
    const clock = testClock();
    const cache = createFeedCache({ clock });
    const load = vi.fn(async () => 'value');

    await cache.read('k', 10_000, load);
    clock.advance(10_000);
    await cache.read('k', 10_000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent readers into one refresh', async () => {
    const cache = createFeedCache({ clock: testClock() });
    let resolveLoad: ((value: string) => void) | undefined;
    const load = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const readers = Promise.all([
      cache.read('k', 10_000, load),
      cache.read('k', 10_000, load),
      cache.read('k', 10_000, load),
    ]);
    resolveLoad?.('value');
    const results = await readers;

    // Without this, a burst of callers fans out to a provider that has done nothing
    // to deserve it, and a public endpoint makes bursts easy.
    expect(load).toHaveBeenCalledTimes(1);
    expect(results.map((reading) => reading.value)).toEqual(['value', 'value', 'value']);
  });

  it('serves the last good value, marked stale with its age and reason', async () => {
    const clock = testClock();
    const cache = createFeedCache({ clock });

    await cache.read('k', 1_000, async () => 'value');
    clock.advance(120_000);
    const reading = await cache.read('k', 1_000, async () => {
      throw new FeedFailure('upstream-rate-limited');
    });

    expect(reading).toEqual({
      ageSeconds: 120,
      fetchedAt: new Date(clock.now().getTime() - 120_000),
      reason: 'upstream-rate-limited',
      state: 'stale',
      value: 'value',
    });
  });

  it('drops the value once it is older than the limit', async () => {
    const clock = testClock();
    const cache = createFeedCache({ clock, maxStaleMs: 300_000 });
    const failing = async (): Promise<string> => {
      throw new FeedFailure('upstream-timeout');
    };

    await cache.read('k', 1_000, async () => 'value');
    clock.advance(300_001);
    expect(await cache.read('k', 1_000, failing)).toEqual({
      ageSeconds: 0,
      fetchedAt: clock.now(),
      reason: 'upstream-timeout',
      state: 'unavailable',
    });

    // And it is gone: a later caller cannot be served what this one refused to publish.
    clock.advance(1_000);
    expect((await cache.read('k', 1_000, failing)).value).toBeUndefined();
  });

  it('has nothing to serve on a cold failure', async () => {
    const cache = createFeedCache({ clock: testClock() });
    const reading = await cache.read('k', 1_000, async () => {
      throw new FeedFailure('upstream-invalid');
    });
    expect(reading.state).toBe('unavailable');
    expect(reading.reason).toBe('upstream-invalid');
  });

  it('never repeats an unexpected throw', async () => {
    const cache = createFeedCache({ clock: testClock() });
    const reading = await cache.read('k', 1_000, async () => {
      throw new Error('connect ECONNREFUSED provider.internal.example:443');
    });
    // The message is exactly the text that must not reach a response, so the code is
    // assigned rather than derived from it.
    expect(reading.reason).toBe('upstream-unavailable');
    expect(JSON.stringify(reading)).not.toContain('ECONNREFUSED');
  });

  it('evicts the least recently written key', async () => {
    const clock = testClock();
    const cache = createFeedCache({ clock, maxEntries: 2 });
    const load = vi.fn(async () => 'value');

    await cache.read('a', 10_000, load);
    await cache.read('b', 10_000, load);
    await cache.read('c', 10_000, load);
    // `a` was evicted when `c` arrived, so reading it loads again; `b` did not.
    await cache.read('b', 10_000, load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.read('a', 10_000, load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});

describe('combineFeedReadings', () => {
  const at = new Date('2026-10-05T18:00:00.000Z');
  const reading = (
    state: 'fresh' | 'stale' | 'unavailable',
    ageSeconds: number,
    reason?: 'upstream-timeout',
  ) =>
    Object.freeze({
      ageSeconds,
      fetchedAt: new Date(at.getTime() - ageSeconds * 1000),
      ...(reason === undefined ? {} : { reason }),
      state,
      ...(state === 'unavailable' ? {} : { value: state }),
    });

  it('is fresh only when every part is', () => {
    expect(combineFeedReadings([reading('fresh', 1), reading('fresh', 3)], 'v', at)).toEqual({
      ageSeconds: 3,
      fetchedAt: new Date(at.getTime() - 3_000),
      state: 'fresh',
      value: 'v',
    });
  });

  it('reports the worst state, the oldest fetch and the first reason', () => {
    expect(
      combineFeedReadings(
        [reading('fresh', 1), reading('stale', 60, 'upstream-timeout'), reading('fresh', 2)],
        'v',
        at,
      ),
    ).toEqual({
      ageSeconds: 60,
      fetchedAt: new Date(at.getTime() - 60_000),
      reason: 'upstream-timeout',
      state: 'stale',
      value: 'v',
    });
  });

  it('is degraded, not fresh, when one part has nothing', () => {
    const combined = combineFeedReadings(
      [reading('fresh', 1), reading('unavailable', 0, 'upstream-timeout')],
      'v',
      at,
    );
    expect(combined.state).toBe('stale');
    expect(combined.value).toBe('v');
  });

  it('is unavailable when no part has anything', () => {
    expect(combineFeedReadings([reading('unavailable', 0, 'upstream-timeout')], 'v', at)).toEqual({
      ageSeconds: 0,
      fetchedAt: at,
      reason: 'upstream-timeout',
      state: 'unavailable',
    });
    expect(combineFeedReadings([], 'v', at).state).toBe('unavailable');
  });
});
