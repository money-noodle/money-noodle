import { describe, expect, it } from 'vitest';
import { PRODUCTION_REPLAY_PARAMETERS, replayCalibrationProbability } from './calibration-replay';
import { alignedKalshiQuote, buildPrediction, publicDashboardData } from './dashboard';
import { activePolicyManifest } from './policy-manifest';
import { normalizeTradingProviderConfiguration } from './trading-provider-config-store';
import { tradingProviderRegistry } from './trading-provider-registry';
import type { CoinSnapshot, ContractReference } from './feeds';
import { MIN_ESTIMATE_QUALITY } from './prediction-policy';
import type { ChartPoint, DashboardData, MarketQuote, VenueQuote } from './types';

const coin: CoinSnapshot = {
  symbol: 'BTC', name: 'Bitcoin', price: 100, high24h: 103, low24h: 98, volume: 1_000_000,
  change1h: 1, change24h: 2, change7d: 4, change30d: 10, change1y: 40,
  chart: [{ time: 1, price: 98 }, { time: 2, price: 100 }],
};
const market: MarketQuote = {
  probabilityUp: 0.5, probabilityDown: 0.5, liquidity: 10_000, volume: 5_000,
  url: 'https://example.com', closesAt: new Date(Date.now() + 900_000).toISOString(), live: true,
};

/** Deterministic one-minute closes with a realistic, non-zero realized volatility. */
function minuteCloses(): number[] {
  let price = 100;
  return Array.from({ length: 61 }, (_, index) => {
    price *= Math.exp(Math.sin(index * 1.7) * 0.0005);
    return price;
  });
}

function reference(currentPrice: number): ContractReference {
  return { symbol: 'BTC', slot: 0, referencePrice: 100, currentPrice, referenceSource: 'test oracle' };
}

function seasonalPoints(): ChartPoint[] {
  const month = new Date().getUTCMonth();
  const currentYear = new Date().getUTCFullYear();
  return [currentYear - 1, currentYear - 2, currentYear - 3].flatMap((year) => [100, 105, 110, 115].map((price, week) => ({
    time: Date.UTC(year, month, 2 + week * 7), price,
  })));
}

const build = (quote: MarketQuote | undefined, currentPrice?: number, weekly: ChartPoint[] = []) =>
  buildPrediction(coin, quote, [], [], weekly, undefined, [], ['polymarket', 'kalshi'],
    currentPrice === undefined ? undefined : reference(currentPrice), currentPrice === undefined ? [] : minuteCloses());

describe('venue window alignment', () => {
  const kalshi = (closesAt: string): VenueQuote => ({
    venue: 'kalshi', probabilityUp: 0.5, bidUp: 0.49, askUp: 0.51, bidDown: 0.49, askDown: 0.51,
    liquidity: 100, volume: 100, url: 'https://kalshi.test', closesAt, ticker: 'KXBTC15M-TEST',
    live: true, comparability: 'approximate',
  });

  it('rejects an unexpired cached Kalshi quote from the prior Polymarket window', () => {
    const now = Date.parse('2026-08-11T19:00:01Z');
    const currentMarket = { ...market, closesAt: '2026-08-11T19:15:00Z' };
    expect(alignedKalshiQuote(currentMarket, kalshi('2026-08-11T19:00:00Z'), now)).toBeUndefined();
  });

  it('retains the same Kalshi ticker even when cross-venue rule comparability is approximate', () => {
    const now = Date.parse('2026-08-11T19:00:01Z');
    const currentMarket = { ...market, closesAt: '2026-08-11T19:15:00Z' };
    expect(alignedKalshiQuote(currentMarket, kalshi('2026-08-11T19:15:00Z'), now)?.ticker).toBe('KXBTC15M-TEST');
  });
});

describe('Blend 0.3', () => {
  it('keeps probabilities bounded and separates the venue price from model edge', () => {
    const prediction = build(market, 100, seasonalPoints());
    expect(prediction.modelProbabilityUp).toBeGreaterThan(0.5);
    expect(prediction.modelProbabilityUp).toBeLessThanOrEqual(0.97);
    expect(prediction.edge).toBeCloseTo(prediction.modelProbabilityUp - market.probabilityUp);
    expect(prediction.factors).toHaveLength(7);
    const breakdown = prediction.confidenceBreakdown;
    expect(prediction.confidence).toBeCloseTo(breakdown.base + breakdown.dataQuality + breakdown.sampleQuality - breakdown.uncertaintyPenalty);
  });

  it('persists exact venue-independent inputs that replay the production probability', () => {
    const prediction = build(market, 100.3, seasonalPoints());
    expect(prediction.calibrationReplay?.source).toBe('issuance-exact');
    expect(prediction.calibrationReplay?.slowTerms.length).toBe(5);
    expect(prediction.calibrationReplay?.baselineReplayError).toBeLessThan(1e-12);
    expect(replayCalibrationProbability(prediction.calibrationReplay!, PRODUCTION_REPLAY_PARAMETERS)).toBeCloseTo(prediction.modelProbabilityUp, 12);
  });

  it('forecasts distance from the settlement reference rather than general bullishness', () => {
    const above = build(market, 100.5);
    const below = build(market, 99.5);
    expect(above.basis?.referencePrice).toBe(100);
    expect(above.modelProbabilityUp).toBeGreaterThan(0.7);
    expect(below.modelProbabilityUp).toBeLessThan(0.3);
    // The same asset with the same momentum must not produce a single standing direction.
    expect(above.modelProbabilityUp).toBeGreaterThan(below.modelProbabilityUp);
  });

  it('grows more decisive as settlement approaches for an identical basis', () => {
    const near = { ...market, closesAt: new Date(Date.now() + 90_000).toISOString() };
    expect(build(near, 100.2).modelProbabilityUp).toBeGreaterThan(build(market, 100.2).modelProbabilityUp);
  });

  it('keeps the tradeable estimate completely independent of venue pricing', () => {
    // Edge is measured against the venue price, so the venue must not move the tradeable forecast at all.
    const low = build({ ...market, probabilityUp: 0.1, probabilityDown: 0.9 }, 100);
    const high = build({ ...market, probabilityUp: 0.9, probabilityDown: 0.1 }, 100);
    expect(high.modelProbabilityUp).toBeCloseTo(low.modelProbabilityUp, 12);
    // The venue-informed reference figure is still produced for comparison, and does move.
    expect(high.blendedProbabilityUp!).toBeGreaterThan(low.blendedProbabilityUp!);
  });

  it('cannot reach the trading confidence gate without an oracle reference', () => {
    const prediction = build(market);
    expect(prediction.basis).toBeUndefined();
    expect(prediction.factors.find((factor) => factor.id === 'basis')?.available).toBe(false);
    expect(prediction.confidence).toBeLessThan(MIN_ESTIMATE_QUALITY);
    expect(prediction.signal).not.toBe('UP');
  });

  it('reports each factor as its exact marginal effect on the final probability', () => {
    const prediction = build(market, 100.3, seasonalPoints());
    const basis = prediction.factors.find((factor) => factor.id === 'basis')!;
    expect(basis.contribution).toBeGreaterThan(0);
    expect(Math.abs(basis.contribution)).toBeGreaterThan(Math.abs(prediction.factors.find((factor) => factor.id === 'yearly')!.contribution));
  });

  it('uses genuine repeated same-month samples when enough history exists', () => {
    const factor = build(market, 100, seasonalPoints()).factors.find((item) => item.id === 'seasonal');
    expect(factor?.available).toBe(true);
    expect(factor?.direction).toBe('bullish');
    expect(factor?.source).toBe('Kraken weekly OHLC');
  });

  it('keeps seasonality neutral when history is insufficient', () => {
    const factor = build(market, 100).factors.find((item) => item.id === 'seasonal');
    expect(factor?.available).toBe(false);
    expect(factor?.score).toBe(0);
    expect(factor?.contribution).toBe(0);
  });

  it('uses an explicitly unavailable neutral market prior when a venue quote is absent', () => {
    const factor = build(undefined, 100).factors.find((item) => item.id === 'market');
    expect(factor?.available).toBe(false);
    expect(factor?.score).toBe(0);
  });
});

describe('public dashboard payload', () => {
  const dashboard = () => ({
    tradingProviders: [], performance: {},
    policyManifest: activePolicyManifest(tradingProviderRegistry(normalizeTradingProviderConfiguration({ executionAuthority: 'provider-registry-v1' })), 'Blend 0.4', []),
    predictions: [],
  } as unknown as DashboardData);

  it('withholds provider permissions, model promotion, and worker trajectory evidence from unauthenticated callers', () => {
    const signed = dashboard();
    signed.predictions = [{
      quoteTrajectorySpread: { version: 'quote-trajectory-spread-observation-v1' },
      quoteTrajectorySpreads: [{ version: 'quote-trajectory-spread-observation-v1' }],
    } as unknown as DashboardData['predictions'][number]];
    expect(signed.policyManifest.model).toBeDefined();
    expect(signed.policyManifest.components.some((component) => component.kind === 'provider')).toBe(true);

    const published = publicDashboardData(signed);
    expect(published.policyManifest.model).toBeUndefined();
    expect(published.policyManifest.components.some((component) => component.kind === 'provider')).toBe(false);
    // The rules themselves stay public: withholding provenance must not withhold the policy.
    expect(published.policyManifest.components.some((component) => component.kind === 'eligibility')).toBe(true);
    expect(published.policyManifest.activeBuyPolicyVersion).toBe(signed.policyManifest.activeBuyPolicyVersion);
    expect('tradingProviders' in published).toBe(false);
    expect('performance' in published).toBe(false);
    expect(published.predictions[0].quoteTrajectorySpread).toBeUndefined();
    expect(published.predictions[0].quoteTrajectorySpreads).toBeUndefined();
  });
});
