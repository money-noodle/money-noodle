import { describe, expect, it } from 'vitest';
import {
  makerPostLadder, printsForSide, simulateMakerPost, staticMakerPost,
  type MakerPostPrint, type MakerPostRung,
} from './maker-post-observation';
import { MAKER_MANAGEMENT_CHECKS, MAKER_MANAGEMENT_POLL_MS } from './managed-maker';
import type { KalshiTradePrint } from './kalshi-market-data';

const HORIZON = MAKER_MANAGEMENT_CHECKS * MAKER_MANAGEMENT_POLL_MS;
const rung = (offsetMs: number, priceCents: number, queueAheadCents: number): MakerPostRung => ({ offsetMs, priceCents, queueAheadCents });
const print = (offsetMs: number, priceCents: number, count: number): MakerPostPrint => ({ offsetMs, priceCents, count });

const trade = (patch: Partial<KalshiTradePrint>): KalshiTradePrint => ({
  id: 't', ticker: 'KXBTC15M-X', at: '2026-08-18T00:00:05.000Z', count: 10,
  yesPrice: 0.43, noPrice: 0.57, takerSide: 'no', ...patch,
});

describe('simulateMakerPost', () => {
  it('fills only once volume through the price exceeds the queue ahead', () => {
    const rungs = [rung(0, 43, 100)];
    expect(simulateMakerPost(rungs, [print(1000, 43, 100)], HORIZON).outcome).toBe('unfilled');
    expect(simulateMakerPost(rungs, [print(1000, 43, 101)], HORIZON).outcome).toBe('filled');
  });

  it('is a strict inequality at the queue boundary across a grid of sizes', () => {
    for (const queue of [0, 1, 7, 100, 1633.52]) {
      const rungs = [rung(0, 50, queue)];
      expect(simulateMakerPost(rungs, [print(500, 50, queue)], HORIZON).outcome).toBe('unfilled');
      expect(simulateMakerPost(rungs, [print(500, 50, queue + 0.01)], HORIZON).outcome).toBe('filled');
    }
  });

  it('counts prints at or through the post price and ignores prints above it', () => {
    const rungs = [rung(0, 43, 0)];
    for (const priceCents of [1, 20, 42, 43]) {
      expect(simulateMakerPost(rungs, [print(100, priceCents, 5)], HORIZON).outcome).toBe('filled');
    }
    for (const priceCents of [44, 60, 99]) {
      expect(simulateMakerPost(rungs, [print(100, priceCents, 5000)], HORIZON).outcome).toBe('unfilled');
    }
  });

  it('resets consumed volume when the ladder reprices, because repricing joins a new queue', () => {
    const rungs = [rung(0, 43, 10), rung(2000, 44, 10)];
    // Nine at the first rung, then nine at the second: neither level alone clears its queue.
    const result = simulateMakerPost(rungs, [print(500, 43, 9), print(2500, 44, 9)], HORIZON);
    expect(result.outcome).toBe('unfilled');
    // Without the reset the eighteen would have filled it; with the reset eleven at the new rung does.
    expect(simulateMakerPost(rungs, [print(500, 43, 9), print(2500, 44, 11)], HORIZON).outcome).toBe('filled');
  });

  it('reports the rung it filled at, not the initial post price', () => {
    const rungs = [rung(0, 43, 1000), rung(2000, 45, 0)];
    const result = simulateMakerPost(rungs, [print(2500, 45, 1)], HORIZON);
    expect(result).toMatchObject({ outcome: 'filled', fillCents: 45, fillOffsetMs: 2500 });
  });

  it('ignores prints outside the horizon in both directions', () => {
    const rungs = [rung(0, 43, 0)];
    expect(simulateMakerPost(rungs, [print(-1, 43, 100)], HORIZON).outcome).toBe('unfilled');
    expect(simulateMakerPost(rungs, [print(HORIZON + 1, 43, 100)], HORIZON).outcome).toBe('unfilled');
    expect(simulateMakerPost(rungs, [print(HORIZON, 43, 100)], HORIZON).outcome).toBe('filled');
  });

  it('reports unobserved rather than unfilled when there is no ladder', () => {
    expect(simulateMakerPost([], [print(0, 43, 100)], HORIZON).outcome).toBe('unobserved');
  });

  it('never fills a post standing behind an unbounded queue, whatever the volume', () => {
    const rungs = [rung(0, 43, 1e6)];
    const prints = Array.from({ length: 50 }, (_, index) => print(index * 100, 43, 1000));
    expect(simulateMakerPost(rungs, prints, HORIZON).outcome).toBe('unfilled');
  });
});

describe('printsForSide', () => {
  const postedAt = Date.parse('2026-08-18T00:00:00.000Z');

  it('keeps only the taker direction that consumes a resting bid on the owned side', () => {
    const prints = [trade({ id: 'a', takerSide: 'no' }), trade({ id: 'b', takerSide: 'yes' })];
    const up = printsForSide(prints, 'UP', postedAt);
    const down = printsForSide(prints, 'DOWN', postedAt);
    expect(up).toHaveLength(1);
    expect(down).toHaveLength(1);
    expect(up[0].priceCents).toBeCloseTo(43, 9);
    expect(down[0].priceCents).toBeCloseTo(57, 9);
  });

  it('prices each side on its own scale', () => {
    const [up] = printsForSide([trade({ takerSide: 'no' })], 'UP', postedAt);
    const [down] = printsForSide([trade({ takerSide: 'yes' })], 'DOWN', postedAt);
    expect(up.priceCents).toBeCloseTo(43, 9);
    expect(down.priceCents).toBeCloseTo(57, 9);
  });

  it('drops malformed prints rather than admitting a zero or out-of-range price', () => {
    const bad = [
      trade({ id: 'x', yesPrice: 0 }), trade({ id: 'y', yesPrice: 1 }),
      trade({ id: 'z', count: 0 }), trade({ id: 'w', at: 'not-a-date' }),
    ];
    expect(printsForSide(bad, 'UP', postedAt)).toEqual([]);
  });
});

describe('makerPostLadder', () => {
  const quote = (bid: number, ask: number) => ({ bid, ask });

  it('walks the limit up from the bid toward the ask across the management checks', () => {
    const rungs = makerPostLadder({
      quoteAt: () => quote(0.43, 0.47),
      maximumPrice: 0.47,
      queueAheadAt: () => 10,
    });
    expect(rungs).not.toBeNull();
    const prices = rungs!.map((r) => r.priceCents);
    expect(prices[0]).toBe(43);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(prices[prices.length - 1]).toBeLessThan(47);
  });

  it('collapses repeated prices so a repriced-to-the-same-tick order keeps its queue progress', () => {
    const rungs = makerPostLadder({ quoteAt: () => quote(0.43, 0.44), maximumPrice: 0.44, queueAheadAt: () => 5 });
    expect(rungs!.map((r) => r.priceCents)).toEqual([43]);
  });

  it('never posts at or above the ask, and never above the issuance cap', () => {
    for (const [bid, ask, cap] of [[0.43, 0.47, 0.45], [0.10, 0.90, 0.5], [0.80, 0.82, 0.99]]) {
      const rungs = makerPostLadder({ quoteAt: () => quote(bid, ask), maximumPrice: cap, queueAheadAt: () => 0 });
      for (const r of rungs ?? []) {
        expect(r.priceCents).toBeLessThan(ask * 100);
        expect(r.priceCents).toBeLessThanOrEqual(cap * 100 + 1e-9);
      }
    }
  });

  it('returns null when no quote was recorded at the post instant', () => {
    expect(makerPostLadder({ quoteAt: () => undefined, maximumPrice: 0.5, queueAheadAt: () => 0 })).toBeNull();
  });

  it('truncates rather than extrapolating when the quote record runs out mid-horizon', () => {
    const rungs = makerPostLadder({
      quoteAt: (offset) => (offset <= MAKER_MANAGEMENT_POLL_MS ? quote(0.43, 0.49) : undefined),
      maximumPrice: 0.49,
      queueAheadAt: () => 1,
    });
    expect(rungs!.length).toBeGreaterThan(0);
    expect(rungs!.length).toBeLessThan(MAKER_MANAGEMENT_CHECKS);
  });

  it('refuses a rung whose queue depth was not observed', () => {
    expect(makerPostLadder({ quoteAt: () => quote(0.43, 0.47), maximumPrice: 0.47, queueAheadAt: () => undefined })).toBeNull();
  });
});

describe('staticMakerPost', () => {
  it('holds the initial rung for the whole horizon', () => {
    const ladder = [rung(0, 43, 10), rung(2000, 45, 0)];
    expect(staticMakerPost(ladder)).toEqual([rung(0, 43, 10)]);
  });

  it('is never more optimistic than the ladder it floors', () => {
    const ladder = [rung(0, 43, 5), rung(2000, 46, 0)];
    const prints = [print(2500, 46, 1)];
    expect(simulateMakerPost(ladder, prints, HORIZON).outcome).toBe('filled');
    expect(simulateMakerPost(staticMakerPost(ladder), prints, HORIZON).outcome).toBe('unfilled');
  });
});
