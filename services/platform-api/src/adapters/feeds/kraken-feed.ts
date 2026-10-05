// Kraken: the exchange series the reference price and the volatility come from.
//
// Three public, keyless reads: the last trade for a set of pairs, one-minute candles
// per asset, and weekly candles per asset. No key, no signature, no account.
//
// The rule that matters here is the completed-minute one (#211, decision 3). Kraken
// returns the minute that is still forming as the last row of a one-minute series.
// v1 kept it, so its newest "close" was a partial minute that moved as the minute
// filled, and the newest log return in its volatility sample described part of a
// minute rather than one. This adapter drops that row before anything reads it, so
// every close published or estimated from describes a minute that finished.

import type { CyclePriceSeries, HistoryPoint } from '../../domain/market-feeds.js';
import {
  SHORT_REFERENCE_SOURCE,
  VOLATILITY_CANDLE_ROWS,
  shortCycleSlotSeconds,
  type MarketAsset,
} from '../../domain/market-registry.js';
import { FeedFailure } from './feed-failure.js';
import type { FeedHttpClient } from './feed-http-client.js';
import {
  asArray,
  assertNoUpstreamErrors,
  asRecord,
  optionalNumber,
  optionalPositiveNumber,
} from './upstream-values.js';

const TICKER_URL = 'https://api.kraken.com/0/public/Ticker';
const OHLC_URL = 'https://api.kraken.com/0/public/OHLC';

export interface MinuteCandle {
  readonly close: number;
  /** Candle start, epoch seconds, on the exchange's clock. */
  readonly startSeconds: number;
}

/** The candle rows of the first result series, which Kraken keys by its own pair name. */
function candleRows(payload: unknown): readonly unknown[] {
  const envelope = assertNoUpstreamErrors(payload);
  const result = asRecord(envelope.result);
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'last' && Array.isArray(value)) return value;
  }
  throw new FeedFailure('upstream-invalid');
}

/**
 * Completed one-minute candles, oldest first.
 *
 * The final row is dropped unconditionally rather than compared against a clock: the
 * exchange's own clock decides which minute is forming, and a comparison against this
 * service's clock would be wrong exactly when the two drift.
 */
export function readCompletedMinuteCandles(payload: unknown): readonly MinuteCandle[] {
  const rows = candleRows(payload);
  const completed = rows.slice(0, -1);
  const candles: MinuteCandle[] = [];
  for (const row of completed) {
    const fields = asArray(row);
    const startSeconds = optionalNumber(fields[0]);
    const close = optionalPositiveNumber(fields[4]);
    // A row that is not a candle is skipped rather than failing the series: the
    // estimator is defined over whatever closes survive, and one unreadable minute
    // makes one return span two minutes rather than making the feed unavailable.
    if (startSeconds === undefined || close === undefined) continue;
    candles.push(Object.freeze({ close, startSeconds }));
  }
  return Object.freeze(candles);
}

/** Weekly closes, as a price history. */
export function readWeeklyHistory(payload: unknown): readonly HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (const row of candleRows(payload)) {
    const fields = asArray(row);
    const startSeconds = optionalNumber(fields[0]);
    const close = optionalPositiveNumber(fields[4]);
    if (startSeconds === undefined || close === undefined) continue;
    points.push(Object.freeze({ price: close, time: new Date(startSeconds * 1000) }));
  }
  return Object.freeze(points);
}

/** Last trade price per asset, for the assets the response carried one for. */
export function readLastTrades(
  payload: unknown,
  assets: readonly MarketAsset[],
): ReadonlyMap<string, number> {
  const envelope = assertNoUpstreamErrors(payload);
  const result = asRecord(envelope.result);
  const prices = new Map<string, number>();

  for (const asset of assets) {
    // Kraken answers under its own key for a pair, which is not always the key it was
    // asked with. The declared key is tried first and a containing key second, which
    // is what the venue's own naming forces.
    const direct = result[asset.krakenTickerKey];
    const fallbackKey = Object.keys(result).find((key) =>
      key.includes(asset.krakenTickerKey.slice(0, 4)),
    );
    const entry = direct ?? (fallbackKey === undefined ? undefined : result[fallbackKey]);
    if (entry === undefined) continue;
    const close = asArray(asRecord(entry).c);
    const price = optionalPositiveNumber(close[0]);
    if (price !== undefined) prices.set(asset.symbol, price);
  }

  return prices;
}

export interface KrakenFeed {
  /** Weekly closes per asset. */
  readonly loadLongHistory: (asset: MarketAsset) => Promise<readonly HistoryPoint[]>;
  /** Completed one-minute candles per asset, for the cycle reference. */
  readonly loadMinuteCandles: (asset: MarketAsset) => Promise<readonly MinuteCandle[]>;
  /** Last trades for a set of assets, in one call. */
  readonly loadLastTrades: (assets: readonly MarketAsset[]) => Promise<ReadonlyMap<string, number>>;
}

export function createKrakenFeed(client: FeedHttpClient): KrakenFeed {
  return Object.freeze({
    loadLastTrades: async (assets: readonly MarketAsset[]) => {
      const pairs = assets.map((asset) => asset.krakenPair).join(',');
      return readLastTrades(await client.getJson(`${TICKER_URL}?pair=${pairs}`), assets);
    },
    loadLongHistory: async (asset: MarketAsset) =>
      readWeeklyHistory(
        await client.getJson(`${OHLC_URL}?pair=${asset.krakenPair}&interval=10080`),
      ),
    loadMinuteCandles: async (asset: MarketAsset) =>
      readCompletedMinuteCandles(
        await client.getJson(`${OHLC_URL}?pair=${asset.krakenPair}&interval=1`),
      ),
  });
}

/**
 * The cycle's reference and current price for one asset.
 *
 * The reference is the close of the minute that ended exactly as the cycle opened,
 * which is the level the contract settles against. Without that candle there is no
 * reference and the asset contributes nothing: a nearby minute is a different number.
 */
export function cyclePriceSeries(
  asset: MarketAsset,
  candles: readonly MinuteCandle[],
  lastTrade: number | undefined,
  at: Date,
): CyclePriceSeries | undefined {
  const slotSeconds = shortCycleSlotSeconds(at.getTime());
  const reference = candles.find((candle) => candle.startSeconds === slotSeconds - 60);
  const closes = candles.slice(-VOLATILITY_CANDLE_ROWS).map((candle) => candle.close);
  const newest = closes.at(-1);
  const currentPrice = lastTrade ?? newest;

  if (reference === undefined || currentPrice === undefined) return undefined;

  return Object.freeze({
    closes: Object.freeze(closes),
    currentPrice,
    referencePrice: reference.close,
    referenceSource: SHORT_REFERENCE_SOURCE,
    slotSeconds,
    symbol: asset.symbol,
  });
}
