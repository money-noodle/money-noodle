import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildMakerShadow } from './maker-shadow';
import type { PaperOrder } from './types';

let seq = 0;
const order = (over: Partial<PaperOrder> = {}): PaperOrder => {
  seq += 1;
  return {
    id: `o${seq}`, executionMode: 'paper', symbol: 'BTC', venue: 'kalshi', contractId: `c${seq}`,
    side: 'UP', status: 'won', createdAt: '2026-08-13T00:00:00Z', calculationAt: '2026-08-13T00:00:00Z',
    closesAt: `2026-08-13T00:${String(seq % 60).padStart(2, '0')}:00Z`,
    modelProbabilityUp: 0.6, confidence: 0.7,
    askPrice: 0.50, bidPrice: 0.40, spread: 0.10, quantity: 10,
    stakeCents: 500, feeCents: 17, potentialPayoutCents: 1_000,
    payoutCents: 1_000, pnlCents: 500, settledAt: '2026-08-13T00:15:00Z', outcome: 'UP',
    makerFillEstimate: { probability: 0.5, horizonSeconds: 12, quoteDistance: 0.1, quoteVolatilityPerSecond: 0.01, samples: 40, model: 'quote-first-passage-v1' },
    ...over,
  } as PaperOrder;
};

describe('maker-execution shadow', () => {
  it('prices the same settled outcome at the fee-free maker bid, which beats the taker ask', () => {
    const [row] = buildMakerShadow([order()], 'paper').rows;
    expect(row.askReturn).toBeCloseTo(1.0, 2); // 500c actual ask stake, 1000c returned
    expect(row.makerReturn).toBeCloseTo(1.5, 9); // 10 × 40c maker purchase, zero maker fee
  });

  it('discounts by the chance the resting order never traded', () => {
    const [row] = buildMakerShadow([order()], 'paper').rows;
    expect(row.expectedMakerReturn!).toBeCloseTo(row.makerReturn! * 0.5, 6);
  });

  it('treats an unfilled maker order as earning nothing rather than losing', () => {
    const never = order({ makerFillEstimate: { probability: 0, horizonSeconds: 12, quoteDistance: 0.2, quoteVolatilityPerSecond: 0.01, samples: 40, model: 'quote-first-passage-v1' } });
    expect(buildMakerShadow([never], 'paper').rows[0].expectedMakerReturn).toBe(0);
  });

  it('improves a loser too, since a cheaper entry loses less', () => {
    const loser = order({ status: 'lost', outcome: 'DOWN', payoutCents: 0, pnlCents: -500 });
    const [row] = buildMakerShadow([loser], 'paper').rows;
    expect(row.askReturn).toBeCloseTo(-1, 6);
    expect(row.makerReturn!).toBeCloseTo(-1, 6); // a total loss is total either way
  });

  it('reports no maker figure when the bid is unusable rather than guessing one', () => {
    const noBid = order({ bidPrice: 0 });
    const [row] = buildMakerShadow([noBid], 'paper').rows;
    expect(row.makerReturn).toBeNull();
    expect(row.expectedMakerReturn).toBeNull();
  });

  it('excludes orders with no recorded fill estimate from the weighted figures', () => {
    const report = buildMakerShadow([order(), order({ makerFillEstimate: undefined })], 'paper');
    expect(report.settled).toBe(2);
    expect(report.modelled).toBe(1);
  });

  it('clusters by settlement window, so one window is one observation', () => {
    const shared = '2026-08-13T01:00:00Z';
    const report = buildMakerShadow([order({ closesAt: shared }), order({ closesAt: shared }), order({ closesAt: '2026-08-13T02:00:00Z' })], 'paper');
    expect(report.settled).toBe(3);
    expect(report.windows).toBe(2);
  });

  it('never mixes execution modes', () => {
    const report = buildMakerShadow([order({ executionMode: 'live' })], 'paper');
    expect(report.settled).toBe(0);
  });

  it('ignores exit legs, which are reduce-only rather than maker entries', () => {
    expect(buildMakerShadow([order({ id: 'x:exit:1' })], 'paper').settled).toBe(0);
  });
});

describe('shadow cohorts, tail concentration, and segments', () => {
  const win = (n: number, pnlCents: number, symbol = 'BTC') => order({
    id: `w${n}-${symbol}`, symbol, closesAt: `2026-08-13T${String(n).padStart(2, '0')}:00:00Z`,
    status: pnlCents >= 0 ? 'won' : 'lost', pnlCents, payoutCents: 500 + pnlCents,
    outcome: pnlCents >= 0 ? 'UP' : 'DOWN',
  });

  it('splits cohorts chronologically, so a decaying edge is visible', () => {
    const report = buildMakerShadow([win(1, 500), win(2, 500), win(3, -500), win(4, -500)], 'paper');
    expect(report.cohorts.map((c) => c.label)).toEqual(['earlier half', 'recent half']);
    expect(report.cohorts[0].askReturn!).toBeGreaterThan(report.cohorts[1].askReturn!);
  });

  it('withholds cohorts when there are too few windows to split meaningfully', () => {
    expect(buildMakerShadow([win(1, 500), win(2, 500)], 'paper').cohorts).toEqual([]);
  });

  it('exposes a book carried by a few windows', () => {
    // One large winner against many small losers: the total is the outlier.
    const rows = [win(1, 5_000), ...Array.from({ length: 9 }, (_, i) => win(i + 2, -100))];
    const { tail } = buildMakerShadow(rows, 'paper');
    expect(tail.topWindowShare!).toBeGreaterThan(0.5);
    expect(tail.withoutTopThree).toBeLessThan(0);
    expect(tail.topWindowContribution).toBeGreaterThan(0);
  });

  it('reports a book that does not depend on its best windows differently', () => {
    const rows = Array.from({ length: 10 }, (_, i) => win(i + 1, 100));
    const { tail } = buildMakerShadow(rows, 'paper');
    expect(tail.topThreeShare!).toBeLessThan(0.5);
    expect(tail.withoutTopThree).toBeGreaterThan(0);
  });

  it('withholds a share of a losing book, which would read as the opposite of its meaning', () => {
    // One outsized winner against many losers: the book is negative overall but the top window is
    // what keeps it from being far worse. Needs enough windows that "top three" is not most of them.
    const losing = [win(1, 2_500), ...Array.from({ length: 9 }, (_, i) => win(i + 2, -500))];
    const { tail } = buildMakerShadow(losing, 'paper');
    expect(tail.totalWindowReturn).toBeLessThan(0);
    expect(tail.topWindowShare).toBeNull();
    expect(tail.topThreeShare).toBeNull();
    // The absolute figures still say what carried the book.
    expect(tail.topWindowContribution).toBeGreaterThan(0);
    expect(tail.withoutTopThree).toBeLessThan(tail.totalWindowReturn);
  });

  it('segments by symbol, ranked so the worst asset is visible', () => {
    const report = buildMakerShadow([win(1, 500, 'BTC'), win(2, 500, 'BTC'), win(3, -500, 'SOL'), win(4, -500, 'SOL')], 'paper');
    expect(report.bySymbol.map((s) => s.symbol)).toEqual(['BTC', 'SOL']);
    expect(report.bySymbol.at(-1)!.expectedMakerReturn!).toBeLessThan(report.bySymbol[0].expectedMakerReturn!);
  });
});

describe('shadow columns across the maker-execution boundary', () => {
  const base = {
    id: 'paper:BTC:UP:1', closesAt: '2026-08-14T01:00:00Z', executionMode: 'paper' as const,
    symbol: 'BTC', venue: 'kalshi' as const, side: 'UP' as const, status: 'won' as const,
    quantity: 4, spread: 0.02, payoutCents: 400,
  };

  it('re-prices the ask side for an order that executed as a maker', () => {
    // Filled at its resting bid of 43c; the always-fills benchmark is the 45c ask it never paid.
    const maker = { ...base, liquidityRole: 'maker' as const, askPrice: 0.45, issuanceAskPrice: 0.45,
      bidPrice: 0.43, initialSubmittedPrice: 0.43, authoritativeFillPrice: 0.43,
      stakeCents: 177, pnlCents: 223 } as unknown as PaperOrder;
    const [row] = buildMakerShadow([maker], 'paper').rows;
    expect(row.makerReturn).toBeCloseTo(223 / 177, 6);   // realized, because it is the maker
    expect(row.askReturn).toBeLessThan(row.makerReturn!); // the ask costs more, so it earns less
    // It already survived the fill risk, so no probability is applied a second time.
    expect(row.fillProbability).toBeNull();
    expect(row.expectedMakerReturn).toBe(row.makerReturn);
  });

  it('keeps the legacy ask-filled convention for orders that predate the change', () => {
    const taker = { ...base, askPrice: 0.45, bidPrice: 0.43, stakeCents: 185, pnlCents: 215,
      makerFillEstimate: { probability: 0.5, horizonSeconds: 12, quoteDistance: 0.02,
        quoteVolatilityPerSecond: 0.01, samples: 7, model: 'quote-first-passage-v1' as const },
    } as unknown as PaperOrder;
    const [row] = buildMakerShadow([taker], 'paper').rows;
    expect(row.askReturn).toBeCloseTo(215 / 185, 6);      // realized, because it took the ask
    expect(row.makerReturn).toBeGreaterThan(row.askReturn); // the bid is cheaper, so it earns more
    expect(row.expectedMakerReturn).toBeCloseTo(row.makerReturn! * 0.5, 6);
  });
});
