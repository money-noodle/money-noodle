import { describe, expect, it } from 'vitest';
import { estimateMakerTouch, quoteVolatilityPerSecond } from './maker-fill-model';

const history = [0.50, 0.49, 0.51, 0.48, 0.50].map((ask, index) => ({ time: index * 10_000, ask }));

describe('observation-only maker first-passage model', () => {
  it('estimates quote volatility from time-normalized ask changes', () => {
    const result = quoteVolatilityPerSecond(history)!;
    expect(result.samples).toBe(4);
    expect(result.volatility).toBeGreaterThan(0);
  });

  it('assigns a higher touch probability to a nearer passive bid', () => {
    const near = estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.49, quoteHistory: history })!;
    const far = estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.4, quoteHistory: history })!;
    expect(near.probability).toBeGreaterThan(far.probability);
    expect(near.model).toBe('quote-first-passage-v1');
    expect(near.horizonSeconds).toBe(12);
  });

  it('fails closed with flat, thin, or crossing quote data', () => {
    expect(estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.49, quoteHistory: history.slice(0, 3) })).toBeNull();
    expect(estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.5, quoteHistory: history })).toBeNull();
    expect(estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.49, quoteHistory: history.map((point) => ({ ...point, ask: 0.5 })) })).toBeNull();
  });
});

// The first-passage suite above still applies: the model is retained as a diagnostic, so its
// behaviour must stay correct even though it no longer decides anything.
import { estimateMakerFill, MAKER_FILL_BASE_RATE, MAKER_FILL_PRIOR_ATTEMPTS } from './maker-fill-model';

const touch = (probability: number) => ({
  probability, horizonSeconds: 12, quoteDistance: 0.02,
  quoteVolatilityPerSecond: 0.01, samples: 7, model: 'quote-first-passage-v1' as const,
});

describe('empirical maker fill estimate', () => {
  it('ignores the first-passage probability, which validated as inverted', () => {
    // Same cohort, opposite touch predictions: the reported fill probability must not move, because
    // sorting 623 recorded attempts by touch produced observed fills of 66/61/57/52% against
    // predictions of 12/41/64/86%. A signal that is backwards is not worth blending in.
    const low = estimateMakerFill({ touch: touch(0.05), cohortAttempts: 40, cohortFills: 20 })!;
    const high = estimateMakerFill({ touch: touch(0.95), cohortAttempts: 40, cohortFills: 20 })!;
    expect(low.probability).toBe(high.probability);
    expect(low.touchProbability).toBe(0.05);
    expect(high.touchProbability).toBe(0.95);
  });

  it('falls back to the base rate when no comparable attempts exist', () => {
    const estimate = estimateMakerFill({ touch: touch(0.9) })!;
    expect(estimate.probability).toBeCloseTo(MAKER_FILL_BASE_RATE, 10);
    expect(estimate.cohortFillRate).toBeNull();
  });

  it('shrinks a thin cohort toward the base rate and trusts a thick one', () => {
    const thin = estimateMakerFill({ touch: touch(0.5), cohortAttempts: 2, cohortFills: 0 })!;
    const thick = estimateMakerFill({ touch: touch(0.5), cohortAttempts: 400, cohortFills: 0 })!;
    expect(thin.probability).toBeGreaterThan(0.45);
    expect(thick.probability).toBeLessThan(0.05);
    const even = estimateMakerFill({ touch: touch(0.5), cohortAttempts: MAKER_FILL_PRIOR_ATTEMPTS, cohortFills: MAKER_FILL_PRIOR_ATTEMPTS })!;
    expect(even.probability).toBeCloseTo((MAKER_FILL_PRIOR_ATTEMPTS + MAKER_FILL_PRIOR_ATTEMPTS * MAKER_FILL_BASE_RATE) / (2 * MAKER_FILL_PRIOR_ATTEMPTS), 10);
  });

  it('stays inside [0,1] and records what it was calibrated on', () => {
    const estimate = estimateMakerFill({ touch: touch(0.5), cohortLabel: '25-50c · 1-2c', cohortAttempts: 10, cohortFills: 7 })!;
    expect(estimate.probability).toBeGreaterThan(0);
    expect(estimate.probability).toBeLessThan(1);
    expect(estimate).toMatchObject({ model: 'maker-fill-empirical-v2', cohortLabel: '25-50c · 1-2c', cohortAttempts: 10, cohortFillRate: 0.7 });
  });

  it('returns nothing when the touch estimate itself is unavailable', () => {
    expect(estimateMakerFill({ touch: null, cohortAttempts: 50, cohortFills: 30 })).toBeNull();
    // Guard the input contract of the retained diagnostic too.
    expect(estimateMakerTouch({ currentAsk: 0.4, passiveBid: 0.45, quoteHistory: [] })).toBeNull();
  });
});
