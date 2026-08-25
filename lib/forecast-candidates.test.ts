import { describe, expect, it } from 'vitest';
import { PRODUCTION_REPLAY_PARAMETERS, replayCalibrationProbability } from './calibration-replay';
import { buildPrediction } from './dashboard';
import { evaluateForecastCandidates, FORECAST_CANDIDATE_REGISTRY, FORECAST_CANDIDATE_REGISTRY_VERSION } from './forecast-candidates';
import type { CoinSnapshot, ContractReference } from './feeds';
import type { MarketQuote, VenueQuote } from './types';

const coin: CoinSnapshot = {
  symbol: 'BTC', name: 'Bitcoin', price: 100.25, high24h: 103, low24h: 98, volume: 1_000_000,
  change1h: 1, change24h: 2, change7d: 4, change30d: 10, change1y: 40,
  chart: [{ time: 1, price: 98 }, { time: 2, price: 100.25 }],
};

function minuteCloses(): number[] {
  let price = 100;
  return Array.from({ length: 61 }, (_, index) => {
    price *= Math.exp(Math.sin(index * 1.7) * 0.0005);
    return price;
  });
}

function prediction() {
  const closesAt = new Date(Date.now() + 600_000).toISOString();
  const market: MarketQuote = {
    probabilityUp: 0.5, probabilityDown: 0.5, askUp: 0.01, askDown: 0.99,
    liquidity: 10_000, volume: 5_000, url: 'https://example.test/poly', closesAt, live: true,
  };
  const kalshi: VenueQuote = {
    venue: 'kalshi', probabilityUp: 0.5, bidUp: 0.39, askUp: 0.40, bidDown: 0.59, askDown: 0.60,
    liquidity: 1_000, volume: 500, url: 'https://example.test/kalshi', closesAt, live: true,
    comparability: 'exact', ticker: 'TEST',
  };
  const reference: ContractReference = {
    symbol: 'BTC', slot: 0, referencePrice: 100, currentPrice: coin.price, referenceSource: 'test oracle',
  };
  return buildPrediction(coin, market, [], [], [], kalshi, [], ['polymarket', 'kalshi'], reference, minuteCloses());
}

describe('prospective forecast candidates', () => {
  it('stamps the complete immutable family and exactly reproduces the production control', () => {
    const production = prediction();
    const evaluation = evaluateForecastCandidates(production);
    expect(evaluation.registryVersion).toBe(FORECAST_CANDIDATE_REGISTRY_VERSION);
    expect(evaluation.decisions.map((candidate) => candidate.candidateId)).toEqual(
      FORECAST_CANDIDATE_REGISTRY.map((candidate) => candidate.id),
    );
    expect(evaluation.decisions.every((candidate) => candidate.status === 'available')).toBe(true);
    const control = evaluation.decisions[0];
    expect(control.probabilityUp).toBe(production.modelProbabilityUp);
    expect(control.replayError).toBeLessThanOrEqual(1e-12);
    expect(Object.isFrozen(FORECAST_CANDIDATE_REGISTRY)).toBe(true);
  });

  it('uses the declared 0.65/0.5 candidate and the shared funded-side policy', () => {
    const production = prediction();
    const evaluation = evaluateForecastCandidates(production);
    const locked = evaluation.decisions.find((candidate) => candidate.candidateId === 'basis065-slow050-v1')!;
    const expected = replayCalibrationProbability(production.calibrationReplay!, {
      ...PRODUCTION_REPLAY_PARAMETERS,
      basisWeight: 0.65,
      slowTiltScale: 0.5,
    });
    expect(locked.probabilityUp).toBeCloseTo(expected, 12);
    // The non-funded provider has the more extreme asks in this fixture but may not enter candidate decisions.
    expect(locked.bestOption?.venue).toBe('kalshi');
    expect(locked.selectedEntry?.venue).toBe('kalshi');
    expect(typeof locked.qualified).toBe('boolean');
  });

  it('fails dependent candidates explicitly when exact issuance replay is absent', () => {
    const production = prediction();
    production.calibrationReplay = undefined;
    const evaluation = evaluateForecastCandidates(production);
    expect(evaluation.decisions[0].status).toBe('available');
    for (const candidate of evaluation.decisions.slice(1)) {
      expect(candidate.status).toBe('unavailable');
      expect(candidate.unavailableReason).toContain('unavailable');
    }
  });
});
