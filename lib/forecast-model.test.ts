import { describe, expect, it } from 'vitest';
import { basisProbability, clampProbability, logit, sigmoid, type BasisInput } from './basis-model';
import {
  combineForecastProbability, evaluateForecastBasis, evaluateForecastModel, PRODUCTION_FORECAST_MODEL,
  type ForecastSlowTermInput,
} from './forecast-model';

/** Frozen pre-extraction Blend 0.4 arithmetic. This test helper must not call the implementation under test. */
function legacyProductionProbability(basisProbabilityUp: number | undefined, terms: ForecastSlowTermInput[]) {
  const basisLogOdds = basisProbabilityUp === undefined ? 0 : logit(basisProbabilityUp) * 0.55;
  const scaledTerms = terms.map((term) => term.baseLogOdds * 0.8);
  const rawTilt = scaledTerms.reduce((sum, value) => sum + value, 0);
  const boundedTilt = Math.max(-0.4, Math.min(0.4, rawTilt));
  const scaling = rawTilt === 0 ? 1 : boundedTilt / rawTilt;
  return {
    basisLogOdds,
    rawTilt,
    boundedTilt,
    scaling,
    termLogOdds: scaledTerms.map((value) => value * scaling),
    probabilityUp: clampProbability(sigmoid(basisLogOdds + boundedTilt), 0.03, 0.97),
  };
}

const basisInputs: Array<BasisInput | undefined> = [
  undefined,
  { referencePrice: 100, currentPrice: 100, secondsRemaining: 900, volatilityPerSecond: 0.0001 },
  { referencePrice: 100, currentPrice: 100.2, secondsRemaining: 600, volatilityPerSecond: 0.0002 },
  { referencePrice: 100, currentPrice: 99.7, secondsRemaining: 120, volatilityPerSecond: 0.0003 },
  { referencePrice: 100, currentPrice: 108, secondsRemaining: 45, volatilityPerSecond: 0.0001 },
  { referencePrice: 100, currentPrice: 92, secondsRemaining: 45, volatilityPerSecond: 0.0001 },
];

const slowTermGrids: ForecastSlowTermInput[][] = [
  [],
  [{ id: 'flat', baseLogOdds: 0 }],
  [{ id: 'positive', baseLogOdds: 0.4875 }], // 0.39 after the production 0.8 scale: below the cap.
  [{ id: 'at-cap', baseLogOdds: 0.5 }], // Exactly 0.40 after scaling.
  [{ id: 'above-cap', baseLogOdds: 0.5125 }],
  [{ id: 'negative-above-cap', baseLogOdds: -0.5125 }],
  [{ id: 'one', baseLogOdds: 0.4 }, { id: 'two', baseLogOdds: -0.15 }, { id: 'three', baseLogOdds: 0.1 }],
];

describe('pure production forecast model', () => {
  it('reproduces the pre-extraction formula over basis, time, volatility, tilt, and cap boundaries', () => {
    for (const basisInput of basisInputs) {
      const basis = basisInput ? basisProbability(basisInput) : null;
      expect(evaluateForecastBasis(basisInput)).toEqual(basis);
      for (const slowTerms of slowTermGrids) {
        const expected = legacyProductionProbability(basis?.probabilityUp, slowTerms);
        const actual = evaluateForecastModel({ basisProbabilityUp: basis?.probabilityUp, slowTerms });
        expect(actual.basisLogOdds).toBeCloseTo(expected.basisLogOdds, 12);
        expect(actual.rawSlowTiltLogOdds).toBeCloseTo(expected.rawTilt, 12);
        expect(actual.slowTiltLogOdds).toBeCloseTo(expected.boundedTilt, 12);
        expect(actual.slowTiltScaling).toBeCloseTo(expected.scaling, 12);
        expect(actual.slowTerms.map((term) => term.logOdds)).toEqual(
          expected.termLogOdds.map((value) => expect.closeTo(value, 12)),
        );
        expect(actual.probabilityUp).toBeCloseTo(expected.probabilityUp, 12);
      }
    }
  });

  it('keeps per-term contributions additive after the aggregate cap', () => {
    const result = evaluateForecastModel({
      basisProbabilityUp: 0.7,
      slowTerms: [{ id: 'a', baseLogOdds: 0.7 }, { id: 'b', baseLogOdds: 0.3 }],
    });
    expect(result.rawSlowTiltLogOdds).toBeCloseTo(0.8, 12);
    expect(result.slowTiltLogOdds).toBeCloseTo(0.4, 12);
    expect(result.slowTerms.reduce((sum, term) => sum + term.logOdds, 0)).toBeCloseTo(result.slowTiltLogOdds, 12);
  });

  it('supports candidate weighting through the same probability combiner without mutating production', () => {
    const before = { ...PRODUCTION_FORECAST_MODEL };
    const candidate = combineForecastProbability({ basisProbabilityUp: 0.75, slowTiltLogOdds: 0.2 }, {
      basisLogOddsWeight: 0.65,
      slowTiltScale: 0.5,
      temperature: 1,
      probabilityFloor: 0.03,
      probabilityCeiling: 0.97,
    });
    const expected = clampProbability(sigmoid(logit(0.75) * 0.65 + 0.2 * 0.5), 0.03, 0.97);
    expect(candidate.probabilityUp).toBeCloseTo(expected, 12);
    expect(PRODUCTION_FORECAST_MODEL).toEqual(before);
    expect(Object.isFrozen(PRODUCTION_FORECAST_MODEL)).toBe(true);
  });
});
