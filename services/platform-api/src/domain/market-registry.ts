// The assets and markets this API publishes public feed data for.
//
// One registry, because every upstream is addressed per asset under a different
// provider's naming: a CoinGecko id, a Polymarket slug, a Kraken pair and its
// ticker key, and two Kalshi series. Keeping those beside each other is what makes
// a per-asset read reviewable; scattering them across adapters is how a venue
// identifier ends up guessed.
//
// The order here is the published order. v1 sorted this list by a
// policy-derived strength score; that score comes from the entry policy, which is
// explicitly not part of this capability (#211), so registry order is the order.
//
// Every identifier in this file is public venue naming, not a credential and not a
// private address. Nothing here reaches a network.

export interface MarketAsset {
  /** CoinGecko's own id for the spot snapshot. */
  readonly coinGeckoId: string;
  /** Kalshi's hourly threshold series, for the research view. */
  readonly kalshiHourlySeries: string;
  /** Kalshi's fifteen-minute up/down series. Absent where the venue lists none. */
  readonly kalshiShortSeries?: string;
  /** The Kraken trading pair used in a request. */
  readonly krakenPair: string;
  /** The key Kraken answers under, which is not always the pair it was asked for. */
  readonly krakenTickerKey: string;
  readonly name: string;
  /** Polymarket's slug fragment. Absent where the venue lists no market. */
  readonly polymarketSlug?: string;
  readonly symbol: string;
}

/**
 * The ten assets, in published order.
 *
 * Three of them carry no Polymarket slug and no fifteen-minute Kalshi series: those
 * venues simply do not list them, which is why both fields are optional rather than
 * filled with a guess.
 */
export const MARKET_ASSETS: readonly MarketAsset[] = Object.freeze([
  Object.freeze({
    coinGeckoId: 'bitcoin',
    kalshiHourlySeries: 'KXBTC',
    kalshiShortSeries: 'KXBTC15M',
    krakenPair: 'XBTUSD',
    krakenTickerKey: 'XXBTZUSD',
    name: 'Bitcoin',
    polymarketSlug: 'btc',
    symbol: 'BTC',
  }),
  Object.freeze({
    coinGeckoId: 'ethereum',
    kalshiHourlySeries: 'KXETH',
    kalshiShortSeries: 'KXETH15M',
    krakenPair: 'ETHUSD',
    krakenTickerKey: 'XETHZUSD',
    name: 'Ethereum',
    polymarketSlug: 'eth',
    symbol: 'ETH',
  }),
  Object.freeze({
    coinGeckoId: 'solana',
    kalshiHourlySeries: 'KXSOL',
    kalshiShortSeries: 'KXSOL15M',
    krakenPair: 'SOLUSD',
    krakenTickerKey: 'SOLUSD',
    name: 'Solana',
    polymarketSlug: 'sol',
    symbol: 'SOL',
  }),
  Object.freeze({
    coinGeckoId: 'ripple',
    kalshiHourlySeries: 'KXXRP',
    kalshiShortSeries: 'KXXRP15M',
    krakenPair: 'XRPUSD',
    krakenTickerKey: 'XXRPZUSD',
    name: 'XRP',
    polymarketSlug: 'xrp',
    symbol: 'XRP',
  }),
  Object.freeze({
    coinGeckoId: 'dogecoin',
    kalshiHourlySeries: 'KXDOGE',
    kalshiShortSeries: 'KXDOGE15M',
    krakenPair: 'DOGEUSD',
    krakenTickerKey: 'XDGUSD',
    name: 'Dogecoin',
    polymarketSlug: 'doge',
    symbol: 'DOGE',
  }),
  Object.freeze({
    coinGeckoId: 'binancecoin',
    kalshiHourlySeries: 'KXBNB',
    kalshiShortSeries: 'KXBNB15M',
    krakenPair: 'BNBUSD',
    krakenTickerKey: 'BNBUSD',
    name: 'BNB',
    polymarketSlug: 'bnb',
    symbol: 'BNB',
  }),
  Object.freeze({
    coinGeckoId: 'hyperliquid',
    kalshiHourlySeries: 'KXHYPE',
    kalshiShortSeries: 'KXHYPE15M',
    krakenPair: 'HYPEUSD',
    krakenTickerKey: 'HYPEUSD',
    name: 'Hyperliquid',
    polymarketSlug: 'hype',
    symbol: 'HYPE',
  }),
  Object.freeze({
    coinGeckoId: 'the-open-network',
    kalshiHourlySeries: 'KXTON',
    krakenPair: 'TONUSD',
    krakenTickerKey: 'TONUSD',
    name: 'Toncoin',
    symbol: 'TON',
  }),
  Object.freeze({
    coinGeckoId: 'near',
    kalshiHourlySeries: 'KXNEAR',
    krakenPair: 'NEARUSD',
    krakenTickerKey: 'NEARUSD',
    name: 'NEAR Protocol',
    symbol: 'NEAR',
  }),
  Object.freeze({
    coinGeckoId: 'zcash',
    kalshiHourlySeries: 'KXZEC',
    krakenPair: 'ZECUSD',
    krakenTickerKey: 'XZECZUSD',
    name: 'Zcash',
    symbol: 'ZEC',
  }),
]);

/** The assets the fifteen-minute overview covers: those both short venues list. */
export const OVERVIEW_ASSETS: readonly MarketAsset[] = Object.freeze(
  MARKET_ASSETS.filter(
    (asset) => asset.polymarketSlug !== undefined && asset.kalshiShortSeries !== undefined,
  ),
);

/** The assets the hourly threshold view covers: all of them. */
export const HOURLY_ASSETS = MARKET_ASSETS;

export const MARKET_ID_SHORT = 'crypto-15m';
export const MARKET_ID_HOURLY = 'crypto-1h';

/** Seconds in one settlement cycle of each market. */
export const SHORT_CYCLE_SECONDS = 900;
export const HOURLY_CYCLE_SECONDS = 3600;

/**
 * The epoch-second start of the quarter-hour `atMs` falls in.
 *
 * Polymarket addresses its fifteen-minute markets by this number, and the Kraken
 * candle that ends exactly at it is the settlement reference, so one definition
 * serves both and neither can drift from the other.
 */
export function shortCycleSlotSeconds(atMs: number): number {
  return Math.floor(atMs / (SHORT_CYCLE_SECONDS * 1000)) * SHORT_CYCLE_SECONDS;
}

/** How close two settlement times must be to be treated as the same window. */
export const CLOSE_ALIGNMENT_TOLERANCE_MS = 5_000;

/** Per-call upstream deadline. Short on purpose: a public read waits for nobody. */
export const UPSTREAM_TIMEOUT_MS = 4_000;

/** Upstream calls this service will have in flight at once, across all feeds. */
export const UPSTREAM_CONCURRENCY_LIMIT = 6;

/**
 * How long a last-good value may be served after a refresh failure.
 *
 * Past this the feed is unavailable and its members are absent: an old price is
 * worse than no price once nobody would act on it, and v1 kept last-good values
 * indefinitely with nothing marking them (#211, decision 5).
 */
export const FEED_MAX_STALE_MS = 300_000;

/** Bound on cache entries, so per-asset and per-slot keys cannot grow unbounded. */
export const FEED_CACHE_MAX_ENTRIES = 512;

/**
 * How long each feed's value is served without asking the upstream again.
 *
 * These are v1's own intervals. They are a politeness budget as much as a freshness
 * one: the public tiers of these providers are rate limited, and a public read
 * endpoint is an invitation to find out how hard.
 */
export const FEED_TTL_MS = Object.freeze({
  coinGeckoSpot: 60_000,
  kalshiHourlyMarkets: 60_000,
  kalshiShortMarkets: 12_000,
  krakenMinuteCandles: 10_000,
  krakenTicker: 10_000,
  krakenWeeklyCandles: 86_400_000,
  newsHeadlines: 600_000,
  polymarketBooks: 12_000,
  polymarketEvents: 12_000,
});

export type FeedName = keyof typeof FEED_TTL_MS;

/** Candle rows read for the volatility estimator, newest last. */
export const VOLATILITY_CANDLE_ROWS = 121;

/** The settlement averaging window both venues describe. */
export const SETTLEMENT_WINDOW_SECONDS = 60;

/** The floor on effective time to settlement, so a closing contract stays finite. */
export const MINIMUM_EFFECTIVE_SECONDS = 2;

/** Headlines published at most. */
export const MAX_HEADLINES = 12;

/** The reference index Kalshi settles these contracts against. */
export const HOURLY_REFERENCE_SOURCE = 'CF Benchmarks RTI 60-second simple average';

/** The reference this API uses for a fifteen-minute cycle's opening price. */
export const SHORT_REFERENCE_SOURCE = 'Kraken 1m series at cycle open';
