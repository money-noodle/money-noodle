import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { bestEntry, bestEntryForSide, downEntryEnabled, qualifiesVenueBuyEdge, venueEntryOptions } from './prediction-policy';

/** A market where DOWN is clearly the better expected value, so the suspension is what decides. */
const bearish = {
  modelProbabilityUp: 0.2, confidence: 0.7, enabledTradingVenues: ['kalshi' as const],
  market: { live: false } as never,
  kalshi: { live: true, askUp: 0.6, askDown: 0.3 } as never,
};

afterEach(() => { delete process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_LIVE;
  delete process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_PAPER; });

describe('DOWN entry suspension', () => {
  it('is off by default, so a restart cannot silently resume DOWN entry', () => {
    expect(downEntryEnabled()).toBe(false);
  });

  it('withholds a DOWN entry even when DOWN carries the better expected value', () => {
    // The option still exists and is still ranked first — the suspension gates entry, not analysis.
    expect(venueEntryOptions(bearish)[0].side).toBe('DOWN');
    expect(bestEntry(bearish)).toBeUndefined();
    expect(bestEntryForSide(bearish, 'DOWN')).toBeUndefined();
  });

  it('closes the inline qualification path as well as the shared admissibility check', () => {
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi', 'DOWN')).toBe(false);
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi')).toBe(false);
  });

  it('re-enables through the documented flag, so the suspension is reversible without a code change', () => {
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_LIVE = 'true';
    expect(downEntryEnabled()).toBe(true);
    expect(bestEntry(bearish)?.side).toBe('DOWN');
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi', 'DOWN')).toBe(true);
  });

  it('leaves UP entry untouched', () => {
    const bullish = { ...bearish, modelProbabilityUp: 0.8, kalshi: { live: true, askUp: 0.3, askDown: 0.6 } as never };
    expect(bestEntry(bullish)?.side).toBe('UP');
    expect(qualifiesVenueBuyEdge(bullish, 'kalshi', 'UP')).toBe(true);
  });
});

describe('per-track DOWN control', () => {
  afterEach(() => {
    delete process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_LIVE;
    delete process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_PAPER;
  });

  it('lets paper run DOWN while live stays suspended', () => {
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_PAPER = 'true';
    expect(downEntryEnabled('paper')).toBe(true);
    expect(downEntryEnabled('live')).toBe(false);
    expect(bestEntry(bearish, 'paper')?.side).toBe('DOWN');
    expect(bestEntry(bearish, 'live')).toBeUndefined();
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi', 'DOWN', 'paper')).toBe(true);
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi', 'DOWN', 'live')).toBe(false);
  });

  it('defaults an unspecified mode to live, so a forgotten argument cannot loosen the gate', () => {
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_PAPER = 'true';
    expect(downEntryEnabled()).toBe(false);
    expect(bestEntry(bearish)).toBeUndefined();
    expect(qualifiesVenueBuyEdge(bearish, 'kalshi', 'DOWN')).toBe(false);
  });

  it('keeps the two tracks independent in the other direction too', () => {
    process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY_LIVE = 'true';
    expect(downEntryEnabled('live')).toBe(true);
    expect(downEntryEnabled('paper')).toBe(false);
  });
});
