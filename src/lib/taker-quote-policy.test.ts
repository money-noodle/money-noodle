import { describe, expect, it } from 'vitest';
import { makerMissTakerHardCeiling, makerMissTakerQuoteRefusal } from './taker-quote-policy';

const quote = { bid: 0.44, ask: 0.45, spread: 0.01, limit: 0.47, tickSize: 0.01 };
const quantity = 1;

describe('maker-miss taker quote policy', () => {
  it('caps the sequence from the final maker limit and the 75c absolute ceiling', () => {
    expect(makerMissTakerHardCeiling(0.40)).toBeCloseTo(0.50);
    expect(makerMissTakerHardCeiling(0.70)).toBeCloseTo(0.75);
    expect(makerMissTakerHardCeiling(Number.NaN)).toBeNull();
  });

  it('requires strictly positive fee-adjusted edge at the submitted limit', () => {
    expect(makerMissTakerQuoteRefusal({ quantity, probability: 0.60, referenceMidpoint: 0.445, quote })).toBeUndefined();
    expect(makerMissTakerQuoteRefusal({ quantity, probability: 0.48, referenceMidpoint: 0.445, quote })).toContain('not positive');
    expect(makerMissTakerQuoteRefusal({ quantity: 0.01, probability: 0.99, referenceMidpoint: 0.445, quote })).toContain('not positive');
  });

  it('allows a rising quote but refuses a midpoint decline beyond one venue tick', () => {
    expect(makerMissTakerQuoteRefusal({ quantity, probability: 0.70, referenceMidpoint: 0.40, quote })).toBeUndefined();
    expect(makerMissTakerQuoteRefusal({ quantity, probability: 0.70, referenceMidpoint: 0.455, quote })).toBeUndefined();
    expect(makerMissTakerQuoteRefusal({ quantity, probability: 0.70, referenceMidpoint: 0.455 + 2e-9, quote })).toContain('declined');
  });
});
