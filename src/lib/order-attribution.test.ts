import { describe, expect, it } from 'vitest';
import {
  buildOrderAttributionFacets, EMPTY_ORDER_ATTRIBUTION_FILTERS, orderAttribution,
  orderAttributionSearchParams, orderMatchesAttribution, parseOrderAttributionFilters,
  UNATTRIBUTED_ORDER_IDENTITY, unknownOrderAttributionFilters,
} from './order-attribution';
import type { PaperOrder } from './types';

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: 'paper:BTC:UP:1', executionMode: 'paper', venue: 'kalshi', symbol: 'BTC', contractId: 'BTC-1',
    side: 'UP', status: 'won', createdAt: '2026-08-26T00:00:00Z', calculationAt: '2026-08-26T00:00:00Z',
    closesAt: '2026-08-26T00:15:00Z', modelProbabilityUp: 0.7, confidence: 0.8,
    askPrice: 0.5, bidPrice: 0.49, spread: 0.01, quantity: 1, stakeCents: 50, feeCents: 1,
    potentialPayoutCents: 100, ...overrides,
  };
}

const current = order({
  providerId: 'kalshi', providerVariantId: 'kalshi-15m-maker-v1', marketId: 'crypto-15m',
  entryDecision: {
    version: 'entry-decision-v1', providerId: 'kalshi', providerVariantId: 'kalshi-15m-maker-v1',
    forecastModelVersion: 'Blend 0.4', executionPolicyVersion: 'paper-v6', policyVersion: 'buy-v22',
    calculationAt: '2026-08-26T00:00:00Z', side: 'UP', probabilityUp: 0.7, probabilityDown: 0.3,
    selectedSideProbability: 0.7, confidence: 0.8,
    confidenceBreakdown: { base: 0.8, dataQuality: 1, sampleQuality: 1, uncertaintyPenalty: 0 },
    actionableAsk: 0.5, actionableBid: 0.49, feeRate: 0.01, netEdge: 0.19, spread: 0.01,
    secondsRemaining: 300, qualifyingSnapshots: 2, medianNetEdge: 0.18, factors: [],
  },
});

function filters(overrides: Partial<typeof EMPTY_ORDER_ATTRIBUTION_FILTERS> = {}) {
  return { ...EMPTY_ORDER_ATTRIBUTION_FILTERS, ...overrides };
}

describe('order attribution', () => {
  it('uses only authoritative legacy fallbacks and leaves non-inferable identity unattributed', () => {
    expect(orderAttribution(order())).toEqual({
      mode: 'paper', providerId: 'kalshi', providerVariantId: UNATTRIBUTED_ORDER_IDENTITY,
      marketId: 'crypto-15m', forecastModelVersion: UNATTRIBUTED_ORDER_IDENTITY,
      buyPolicyVersion: UNATTRIBUTED_ORDER_IDENTITY, executionPolicyVersion: UNATTRIBUTED_ORDER_IDENTITY,
    });
    expect(orderAttribution(order({
      entryExecutionDecision: {
        policyVersion: 'legacy-execution', configuredMode: 'maker', executedStyle: 'maker',
        recommendedStyle: 'maker', reason: 'test', takerNetEdge: 0.1, medianNetEdge: 0.1,
        makerNetEdge: 0.1, makerExpectedCapturedEdge: null, takerAdvantage: null,
        makerCohort: 'test', makerSamples: 0, makerFillRate: null,
      },
    })).executionPolicyVersion).toBe('legacy-execution');
  });

  it('matches OR within dimensions and AND across dimensions over a grid', () => {
    const live = { ...current, id: 'live:BTC:UP:1', executionMode: 'live' as const };
    const other = order({ providerId: 'polymarket', providerVariantId: 'poly-v1' });
    expect([current, live, other].filter((item) => orderMatchesAttribution(item,
      filters({ modes: ['paper'], providerIds: ['kalshi', 'polymarket'] })))).toEqual([current, other]);
    expect(orderMatchesAttribution(current, filters({ providerIds: ['kalshi'], buyPolicyVersions: ['other'] }))).toBe(false);
    expect(orderMatchesAttribution(current, filters())).toBe(true);
  });

  it('builds complete-population facets and reports unknown selections', () => {
    const facets = buildOrderAttributionFacets([current, order()]);
    expect(facets.providerIds).toEqual([{ value: 'kalshi', count: 2 }]);
    expect(facets.providerVariantIds).toEqual([
      { value: 'kalshi-15m-maker-v1', count: 1 }, { value: UNATTRIBUTED_ORDER_IDENTITY, count: 1 },
    ]);
    expect(unknownOrderAttributionFilters(filters({ providerIds: ['missing'] }), facets))
      .toEqual([{ key: 'providerIds', value: 'missing' }]);
  });

  it('round-trips repeated and comma-separated query values and rejects malformed mode', () => {
    const parsed = parseOrderAttributionFilters(new URLSearchParams('mode=live,paper&provider=kalshi&provider=polymarket&buyPolicy=buy-v22'));
    expect(parsed.modes).toEqual(['live', 'paper']);
    expect(parsed.providerIds).toEqual(['kalshi', 'polymarket']);
    expect(parseOrderAttributionFilters(orderAttributionSearchParams(parsed))).toEqual(parsed);
    expect(() => parseOrderAttributionFilters(new URLSearchParams('mode=production'))).toThrow('Invalid mode');
  });
});
