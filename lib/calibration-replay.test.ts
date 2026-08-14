import { describe, expect, it } from 'vitest';
import { calibrationReplayForForecast, createCalibrationReplaySnapshot, PRODUCTION_CONFIDENCE_PARAMETERS, PRODUCTION_REPLAY_PARAMETERS, replayCalibrationProbability, replayConfidence } from './calibration-replay';
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

describe('estimate-quality replay', () => {
  const input = { basisPresent: true, venueProbabilityCount: 2, volatilitySamples: 60, secondsRemaining: 300, rangePercent: 1.2 };

  it('reproduces the production expression exactly', () => {
    // 0.30 base + 0.20 basis + 0.04 venue + 0.22 samples − (0.04 clock + 0.02 range).
    expect(replayConfidence(input)).toBeCloseTo(0.7, 12);
  });

  it('records zero replay error at issuance, which is what makes a row usable as evidence', () => {
    const snapshot = createCalibrationReplaySnapshot({
      slowTiltLogOdds: 0, slowTerms: [], productionProbabilityUp: 0.6,
      confidence: { input, productionConfidence: replayConfidence(input) },
    });
    expect(snapshot.confidenceSource).toBe('issuance-exact');
    expect(snapshot.confidenceReplayError).toBeCloseTo(0, 12);
    expect(snapshot.confidenceInput).toEqual(input);
  });

  it('reports divergence rather than hiding it when the stored value disagrees', () => {
    const snapshot = createCalibrationReplaySnapshot({
      slowTiltLogOdds: 0, slowTerms: [], productionProbabilityUp: 0.6,
      confidence: { input, productionConfidence: replayConfidence(input) + 0.05 },
    });
    expect(snapshot.confidenceReplayError).toBeCloseTo(0.05, 12);
  });

  it('isolates the elapsed-time lift as a parameter instead of an expression', () => {
    const early = replayConfidence({ ...input, secondsRemaining: 900 });
    const late = replayConfidence({ ...input, secondsRemaining: 0 });
    // Quality gates entry at 50%, so this 12pp swing on the clock alone decides late-window entries.
    expect(late - early).toBeCloseTo(PRODUCTION_CONFIDENCE_PARAMETERS.clockPenaltyMax, 12);
    const flat = { ...PRODUCTION_CONFIDENCE_PARAMETERS, clockPenaltyMax: 0 };
    expect(replayConfidence({ ...input, secondsRemaining: 900 }, flat))
      .toBeCloseTo(replayConfidence({ ...input, secondsRemaining: 0 }, flat), 12);
  });

  it('penalizes a missing basis and withholds its sample credit together', () => {
    const withoutBasis = replayConfidence({ ...input, basisPresent: false, volatilitySamples: 0 });
    expect(withoutBasis).toBeCloseTo(PRODUCTION_CONFIDENCE_PARAMETERS.floor, 12);
  });

  it('clamps to the production floor and ceiling', () => {
    const best = replayConfidence({ basisPresent: true, venueProbabilityCount: 2, volatilitySamples: 10_000, secondsRemaining: 0, rangePercent: 0 });
    expect(best).toBeLessThanOrEqual(PRODUCTION_CONFIDENCE_PARAMETERS.ceiling);
    const worst = replayConfidence({ basisPresent: false, venueProbabilityCount: 0, volatilitySamples: 0, secondsRemaining: 900, rangePercent: 100 });
    expect(worst).toBe(PRODUCTION_CONFIDENCE_PARAMETERS.floor);
  });

  it('marks historical rows absent rather than inventing a quality it cannot recover', () => {
    const snapshot = calibrationReplayForForecast(forecast(0.62));
    expect(snapshot.confidenceSource).toBe('absent');
    expect(snapshot.confidenceInput).toBeUndefined();
    expect(snapshot.confidenceReplayError).toBeUndefined();
  });
});
