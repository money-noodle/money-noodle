import { describe, expect, it } from 'vitest';
import { parseKalshiOrderBook, selectedSideDepth, selectedSideOrderBook } from './order-book-depth';

describe('Kalshi order-book depth normalization', () => {
  const book = parseKalshiOrderBook({ orderbook_fp: {
    yes_dollars: [['0.40', '5'], ['0.41', '7']], no_dollars: [['0.57', '11'], ['0.58', '13']],
  } }, '2026-01-01T00:00:00Z')!;

  it('parses fixed-point bid ladders', () => {
    expect(book.yesBids).toEqual([{ price: 0.4, quantity: 5 }, { price: 0.41, quantity: 7 }]);
    expect(book.noBids.at(-1)).toEqual({ price: 0.58, quantity: 13 });
  });

  it('maps the opposite bid ladder to selected-side asks and reports only a queue proxy', () => {
    expect(selectedSideDepth(book, 'UP', 0.41, 0.42, 0.4)).toEqual({
      bestBidDepth: 7, bestAskDepth: 13, displayedAtLimit: 5, displayedAhead: 12, depthImbalance: 0.35,
    });
    expect(selectedSideDepth(book, 'DOWN', 0.58, 0.59, 0.58)).toMatchObject({
      bestBidDepth: 13, bestAskDepth: 7, displayedAtLimit: 13, displayedAhead: 13,
    });
  });

  it('normalizes bounded UP and DOWN ladders best-first with cumulative displayed depth', () => {
    const up = selectedSideOrderBook(book, 'UP', 2);
    expect(up).toMatchObject({
      side: 'UP', observedAt: '2026-01-01T00:00:00Z',
      bids: [
        { price: 0.41, quantity: 7, cumulativeQuantity: 7 },
        { price: 0.4, quantity: 5, cumulativeQuantity: 12 },
      ],
      asks: [
        { quantity: 13, cumulativeQuantity: 13 },
        { quantity: 11, cumulativeQuantity: 24 },
      ],
    });
    expect(up.asks[0].price).toBeCloseTo(0.42, 12);
    expect(up.asks[1].price).toBeCloseTo(0.43, 12);

    const down = selectedSideOrderBook(book, 'DOWN', 1);
    expect(down).toMatchObject({
      side: 'DOWN',
      bids: [{ price: 0.58, quantity: 13, cumulativeQuantity: 13 }],
      asks: [{ quantity: 7, cumulativeQuantity: 7 }],
    });
    expect(down.asks[0].price).toBeCloseTo(0.59, 12);
  });

  it('bounds requested ladder depth and drops zero-size levels', () => {
    const wide = parseKalshiOrderBook({ orderbook_fp: {
      yes_dollars: Array.from({ length: 25 }, (_, index) => [`${(index + 1) / 100}`, index === 24 ? '0' : '1']),
      no_dollars: [['0.50', '1']],
    } })!;
    expect(selectedSideOrderBook(wide, 'UP', 100).bids).toHaveLength(20);
    expect(selectedSideOrderBook(wide, 'UP', Number.NaN).bids).toHaveLength(10);
  });

  it('accepts the legacy integer-cent shape and fails closed on malformed books', () => {
    expect(parseKalshiOrderBook({ orderbook: { yes: [[40, 2]], no: [[60, 3]] } })?.yesBids[0]).toEqual({ price: 0.4, quantity: 2 });
    expect(parseKalshiOrderBook({ orderbook_fp: { yes_dollars: [['bad', 2]] } })).toBeUndefined();
  });
});
