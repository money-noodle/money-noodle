// What the API may ask a public market feed for, and what a feed may say back.
//
// One port per provider capability, so the thing an adapter implements is the
// question this service needs answered rather than a provider's whole surface. The
// adapters live behind these and are the only code that knows a hostname (#211,
// ADR-0012's layering, `docs/architecture/overview.md`).
//
// Every read is a read. No port here can place an order, hold a credential, or
// write anything: these are public, keyless endpoints, and a capability that needed
// a key is out of scope by decision rather than by omission.
//
// The freshness vocabulary is the other half of this file, and it is deliberately
// new. v1 served a last-good value indefinitely with nothing on the wire to say so,
// and its one cache flag was true on almost every response. Here every feed value
// arrives wrapped in the state it is in, the time it was obtained, and — when it is
// not fresh — a fixed reason code. The numbers are unchanged by this; what changes
// is that a caller can tell a current price from a five-minute-old one.

import type { MarketAsset } from './market-registry.js';

/**
 * How current a feed's value is.
 *
 * `stale` is a successful read of an older value: the refresh failed and the
 * previous value is still inside its maximum age. `unavailable` means there is
 * nothing to publish — either no value was ever obtained, or the last one has aged
 * out — and the members it would have filled are absent rather than zero.
 */
export type FeedState = 'fresh' | 'stale' | 'unavailable';

/**
 * Why a feed is not fresh, in the only vocabulary a public response gets.
 *
 * Fixed codes, chosen so that none of them can carry a host, a URL, a status line
 * or an upstream's error text — all of which v1 passed through to callers
 * (SECURITY.md). What a code says is what this service is prepared to say publicly;
 * the detail stays in the adapter that saw it.
 */
export const FEED_FAILURE_CODES = Object.freeze([
  'upstream-invalid',
  'upstream-rate-limited',
  'upstream-timeout',
  'upstream-unavailable',
] as const);

export type FeedFailureCode = (typeof FEED_FAILURE_CODES)[number];

/** A feed's value together with how current it is. */
export interface FeedReading<T> {
  /** Seconds since the value was obtained. Zero for a value fetched just now. */
  readonly ageSeconds: number;
  /** When this value was obtained from the upstream. Never a source time: these providers publish none. */
  readonly fetchedAt: Date;
  /** Absent when the value aged out or was never obtained. */
  readonly reason?: FeedFailureCode;
  readonly state: FeedState;
  /** Absent exactly when `state` is `unavailable`. */
  readonly value?: T;
}

/** A single spot snapshot, as the markets provider reports it. */
export interface SpotSnapshot {
  readonly change1hPercent?: number;
  readonly change7dPercent?: number;
  readonly change24hPercent?: number;
  readonly change30dPercent?: number;
  readonly change1yPercent?: number;
  /** Seven-day sparkline. Times are fetch-relative estimates, not provider times. */
  readonly chart: readonly { readonly price: number; readonly time: Date }[];
  readonly high24h?: number;
  readonly iconUrl?: string;
  readonly low24h?: number;
  readonly price?: number;
  readonly symbol: string;
  readonly volume24h?: number;
}

/** One point of a longer price history. */
export interface HistoryPoint {
  readonly price: number;
  readonly time: Date;
}

/**
 * The reference and current price of one asset for the current cycle.
 *
 * `closes` are completed one-minute closes, newest last. The candle still forming is
 * dropped before anything reads this (#211, decision 3), which is why an estimate
 * taken from it describes minutes that actually happened.
 */
export interface CyclePriceSeries {
  readonly closes: readonly number[];
  readonly currentPrice: number;
  readonly referencePrice: number;
  readonly referenceSource: string;
  readonly slotSeconds: number;
  readonly symbol: string;
}

/** A quote on a binary market, prices as a fraction of one dollar. */
export interface BinaryQuote {
  readonly askDown?: number;
  readonly askUp?: number;
  readonly bidDown?: number;
  readonly bidUp?: number;
  readonly closesAt: Date;
  readonly contractId: string;
  readonly live: boolean;
  readonly probabilityDown?: number;
  readonly probabilityUp?: number;
  readonly url: string;
}

/** A Polymarket fifteen-minute up/down quote. */
export interface PolymarketQuote extends BinaryQuote {
  readonly liquidityUsd?: number;
  readonly volumeUsd?: number;
}

/** A Kalshi fifteen-minute up/down quote. */
export interface KalshiQuote extends BinaryQuote {
  readonly floorStrike?: number;
  readonly liquidityUsd?: number;
  readonly ticker: string;
  readonly volumeContracts?: number;
}

/** One headline, already sanitized to plain text. */
export interface Headline {
  readonly link?: string;
  readonly publishedAt?: Date;
  readonly title: string;
}

/** One row of a Kalshi hourly threshold listing, already classified. */
export interface HourlyThresholdRow {
  readonly askNo?: number;
  readonly askYes?: number;
  readonly bidNo?: number;
  readonly bidYes?: number;
  readonly direction: 'ABOVE' | 'BELOW';
  readonly rulesText: string;
  readonly strike: number;
  readonly ticker: string;
}

/** The hourly group one asset is currently trading, with its classified rows. */
export interface HourlyThresholdGroup {
  readonly closesAt: Date;
  readonly openAt: Date;
  readonly rows: readonly HourlyThresholdRow[];
  /** Sides the venue listed zero or more than one row for. */
  readonly unusableSides: readonly (
    'above-ambiguous' | 'above-missing' | 'below-ambiguous' | 'below-missing'
  )[];
}

/**
 * The feeds the market-data reads depend on.
 *
 * Each method answers for one call to one provider and returns a reading rather than
 * a bare value, so freshness is part of the answer and cannot be lost on the way up.
 * None of them throws for an upstream failure: a failure is a reading whose state
 * says so. A thrown error from here is a defect in this service.
 */
export interface MarketFeedPort {
  /** Hourly threshold rows for one asset, for the research view. */
  readonly readHourlyThresholds: (
    asset: MarketAsset,
  ) => Promise<FeedReading<HourlyThresholdGroup | null>>;
  /** Fifteen-minute Kalshi quotes, keyed by symbol. */
  readonly readKalshiQuotes: () => Promise<FeedReading<ReadonlyMap<string, KalshiQuote>>>;
  /** Headlines, newest first as the publisher ordered them. */
  readonly readHeadlines: () => Promise<FeedReading<readonly Headline[]>>;
  /** Weekly price history, keyed by symbol. */
  readonly readLongHistory: () => Promise<
    FeedReading<ReadonlyMap<string, readonly HistoryPoint[]>>
  >;
  /** Fifteen-minute Polymarket quotes, keyed by symbol. */
  readonly readPolymarketQuotes: () => Promise<FeedReading<ReadonlyMap<string, PolymarketQuote>>>;
  /**
   * Reference and current prices for the current cycle, keyed by symbol.
   *
   * Used by the overview. The hourly view reads its own completed-minute closes
   * through `readMinuteCloses`, because it needs them per asset and for ten assets.
   */
  readonly readCyclePrices: () => Promise<FeedReading<ReadonlyMap<string, CyclePriceSeries>>>;
  /** Completed one-minute closes for one asset, newest last. */
  readonly readMinuteCloses: (asset: MarketAsset) => Promise<FeedReading<readonly number[]>>;
  /** Spot snapshots, keyed by symbol. */
  readonly readSpotSnapshots: () => Promise<FeedReading<ReadonlyMap<string, SpotSnapshot>>>;
}

/** A reading that carries no value, for a feed that has nothing to publish. */
export function unavailableReading<T>(
  reason: FeedFailureCode,
  fetchedAt: Date,
  ageSeconds = 0,
): FeedReading<T> {
  return Object.freeze({ ageSeconds, fetchedAt, reason, state: 'unavailable' as const });
}
