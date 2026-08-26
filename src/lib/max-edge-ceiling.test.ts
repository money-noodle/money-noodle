import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { bestEntry, MAX_NET_EDGE, maximumNetEdge, qualifiesVenueBuyEdge, venueEntryOptions } from './prediction-policy';

/** An implausibly cheap UP ask against a confident model: edge far above the ceiling. */
const absurd = {
  modelProbabilityUp: 0.75, confidence: 0.7, enabledTradingVenues: ['kalshi' as const],
  market: { live: false } as never,
  kalshi: { live: true, askUp: 0.10, askDown: 0.95 } as never,
};
/** A normal candidate comfortably inside the band. */
const ordinary = {
  modelProbabilityUp: 0.62, confidence: 0.7, enabledTradingVenues: ['kalshi' as const],
  market: { live: false } as never,
  kalshi: { live: true, askUp: 0.50, askDown: 0.52 } as never,
};

afterEach(() => { delete process.env.MONEY_NOODLE_MAX_NET_EDGE; });

describe('maximum net edge', () => {
  it('is disarmed by default at v20, so the ceiling refuses nothing until it is configured', () => {
    expect(maximumNetEdge()).toBe(MAX_NET_EDGE);
    expect(MAX_NET_EDGE).toBe(1);
    // The absurd claim is now admitted, which is the whole of what v20 changed here.
    expect(bestEntry(absurd)?.side).toBe('UP');
    expect(qualifiesVenueBuyEdge(absurd, 'kalshi', 'UP')).toBe(true);
  });

  it('still refuses a claim above the ceiling once one is configured', () => {
    process.env.MONEY_NOODLE_MAX_NET_EDGE = '0.35';
    expect(venueEntryOptions(absurd)[0].netEdge).toBeGreaterThan(0.35);
    expect(bestEntry(absurd)).toBeUndefined();
    expect(qualifiesVenueBuyEdge(absurd, 'kalshi', 'UP')).toBe(false);
  });

  it('leaves ordinary edges untouched', () => {
    const entry = bestEntry(ordinary);
    expect(entry?.side).toBe('UP');
    expect(entry!.netEdge).toBeLessThan(maximumNetEdge());
    expect(qualifiesVenueBuyEdge(ordinary, 'kalshi', 'UP')).toBe(true);
  });

  it('is restrictive only: it can refuse a trade but never authorize one below the floor', () => {
    process.env.MONEY_NOODLE_MAX_NET_EDGE = '1';
    expect(maximumNetEdge()).toBe(1);
    // A candidate below the v20 floor of -5pp is still refused with the ceiling wide open.
    const flat = { ...ordinary, modelProbabilityUp: 0.56, kalshi: { live: true, askUp: 0.65, askDown: 0.4 } as never };
    expect(qualifiesVenueBuyEdge(flat, 'kalshi', 'UP')).toBe(false);
  });

  it('can be reconfigured without a code change', () => {
    process.env.MONEY_NOODLE_MAX_NET_EDGE = '0.10';
    expect(maximumNetEdge()).toBe(0.10);
    expect(bestEntry(ordinary)).toBeUndefined();
  });

  it('ignores a malformed override rather than disabling the ceiling', () => {
    process.env.MONEY_NOODLE_MAX_NET_EDGE = 'not-a-number';
    expect(maximumNetEdge()).toBe(MAX_NET_EDGE);
  });
});
