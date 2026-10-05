// What the guards refuse.
//
// Each case below is a response that is almost this contract: a future schema version, a
// record that is not from the durable source, a market response missing one feed's
// freshness, an hourly response claiming a capability this site has no business showing.
// All of them are refused whole, because half-rendering an answer this site does not
// recognise is how a figure ends up on screen with no idea what it means.

import { describe, expect, it } from 'vitest';

import {
  syntheticHourlyThresholds,
  syntheticMarketOverview,
  syntheticPaperBudget,
  syntheticPaperPerformance,
  syntheticPaperPerformanceSummary,
} from '../../presentation/synthetic-records.test';
import {
  isHourlyThresholdMarkets,
  isMarketOverview,
  isPaperBudget,
  isPaperPerformance,
  isPaperPerformanceSummary,
} from './validate-dashboard-responses';

const guards = [
  ['market overview', isMarketOverview, syntheticMarketOverview()],
  ['hourly thresholds', isHourlyThresholdMarkets, syntheticHourlyThresholds()],
  ['paper budget', isPaperBudget, syntheticPaperBudget()],
  ['paper summary', isPaperPerformanceSummary, syntheticPaperPerformanceSummary()],
  ['paper record', isPaperPerformance, syntheticPaperPerformance()],
] as const;

describe('every guard', () => {
  for (const [name, guard, valid] of guards) {
    it(`accepts a ${name} and refuses what is not one`, () => {
      expect(guard(valid)).toBe(true);
      // A future major version is refused rather than half-rendered.
      expect(guard({ ...valid, schemaVersion: '2' })).toBe(false);
      expect(guard({ ...valid, requestId: 'not a request id!' })).toBe(false);
      for (const notAnObject of [undefined, null, 'a string', 42, [valid]]) {
        expect(guard(notAnObject)).toBe(false);
      }
    });
  }
});

describe('isPaperBudget', () => {
  const budget = syntheticPaperBudget();

  it('needs the durable source and the balances that are the record', () => {
    expect(isPaperBudget({ ...budget, durable: false })).toBe(false);
    expect(isPaperBudget({ ...budget, equityCents: 'lots' })).toBe(false);
    expect(isPaperBudget({ ...budget, startingCents: Number.NaN })).toBe(false);
    expect(isPaperBudget({ ...budget, running: 'yes' })).toBe(false);
    expect(isPaperBudget({ ...budget, sourceUpdatedAt: 'sometime' })).toBe(false);
    expect(isPaperBudget({ ...budget, recentExecutions: undefined })).toBe(false);
  });

  it('accepts a present record with no executions beside it', () => {
    expect(isPaperBudget({ ...budget, recentExecutions: [] })).toBe(true);
  });
});

describe('isPaperPerformanceSummary and isPaperPerformance', () => {
  it('need a paper record, and refuse any other mode', () => {
    const summary = syntheticPaperPerformanceSummary();
    expect(
      isPaperPerformanceSummary({
        ...summary,
        paperRecord: { ...summary.paperRecord, mode: 'live' },
      }),
    ).toBe(false);
    const record = syntheticPaperPerformance();
    expect(
      isPaperPerformance({ ...record, paperRecord: { ...record.paperRecord, mode: 'funded' } }),
    ).toBe(false);
    expect(isPaperPerformance({ ...record, forecasts: undefined })).toBe(false);
    expect(isPaperPerformance({ ...record, paperEpochs: 'none' })).toBe(false);
  });
});

describe('isMarketOverview', () => {
  const overview = syntheticMarketOverview();

  it('needs every feed to state its own freshness', () => {
    const { spot, ...withoutSpot } = overview.feeds;
    expect(spot.state).toBe('fresh');
    expect(isMarketOverview({ ...overview, feeds: withoutSpot })).toBe(false);
    expect(
      isMarketOverview({
        ...overview,
        feeds: { ...overview.feeds, news: { ageSeconds: 1, state: 'unknown' } },
      }),
    ).toBe(false);
    expect(
      isMarketOverview({
        ...overview,
        feeds: { ...overview.feeds, news: { ageSeconds: 'old', state: 'fresh' } },
      }),
    ).toBe(false);
  });

  it('needs the market it was generated against', () => {
    expect(isMarketOverview({ ...overview, marketId: 'crypto-1h' })).toBe(false);
    expect(isMarketOverview({ ...overview, generatedAt: 'now' })).toBe(false);
    expect(isMarketOverview({ ...overview, assets: undefined })).toBe(false);
    expect(isMarketOverview({ ...overview, headlines: undefined })).toBe(false);
  });

  it('accepts an unavailable feed with no value and no time', () => {
    expect(
      isMarketOverview({
        ...overview,
        feeds: {
          ...overview.feeds,
          news: { ageSeconds: 0, reason: 'upstream-unavailable', state: 'unavailable' },
        },
      }),
    ).toBe(true);
  });
});

describe('isHourlyThresholdMarkets', () => {
  const markets = syntheticHourlyThresholds();

  it('refuses anything claiming more than market data', () => {
    for (const capability of [
      { live: true, marketData: true, paper: false },
      { live: false, marketData: true, paper: true },
      { live: false, marketData: false, paper: false },
    ]) {
      expect(isHourlyThresholdMarkets({ ...markets, capability })).toBe(false);
    }
  });

  it('needs the venue, the market and the reference it was read against', () => {
    expect(isHourlyThresholdMarkets({ ...markets, providerId: 'somewhere-else' })).toBe(false);
    expect(isHourlyThresholdMarkets({ ...markets, marketId: 'crypto-15m' })).toBe(false);
    expect(isHourlyThresholdMarkets({ ...markets, referenceSource: 7 })).toBe(false);
    expect(isHourlyThresholdMarkets({ ...markets, markets: undefined })).toBe(false);
  });
});
