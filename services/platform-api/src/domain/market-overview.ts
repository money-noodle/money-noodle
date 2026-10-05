// The market overview, as this API publishes it.
//
// Pure assembly: feed readings in, one published record out, no I/O and no clock of
// its own beyond the instant the caller passes. Every judgement the record carries is
// made here, which is what makes it testable without a network.
//
// What this is not. v1's own payload mixed public feed data with a forecasting
// model, an entry-policy signal, execution fill estimates and a trading-policy
// manifest. None of that is here (#211, decision 1): those are model output and move
// with the engine. What remains is market data plus the basis arithmetic, which is
// public data divided by public data.
//
// Three honesty rules, each a deliberate difference from v1:
//
//   * **No placeholder quote.** Where v1 published a fabricated 50/50 market with
//     zero liquidity for an asset the venue had not listed, this omits the venue.
//     A missing quote is missing.
//   * **No zero for absent.** v1 defaulted missing provider numbers to zero, so a
//     real zero and an absent field were indistinguishable. Here an absent upstream
//     field is an absent published field.
//   * **Freshness is on the wire.** Each feed states fresh, stale or unavailable,
//     when its value was obtained, and why it is not fresh.

import type {
  FeedFailureCode,
  FeedReading,
  FeedState,
  HistoryPoint,
  KalshiQuote,
  PolymarketQuote,
  SpotSnapshot,
  CyclePriceSeries,
  Headline,
} from './market-feeds.js';
import {
  boundedBasisProbability,
  effectiveSecondsRemaining,
  realizedVolatilityPerSecond,
  standardNormalCdf,
  standardNormalQuantile,
} from './market-math.js';
import {
  CLOSE_ALIGNMENT_TOLERANCE_MS,
  OVERVIEW_ASSETS,
  MARKET_ID_SHORT,
  MAX_HEADLINES,
  SHORT_REFERENCE_SOURCE,
} from './market-registry.js';

/** How current one feed is, as published. */
export interface PublishedFeedState {
  readonly ageSeconds: number;
  readonly fetchedAt?: string;
  readonly reason?: FeedFailureCode;
  readonly state: FeedState;
}

export interface PublishedChartPoint {
  readonly price: number;
  readonly time: string;
}

export interface PublishedSpot {
  readonly change1hPercent?: number;
  readonly change7dPercent?: number;
  readonly change24hPercent?: number;
  readonly change30dPercent?: number;
  readonly change1yPercent?: number;
  readonly chart: readonly PublishedChartPoint[];
  readonly high24h?: number;
  readonly iconUrl?: string;
  readonly low24h?: number;
  readonly price?: number;
  readonly volume24h?: number;
}

export interface PublishedVenueQuote {
  readonly askDown?: number;
  readonly askUp?: number;
  readonly bidDown?: number;
  readonly bidUp?: number;
  readonly closesAt: string;
  readonly contractId: string;
  readonly floorStrike?: number;
  readonly liquidityUsd?: number;
  readonly live: boolean;
  readonly probabilityDown?: number;
  readonly probabilityUp?: number;
  readonly ticker?: string;
  readonly url: string;
  readonly venue: 'kalshi' | 'polymarket';
  readonly volumeContracts?: number;
  readonly volumeUsd?: number;
}

export interface PublishedContractBasis {
  readonly basisPercent: number;
  readonly currentPrice: number;
  readonly impliedVolatilityPerSecond?: number;
  readonly probabilityUp: number;
  readonly referencePrice: number;
  readonly referenceSource: string;
  readonly secondsRemaining: number;
  readonly standardDeviationPercent: number;
  readonly volatilityPerSecond: number;
  readonly volatilityRatio?: number;
  readonly volatilitySamples: number;
  readonly zScore: number;
}

export interface PublishedMarketAsset {
  readonly basis?: PublishedContractBasis;
  readonly kalshi?: PublishedVenueQuote;
  readonly longHistory: readonly PublishedChartPoint[];
  readonly name: string;
  readonly polymarket?: PublishedVenueQuote;
  readonly spot?: PublishedSpot;
  readonly symbol: string;
  readonly venueDisagreement?: number;
  readonly venueProbabilityUp?: number;
}

export interface PublishedHeadline {
  readonly link?: string;
  readonly publishedAt?: string;
  readonly title: string;
}

export interface PublishedMarketOverview {
  readonly assets: readonly PublishedMarketAsset[];
  readonly feeds: {
    readonly kalshiQuotes: PublishedFeedState;
    readonly longHistory: PublishedFeedState;
    readonly news: PublishedFeedState;
    readonly polymarketQuotes: PublishedFeedState;
    readonly referencePrices: PublishedFeedState;
    readonly spot: PublishedFeedState;
  };
  /** When this record was assembled, on this service's clock. Never a source time. */
  readonly generatedAt: string;
  readonly headlines: readonly PublishedHeadline[];
  readonly marketId: typeof MARKET_ID_SHORT;
}

export interface MarketOverviewFeedReadings {
  readonly cyclePrices: FeedReading<ReadonlyMap<string, CyclePriceSeries>>;
  readonly headlines: FeedReading<readonly Headline[]>;
  readonly kalshiQuotes: FeedReading<ReadonlyMap<string, KalshiQuote>>;
  readonly longHistory: FeedReading<ReadonlyMap<string, readonly HistoryPoint[]>>;
  readonly polymarketQuotes: FeedReading<ReadonlyMap<string, PolymarketQuote>>;
  readonly spot: FeedReading<ReadonlyMap<string, SpotSnapshot>>;
}

/** The weights v1 combined the two venues with, kept so the figure is comparable. */
export const VENUE_WEIGHTS = Object.freeze({ kalshi: 0.25, polymarket: 0.75 });

const published = (reading: FeedReading<unknown>): PublishedFeedState =>
  Object.freeze({
    ageSeconds: reading.ageSeconds,
    ...(reading.state === 'unavailable' && reading.value === undefined
      ? {}
      : { fetchedAt: reading.fetchedAt.toISOString() }),
    ...(reading.reason === undefined ? {} : { reason: reading.reason }),
    state: reading.state,
  });

/** The value of a reading that has one, or `undefined` for an unavailable feed. */
const valueOf = <T>(reading: FeedReading<T>): T | undefined =>
  reading.state === 'unavailable' ? undefined : reading.value;

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

function publishedSpot(snapshot: SpotSnapshot): PublishedSpot {
  return Object.freeze({
    ...optional('change1hPercent', snapshot.change1hPercent),
    ...optional('change7dPercent', snapshot.change7dPercent),
    ...optional('change24hPercent', snapshot.change24hPercent),
    ...optional('change30dPercent', snapshot.change30dPercent),
    ...optional('change1yPercent', snapshot.change1yPercent),
    chart: Object.freeze(
      snapshot.chart.map((point) =>
        Object.freeze({ price: point.price, time: point.time.toISOString() }),
      ),
    ),
    ...optional('high24h', snapshot.high24h),
    ...optional('iconUrl', snapshot.iconUrl),
    ...optional('low24h', snapshot.low24h),
    ...optional('price', snapshot.price),
    ...optional('volume24h', snapshot.volume24h),
  });
}

function publishedQuote(
  venue: 'kalshi' | 'polymarket',
  quote: KalshiQuote | PolymarketQuote,
): PublishedVenueQuote {
  const kalshi = venue === 'kalshi' ? (quote as KalshiQuote) : undefined;
  return Object.freeze({
    ...optional('askDown', quote.askDown),
    ...optional('askUp', quote.askUp),
    ...optional('bidDown', quote.bidDown),
    ...optional('bidUp', quote.bidUp),
    closesAt: quote.closesAt.toISOString(),
    contractId: quote.contractId,
    ...optional('floorStrike', kalshi?.floorStrike),
    ...optional('liquidityUsd', quote.liquidityUsd),
    live: quote.live,
    ...optional('probabilityDown', quote.probabilityDown),
    ...optional('probabilityUp', quote.probabilityUp),
    ...optional('ticker', kalshi?.ticker),
    url: quote.url,
    venue,
    ...optional('volumeContracts', kalshi?.volumeContracts),
    ...optional('volumeUsd', (quote as PolymarketQuote).volumeUsd),
  });
}

/**
 * Whether a Kalshi quote describes the same settlement window as the Polymarket one.
 *
 * Both venues are asked for "the current fifteen-minute market", and both can answer
 * with a contract from a window that has already closed. Publishing the pair anyway
 * would invite a comparison of two different questions, so the Kalshi side is
 * published only when it settles within five seconds of the Polymarket side and that
 * settlement is still ahead.
 */
export function quotesAligned(
  polymarket: PolymarketQuote | undefined,
  kalshi: KalshiQuote | undefined,
  at: Date,
): boolean {
  if (polymarket === undefined || kalshi === undefined) return false;
  if (kalshi.closesAt.getTime() <= at.getTime()) return false;
  return (
    Math.abs(kalshi.closesAt.getTime() - polymarket.closesAt.getTime()) <=
    CLOSE_ALIGNMENT_TOLERANCE_MS
  );
}

/**
 * The cross-venue probability, from the quotes in this response only.
 *
 * v1 smoothed this over a three-minute window of samples it had recorded in process
 * memory, which made the figure depend on which instance answered and on how recently
 * that instance had been asked. This service keeps no feed history, so the published
 * figure is the current quotes weighted the same way — comparable in meaning, and the
 * same for every instance at the same instant.
 */
export function crossVenueProbability(
  polymarket: PolymarketQuote | undefined,
  kalshi: KalshiQuote | undefined,
  aligned: boolean,
): number | undefined {
  const poly = polymarket?.live === true ? polymarket.probabilityUp : undefined;
  const kal = aligned && kalshi?.live === true ? kalshi.probabilityUp : undefined;
  if (poly !== undefined && kal !== undefined) {
    return VENUE_WEIGHTS.polymarket * poly + VENUE_WEIGHTS.kalshi * kal;
  }
  return poly ?? kal;
}

interface BasisInput {
  readonly closesAt: Date;
  readonly currentPrice: number;
  readonly referencePrice: number;
  readonly referenceSource: string;
  readonly series?: CyclePriceSeries;
  readonly venueProbabilityUp?: number;
}

/**
 * Distance to the settlement reference, in the units the contract settles on.
 *
 * Public arithmetic end to end: how far spot has moved from the cycle's opening
 * reference, how much movement the recent minutes imply, and the probability those
 * two give for closing above the reference. The probability is bounded to v1's range
 * because the estimator is a sample of a hundred-odd minutes and its tails are not
 * worth the precision they suggest.
 */
export function contractBasis(input: BasisInput, at: Date): PublishedContractBasis | undefined {
  const { currentPrice, referencePrice } = input;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return undefined;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return undefined;

  const volatility = realizedVolatilityPerSecond(input.series?.closes ?? []);
  if (volatility === undefined) return undefined;

  const secondsRemaining = Math.max(0, (input.closesAt.getTime() - at.getTime()) / 1000);
  const effective = effectiveSecondsRemaining(secondsRemaining);
  const standardDeviation = volatility.perSecond * Math.sqrt(effective);
  if (!Number.isFinite(standardDeviation) || standardDeviation <= 0) return undefined;

  const zScore = Math.log(currentPrice / referencePrice) / standardDeviation;
  const impliedVolatility =
    input.venueProbabilityUp === undefined
      ? undefined
      : impliedVolatilityPerSecond(
          currentPrice,
          referencePrice,
          input.venueProbabilityUp,
          effective,
        );

  return Object.freeze({
    basisPercent: (currentPrice / referencePrice - 1) * 100,
    currentPrice,
    ...optional('impliedVolatilityPerSecond', impliedVolatility),
    probabilityUp: boundedBasisProbability(standardNormalCdf(zScore)),
    referencePrice,
    referenceSource: input.referenceSource,
    secondsRemaining,
    standardDeviationPercent: standardDeviation * 100,
    volatilityPerSecond: volatility.perSecond,
    ...optional(
      'volatilityRatio',
      impliedVolatility === undefined ? undefined : volatility.perSecond / impliedVolatility,
    ),
    volatilitySamples: volatility.samples,
    zScore,
  });
}

/** The volatility the venues' own probability implies, read back through the model. */
function impliedVolatilityPerSecond(
  currentPrice: number,
  referencePrice: number,
  venueProbabilityUp: number,
  effectiveSeconds: number,
): number | undefined {
  const quantile = standardNormalQuantile(venueProbabilityUp);
  if (quantile === undefined || quantile === 0) return undefined;
  const implied =
    Math.log(currentPrice / referencePrice) / (quantile * Math.sqrt(effectiveSeconds));
  return Number.isFinite(implied) && implied > 0 ? implied : undefined;
}

/** The published overview, assembled from one set of feed readings. */
export function assembleMarketOverview(
  readings: MarketOverviewFeedReadings,
  at: Date,
): PublishedMarketOverview {
  const spot = valueOf(readings.spot);
  const polymarketQuotes = valueOf(readings.polymarketQuotes);
  const kalshiQuotes = valueOf(readings.kalshiQuotes);
  const cyclePrices = valueOf(readings.cyclePrices);
  const longHistory = valueOf(readings.longHistory);
  const headlines = valueOf(readings.headlines) ?? [];

  const assets = OVERVIEW_ASSETS.map((asset) => {
    const snapshot = spot?.get(asset.symbol);
    const polymarket = polymarketQuotes?.get(asset.symbol);
    const kalshiCandidate = kalshiQuotes?.get(asset.symbol);
    const aligned = quotesAligned(polymarket, kalshiCandidate, at);
    const kalshi = aligned ? kalshiCandidate : undefined;
    const series = cyclePrices?.get(asset.symbol);
    const venueProbabilityUp = crossVenueProbability(polymarket, kalshiCandidate, aligned);

    // The reference is the cycle's opening price where the exchange series has it, and
    // the contract's own floor strike otherwise: both are the level the contract
    // settles against, and the second is the venue's own statement of it.
    const referencePrice = series?.referencePrice ?? kalshi?.floorStrike;
    const referenceSource =
      series?.referenceSource ?? (referencePrice === undefined ? undefined : 'Kalshi floor strike');
    const currentPrice = series?.currentPrice ?? snapshot?.price;
    const closesAt = polymarket?.closesAt ?? kalshi?.closesAt;

    const basis =
      referencePrice === undefined ||
      referenceSource === undefined ||
      currentPrice === undefined ||
      closesAt === undefined
        ? undefined
        : contractBasis(
            {
              closesAt,
              currentPrice,
              referencePrice,
              referenceSource,
              ...optional('series', series),
              ...optional('venueProbabilityUp', venueProbabilityUp),
            },
            at,
          );

    const disagreement =
      aligned &&
      polymarket?.probabilityUp !== undefined &&
      kalshiCandidate?.probabilityUp !== undefined
        ? Math.abs(polymarket.probabilityUp - kalshiCandidate.probabilityUp)
        : undefined;

    return Object.freeze({
      ...optional('basis', basis),
      ...optional('kalshi', kalshi === undefined ? undefined : publishedQuote('kalshi', kalshi)),
      longHistory: Object.freeze(
        (longHistory?.get(asset.symbol) ?? []).map((point) =>
          Object.freeze({ price: point.price, time: point.time.toISOString() }),
        ),
      ),
      name: asset.name,
      ...optional(
        'polymarket',
        polymarket === undefined ? undefined : publishedQuote('polymarket', polymarket),
      ),
      ...optional('spot', snapshot === undefined ? undefined : publishedSpot(snapshot)),
      symbol: asset.symbol,
      ...optional('venueDisagreement', disagreement),
      ...optional('venueProbabilityUp', venueProbabilityUp),
    });
  });

  return Object.freeze({
    assets: Object.freeze(assets),
    feeds: Object.freeze({
      kalshiQuotes: published(readings.kalshiQuotes),
      longHistory: published(readings.longHistory),
      news: published(readings.headlines),
      polymarketQuotes: published(readings.polymarketQuotes),
      referencePrices: published(readings.cyclePrices),
      spot: published(readings.spot),
    }),
    generatedAt: at.toISOString(),
    headlines: Object.freeze(
      headlines.slice(0, MAX_HEADLINES).map((headline) =>
        Object.freeze({
          ...optional('link', headline.link),
          ...optional('publishedAt', headline.publishedAt?.toISOString()),
          title: headline.title,
        }),
      ),
    ),
    marketId: MARKET_ID_SHORT,
  });
}

export { SHORT_REFERENCE_SOURCE };
