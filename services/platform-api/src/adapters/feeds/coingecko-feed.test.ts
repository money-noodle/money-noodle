// The spot adapter, against a synthetic markets payload.
//
// Invented ids, prices and an invented icon host. The two cases worth having are the
// absent field — which stays absent rather than becoming zero — and the sparkline,
// whose times this API has to synthesize and must therefore not present as the
// provider's own.

import { describe, expect, it } from 'vitest';

import { MARKET_ASSETS, OVERVIEW_ASSETS } from '../../domain/market-registry.js';
import { createCoinGeckoFeed, MAX_CHART_POINTS, readSpotSnapshots } from './coingecko-feed.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';

const bitcoin = MARKET_ASSETS[0]!;
const ethereum = MARKET_ASSETS[1]!;
const FETCHED_AT = new Date('2026-10-05T18:07:28.000Z');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  current_price: 64_100,
  high_24h: 64_500,
  id: 'bitcoin',
  image: 'https://assets.example.com/btc.png',
  low_24h: 62_800,
  price_change_percentage_1h_in_currency: 0.4,
  price_change_percentage_24h_in_currency: 1.25,
  price_change_percentage_7d_in_currency: -3.1,
  sparkline_in_7d: { price: [63_000, 63_500, 64_000] },
  total_volume: 1_234_000_000,
  ...overrides,
});

describe('readSpotSnapshots', () => {
  it('reads the provider numbers unrounded, keyed by the registry symbol', () => {
    const snapshots = readSpotSnapshots([row()], [bitcoin], FETCHED_AT);
    const bitcoinSnapshot = snapshots.get('BTC');
    expect(bitcoinSnapshot?.price).toBe(64_100);
    expect(bitcoinSnapshot?.change24hPercent).toBe(1.25);
    expect(bitcoinSnapshot?.change7dPercent).toBe(-3.1);
    expect(bitcoinSnapshot?.high24h).toBe(64_500);
    expect(bitcoinSnapshot?.low24h).toBe(62_800);
    expect(bitcoinSnapshot?.volume24h).toBe(1_234_000_000);
    expect(bitcoinSnapshot?.iconUrl).toBe('https://assets.example.com/btc.png');
  });

  it('leaves a percentage the provider did not compute absent', () => {
    const snapshot = readSpotSnapshots(
      [row({ price_change_percentage_24h_in_currency: null, total_volume: null })],
      [bitcoin],
      FETCHED_AT,
    ).get('BTC');
    // A published zero would read as "unchanged", which is a different claim.
    expect(snapshot?.change24hPercent).toBeUndefined();
    expect(snapshot?.volume24h).toBeUndefined();
    expect(snapshot?.change30dPercent).toBeUndefined();
  });

  it('accepts the plain 24-hour change when the currency-scoped one is missing', () => {
    const snapshot = readSpotSnapshots(
      [row({ price_change_percentage_24h: 2.5, price_change_percentage_24h_in_currency: null })],
      [bitcoin],
      FETCHED_AT,
    ).get('BTC');
    expect(snapshot?.change24hPercent).toBe(2.5);
  });

  it('spaces the seven-day series backwards from the fetch', () => {
    const chart = readSpotSnapshots([row()], [bitcoin], FETCHED_AT).get('BTC')?.chart ?? [];
    expect(chart).toHaveLength(3);
    expect(chart.at(-1)?.time.getTime()).toBe(FETCHED_AT.getTime());
    expect(chart[0]?.time.getTime()).toBe(FETCHED_AT.getTime() - SEVEN_DAYS_MS);
    expect(chart[1]?.time.getTime()).toBe(FETCHED_AT.getTime() - SEVEN_DAYS_MS / 2);
  });

  it('bounds the series and tolerates a provider that sent none', () => {
    const long = readSpotSnapshots(
      [row({ sparkline_in_7d: { price: Array.from({ length: 900 }, (_, i) => 60_000 + i) } })],
      [bitcoin],
      FETCHED_AT,
    );
    expect(long.get('BTC')?.chart).toHaveLength(MAX_CHART_POINTS);
    expect(
      readSpotSnapshots([row({ sparkline_in_7d: null })], [bitcoin], FETCHED_AT).get('BTC')?.chart,
    ).toEqual([]);
    expect(
      readSpotSnapshots([row({ sparkline_in_7d: { price: ['x'] } })], [bitcoin], FETCHED_AT).get(
        'BTC',
      )?.chart,
    ).toEqual([]);
  });

  it('gives a single point the time it was fetched', () => {
    const chart =
      readSpotSnapshots([row({ sparkline_in_7d: { price: [64_000] } })], [bitcoin], FETCHED_AT).get(
        'BTC',
      )?.chart ?? [];
    expect(chart).toEqual([{ price: 64_000, time: FETCHED_AT }]);
  });

  it('publishes no icon from a URL a browser should not follow', () => {
    for (const image of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'not a url']) {
      expect(
        readSpotSnapshots([row({ image })], [bitcoin], FETCHED_AT).get('BTC')?.iconUrl,
      ).toBeUndefined();
    }
  });

  it('omits an asset the response did not carry', () => {
    const snapshots = readSpotSnapshots([row()], [bitcoin, ethereum], FETCHED_AT);
    expect(snapshots.has('ETH')).toBe(false);
    expect(snapshots.size).toBe(1);
  });

  it('refuses a response that carried none of the assets asked for', () => {
    expect(() => readSpotSnapshots([], [bitcoin], FETCHED_AT)).toThrow(FeedFailure);
    expect(() => readSpotSnapshots([row({ id: 'something-else' })], [bitcoin], FETCHED_AT)).toThrow(
      FeedFailure,
    );
    expect(() => readSpotSnapshots({ data: [] }, [bitcoin], FETCHED_AT)).toThrow(FeedFailure);
  });
});

describe('createCoinGeckoFeed', () => {
  it('asks for every registry asset in one keyless call', async () => {
    const urls: string[] = [];
    const client: FeedHttpClient = {
      getJson: async (url: string) => {
        urls.push(url);
        return [row()];
      },
      getText: async () => '',
      postJson: async () => undefined,
    };

    const snapshots = await createCoinGeckoFeed(client).loadSpotSnapshots(
      OVERVIEW_ASSETS,
      FETCHED_AT,
    );

    expect(urls[0]).toContain(`ids=${OVERVIEW_ASSETS.map((asset) => asset.coinGeckoId).join(',')}`);
    expect(urls[0]).toContain('vs_currency=usd');
    expect(urls[0]).toContain('sparkline=true');
    expect(urls[0]).not.toMatch(/key|token/iu);
    expect(snapshots.get('BTC')?.price).toBe(64_100);
  });
});
