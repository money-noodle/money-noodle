import { describe, expect, it } from 'vitest';

import * as transport from './index';

describe('platform API transport package', () => {
  it('exports the generated status and health operations', () => {
    expect(transport.getPlatformStatus).toBeTypeOf('function');
    expect(transport.getLiveness).toBeTypeOf('function');
    expect(transport.getReadiness).toBeTypeOf('function');
  });

  it('exports the generated paper read operations', () => {
    expect(transport.getPaperBudget).toBeTypeOf('function');
    expect(transport.getPaperPerformanceSummary).toBeTypeOf('function');
    expect(transport.getPaperPerformance).toBeTypeOf('function');
  });

  it('exports the generated public market read operations', () => {
    expect(transport.getMarketOverview).toBeTypeOf('function');
    expect(transport.getHourlyThresholdMarkets).toBeTypeOf('function');
  });

  it('carries the published freshness vocabulary into the generated types', () => {
    // The point of generating this package is that a caller cannot mistype a feed
    // state or invent a reason code: both are closed sets in the contract.
    const state: transport.MarketFeedState = {
      ageSeconds: 0,
      fetchedAt: '2026-10-05T18:07:30.000Z',
      reason: 'upstream-timeout',
      state: 'stale',
    };
    expect(state.state).toBe('stale');
  });
});
