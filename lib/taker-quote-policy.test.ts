import { describe, expect, it } from 'vitest';
import { MAX_TAKER_QUOTE_MOVEMENT, refreshedAskFitsTakerCap, takerQuoteCap } from './taker-quote-policy';
import { MAX_ENTRY_PRICE } from './prediction-policy';

describe('taker quote movement cap', () => {
  it('allows at most one cent above the issuance ask', () => {
    const cap = takerQuoteCap(0.28)!;
    expect(cap.maximumPrice).toBeCloseTo(0.29, 12);
    expect(cap.movementLimit).toBeCloseTo(MAX_TAKER_QUOTE_MOVEMENT, 12);
    expect(refreshedAskFitsTakerCap(0.29, cap)).toBe(true);
    expect(refreshedAskFitsTakerCap(0.290_000_002, cap)).toBe(false);
  });

  it('never relaxes beyond the entry policy price ceiling', () => {
    // Written against MAX_ENTRY_PRICE rather than a literal band. The claim is that the one-cent
    // tolerance tracks the policy ceiling wherever it sits; a fixture pinned to one band silently
    // stops testing that the moment the band moves, which is what happened at v22.
    const halfCentBelowCeiling = MAX_ENTRY_PRICE - 0.005;
    const cap = takerQuoteCap(halfCentBelowCeiling)!;
    expect(cap.maximumPrice).toBe(MAX_ENTRY_PRICE);
    expect(cap.movementLimit).toBeCloseTo(0.005, 12);
    expect(refreshedAskFitsTakerCap(MAX_ENTRY_PRICE + 0.001, cap)).toBe(false);
  });

  it('fails closed on malformed or out-of-policy issuance prices', () => {
    expect(takerQuoteCap(Number.NaN)).toBeNull();
    expect(takerQuoteCap(0)).toBeNull();
    expect(takerQuoteCap(MAX_ENTRY_PRICE + 0.01)).toBeNull();
  });
});
