import { describe, expect, it } from 'vitest';
import { buildContractComparabilityReport, settlementPathAverage } from './contract-comparability';
import { contractProvenanceRef, createContractProvenance } from './contract-provenance';
import type { CyclePathRecord, TrackedForecast, VenueOutcomeRecord } from './types';

const close = '2026-01-01T00:15:00.000Z';
const poly = createContractProvenance({
  venue: 'polymarket', contractId: 'poly', marketUrl: 'https://poly.test', closesAt: close,
  rulesSource: 'https://poly.test/rules', rulesText: 'Chainlink time-weighted average price.',
  referenceSource: 'https://data.chain.link/streams/btc-usd-twap-60s-streams', comparability: 'approximate',
});
const kalshi = createContractProvenance({
  venue: 'kalshi', contractId: 'kalshi', marketUrl: 'https://kalshi.test', closesAt: close,
  rulesSource: 'https://kalshi.test/rules',
  rulesText: "Simple average of the sixty seconds of CF Benchmarks' BTCUSDRTI before close.",
  referenceSource: 'CF Benchmarks RTI', referenceValue: 99, comparability: 'approximate',
});
const outcome = (venue: 'polymarket' | 'kalshi', contractId: string, result: 'UP' | 'DOWN'): VenueOutcomeRecord => ({
  venue, contractId, outcome: result, resolutionSource: 'test', resolvedAt: '2026-01-01T00:16:00Z',
});
const forecast: TrackedForecast = {
  id: 'forecast', symbol: 'BTC', marketUrl: 'https://poly.test', issuedAt: '2026-01-01T00:10:00Z', closesAt: close,
  direction: 'UP', probabilityUp: 0.6, directionalLikelihood: 0.6, confidence: 0.7,
  modelVersion: 'model', policyVersion: 'policy', polymarketProbabilityUp: 0.5, factors: [], status: 'resolved',
  venueContracts: { polymarket: contractProvenanceRef(poly), kalshi: contractProvenanceRef(kalshi) },
  venueOutcomes: { polymarket: outcome('polymarket', 'poly', 'UP'), kalshi: outcome('kalshi', 'kalshi', 'UP') },
  outcome: 'UP', correct: true, brierScore: 0.16, logLoss: 0.5, resolvedAt: '2026-01-01T00:16:00Z',
};
const path: CyclePathRecord = {
  id: `BTC:${close}`, symbol: 'BTC', cycleStartedAt: '2026-01-01T00:00:00Z', closesAt: close,
  referencePrice: 100,
  points: [0, 15, 30, 45, 60].map((seconds) => ({
    at: new Date(Date.parse(close) - (60 - seconds) * 1_000).toISOString(),
    offsetSeconds: 840 + seconds, price: 101, basisPercent: 1,
  })),
  features: {
    observedAt: close, observationCount: 5, coverageSeconds: 60, signFlipRate: 0,
    lagOneAutocorrelation: null, trendEfficiency: 1, rangePercent: 0,
    localVolatilityPerSecond: 0, localVolatility15mPercent: 0, regime: 'trending',
  },
};

describe('contract comparability report', () => {
  it('approximates the published settlement window from a sufficiently covered path', () => {
    expect(settlementPathAverage(path.points, close, 60)).toBe(101);
    expect(settlementPathAverage(path.points.slice(0, 3), close, 60)).toBeUndefined();
  });

  it('reports direct reference drift and exact-venue proxy agreement without changing production', () => {
    const report = buildContractComparabilityReport([forecast], [path], [poly, kalshi]);
    expect(report.totalContracts).toBe(2);
    expect(report.metadataContracts).toBe(2);
    expect(report.pairedOutcomeWindows).toBe(1);
    expect(report.pairedOutcomeAssetWindows).toBe(1);
    expect(report.venueOutcomeDisagreements).toBe(0);
    expect(report.comparison.comparability).toBe('approximate');
    const kalshiReport = report.venues.find((item) => item.venue === 'kalshi')!;
    expect(kalshiReport.directReferenceDriftSamples).toBe(1);
    expect(kalshiReport.meanReferenceDriftPercent).toBeCloseTo((100 / 99 - 1) * 100);
    expect(kalshiReport.proxyOutcomeAgreement).toBe(1);
    expect(report.productionChanged).toBe(false);
  });

  it('counts venue disagreements while preserving each exact venue outcome', () => {
    const changed = {
      ...forecast,
      venueOutcomes: { ...forecast.venueOutcomes, kalshi: outcome('kalshi', 'kalshi', 'DOWN') },
    };
    const report = buildContractComparabilityReport([changed], [path], [poly, kalshi]);
    expect(report.pairedOutcomeWindows).toBe(1);
    expect(report.venueOutcomeDisagreements).toBe(1);
    expect(report.recent.find((item) => item.venue === 'kalshi')?.venueOutcome).toBe('DOWN');
  });
});
