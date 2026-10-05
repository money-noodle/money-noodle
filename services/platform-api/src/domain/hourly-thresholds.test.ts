// The hourly assembly: what is published when a listing is complete, partial, or gone.
//
// Every degradation on this view lives inside a success, so these cases are the
// contract: an asset with no group, an asset whose listing failed, a side the venue
// listed twice, and a pair with no usable price series all have to produce a published
// entry that says so without inventing a number.

import { describe, expect, it } from 'vitest';

import {
  assembleHourlyThresholds,
  hourlyMarketUrl,
  hourlyRulesSource,
  type HourlyAssetReadings,
} from './hourly-thresholds.js';
import type { FeedReading, HourlyThresholdGroup, HourlyThresholdRow } from './market-feeds.js';
import { HOURLY_ASSETS, HOURLY_REFERENCE_SOURCE } from './market-registry.js';
import { fresh, gone, stale } from './market-overview.test.js';

export const HOURLY_AT = new Date('2026-10-05T18:30:00.000Z');
const OPEN_AT = new Date('2026-10-05T18:00:00.000Z');
const CLOSES_AT = new Date('2026-10-05T19:00:00.000Z');

const RULES =
  'If the settlement price is above the strike, the market resolves Yes. The settlement ' +
  'price is the simple average of the prices collected over the final 60 seconds.';

const aboveRow: HourlyThresholdRow = Object.freeze({
  askYes: 0.55,
  bidYes: 0.53,
  direction: 'ABOVE',
  rulesText: RULES,
  strike: 64_000,
  ticker: 'KXBTC-26OCT0519-T64000',
});

const belowRow: HourlyThresholdRow = Object.freeze({
  askNo: 0.49,
  bidNo: 0.47,
  direction: 'BELOW',
  rulesText: RULES.replace('above', 'below'),
  strike: 63_500,
  ticker: 'KXBTC-26OCT0519-T63500',
});

/** A complete pair for the hour now trading. */
const completeGroup: HourlyThresholdGroup = Object.freeze({
  closesAt: CLOSES_AT,
  openAt: OPEN_AT,
  rows: Object.freeze([aboveRow, belowRow]),
  unusableSides: Object.freeze([]),
});

/** Closes that move enough for the estimator to have something to say. */
const closes = Object.freeze(
  Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 63_800 : 63_800 * Math.exp(0.0012))),
);

function readings(
  overrides: Partial<Record<string, FeedReading<HourlyThresholdGroup | null>>> = {},
  withCloses = true,
): readonly HourlyAssetReadings[] {
  return HOURLY_ASSETS.map((asset) => {
    const listing =
      overrides[asset.symbol] ??
      (asset.symbol === 'BTC' ? fresh<HourlyThresholdGroup | null>(completeGroup) : fresh(null));
    const group = listing.state === 'unavailable' ? undefined : listing.value;
    const needsPrices = group !== undefined && group !== null && group.rows.length > 0;
    return {
      asset,
      listing,
      ...(needsPrices && withCloses ? { minuteCloses: fresh(closes) } : {}),
    };
  });
}

export const syntheticHourlyThresholds = () => assembleHourlyThresholds(readings(), HOURLY_AT);

describe('hourlyMarketUrl and hourlyRulesSource', () => {
  it('address the public series page and the public rules endpoint', () => {
    expect(hourlyMarketUrl('KXBTC')).toBe('https://kalshi.com/markets/kxbtc');
    expect(hourlyRulesSource('KXBTC-26OCT0519-T64000')).toBe(
      'https://api.elections.kalshi.com/trade-api/v2/markets/KXBTC-26OCT0519-T64000',
    );
  });
});

describe('assembleHourlyThresholds', () => {
  it('publishes one entry per registry asset with the constant labels', () => {
    const view = syntheticHourlyThresholds();
    expect(view.markets.map((market) => market.symbol)).toEqual(
      HOURLY_ASSETS.map((asset) => asset.symbol),
    );
    expect(view.capability).toEqual({ live: false, marketData: true, paper: false });
    expect(view.marketId).toBe('crypto-1h');
    expect(view.modelVersion).toBe('strike-threshold-zero-drift-v1');
    expect(view.marketDataVersion).toBe('kalshi-hourly-threshold-read-v1');
    expect(view.providerId).toBe('kalshi');
    expect(view.referenceSource).toBe(HOURLY_REFERENCE_SOURCE);
    expect(view.generatedAt).toBe(HOURLY_AT.toISOString());
  });

  it('prices a complete pair from the last completed minute', () => {
    const [bitcoin] = syntheticHourlyThresholds().markets;
    expect(bitcoin?.marketDataAvailable).toBe(true);
    expect(bitcoin?.unavailableReasons).toEqual([]);
    expect(bitcoin?.openAt).toBe(OPEN_AT.toISOString());
    expect(bitcoin?.closesAt).toBe(CLOSES_AT.toISOString());
    // The newest completed close, not a candle still forming.
    expect(bitcoin?.currentPrice).toBe(closes.at(-1));
    expect(bitcoin?.volatilitySamples).toBe(39);
    expect(bitcoin?.candidates).toHaveLength(2);
  });

  it('describes each candidate with its own strike and its own probability', () => {
    const [bitcoin] = syntheticHourlyThresholds().markets;
    const [above, below] = bitcoin?.candidates ?? [];

    expect(above?.direction).toBe('ABOVE');
    expect(above?.displaySide).toBe('UP');
    expect(above?.relation).toBe('greater-than');
    expect(above?.label).toBe('Above 64000');
    expect(above?.settlementPriceMethod).toBe('simple-average');
    expect(above?.rulesFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(above?.modelMinusAsk).toBeCloseTo((above?.modelProbabilityYes ?? 0) - 0.55, 12);

    expect(below?.direction).toBe('BELOW');
    expect(below?.displaySide).toBe('DOWN');
    expect(below?.relation).toBe('less-than');
    // Different strikes, so the two are not complements of one another.
    expect(below?.strike).not.toBe(above?.strike);
    expect(below?.rulesFingerprint).not.toBe(above?.rulesFingerprint);
    // No ask on the yes side here, so there is nothing to subtract from.
    expect(below?.modelMinusAsk).toBeUndefined();
  });

  it('publishes a pair without model numbers when the price series is unusable', () => {
    const view = assembleHourlyThresholds(readings({}, false), HOURLY_AT);
    const [bitcoin] = view.markets;
    expect(bitcoin?.marketDataAvailable).toBe(true);
    expect(bitcoin?.currentPrice).toBeUndefined();
    expect(bitcoin?.volatilityPerSecond).toBeUndefined();
    expect(bitcoin?.spot).toBeUndefined();
    for (const candidate of bitcoin?.candidates ?? []) {
      expect(candidate.modelProbabilityYes).toBeUndefined();
      expect(candidate.modelUnavailableReason).toBe('volatility-unavailable');
      expect(candidate.modelMinusAsk).toBeUndefined();
    }
  });

  it('names the venue listing nothing for the hour', () => {
    const [, ethereum] = syntheticHourlyThresholds().markets;
    expect(ethereum?.marketDataAvailable).toBe(false);
    expect(ethereum?.unavailableReasons).toEqual(['no-active-hour-group']);
    expect(ethereum?.candidates).toEqual([]);
    expect(ethereum?.listing.state).toBe('fresh');
  });

  it('reports a failed listing with its fixed code and nothing else', () => {
    const view = assembleHourlyThresholds(
      readings({ BTC: gone<HourlyThresholdGroup | null>() }),
      HOURLY_AT,
    );
    const [bitcoin] = view.markets;
    expect(bitcoin?.unavailableReasons).toEqual(['upstream-unavailable']);
    expect(bitcoin?.listing).toEqual({
      ageSeconds: 0,
      reason: 'upstream-unavailable',
      state: 'unavailable',
    });
    // Nothing from the upstream's own message, host or status can appear: the whole
    // published record is one code from a fixed set.
    expect(JSON.stringify(view)).not.toMatch(/kalshi\.com\/trade-api|ECONN|timeout of/u);
  });

  it('publishes the usable side of an ambiguous listing and names the other', () => {
    const partial: HourlyThresholdGroup = Object.freeze({
      closesAt: CLOSES_AT,
      openAt: OPEN_AT,
      rows: Object.freeze([aboveRow]),
      unusableSides: Object.freeze(['below-ambiguous'] as const),
    });
    const view = assembleHourlyThresholds(
      readings({ BTC: fresh<HourlyThresholdGroup | null>(partial) }),
      HOURLY_AT,
    );
    const [bitcoin] = view.markets;
    expect(bitcoin?.marketDataAvailable).toBe(false);
    expect(bitcoin?.unavailableReasons).toEqual(['below-ambiguous']);
    expect(bitcoin?.candidates).toHaveLength(1);
    expect(bitcoin?.candidates[0]?.direction).toBe('ABOVE');
  });

  it('serves a stale listing labelled with its age', () => {
    const view = assembleHourlyThresholds(
      readings({ BTC: stale<HourlyThresholdGroup | null>(completeGroup, 90) }),
      HOURLY_AT,
    );
    const [bitcoin] = view.markets;
    expect(bitcoin?.listing.state).toBe('stale');
    expect(bitcoin?.listing.ageSeconds).toBe(90);
    expect(bitcoin?.listing.reason).toBe('upstream-timeout');
    expect(bitcoin?.marketDataAvailable).toBe(true);
  });
});
