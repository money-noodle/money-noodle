import { describe, expect, it } from 'vitest';
import { basisProbability, impliedVolatility, logit, MAX_BASIS_PROBABILITY, MIN_BASIS_PROBABILITY, normalCdf, normalInverseCdf, realizedVolatility, resolveVolatility, sigmoid } from './basis-model';

describe('normal cdf', () => {
  it('matches known quantiles', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.6448536)).toBeCloseTo(0.95, 5);
    expect(normalCdf(-1.9599640)).toBeCloseTo(0.025, 5);
  });
});

describe('log-odds helpers', () => {
  it('round-trips', () => {
    expect(sigmoid(logit(0.37))).toBeCloseTo(0.37, 9);
    expect(logit(0.5)).toBeCloseTo(0, 9);
  });
});

describe('realized volatility', () => {
  it('requires a real sample instead of inventing one', () => {
    expect(realizedVolatility([100, 101, 102], 60)).toBeNull();
    expect(realizedVolatility([], 60)).toBeNull();
  });

  it('scales an interval estimate down to per-second volatility', () => {
    const closes = Array.from({ length: 61 }, (_, index) => 100 * Math.exp(index % 2 === 0 ? 0.001 : -0.001));
    const estimate = realizedVolatility(closes, 60);
    expect(estimate).not.toBeNull();
    expect(estimate!.samples).toBe(60);
    expect(estimate!.perSecond).toBeCloseTo(estimate!.perSecond, 12);
    expect(estimate!.perSecond * Math.sqrt(60)).toBeGreaterThan(0.001);
  });
});

describe('volatility resolution', () => {
  it('uses the primary estimator rather than the widest, so edge is not fabricated', () => {
    expect(resolveVolatility([{ perSecond: 0.0001, samples: 500 }, { perSecond: 0.0004, samples: 20 }])?.perSecond).toBe(0.0001);
    expect(resolveVolatility([null, { perSecond: 0.0004, samples: 20 }])?.perSecond).toBe(0.0004);
    expect(resolveVolatility([null, null])).toBeNull();
  });
});

describe('inverse normal cdf', () => {
  it('inverts the forward cdf', () => {
    for (const p of [0.01, 0.1, 0.3, 0.5, 0.77, 0.99]) expect(normalCdf(normalInverseCdf(p))).toBeCloseTo(p, 6);
  });
});

describe('implied volatility', () => {
  it('recovers the volatility a venue price implies', () => {
    const volatilityPerSecond = 0.0004;
    const secondsRemaining = 600;
    const priced = basisProbability({ referencePrice: 100, currentPrice: 100.3, secondsRemaining, volatilityPerSecond })!;
    const implied = impliedVolatility({ logBasis: priced.logBasis, marketProbability: priced.probabilityUp, secondsRemaining });
    expect(implied).toBeCloseTo(volatilityPerSecond, 8);
  });

  it('returns nothing when volatility cannot explain the market price', () => {
    // Basis is positive but the market says DOWN, which no positive volatility reconciles.
    expect(impliedVolatility({ logBasis: 0.002, marketProbability: 0.2, secondsRemaining: 600 })).toBeNull();
    expect(impliedVolatility({ logBasis: 0, marketProbability: 0.8, secondsRemaining: 600 })).toBeNull();
  });
});

describe('contract basis probability', () => {
  const volatilityPerSecond = 0.0004;

  it('is a coin flip exactly at the reference price', () => {
    const result = basisProbability({ referencePrice: 100, currentPrice: 100, secondsRemaining: 600, volatilityPerSecond });
    // Tolerance reflects the documented 7.5e-8 bound of the normal CDF approximation.
    expect(result!.probabilityUp).toBeCloseTo(0.5, 7);
  });

  it('grows more decisive as the settlement window approaches', () => {
    const far = basisProbability({ referencePrice: 100, currentPrice: 100.2, secondsRemaining: 800, volatilityPerSecond })!;
    const near = basisProbability({ referencePrice: 100, currentPrice: 100.2, secondsRemaining: 120, volatilityPerSecond })!;
    expect(near.probabilityUp).toBeGreaterThan(far.probabilityUp);
    expect(far.probabilityUp).toBeGreaterThan(0.5);
  });

  it('applies no safety padding to volatility, which would fabricate edge on cheap contracts', () => {
    // A one-standard-deviation move must price at exactly the normal quantile, not wider.
    const secondsRemaining = 600;
    const sd = volatilityPerSecond * Math.sqrt(secondsRemaining - 30);
    const result = basisProbability({ referencePrice: 100, currentPrice: 100 * Math.exp(-sd), secondsRemaining, volatilityPerSecond })!;
    expect(result.zScore).toBeCloseTo(-1, 9);
    expect(result.probabilityUp).toBeCloseTo(normalCdf(-1), 7);
  });

  it('mirrors symmetric moves and stays clamped', () => {
    const up = basisProbability({ referencePrice: 100, currentPrice: 108, secondsRemaining: 60, volatilityPerSecond })!;
    const down = basisProbability({ referencePrice: 100, currentPrice: 100 / 1.08, secondsRemaining: 60, volatilityPerSecond })!;
    expect(up.probabilityUp).toBeCloseTo(MAX_BASIS_PROBABILITY, 9);
    expect(down.probabilityUp).toBeCloseTo(MIN_BASIS_PROBABILITY, 9);
  });

  it('fails closed on unusable inputs', () => {
    expect(basisProbability({ referencePrice: 0, currentPrice: 100, secondsRemaining: 100, volatilityPerSecond })).toBeNull();
    expect(basisProbability({ referencePrice: 100, currentPrice: 100, secondsRemaining: 100, volatilityPerSecond: 0 })).toBeNull();
  });
});
