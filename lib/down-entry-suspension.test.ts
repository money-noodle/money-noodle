import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { bestEntry, bestEntryForSide, downEntryEnabled, qualifiesVenueBuyEdge, venueEntryOptions } from './prediction-policy';

/** A market where DOWN is clearly the better expected value, so the DOWN control is what decides. */
// Edge kept inside the 35pp ceiling: this fixture tests the DOWN gate, not the edge bound.
const bearish = {
  modelProbabilityUp: 0.35, confidence: 0.7, enabledTradingVenues: ['kalshi' as const],
  market: { live: false } as never,
  kalshi: { live: true, askUp: 0.62, askDown: 0.45 } as never,
};

const clear = () => { delete process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY; };
afterEach(clear);

describe('DOWN entry', () => {
  it('is permitted by default, the v14 suspension having been withdrawn', () => {
    expect(downEntryEnabled()).toBe(true);
  });

  it('takes a DOWN entry when DOWN carries the better expected value', () => {
    expect(venueEntryOptions(bearish)[0].side).toBe('DOWN');
    expect(bestEntry(bearish)?.side).toBe('DOWN');
    expect(bestEntryForSide(bearish, 'DOWN')?.side).toBe('DOWN');
  });

  it('qualifies through the inline path as well as the shared admissibility check', () => {
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi', 'DOWN')).toBe(true);
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi')).toBe(true);
  });

  it('leaves UP entry untouched', () => {
    const bullish = { ...bearish, modelProbabilityUp: 0.65, kalshi: { live: true, askUp: 0.45, askDown: 0.62 } as never };
    expect(bestEntry(bullish)?.side).toBe('UP');
    expect(qualifiesVenueBuyEdge(bullish, 'kalshi', 'UP')).toBe(true);
  });
});

describe('the DOWN suspension switch', () => {
  it('closes every entry path when suspended', () => {
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY = 'false';
    expect(downEntryEnabled()).toBe(false);
    expect(bestEntry(bearish)).toBeUndefined();
    expect(bestEntryForSide(bearish, 'DOWN')).toBeUndefined();
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi', 'DOWN')).toBe(false);
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi')).toBe(false);
  });

  it('takes no track argument, so live and paper cannot diverge on it', () => {
    // One switch by construction. A DOWN experiment on one track only is a candidate policy,
    // which belongs in the evaluation lane and never touches these functions. See SPEC 12.3.
    expect(downEntryEnabled.length).toBe(0);
    expect(bestEntry.length).toBe(1);
    expect(qualifiesVenueBuyEdge.length).toBe(3);
  });

  it('treats any value other than the literal false as enabled', () => {
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY = 'true';
    expect(downEntryEnabled()).toBe(true);
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY = '';
    expect(downEntryEnabled()).toBe(true);
  });
});
