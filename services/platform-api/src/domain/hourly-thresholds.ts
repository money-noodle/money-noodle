// The hourly threshold research view, as this API publishes it.
//
// One venue's "above or below a strike" contracts for the hour now trading, each with
// the probability a zero-drift diffusion gives it from recent realized volatility.
// Pure assembly, like the overview: readings in, record out.
//
// Observation only. The probability beside a quote is arithmetic over public data,
// not advice and not a position: no entry policy, no fee model, no sizing, nothing
// that decides anything. The difference between the model and the asking price is
// published because it is the obvious subtraction and hiding it would be pretending.
//
// Differences from v1, both deliberate:
//
//   * **Completed minutes only.** The current price and the volatility sample come
//     from finished one-minute candles. v1 used the candle still forming, so its
//     "current price" moved within the minute and its newest return described a
//     partial one (#211, decision 3).
//   * **Last good value on failure, then unavailable.** v1 kept nothing here: a
//     failed listing erased the asset for a minute. This serves the previous listing
//     marked stale with its age, and drops it once it is older than the maximum
//     (#211, decision 5).

import type { FeedReading, HourlyThresholdGroup } from './market-feeds.js';
import { probabilityAboveStrike, realizedVolatilityPerSecond } from './market-math.js';
import {
  HOURLY_REFERENCE_SOURCE,
  MARKET_ID_HOURLY,
  SETTLEMENT_WINDOW_SECONDS,
  type MarketAsset,
} from './market-registry.js';
import { contractSettlementIdentity, type SettlementPriceMethod } from './rules-fingerprint.js';
import type { PublishedFeedState } from './market-overview.js';

/** Why an asset has no complete pair to publish. */
export const HOURLY_UNAVAILABLE_REASONS = Object.freeze([
  'above-ambiguous',
  'above-missing',
  'below-ambiguous',
  'below-missing',
  'no-active-hour-group',
  'upstream-invalid',
  'upstream-rate-limited',
  'upstream-timeout',
  'upstream-unavailable',
] as const);

export type HourlyUnavailableReason = (typeof HOURLY_UNAVAILABLE_REASONS)[number];

export interface PublishedThresholdCandidate {
  readonly askNo?: number;
  readonly askYes?: number;
  readonly bidNo?: number;
  readonly bidYes?: number;
  readonly direction: 'ABOVE' | 'BELOW';
  readonly displaySide: 'DOWN' | 'UP';
  readonly label: string;
  readonly marketUrl: string;
  readonly modelProbabilityYes?: number;
  readonly modelUnavailableReason?: 'volatility-unavailable';
  readonly modelMinusAsk?: number;
  readonly relation: 'greater-than' | 'less-than';
  readonly rulesFingerprint: string;
  readonly settlementPriceMethod: SettlementPriceMethod;
  readonly strike: number;
  readonly ticker: string;
}

export interface PublishedHourlyMarket {
  readonly candidates: readonly PublishedThresholdCandidate[];
  readonly closesAt?: string;
  readonly currentPrice?: number;
  /** How current this asset's listing is. Each asset is read separately. */
  readonly listing: PublishedFeedState;
  readonly marketDataAvailable: boolean;
  readonly name: string;
  readonly openAt?: string;
  /** How current this asset's price series is. Absent when it was not needed. */
  readonly spot?: PublishedFeedState;
  readonly symbol: string;
  readonly unavailableReasons: readonly HourlyUnavailableReason[];
  readonly volatilityPerSecond?: number;
  readonly volatilitySamples?: number;
}

export interface PublishedHourlyThresholds {
  readonly capability: {
    readonly live: false;
    readonly marketData: true;
    readonly paper: false;
  };
  /** When this record was assembled, on this service's clock. */
  readonly generatedAt: string;
  readonly marketDataVersion: 'kalshi-hourly-threshold-read-v1';
  readonly marketId: typeof MARKET_ID_HOURLY;
  readonly markets: readonly PublishedHourlyMarket[];
  readonly modelVersion: 'strike-threshold-zero-drift-v1';
  readonly providerId: 'kalshi';
  readonly referenceSource: typeof HOURLY_REFERENCE_SOURCE;
}

/** One asset's two readings: its listing, and the prices the model needs. */
export interface HourlyAssetReadings {
  readonly asset: MarketAsset;
  readonly listing: FeedReading<HourlyThresholdGroup | null>;
  /** Absent when no candidate survived, because the prices are then not fetched. */
  readonly minuteCloses?: FeedReading<readonly number[]>;
}

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

const publishedState = (reading: FeedReading<unknown>): PublishedFeedState =>
  Object.freeze({
    ageSeconds: reading.ageSeconds,
    ...(reading.state === 'unavailable' && reading.value === undefined
      ? {}
      : { fetchedAt: reading.fetchedAt.toISOString() }),
    ...(reading.reason === undefined ? {} : { reason: reading.reason }),
    state: reading.state,
  });

/** The venue page for a series. The venue publishes no per-contract page. */
export function hourlyMarketUrl(series: string): string {
  return `https://kalshi.com/markets/${series.toLowerCase()}`;
}

/** Where the rules text of one contract can be read. */
export function hourlyRulesSource(ticker: string): string {
  return `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`;
}

/**
 * The reasons an asset's pair is incomplete.
 *
 * An upstream failure contributes its own code; a listing that answered but held no
 * usable hour contributes `no-active-hour-group`; a listing that held one side
 * contributes that side's reason and the other side is still published, because half
 * a pair is still a quote someone may want to read.
 */
function unavailableReasons(
  listing: FeedReading<HourlyThresholdGroup | null>,
  group: HourlyThresholdGroup | undefined,
): readonly HourlyUnavailableReason[] {
  if (group === undefined) {
    const reason: HourlyUnavailableReason = listing.reason ?? 'no-active-hour-group';
    return Object.freeze([reason]);
  }
  return Object.freeze([...group.unusableSides]);
}

function publishedCandidate(
  asset: MarketAsset,
  group: HourlyThresholdGroup,
  row: HourlyThresholdGroup['rows'][number],
  model: { readonly currentPrice: number; readonly volatilityPerSecond: number } | undefined,
  at: Date,
): PublishedThresholdCandidate {
  const secondsRemaining = Math.max(0, (group.closesAt.getTime() - at.getTime()) / 1000);
  const above =
    model === undefined
      ? undefined
      : probabilityAboveStrike({
          currentPrice: model.currentPrice,
          secondsRemaining,
          strike: row.strike,
          volatilityPerSecond: model.volatilityPerSecond,
        });
  const probability =
    above === undefined ? undefined : row.direction === 'ABOVE' ? above : 1 - above;

  const marketUrl = hourlyMarketUrl(asset.kalshiHourlySeries);
  const identity = contractSettlementIdentity({
    closesAt: group.closesAt,
    contractId: row.ticker,
    marketUrl,
    referenceSource: HOURLY_REFERENCE_SOURCE,
    referenceValue: row.strike,
    rulesSource: hourlyRulesSource(row.ticker),
    rulesText: row.rulesText,
    settlementWindowSeconds: SETTLEMENT_WINDOW_SECONDS,
  });

  return Object.freeze({
    ...optional('askNo', row.askNo),
    ...optional('askYes', row.askYes),
    ...optional('bidNo', row.bidNo),
    ...optional('bidYes', row.bidYes),
    direction: row.direction,
    displaySide: row.direction === 'ABOVE' ? ('UP' as const) : ('DOWN' as const),
    label: `${row.direction === 'ABOVE' ? 'Above' : 'Below'} ${row.strike}`,
    marketUrl,
    ...optional('modelProbabilityYes', probability),
    ...(probability === undefined
      ? { modelUnavailableReason: 'volatility-unavailable' as const }
      : {}),
    ...optional(
      'modelMinusAsk',
      probability === undefined || row.askYes === undefined ? undefined : probability - row.askYes,
    ),
    relation: row.direction === 'ABOVE' ? ('greater-than' as const) : ('less-than' as const),
    rulesFingerprint: identity.fingerprint,
    settlementPriceMethod: identity.settlementPriceMethod,
    strike: row.strike,
    ticker: row.ticker,
  });
}

/** The published research view, assembled from one reading per asset. */
export function assembleHourlyThresholds(
  readings: readonly HourlyAssetReadings[],
  at: Date,
): PublishedHourlyThresholds {
  const markets = readings.map((entry) => {
    const group =
      entry.listing.state === 'unavailable' ? undefined : (entry.listing.value ?? undefined);
    const reasons = unavailableReasons(entry.listing, group ?? undefined);
    const closes =
      entry.minuteCloses === undefined || entry.minuteCloses.state === 'unavailable'
        ? undefined
        : entry.minuteCloses.value;
    const volatility = closes === undefined ? undefined : realizedVolatilityPerSecond(closes);
    const currentPrice = closes?.at(-1);
    const model =
      volatility === undefined || currentPrice === undefined
        ? undefined
        : { currentPrice, volatilityPerSecond: volatility.perSecond };

    const candidates =
      group === undefined
        ? []
        : group.rows.map((row) => publishedCandidate(entry.asset, group, row, model, at));

    return Object.freeze({
      candidates: Object.freeze(candidates),
      ...optional('closesAt', group?.closesAt.toISOString()),
      ...optional('currentPrice', currentPrice),
      listing: publishedState(entry.listing),
      // A complete, unambiguous pair: one contract above a strike and one below one.
      marketDataAvailable: group !== undefined && reasons.length === 0 && candidates.length === 2,
      name: entry.asset.name,
      ...optional('openAt', group?.openAt.toISOString()),
      ...optional(
        'spot',
        entry.minuteCloses === undefined ? undefined : publishedState(entry.minuteCloses),
      ),
      symbol: entry.asset.symbol,
      unavailableReasons: reasons,
      ...optional('volatilityPerSecond', volatility?.perSecond),
      ...optional('volatilitySamples', volatility?.samples),
    });
  });

  return Object.freeze({
    capability: Object.freeze({
      live: false as const,
      marketData: true as const,
      paper: false as const,
    }),
    generatedAt: at.toISOString(),
    marketDataVersion: 'kalshi-hourly-threshold-read-v1' as const,
    marketId: MARKET_ID_HOURLY,
    markets: Object.freeze(markets),
    modelVersion: 'strike-threshold-zero-drift-v1' as const,
    providerId: 'kalshi' as const,
    referenceSource: HOURLY_REFERENCE_SOURCE,
  });
}
