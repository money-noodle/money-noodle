// The two models, against numbers worked out by hand.
//
// These are the only functions in this slice whose output is not a provider's value
// repeated, so they are the only ones where a mistake is invisible in the response.
// Each case below states the closed form it expects rather than a recorded output, so
// a change in the estimator fails here instead of quietly republishing a new number.

import { describe, expect, it } from 'vitest';

import {
  BASIS_PROBABILITY_BOUNDS,
  boundedBasisProbability,
  effectiveSecondsRemaining,
  probabilityAboveStrike,
  realizedVolatilityPerSecond,
  standardNormalCdf,
  standardNormalQuantile,
  usableCloses,
} from './market-math.js';
import { MINIMUM_EFFECTIVE_SECONDS, VOLATILITY_CANDLE_ROWS } from './market-registry.js';

/** Closes whose log returns alternate `+step` and `-step`, from `100`. */
function alternatingCloses(count: number, step: number): readonly number[] {
  const closes = [100];
  for (let index = 1; index < count; index += 1) {
    closes.push(index % 2 === 1 ? 100 * Math.exp(step) : 100);
  }
  return closes;
}

describe('standardNormalCdf', () => {
  it('is one half at the mean and symmetric about it', () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 8);
    expect(standardNormalCdf(-1.2345)).toBeCloseTo(1 - standardNormalCdf(1.2345), 12);
  });

  it('matches the published quantiles of the normal distribution', () => {
    expect(standardNormalCdf(1.959963985)).toBeCloseTo(0.975, 6);
    expect(standardNormalCdf(-2.326347874)).toBeCloseTo(0.01, 6);
    expect(standardNormalCdf(1)).toBeCloseTo(0.841344746, 6);
  });

  it('treats a non-finite input as the limit it approaches', () => {
    expect(standardNormalCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(standardNormalCdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(standardNormalCdf(Number.NaN)).toBe(0);
  });
});

describe('standardNormalQuantile', () => {
  it('inverts the distribution across all three branches', () => {
    expect(standardNormalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(standardNormalQuantile(0.975)).toBeCloseTo(1.959963985, 7);
    // Below and above Acklam's tail boundary of 0.02425, where the rational form
    // changes: both must still invert the distribution.
    expect(standardNormalQuantile(0.01)).toBeCloseTo(-2.326347874, 6);
    expect(standardNormalQuantile(0.99)).toBeCloseTo(2.326347874, 6);
  });

  it('has no answer at or outside the bounds', () => {
    // A venue quoting exactly zero or one implies no finite volatility. An absent
    // answer is the honest one; an enormous one would be published as a number.
    expect(standardNormalQuantile(0)).toBeUndefined();
    expect(standardNormalQuantile(1)).toBeUndefined();
    expect(standardNormalQuantile(1.5)).toBeUndefined();
    expect(standardNormalQuantile(Number.NaN)).toBeUndefined();
  });
});

describe('usableCloses', () => {
  it('drops what cannot be a price and keeps the newest window', () => {
    expect(usableCloses([1, 0, -2, Number.NaN, 3])).toEqual([1, 3]);
    expect(usableCloses(Array.from({ length: 300 }, (_, index) => index + 1))).toHaveLength(
      VOLATILITY_CANDLE_ROWS,
    );
  });
});

describe('realizedVolatilityPerSecond', () => {
  it('is the sample standard deviation of log returns over the root interval', () => {
    const step = 0.002;
    const estimate = realizedVolatilityPerSecond(alternatingCloses(13, step));

    // Twelve returns, six of +step and six of -step: the mean is zero, so the sample
    // variance is 12 * step^2 / 11 and the per-second figure divides by sqrt(60).
    const expected = (step * Math.sqrt(12 / 11)) / Math.sqrt(60);
    expect(estimate?.samples).toBe(12);
    expect(estimate?.perSecond).toBeCloseTo(expected, 15);
  });

  it('honours the interval it is told the closes are spaced by', () => {
    const step = 0.002;
    const perMinute = realizedVolatilityPerSecond(alternatingCloses(13, step));
    const perTenSeconds = realizedVolatilityPerSecond(alternatingCloses(13, step), 10);
    expect(perTenSeconds?.perSecond).toBeCloseTo((perMinute?.perSecond ?? 0) * Math.sqrt(6), 15);
  });

  it('has no estimate below the minimum sample', () => {
    expect(realizedVolatilityPerSecond(alternatingCloses(11, 0.002))).toBeUndefined();
    expect(realizedVolatilityPerSecond(alternatingCloses(12, 0.002))?.samples).toBe(11);
  });

  it('has no estimate when nothing moved', () => {
    // A zero estimate would be used by the threshold model as certainty.
    expect(realizedVolatilityPerSecond(Array.from({ length: 30 }, () => 100))).toBeUndefined();
  });

  it('spans an unusable row rather than inventing a return for it', () => {
    const closes = [...alternatingCloses(13, 0.002)];
    closes.splice(6, 0, 0);
    const estimate = realizedVolatilityPerSecond(closes);
    // The zero is dropped, so twelve returns remain over thirteen usable closes.
    expect(estimate?.samples).toBe(12);
  });
});

describe('effectiveSecondsRemaining', () => {
  it('subtracts half the settlement window', () => {
    expect(effectiveSecondsRemaining(900)).toBe(870);
    expect(effectiveSecondsRemaining(60.5)).toBeCloseTo(30.5, 12);
  });

  it('floors at the minimum so a closing contract stays finite', () => {
    expect(effectiveSecondsRemaining(10)).toBe(MINIMUM_EFFECTIVE_SECONDS);
    expect(effectiveSecondsRemaining(0)).toBe(MINIMUM_EFFECTIVE_SECONDS);
  });
});

describe('probabilityAboveStrike', () => {
  it('is one half at the money', () => {
    expect(
      probabilityAboveStrike({
        currentPrice: 100,
        secondsRemaining: 900,
        strike: 100,
        volatilityPerSecond: 0.001,
      }),
    ).toBeCloseTo(0.5, 8);
  });

  it('is one standard deviation below the strike at one standard deviation', () => {
    const volatilityPerSecond = 0.001;
    const secondsRemaining = 960;
    // tEff = 960 - 30 = 930, so one standard deviation is 0.001 * sqrt(930).
    const standardDeviation = volatilityPerSecond * Math.sqrt(930);
    const probability = probabilityAboveStrike({
      currentPrice: 100,
      secondsRemaining,
      strike: 100 * Math.exp(standardDeviation),
      volatilityPerSecond,
    });
    expect(probability).toBeCloseTo(0.158655254, 6);
  });

  it('is unclamped in both tails', () => {
    const far = probabilityAboveStrike({
      currentPrice: 100,
      secondsRemaining: 60,
      strike: 1_000_000,
      volatilityPerSecond: 0.0001,
    });
    expect(far).toBeLessThan(1e-9);
    expect(far).toBeGreaterThanOrEqual(0);
  });

  it('refuses every input that makes the model meaningless', () => {
    const base = {
      currentPrice: 100,
      secondsRemaining: 900,
      strike: 100,
      volatilityPerSecond: 0.001,
    };
    expect(probabilityAboveStrike({ ...base, strike: 0 })).toBeUndefined();
    expect(probabilityAboveStrike({ ...base, currentPrice: -1 })).toBeUndefined();
    expect(probabilityAboveStrike({ ...base, volatilityPerSecond: 0 })).toBeUndefined();
    expect(probabilityAboveStrike({ ...base, secondsRemaining: -1 })).toBeUndefined();
    expect(probabilityAboveStrike({ ...base, secondsRemaining: Number.NaN })).toBeUndefined();
    // A volatility so large the standard deviation overflows is not an answer either.
    expect(
      probabilityAboveStrike({ ...base, volatilityPerSecond: Number.MAX_VALUE }),
    ).toBeUndefined();
  });
});

describe('boundedBasisProbability', () => {
  it('clamps to the published bounds and leaves the middle alone', () => {
    expect(boundedBasisProbability(0.0001)).toBe(BASIS_PROBABILITY_BOUNDS.lower);
    expect(boundedBasisProbability(0.9999)).toBe(BASIS_PROBABILITY_BOUNDS.upper);
    expect(boundedBasisProbability(0.42)).toBe(0.42);
  });
});
