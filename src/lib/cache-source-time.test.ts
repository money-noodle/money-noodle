import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cached, recordOracleHistory, recordVenueHistory } from './cache';
import type { QuotePathSample } from './quote-trajectory-spread';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('cache source timestamps', () => {
  it('preserves the producing response time across cache hits and failed refresh fallback', async () => {
    vi.stubEnv('MONEY_NOODLE_STATELESS', 'true');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T04:00:00Z'));
    const key = `source-time-${Math.random()}`;
    const first = await cached(key, 12_000, async () => ({ quote: 0.51 }));
    expect(first.savedAt).toBe(Date.parse('2026-08-20T04:00:00Z'));
    expect(first.fromCache).toBe(false);

    vi.setSystemTime(new Date('2026-08-20T04:00:05Z'));
    const hit = await cached(key, 12_000, async () => ({ quote: 0.99 }));
    expect(hit).toEqual({ value: { quote: 0.51 }, fromCache: true, savedAt: first.savedAt });

    vi.setSystemTime(new Date('2026-08-20T04:00:20Z'));
    const fallback = await cached(key, 12_000, async () => { throw new Error('upstream failed'); }, true);
    expect(fallback).toEqual({ value: { quote: 0.51 }, fromCache: true, savedAt: first.savedAt });
  });

  it('deduplicates source observations even when the dashboard records the same cached value later', async () => {
    vi.stubEnv('MONEY_NOODLE_STATELESS', 'true');
    vi.useFakeTimers();
    const sourceObservedAt = Date.parse('2026-08-20T04:05:00Z');
    vi.setSystemTime(sourceObservedAt);
    const sample: QuotePathSample = {
      providerId: 'kalshi', symbol: 'BTC', contractId: 'KXBTC', closesAt: '2026-08-20T04:15:00Z',
      sourceObservedAt, bidUp: 0.49, askUp: 0.51, bidDown: 0.49, askDown: 0.51,
    };
    await recordVenueHistory({}, {}, {}, { quotePathSamples: [sample] });
    await recordOracleHistory({ BTC: 100 }, sourceObservedAt);

    vi.setSystemTime(sourceObservedAt + 20_000);
    const venue = await recordVenueHistory({}, {}, {}, { quotePathSamples: [sample] });
    const oracle = await recordOracleHistory({ BTC: 100 }, sourceObservedAt);
    expect(venue.flatMap((point) => point.quotePathSamples ?? [])).toEqual([sample]);
    expect(oracle.filter((point) => point.sourceObservedAt === sourceObservedAt)).toHaveLength(1);
  });
});
