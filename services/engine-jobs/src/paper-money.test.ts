import { describe, expect, it } from 'vitest';
import {
  estimatePaperFill,
  venueFeeCents,
  paperEntryStakeLimit,
  paperMakerAccounting,
  paperSettlementTerms,
} from './domain/paper-money.js';
import {
  floorToValidKalshiPrice,
  advanceValidKalshiPrice,
  backOffValidKalshiPrice,
  boundedTakerLimit,
  initialManagedMakerPrice,
  nextManagedMakerPrice,
  selectedManagedMakerQuote,
} from './domain/paper-pricing.js';
import { selectedSideDepth } from './domain/paper-depth.js';
describe('historical paper arithmetic, no runtime authority', () => {
  it('charges 7c at four half-dollar taker contracts, zero on simulated Kalshi maker', () => {
    // 100 * 4 * .07 * .5 * .5 = 7, not 8 from representation dust.
    expect(venueFeeCents('kalshi', 50, 4, 'taker')).toBe(7);
    expect(venueFeeCents('kalshi', 50, 4, 'maker')).toBe(0);
    expect(venueFeeCents('kalshi', 1, 0.01, 'taker')).toBe(1);
    expect(venueFeeCents('polymarket', 50, 4, 'maker')).toBe(2);
  });
  it('reserves at taker fees and preserves decimal vs whole-contract sizing', () => {
    expect(estimatePaperFill(207, 0.5, 'kalshi')).toEqual({
      quantity: 4,
      limitPriceCents: 50,
      purchaseCents: 200,
      feeCents: 7,
      stakeCents: 207,
      potentialPayoutCents: 400,
    });
    // 3.86 * 45 = 173.7 -> 174; fee 6.68745 -> 7; 3.87 would require182.
    expect(estimatePaperFill(181, 0.45, 'kalshi')).toMatchObject({
      quantity: 3.86,
      purchaseCents: 174,
      feeCents: 7,
      stakeCents: 181,
      potentialPayoutCents: 386,
    });
    expect(estimatePaperFill(207, 0.5, 'polymarket')).toMatchObject({
      quantity: 4,
      purchaseCents: 200,
      feeCents: 2,
      stakeCents: 202,
    });
    for (const cap of [0, -1, 0.5, Number.NaN])
      expect(estimatePaperFill(cap, 0.5, 'kalshi')).toBeNull();
    for (const ask of [0, 1, Number.NaN]) expect(estimatePaperFill(207, ask, 'kalshi')).toBeNull();
    expect(estimatePaperFill(1, 0.99, 'polymarket')).toBeNull();
  });
  it('quantizes reduction once; no default amount authorizes spending', () => {
    expect(paperEntryStakeLimit(101, 0.29)).toBe(31);
    expect(paperEntryStakeLimit(101, 0.3)).toBe(101);
    expect(paperEntryStakeLimit(0, 0.4)).toBeNull();
  });
  it('returns unused reserve after a fractional partial maker fill and conserves bankroll', () => {
    // Start1000, reserve207 => cash793. 1.25 * .58 *100 =72.5 ->73;
    // release134 => cash927, stake73. Win pays125 => cash1052, realized52.
    const fill = paperMakerAccounting({
      reservationCents: 207,
      filledCount: 1.25,
      purchaseCents: 72.5,
      averagePrice: 0.58,
      evidenceComplete: false,
      venue: 'kalshi',
    });
    expect(fill).toEqual({
      status: 'open',
      stakeCents: 73,
      feeCents: 0,
      releasedCents: 134,
      potentialPayoutCents: 125,
    });
    const won = paperSettlementTerms(73, 125, 'DOWN', 'DOWN');
    expect(won).toEqual({ status: 'won', payoutCents: 125, pnlCents: 52 });
    expect(1000 - 207 + fill.releasedCents + won.payoutCents).toBe(1052);
    expect(paperSettlementTerms(73, 125, 'DOWN', 'UP')).toEqual({
      status: 'lost',
      payoutCents: 0,
      pnlCents: -73,
    });
    expect(paperSettlementTerms(73, 125, 'DOWN', 'INVALID')).toEqual({
      status: 'invalid',
      payoutCents: 73,
      pnlCents: 0,
    });
  });
  it('does not confuse unavailable evidence with a definitive maker miss', () => {
    // A no-fill plan must not overwrite the original issuance stake/fee/quantity.
    const zero = {
      reservationCents: 207,
      filledCount: 0,
      purchaseCents: 0,
      averagePrice: 0,
      venue: 'kalshi' as const,
    };
    expect(paperMakerAccounting({ ...zero, evidenceComplete: true })).toMatchObject({
      status: 'unfilled',
      releasedCents: 207,
    });
    expect(paperMakerAccounting({ ...zero, evidenceComplete: false })).toMatchObject({
      status: 'rejected',
      releasedCents: 207,
    });
    expect(() =>
      paperMakerAccounting({ ...zero, purchaseCents: 1, evidenceComplete: true }),
    ).toThrow();
    expect(() =>
      paperMakerAccounting({
        ...zero,
        filledCount: 4,
        purchaseCents: 208,
        averagePrice: 0.52,
        evidenceComplete: true,
      }),
    ).toThrow();
    expect(() =>
      paperMakerAccounting({
        ...zero,
        filledCount: 1,
        purchaseCents: 50,
        averagePrice: 0.6,
        evidenceComplete: true,
      }),
    ).toThrow();
    expect(() => venueFeeCents('kalshi', 0, 1, 'maker')).toThrow();
    expect(() => venueFeeCents('kalshi', 50, -1, 'maker')).toThrow();
    expect(() => paperSettlementTerms(-1, 100, 'UP', 'UP')).toThrow();
  });
});
describe('exact passive price ladder and displayed depth proxy', () => {
  const ranges = [{ start: '0', end: '1', step: '0.01' }];
  it('starts below exact ask and reprices only during five amendment opportunities', () => {
    expect(
      initialManagedMakerPrice({
        quote: { bid: 0.38, ask: 0.42, ranges },
        maximumPrice: 0.47,
        requestedStart: 0.46,
      }),
    ).toBe(0.41);
    expect(
      nextManagedMakerPrice({
        quote: { bid: 0.42, ask: 0.44, ranges },
        maximumPrice: 0.47,
        currentPrice: 0.41,
        managementAttempt: 0,
      }),
    ).toBe(0.42);
    expect(
      nextManagedMakerPrice({
        quote: { bid: 0.42, ask: 0.44, ranges },
        maximumPrice: 0.47,
        currentPrice: 0.41,
        managementAttempt: 5,
      }),
    ).toBe(0.41);
    expect(initialManagedMakerPrice({ quote: { bid: 0, ask: 0.01 }, maximumPrice: 0.01 })).toBe(0);
  });
  it('converts DOWN quote and advances/backoffs exact ticks across a tapered boundary', () => {
    const down = selectedManagedMakerQuote({ yesBid: 0.4, yesAsk: 0.42, side: 'DOWN', ranges });
    expect(down.bid).toBeCloseTo(0.58);
    expect(down.ask).toBeCloseTo(0.6);
    expect(selectedManagedMakerQuote({ yesBid: 0.4, yesAsk: 0.42, side: 'UP' })).toMatchObject({
      bid: 0.4,
      ask: 0.42,
    });
    const taper = [
      { start: '0', end: '0.1', step: '0.001' },
      { start: '0.1', end: '0.9', step: '0.01' },
    ];
    expect(floorToValidKalshiPrice(0.105, taper)).toBe(0.1);
    expect(advanceValidKalshiPrice(0.099, 2, taper)).toBe(0.11);
    expect(backOffValidKalshiPrice(0.11, 2, taper)).toBe(0.099);
    expect(boundedTakerLimit({ ask: 0.42, maximumPrice: 0.5, cushionTicks: 2 })).toEqual({
      limit: 0.44,
      tickSize: 0.01,
    });
    expect(boundedTakerLimit({ ask: 0.425, maximumPrice: 0.5, cushionTicks: 2 })).toBeNull();
  });
  it('counts quantity at-or-better as a proxy, not private queue rank', () => {
    const book = {
      observedAt: 'synthetic',
      yesBids: [
        { price: 0.43, quantity: 3 },
        { price: 0.42, quantity: 7 },
        { price: 0.41, quantity: 20 },
      ],
      noBids: [{ price: 0.55, quantity: 5 }],
    };
    expect(selectedSideDepth(book, 'UP', 0.43, 0.45, 0.42)).toEqual({
      bestBidDepth: 3,
      bestAskDepth: 5,
      displayedAtLimit: 7,
      displayedAhead: 10,
      depthImbalance: 0.375,
    });
    expect(selectedSideDepth(book, 'DOWN', 0.55, 0.57, 0.55)).toMatchObject({
      bestBidDepth: 5,
      bestAskDepth: 3,
      displayedAhead: 5,
    });
    expect(selectedSideDepth(undefined, 'UP', 0.43, 0.45).displayedAhead).toBeUndefined();
  });
});
