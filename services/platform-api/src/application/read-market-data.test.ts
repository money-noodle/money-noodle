// The two use cases, against a port that is a literal object.
//
// The only decisions these make are which feeds to read and when, so that is what is
// tested: every feed for the overview, and the price series only for an asset that has
// something to price. The arithmetic is the domain's and is tested there.

import { describe, expect, it, vi } from 'vitest';

import { fresh, gone } from '../domain/market-overview.test.js';
import type { FeedReading, HourlyThresholdGroup, MarketFeedPort } from '../domain/market-feeds.js';
import { HOURLY_ASSETS, type MarketAsset } from '../domain/market-registry.js';
import { createGetHourlyThresholdMarkets, createGetMarketOverview } from './read-market-data.js';

const AT = new Date('2026-10-05T18:07:30.000Z');
const CLOSES_AT = new Date('2026-10-05T19:00:00.000Z');

const group: HourlyThresholdGroup = Object.freeze({
  closesAt: CLOSES_AT,
  openAt: new Date('2026-10-05T18:00:00.000Z'),
  rows: Object.freeze([
    {
      direction: 'ABOVE' as const,
      rulesText: 'Resolves Yes if the settlement price is above the strike.',
      strike: 64_000,
      ticker: 'KXBTC-26OCT0519-T64000',
    },
  ]),
  unusableSides: Object.freeze([]),
});

const closes = Object.freeze(
  Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 63_800 : 63_900)),
);

function fakePort(listings: (asset: MarketAsset) => FeedReading<HourlyThresholdGroup | null>): {
  readonly asked: string[];
  readonly port: MarketFeedPort;
} {
  const asked: string[] = [];
  return {
    asked,
    port: {
      readCyclePrices: vi.fn(async () => fresh(new Map())),
      readHeadlines: vi.fn(async () => fresh([])),
      readHourlyThresholds: vi.fn(async (asset: MarketAsset) => listings(asset)),
      readKalshiQuotes: vi.fn(async () => fresh(new Map())),
      readLongHistory: vi.fn(async () => fresh(new Map())),
      readMinuteCloses: vi.fn(async (asset: MarketAsset) => {
        asked.push(asset.symbol);
        return fresh(closes);
      }),
      readPolymarketQuotes: vi.fn(async () => fresh(new Map())),
      readSpotSnapshots: vi.fn(async () => fresh(new Map())),
    },
  };
}

describe('createGetMarketOverview', () => {
  it('reads every feed once and stamps the record with the injected clock', async () => {
    const { port } = fakePort(() => fresh(null));
    const overview = await createGetMarketOverview({ clock: () => AT, feeds: port })();

    expect(overview.generatedAt).toBe(AT.toISOString());
    expect(overview.marketId).toBe('crypto-15m');
    for (const read of [
      port.readCyclePrices,
      port.readHeadlines,
      port.readKalshiQuotes,
      port.readLongHistory,
      port.readPolymarketQuotes,
      port.readSpotSnapshots,
    ]) {
      expect(read).toHaveBeenCalledTimes(1);
    }
    // The hourly view's per-asset series is not part of this read.
    expect(port.readMinuteCloses).not.toHaveBeenCalled();
  });

  it('defaults to the service clock when given none', async () => {
    const { port } = fakePort(() => fresh(null));
    const before = Date.now();
    const overview = await createGetMarketOverview({ feeds: port })();
    expect(new Date(overview.generatedAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('createGetHourlyThresholdMarkets', () => {
  it('reads the price series only for an asset with something to price', async () => {
    const { asked, port } = fakePort((asset) =>
      asset.symbol === 'BTC' ? fresh<HourlyThresholdGroup | null>(group) : fresh(null),
    );

    const view = await createGetHourlyThresholdMarkets({ clock: () => AT, feeds: port })();

    expect(port.readHourlyThresholds).toHaveBeenCalledTimes(HOURLY_ASSETS.length);
    // An exchange should not be asked for a series this read is not going to use.
    expect(asked).toEqual(['BTC']);
    expect(view.markets).toHaveLength(HOURLY_ASSETS.length);
    expect(view.markets[0]?.candidates).toHaveLength(1);
    expect(view.markets[0]?.currentPrice).toBe(closes.at(-1));
    expect(view.generatedAt).toBe(AT.toISOString());
  });

  it('asks for no series when a listing failed or lists nothing', async () => {
    const { asked, port } = fakePort((asset) =>
      asset.symbol === 'BTC' ? gone<HourlyThresholdGroup | null>() : fresh(null),
    );

    const view = await createGetHourlyThresholdMarkets({ clock: () => AT, feeds: port })();

    expect(asked).toEqual([]);
    expect(view.markets[0]?.unavailableReasons).toEqual(['upstream-unavailable']);
    expect(view.markets[1]?.unavailableReasons).toEqual(['no-active-hour-group']);
  });

  it('asks for no series for a group with no usable side', async () => {
    const { asked, port } = fakePort((asset) =>
      asset.symbol === 'BTC'
        ? fresh<HourlyThresholdGroup | null>({
            ...group,
            rows: [],
            unusableSides: ['above-ambiguous', 'below-missing'],
          })
        : fresh(null),
    );

    const view = await createGetHourlyThresholdMarkets({ clock: () => AT, feeds: port })();
    expect(asked).toEqual([]);
    expect(view.markets[0]?.unavailableReasons).toEqual(['above-ambiguous', 'below-missing']);
    expect(view.markets[0]?.marketDataAvailable).toBe(false);
  });

  it('defaults to the service clock when given none', async () => {
    const { port } = fakePort(() => fresh(null));
    const before = Date.now();
    const view = await createGetHourlyThresholdMarkets({ feeds: port })();
    expect(new Date(view.generatedAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});
