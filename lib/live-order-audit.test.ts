import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./kalshi-api', () => ({
  kalshiConfigured: () => true,
  kalshiEnvironment: () => 'production',
  kalshiRequest: request,
}));
vi.mock('./kalshi-depth', () => ({ observeKalshiOrderBook: () => ({
  observedAt: '2026-01-01T00:00:00Z',
  yesBids: [{ price: 0.39, quantity: 5 }, { price: 0.4, quantity: 7 }],
  noBids: [{ price: 0.58, quantity: 11 }],
}) }));

import { placeKalshiBuy } from './live-orders';
import type { EntryExecutionObservation } from './types';

describe('managed maker execution audit', () => {
  let fillReads = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.MONEY_NOODLE_ENABLE_LIVE = 'true';
    delete process.env.MONEY_NOODLE_KILL_SWITCH;
    request.mockReset();
    fillReads = 0;
    request.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/markets/TEST') return { market: {
        yes_bid_dollars: '0.40', yes_ask_dollars: '0.42',
        price_ranges: [{ start: '0', end: '1', step: '0.001' }],
      } };
      if (path.includes('/orderbook')) return { orderbook_fp: {
        yes_dollars: [['0.39', '5'], ['0.40', '7']], no_dollars: [['0.58', '11']],
      } };
      if (path === '/portfolio/events/orders' && init?.method === 'POST') return { order_id: 'venue-1' };
      if (path.endsWith('/amend') && init?.method === 'POST') return {};
      if (path.startsWith('/portfolio/fills')) {
        fillReads += 1;
        return { fills: fillReads === 1 ? [] : [{
          order_id: 'venue-1', count_fp: '0.20', yes_price_dollars: '0.40', fee_cost: '0', is_taker: false,
        }] };
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MONEY_NOODLE_ENABLE_LIVE;
  });

  it('records the issuance-independent submitted price, displayed queue proxy, acceptance, and fill', async () => {
    const durable: EntryExecutionObservation[] = [];
    const pending = placeKalshiBuy({
      ticker: 'TEST', positionSide: 'UP', priceCents: 45, startPriceCents: 40,
      count: 0.2, clientOrderId: 'live:test',
      onObservation: async (observation) => { durable.push(observation); },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const fill = await pending;
    expect(fill.averagePriceCents).toBeCloseTo(40);
    expect(fill.executionObservations.map((item) => item.event)).toEqual([
      'create_quote', 'accepted', 'management_quote', 'amend_accepted', 'terminal_fill',
    ]);
    expect(fill.executionObservations.find((item) => item.event === 'management_quote')).toMatchObject({
      selectedBid: 0.4, selectedAsk: 0.42, limitPrice: 0.4,
      displayedAtLimit: 7, displayedAhead: 7, bestBidDepth: 7, bestAskDepth: 11,
    });
    expect(durable).toEqual(fill.executionObservations);
  });
});
