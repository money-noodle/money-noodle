import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { parseKalshiTradePrints } from './kalshi-market-data';

describe('Kalshi public trade prints', () => {
  it('parses fixed-point prices, quantity, time, and aggressor outcome', () => {
    expect(parseKalshiTradePrints([{
      trade_id: 'trade-1', ticker: 'KXBTC', created_time: '2026-08-15T00:28:09.890733Z',
      count_fp: '13.21', yes_price_dollars: '0.4500', no_price_dollars: '0.5500',
      taker_book_side: 'ask', taker_outcome_side: 'no', taker_side: 'no',
    }])).toEqual([{
      id: 'trade-1', ticker: 'KXBTC', at: '2026-08-15T00:28:09.890733Z', count: 13.21,
      yesPrice: 0.45, noPrice: 0.55, takerSide: 'no',
    }]);
  });

  it('drops malformed rows rather than treating them as queue evidence', () => {
    expect(parseKalshiTradePrints([
      { trade_id: 'missing-count', ticker: 'KX', created_time: '2026-08-15T00:00:00Z', yes_price_dollars: '0.4', no_price_dollars: '0.6', taker_side: 'no' },
      { trade_id: 'bad-side', ticker: 'KX', created_time: '2026-08-15T00:00:00Z', count_fp: '2', yes_price_dollars: '0.4', no_price_dollars: '0.6', taker_side: 'unknown' },
    ])).toEqual([]);
  });
});
