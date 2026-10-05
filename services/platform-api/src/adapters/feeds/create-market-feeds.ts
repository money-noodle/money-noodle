// The market feed port, assembled from the provider adapters and one cache.
//
// This is the only place that knows which provider answers which question, and the
// only place that decides what a cache key is. Everything above it sees the port
// (`domain/market-feeds.ts`): readings with a state, a fetch time and — when they are
// not fresh — a fixed reason code.
//
// Three properties worth stating, because they are what keeps a public read bounded:
//
//   * **One upstream call per cache key.** The one-minute candle series is read once
//     per asset and serves both the overview's reference price and the hourly view's
//     volatility sample, rather than twice for the same numbers.
//   * **A key that names the settlement window.** Venue quotes are keyed by the
//     quarter-hour slot and hourly listings by the hour, so a last-good value can
//     never be served across a settlement boundary: when the window turns over, the
//     key is new and a failure is `unavailable` rather than a stale prior contract.
//   * **A per-asset failure is one asset.** The map a feed returns holds the assets
//     that answered; the reading beside it carries the worst state of the calls behind
//     it, so a partial answer is labelled as one. An empty map with a fresh state
//     means the providers answered and listed nothing — which is a fact, not a fault.
//
// No scheduler, no background polling, nothing persisted, no credential. Every URL
// behind this is a public, keyless endpoint.

import type {
  CyclePriceSeries,
  FeedReading,
  Headline,
  HistoryPoint,
  HourlyThresholdGroup,
  KalshiQuote,
  MarketFeedPort,
  PolymarketQuote,
  SpotSnapshot,
} from '../../domain/market-feeds.js';
import { unavailableReading } from '../../domain/market-feeds.js';
import {
  OVERVIEW_ASSETS,
  FEED_TTL_MS,
  HOURLY_CYCLE_SECONDS,
  VOLATILITY_CANDLE_ROWS,
  shortCycleSlotSeconds,
  type MarketAsset,
} from '../../domain/market-registry.js';
import { createCoinGeckoFeed, type CoinGeckoFeed } from './coingecko-feed.js';
import { combineFeedReadings, createFeedCache, type Clock, type FeedCache } from './feed-cache.js';
import { createFeedHttpClient, type FeedHttpClient } from './feed-http-client.js';
import { createKalshiFeed, type KalshiFeed } from './kalshi-feed.js';
import {
  createKrakenFeed,
  cyclePriceSeries,
  type KrakenFeed,
  type MinuteCandle,
} from './kraken-feed.js';
import { createNewsFeed, type NewsFeed } from './news-feed.js';
import {
  createPolymarketFeed,
  withBookTops,
  type BookTop,
  type PolymarketEventQuote,
  type PolymarketFeed,
} from './polymarket-feed.js';

export interface MarketFeedsOptions {
  readonly cache?: FeedCache;
  readonly clock?: Clock;
  readonly coinGecko?: CoinGeckoFeed;
  readonly http?: FeedHttpClient;
  readonly kalshi?: KalshiFeed;
  readonly kraken?: KrakenFeed;
  readonly news?: NewsFeed;
  readonly polymarket?: PolymarketFeed;
}

/** The epoch-second start of the hour `atMs` falls in. */
const hourSlotSeconds = (atMs: number): number =>
  Math.floor(atMs / (HOURLY_CYCLE_SECONDS * 1000)) * HOURLY_CYCLE_SECONDS;

export function createMarketFeeds(options: MarketFeedsOptions = {}): MarketFeedPort {
  const clock = options.clock ?? { now: () => new Date() };
  const http = options.http ?? createFeedHttpClient();
  const cache = options.cache ?? createFeedCache({ clock });
  const coinGecko = options.coinGecko ?? createCoinGeckoFeed(http);
  const kalshi = options.kalshi ?? createKalshiFeed(http);
  const kraken = options.kraken ?? createKrakenFeed(http);
  const news = options.news ?? createNewsFeed(http);
  const polymarket = options.polymarket ?? createPolymarketFeed(http);

  /** One reading per asset, folded into one map keyed by symbol. */
  const perAsset = async <T>(
    assets: readonly MarketAsset[],
    ttlMs: number,
    key: (asset: MarketAsset) => string,
    load: (asset: MarketAsset) => Promise<T | undefined>,
    at: Date,
  ): Promise<FeedReading<ReadonlyMap<string, T>>> => {
    const readings = await Promise.all(
      assets.map(async (asset) => cache.read(key(asset), ttlMs, async () => load(asset))),
    );
    const value = new Map<string, T>();
    assets.forEach((asset, index) => {
      const reading = readings[index];
      if (reading === undefined || reading.state === 'unavailable') return;
      if (reading.value !== undefined) value.set(asset.symbol, reading.value);
    });
    return combineFeedReadings(readings, value as ReadonlyMap<string, T>, at);
  };

  /** The completed one-minute candles of one asset, read once and shared. */
  const minuteCandles = async (asset: MarketAsset): Promise<FeedReading<readonly MinuteCandle[]>> =>
    cache.read(`kraken-minute-candles:${asset.symbol}`, FEED_TTL_MS.krakenMinuteCandles, async () =>
      kraken.loadMinuteCandles(asset),
    );

  return Object.freeze({
    readCyclePrices: async (): Promise<FeedReading<ReadonlyMap<string, CyclePriceSeries>>> => {
      const at = clock.now();
      const ticker = await cache.read('kraken-ticker', FEED_TTL_MS.krakenTicker, async () =>
        kraken.loadLastTrades(OVERVIEW_ASSETS),
      );
      const candles = await Promise.all(OVERVIEW_ASSETS.map(async (asset) => minuteCandles(asset)));

      const lastTrades = ticker.state === 'unavailable' ? undefined : ticker.value;
      const series = new Map<string, CyclePriceSeries>();
      OVERVIEW_ASSETS.forEach((asset, index) => {
        const reading = candles[index];
        if (
          reading === undefined ||
          reading.state === 'unavailable' ||
          reading.value === undefined
        ) {
          return;
        }
        const entry = cyclePriceSeries(asset, reading.value, lastTrades?.get(asset.symbol), at);
        if (entry !== undefined) series.set(asset.symbol, entry);
      });

      return combineFeedReadings(
        [ticker, ...candles],
        series as ReadonlyMap<string, CyclePriceSeries>,
        at,
      );
    },

    readHeadlines: async (): Promise<FeedReading<readonly Headline[]>> =>
      cache.read('news-headlines', FEED_TTL_MS.newsHeadlines, async () => news.loadHeadlines()),

    readHourlyThresholds: async (
      asset: MarketAsset,
    ): Promise<FeedReading<HourlyThresholdGroup | null>> => {
      const at = clock.now();
      return cache.read(
        `kalshi-hourly:${asset.symbol}:${hourSlotSeconds(at.getTime())}`,
        FEED_TTL_MS.kalshiHourlyMarkets,
        async () => kalshi.loadHourlyGroup(asset, at),
      );
    },

    readKalshiQuotes: async (): Promise<FeedReading<ReadonlyMap<string, KalshiQuote>>> => {
      const at = clock.now();
      const slot = shortCycleSlotSeconds(at.getTime());
      return perAsset(
        OVERVIEW_ASSETS,
        FEED_TTL_MS.kalshiShortMarkets,
        (asset) => `kalshi-short:${asset.symbol}:${slot}`,
        async (asset) => kalshi.loadShortQuote(asset, at),
        at,
      );
    },

    readLongHistory: async (): Promise<
      FeedReading<ReadonlyMap<string, readonly HistoryPoint[]>>
    > => {
      const at = clock.now();
      return perAsset(
        OVERVIEW_ASSETS,
        FEED_TTL_MS.krakenWeeklyCandles,
        (asset) => `kraken-weekly:${asset.symbol}`,
        async (asset) => kraken.loadLongHistory(asset),
        at,
      );
    },

    readMinuteCloses: async (asset: MarketAsset): Promise<FeedReading<readonly number[]>> => {
      const reading = await minuteCandles(asset);
      const candles = reading.value;
      if (candles === undefined) {
        return unavailableReading(
          reading.reason ?? 'upstream-unavailable',
          reading.fetchedAt,
          reading.ageSeconds,
        );
      }
      const closes = Object.freeze(
        candles.slice(-VOLATILITY_CANDLE_ROWS).map((candle) => candle.close),
      );
      return Object.freeze({ ...reading, value: closes });
    },

    readPolymarketQuotes: async (): Promise<FeedReading<ReadonlyMap<string, PolymarketQuote>>> => {
      const at = clock.now();
      const slot = shortCycleSlotSeconds(at.getTime());

      const events = await Promise.all(
        OVERVIEW_ASSETS.map(async (asset) =>
          cache.read(
            `polymarket-event:${asset.symbol}:${slot}`,
            FEED_TTL_MS.polymarketEvents,
            async () => polymarket.loadEventQuote(asset.polymarketSlug ?? asset.symbol, slot),
          ),
        ),
      );

      const found: { readonly entry: PolymarketEventQuote; readonly symbol: string }[] = [];
      OVERVIEW_ASSETS.forEach((asset, index) => {
        const reading = events[index];
        if (reading === undefined || reading.state === 'unavailable') return;
        if (reading.value !== undefined) found.push({ entry: reading.value, symbol: asset.symbol });
      });

      // The books are one batch for every token the events named, so its key names the
      // slot: a new window asks about different tokens and must not read the old answer.
      const tokenIds = found.flatMap((item) => [...item.entry.tokenIds]);
      const books = await cache.read(
        `polymarket-books:${slot}`,
        FEED_TTL_MS.polymarketBooks,
        async () => polymarket.loadBookTops(tokenIds),
      );
      const tops: ReadonlyMap<string, BookTop> =
        books.state === 'unavailable' || books.value === undefined ? new Map() : books.value;

      const quotes = new Map<string, PolymarketQuote>();
      for (const item of found) quotes.set(item.symbol, withBookTops(item.entry, tops));

      // A failed book batch degrades the feed without emptying it: the probabilities are
      // the event call's, and they are still current.
      return combineFeedReadings(
        [...events, books],
        quotes as ReadonlyMap<string, PolymarketQuote>,
        at,
      );
    },

    readSpotSnapshots: async (): Promise<FeedReading<ReadonlyMap<string, SpotSnapshot>>> =>
      cache.read('coingecko-spot', FEED_TTL_MS.coinGeckoSpot, async () =>
        coinGecko.loadSpotSnapshots(OVERVIEW_ASSETS, clock.now()),
      ),
  });
}
