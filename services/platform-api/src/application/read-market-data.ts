// The two public market-data reads.
//
// Both are the same shape: ask the feed port for everything the view needs, in
// parallel, then hand the readings to a pure assembly in the domain. Neither decides
// anything about freshness or validity — the port states that, and the assembly
// publishes it.
//
// Neither read can fail as a whole. Every feed answers with a state rather than a
// throw, so a total upstream outage produces a two hundred whose every feed says
// `unavailable` and whose numbers are absent. That is the point of the shape: a caller
// of a public read learns what is known and what is not, instead of a status code that
// could mean anything.
//
// There is no forecast, no entry signal and no fill estimate here (#211, decision 1).
// What is published is market data, plus arithmetic over market data whose inputs are
// published beside the result.

import {
  assembleHourlyThresholds,
  type HourlyAssetReadings,
  type PublishedHourlyThresholds,
} from '../domain/hourly-thresholds.js';
import { assembleMarketOverview, type PublishedMarketOverview } from '../domain/market-overview.js';
import type { MarketFeedPort } from '../domain/market-feeds.js';
import { HOURLY_ASSETS } from '../domain/market-registry.js';

export interface MarketDataDependencies {
  /** This service's clock. Injected so a test fixes the instant a view describes. */
  readonly clock?: () => Date;
  readonly feeds: MarketFeedPort;
}

export type GetMarketOverview = () => Promise<PublishedMarketOverview>;

/**
 * The market overview: spot, both venues' current quotes, the basis, and headlines.
 *
 * The six feeds are read concurrently and the view's instant is taken once they have
 * all answered, so the countdown to settlement and the alignment check are measured
 * from the same moment the record claims to describe.
 */
export function createGetMarketOverview(dependencies: MarketDataDependencies): GetMarketOverview {
  const now = dependencies.clock ?? (() => new Date());
  return async () => {
    const { feeds } = dependencies;
    const [cyclePrices, headlines, kalshiQuotes, longHistory, polymarketQuotes, spot] =
      await Promise.all([
        feeds.readCyclePrices(),
        feeds.readHeadlines(),
        feeds.readKalshiQuotes(),
        feeds.readLongHistory(),
        feeds.readPolymarketQuotes(),
        feeds.readSpotSnapshots(),
      ]);

    return assembleMarketOverview(
      { cyclePrices, headlines, kalshiQuotes, longHistory, polymarketQuotes, spot },
      now(),
    );
  };
}

export type GetHourlyThresholdMarkets = () => Promise<PublishedHourlyThresholds>;

/**
 * The hourly threshold research view: one listing per asset, with the model beside it.
 *
 * The price series is read only for an asset whose listing produced a candidate. An
 * asset with nothing to price needs no price, and a public read should not ask an
 * exchange for a series it is not going to use.
 */
export function createGetHourlyThresholdMarkets(
  dependencies: MarketDataDependencies,
): GetHourlyThresholdMarkets {
  const now = dependencies.clock ?? (() => new Date());
  return async () => {
    const { feeds } = dependencies;
    const listings = await Promise.all(
      HOURLY_ASSETS.map(async (asset) => ({
        asset,
        listing: await feeds.readHourlyThresholds(asset),
      })),
    );

    const readings: readonly HourlyAssetReadings[] = await Promise.all(
      listings.map(async (entry): Promise<HourlyAssetReadings> => {
        const group = entry.listing.state === 'unavailable' ? undefined : entry.listing.value;
        if (group === undefined || group === null || group.rows.length === 0) return entry;
        return { ...entry, minuteCloses: await feeds.readMinuteCloses(entry.asset) };
      }),
    );

    return assembleHourlyThresholds(readings, now());
  };
}
