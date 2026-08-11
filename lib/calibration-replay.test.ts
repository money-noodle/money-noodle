import { describe, expect, it } from 'vitest';
import { calibrationReplayForForecast, createCalibrationReplaySnapshot, PRODUCTION_REPLAY_PARAMETERS, replayCalibrationProbability } from './calibration-replay';
import { basisProbability, clampProbability, logit, sigmoid } from './basis-model';
import type { TrackedForecast } from './types';

const forecast = (probabilityUp: number, basisProbabilityUp = 0.7): TrackedForecast => ({
  id: 'BTC:1', symbol: 'BTC', marketUrl: 'https://example.com', issuedAt: '2026-01-01T00:10:00Z', closesAt: '2026-01-01T00:15:00Z',
  direction: 'UP', probabilityUp, directionalLikelihood: probabilityUp, confidence: 0.7, modelVersion: 'legacy', policyVersion: 'v9',
  polymarketProbabilityUp: 0.5, basisProbabilityUp, factors: [], status: 'resolved', outcome: 'UP',
});

describe('calibration probability replay', () => {
  it('replays exact raw basis and slow-tilt inputs', () => {
    const raw = { referencePrice: 100, currentPrice: 100.2, secondsRemaining: 300, volatilityPerSecond: 0.0001, volatilitySamples: 60 };
    const basisResult = basisProbability(raw)!;
    const productionProbabilityUp = clampProbability(sigmoid(logit(basisResult.probabilityUp) * 0.55 + 0.1), 0.03, 0.97);
    const snapshot = createCalibrationReplaySnapshot({
      basis: {
        ...raw, referenceSource: 'test', basisPercent: 0.2,
        standardDeviationPercent: basisResult.standardDeviation * 100, zScore: basisResult.zScore, probabilityUp: basisResult.probabilityUp,
      },
      slowTiltLogOdds: 0.1,
      slowTerms: [{ id: 'intraday', logOdds: 0.1 }],
      productionProbabilityUp,
    });
    expect(snapshot.baselineReplayError).toBeLessThan(1e-12);
  });

  it('makes a positive basis less decisive when candidate volatility increases', () => {
    const raw = { referencePrice: 100, currentPrice: 100.2, secondsRemaining: 300, volatilityPerSecond: 0.0005, volatilitySamples: 60 };
    const basisResult = basisProbability(raw)!;
    const productionProbabilityUp = clampProbability(sigmoid(logit(basisResult.probabilityUp) * 0.55), 0.03, 0.97);
    const snapshot = createCalibrationReplaySnapshot({
      basis: {
        ...raw, referenceSource: 'test', basisPercent: 0.2,
        standardDeviationPercent: basisResult.standardDeviation * 100, zScore: basisResult.zScore, probabilityUp: basisResult.probabilityUp,
      }, slowTiltLogOdds: 0, slowTerms: [], productionProbabilityUp,
    });
    const lowVol = replayCalibrationProbability(snapshot, { ...PRODUCTION_REPLAY_PARAMETERS, volatilityScale: 0.8 });
    const highVol = replayCalibrationProbability(snapshot, { ...PRODUCTION_REPLAY_PARAMETERS, volatilityScale: 1.2 });
    expect(lowVol).toBeGreaterThan(highVol);
  });

  it('reconstructs legacy rows and exactly reproduces their stored baseline', () => {
    const snapshot = calibrationReplayForForecast(forecast(0.64));
    expect(snapshot.source).toBe('historical-reconstruction');
    expect(snapshot.baselineReplayError).toBeLessThan(1e-12);
    expect(replayCalibrationProbability(snapshot, PRODUCTION_REPLAY_PARAMETERS)).toBeCloseTo(0.64, 12);
  });
});
