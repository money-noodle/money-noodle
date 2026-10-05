// The overview assembly, against readings a test can state outright.
//
// No network, no clock and no provider shape: the port's vocabulary is the input, so
// the cases that matter — an unavailable feed, a quote from the wrong window, a
// provider that sent no number — are as easy to write as the happy one. That is the
// whole reason the assembly is a pure function in the domain.
//
// The fixtures here are exported because the HTTP tests publish them through the real
// contract validator, which proves the thing neither layer can prove alone: that what
// this assembly produces is what the published contract says.

import { describe, expect, it } from 'vitest';

import type {
  CyclePriceSeries,
  FeedReading,
  Headline,
  HistoryPoint,
  KalshiQuote,
  PolymarketQuote,
  SpotSnapshot,
} from './market-feeds.js';
import {
  assembleMarketOverview,
  contractBasis,
  crossVenueProbability,
  quotesAligned,
  VENUE_WEIGHTS,
  type MarketOverviewFeedReadings,
} from './market-overview.js';
import { MAX_HEADLINES, OVERVIEW_ASSETS, SHORT_REFERENCE_SOURCE } from './market-registry.js';

export const OVERVIEW_AT = new Date('2026-10-05T18:07:30.000Z');
const FETCHED_AT = new Date('2026-10-05T18:07:28.000Z');
const CLOSES_AT = new Date('2026-10-05T18:15:00.000Z');

export const fresh = <T>(value: T, fetchedAt = FETCHED_AT): FeedReading<T> =>
  Object.freeze({ ageSeconds: 2, fetchedAt, state: 'fresh' as const, value });

export const stale = <T>(value: T, ageSeconds = 120): FeedReading<T> =>
  Object.freeze({
    ageSeconds,
    fetchedAt: new Date(OVERVIEW_AT.getTime() - ageSeconds * 1000),
    reason: 'upstream-timeout' as const,
    state: 'stale' as const,
    value,
  });

export const gone = <T>(): FeedReading<T> =>
  Object.freeze({
    ageSeconds: 0,
    fetchedAt: OVERVIEW_AT,
    reason: 'upstream-unavailable' as const,
    state: 'unavailable' as const,
  });

/** Closes whose log returns alternate, so the estimator has something to measure. */
const closes = Array.from({ length: 30 }, (_, index) =>
  index % 2 === 0 ? 64_000 : 64_000 * Math.exp(0.0004),
);

const spotSnapshot: SpotSnapshot = Object.freeze({
  change24hPercent: 1.25,
  chart: Object.freeze([
    { price: 63_000, time: new Date('2026-09-28T18:00:00.000Z') },
    { price: 64_000, time: new Date('2026-10-05T18:00:00.000Z') },
  ]),
  high24h: 64_500,
  iconUrl: 'https://assets.example.com/btc.png',
  low24h: 62_800,
  price: 64_100,
  symbol: 'BTC',
  volume24h: 1_234_000_000,
});

const polymarketQuote: PolymarketQuote = Object.freeze({
  askUp: 0.54,
  bidUp: 0.52,
  closesAt: CLOSES_AT,
  contractId: '0xcondition',
  liquidityUsd: 90_000,
  live: true,
  probabilityDown: 0.47,
  probabilityUp: 0.53,
  url: 'https://polymarket.com/event/btc-updown-15m-1791309600',
  volumeUsd: 450_000,
});

const kalshiQuote: KalshiQuote = Object.freeze({
  askDown: 0.52,
  askUp: 0.5,
  bidDown: 0.48,
  bidUp: 0.48,
  closesAt: new Date(CLOSES_AT.getTime() + 2_000),
  contractId: 'KXBTC15M-26OCT0518',
  floorStrike: 64_000,
  liquidityUsd: 12_000,
  live: true,
  probabilityUp: 0.49,
  ticker: 'KXBTC15M-26OCT0518',
  url: 'https://kalshi.com/markets/kxbtc15m',
  volumeContracts: 800,
});

const cycleSeries: CyclePriceSeries = Object.freeze({
  closes: Object.freeze(closes),
  currentPrice: 64_120,
  referencePrice: 64_000,
  referenceSource: SHORT_REFERENCE_SOURCE,
  slotSeconds: 1_791_309_600,
  symbol: 'BTC',
});

const history: readonly HistoryPoint[] = Object.freeze([
  { price: 61_000, time: new Date('2026-09-21T00:00:00.000Z') },
  { price: 63_500, time: new Date('2026-09-28T00:00:00.000Z') },
]);

const headlines: readonly Headline[] = Object.freeze(
  Array.from({ length: MAX_HEADLINES + 2 }, (_, index) => ({
    link: `https://news.example.com/story-${index}`,
    publishedAt: new Date('2026-10-05T17:00:00.000Z'),
    title: `Story ${index}`,
  })),
);

/** Every feed fresh, with one asset fully covered. */
export function syntheticOverviewReadings(): MarketOverviewFeedReadings {
  return {
    cyclePrices: fresh(new Map([['BTC', cycleSeries]])),
    headlines: fresh(headlines),
    kalshiQuotes: fresh(new Map([['BTC', kalshiQuote]])),
    longHistory: fresh(new Map([['BTC', history]])),
    polymarketQuotes: fresh(new Map([['BTC', polymarketQuote]])),
    spot: fresh(new Map([['BTC', spotSnapshot]])),
  };
}

export const syntheticOverview = () =>
  assembleMarketOverview(syntheticOverviewReadings(), OVERVIEW_AT);

describe('quotesAligned', () => {
  it('accepts two closes inside the tolerance', () => {
    expect(quotesAligned(polymarketQuote, kalshiQuote, OVERVIEW_AT)).toBe(true);
  });

  it('refuses a contract from another window, or a settled one', () => {
    const drifted = { ...kalshiQuote, closesAt: new Date(CLOSES_AT.getTime() + 60_000) };
    const settled = { ...kalshiQuote, closesAt: new Date(OVERVIEW_AT.getTime() - 1_000) };
    expect(quotesAligned(polymarketQuote, drifted, OVERVIEW_AT)).toBe(false);
    expect(quotesAligned(polymarketQuote, settled, OVERVIEW_AT)).toBe(false);
    expect(quotesAligned(undefined, kalshiQuote, OVERVIEW_AT)).toBe(false);
    expect(quotesAligned(polymarketQuote, undefined, OVERVIEW_AT)).toBe(false);
  });
});

describe('crossVenueProbability', () => {
  it('weights the two venues when both are live and aligned', () => {
    expect(crossVenueProbability(polymarketQuote, kalshiQuote, true)).toBeCloseTo(
      VENUE_WEIGHTS.polymarket * 0.53 + VENUE_WEIGHTS.kalshi * 0.49,
      12,
    );
  });

  it('falls back to whichever venue is usable, and to nothing when neither is', () => {
    expect(crossVenueProbability(polymarketQuote, kalshiQuote, false)).toBe(0.53);
    expect(crossVenueProbability(undefined, kalshiQuote, true)).toBe(0.49);
    expect(
      crossVenueProbability({ ...polymarketQuote, live: false }, undefined, false),
    ).toBeUndefined();
  });
});

describe('contractBasis', () => {
  const input = {
    closesAt: CLOSES_AT,
    currentPrice: 64_120,
    referencePrice: 64_000,
    referenceSource: SHORT_REFERENCE_SOURCE,
    series: cycleSeries,
  };

  it('publishes every input beside the figure derived from it', () => {
    const basis = contractBasis(input, OVERVIEW_AT);
    expect(basis?.basisPercent).toBeCloseTo((64_120 / 64_000 - 1) * 100, 12);
    expect(basis?.secondsRemaining).toBe(450);
    expect(basis?.volatilitySamples).toBe(29);
    expect(basis?.zScore).toBeCloseTo(
      Math.log(64_120 / 64_000) / ((basis?.standardDeviationPercent ?? 0) / 100),
      9,
    );
    // These closes move by four basis points a minute, so twenty above the reference
    // is many standard deviations out and the figure sits on its upper bound. That is
    // the bound doing its job: the estimator is a sample of half an hour of minutes
    // and its tails do not deserve the precision they would otherwise claim.
    expect(basis?.probabilityUp).toBe(0.95);
    expect(basis?.impliedVolatilityPerSecond).toBeUndefined();
  });

  it('reads an implied volatility back out of a venue probability', () => {
    const basis = contractBasis({ ...input, venueProbabilityUp: 0.53 }, OVERVIEW_AT);
    expect(basis?.impliedVolatilityPerSecond).toBeGreaterThan(0);
    expect(basis?.volatilityRatio).toBeCloseTo(
      (basis?.volatilityPerSecond ?? 0) / (basis?.impliedVolatilityPerSecond ?? 1),
      12,
    );
  });

  it('has no implied figure from a probability the model cannot invert', () => {
    // Exactly one half inverts to zero standard deviations, which implies no
    // volatility at all rather than an enormous one.
    const flat = contractBasis({ ...input, venueProbabilityUp: 0.5 }, OVERVIEW_AT);
    expect(flat?.impliedVolatilityPerSecond).toBeUndefined();
    const impossible = contractBasis({ ...input, venueProbabilityUp: 1 }, OVERVIEW_AT);
    expect(impossible?.impliedVolatilityPerSecond).toBeUndefined();
  });

  it('refuses a price or reference that is not one, and a sample too small', () => {
    expect(contractBasis({ ...input, currentPrice: 0 }, OVERVIEW_AT)).toBeUndefined();
    expect(contractBasis({ ...input, referencePrice: Number.NaN }, OVERVIEW_AT)).toBeUndefined();
    expect(
      contractBasis(
        { ...input, series: { ...cycleSeries, closes: [64_000, 64_100] } },
        OVERVIEW_AT,
      ),
    ).toBeUndefined();
  });
});

describe('assembleMarketOverview', () => {
  it('publishes one entry per registry asset, in registry order', () => {
    const overview = syntheticOverview();
    expect(overview.assets.map((asset) => asset.symbol)).toEqual(
      OVERVIEW_ASSETS.map((asset) => asset.symbol),
    );
    expect(overview.generatedAt).toBe(OVERVIEW_AT.toISOString());
    expect(overview.marketId).toBe('crypto-15m');
  });

  it('carries the covered asset in full', () => {
    const [bitcoin] = syntheticOverview().assets;
    expect(bitcoin?.spot?.price).toBe(64_100);
    expect(bitcoin?.spot?.chart).toHaveLength(2);
    expect(bitcoin?.polymarket?.venue).toBe('polymarket');
    expect(bitcoin?.kalshi?.ticker).toBe('KXBTC15M-26OCT0518');
    expect(bitcoin?.longHistory).toHaveLength(2);
    expect(bitcoin?.basis?.referenceSource).toBe(SHORT_REFERENCE_SOURCE);
    expect(bitcoin?.venueDisagreement).toBeCloseTo(0.04, 12);
  });

  it('publishes nothing for an asset no venue listed', () => {
    const [, ethereum] = syntheticOverview().assets;
    // Not a fifty-fifty placeholder with zero liquidity, which is what v1 served.
    expect(ethereum?.polymarket).toBeUndefined();
    expect(ethereum?.kalshi).toBeUndefined();
    expect(ethereum?.spot).toBeUndefined();
    expect(ethereum?.basis).toBeUndefined();
    expect(ethereum?.longHistory).toEqual([]);
  });

  it('omits the other venue when its contract is from another window', () => {
    const readings = syntheticOverviewReadings();
    const overview = assembleMarketOverview(
      {
        ...readings,
        kalshiQuotes: fresh(
          new Map([['BTC', { ...kalshiQuote, closesAt: new Date(CLOSES_AT.getTime() + 60_000) }]]),
        ),
      },
      OVERVIEW_AT,
    );
    const [bitcoin] = overview.assets;
    expect(bitcoin?.kalshi).toBeUndefined();
    expect(bitcoin?.venueDisagreement).toBeUndefined();
    // The remaining venue still answers, so the combined probability is its own.
    expect(bitcoin?.venueProbabilityUp).toBe(0.53);
  });

  it('states a stale feed as stale, with its age and reason', () => {
    const readings = syntheticOverviewReadings();
    const overview = assembleMarketOverview(
      { ...readings, spot: stale(new Map([['BTC', spotSnapshot]])) },
      OVERVIEW_AT,
    );
    expect(overview.feeds.spot).toEqual({
      ageSeconds: 120,
      fetchedAt: new Date(OVERVIEW_AT.getTime() - 120_000).toISOString(),
      reason: 'upstream-timeout',
      state: 'stale',
    });
    // The value is still published: a two-minute-old spot price labelled as such is
    // more use than no price, which is the point of serving the last good one.
    expect(overview.assets[0]?.spot?.price).toBe(64_100);
  });

  it('leaves the members of an unavailable feed absent rather than zero', () => {
    const overview = assembleMarketOverview(
      {
        cyclePrices: gone(),
        headlines: gone(),
        kalshiQuotes: gone(),
        longHistory: gone(),
        polymarketQuotes: gone(),
        spot: gone(),
      },
      OVERVIEW_AT,
    );

    expect(overview.feeds.spot).toEqual({
      ageSeconds: 0,
      reason: 'upstream-unavailable',
      state: 'unavailable',
    });
    expect(overview.headlines).toEqual([]);
    for (const asset of overview.assets) {
      expect(asset.spot).toBeUndefined();
      expect(asset.polymarket).toBeUndefined();
      expect(asset.basis).toBeUndefined();
      expect(asset.longHistory).toEqual([]);
    }
  });

  it('falls back to the venue strike when the exchange series has no reference', () => {
    const readings = syntheticOverviewReadings();
    const overview = assembleMarketOverview({ ...readings, cyclePrices: gone() }, OVERVIEW_AT);
    const [bitcoin] = overview.assets;
    // Without a price series there is no volatility sample either, so there is no
    // basis to publish: the reference alone is not enough.
    expect(bitcoin?.basis).toBeUndefined();
    expect(bitcoin?.polymarket?.probabilityUp).toBe(0.53);
  });

  it('caps the headline list', () => {
    expect(syntheticOverview().headlines).toHaveLength(MAX_HEADLINES);
    expect(syntheticOverview().headlines[0]).toEqual({
      link: 'https://news.example.com/story-0',
      publishedAt: '2026-10-05T17:00:00.000Z',
      title: 'Story 0',
    });
  });
});
