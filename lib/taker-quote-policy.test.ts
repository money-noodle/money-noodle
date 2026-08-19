import { describe, expect, it } from 'vitest';
import { MAX_TAKER_QUOTE_MOVEMENT, refreshedAskFitsTakerCap, takerQuoteCap } from './taker-quote-policy';

describe('taker quote movement cap', () => {
  it('allows at most one cent above the issuance ask', () => {
    const cap = takerQuoteCap(0.28)!;
    expect(cap.maximumPrice).toBeCloseTo(0.29, 12);
    expect(cap.movementLimit).toBeCloseTo(MAX_TAKER_QUOTE_MOVEMENT, 12);
    expect(refreshedAskFitsTakerCap(0.29, cap)).toBe(true);
    expect(refreshedAskFitsTakerCap(0.290_000_002, cap)).toBe(false);
  });

  it('never relaxes beyond the entry policy price ceiling', () => {
    const cap = takerQuoteCap(0.965)!;
    expect(cap.maximumPrice).toBe(0.97);
    expect(cap.movementLimit).toBeCloseTo(0.005, 12);
    expect(refreshedAskFitsTakerCap(0.971, cap)).toBe(false);
  });

  it('fails closed on malformed or out-of-policy issuance prices', () => {
    expect(takerQuoteCap(Number.NaN)).toBeNull();
    expect(takerQuoteCap(0)).toBeNull();
    expect(takerQuoteCap(0.98)).toBeNull();
  });
});
