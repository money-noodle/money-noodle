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

import { liveEntryClientOrderId } from './live-order-identity';
import { placeKalshiBuy, placeKalshiSell, placeKalshiTakerBuy } from './live-orders';
import type { EntryExecutionObservation } from './types';

describe('managed maker execution audit', () => {
  let fillReads = 0;
  let writeBodies: unknown[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.MONEY_NOODLE_ENABLE_LIVE = 'true';
    delete process.env.MONEY_NOODLE_KILL_SWITCH;
    request.mockReset();
    fillReads = 0;
    writeBodies = [];
    request.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/markets/TEST') return { market: {
        ticker: 'TEST', status: 'active', exchange_index: 2,
        yes_bid_dollars: '0.40', yes_ask_dollars: '0.42',
        price_ranges: [{ start: '0', end: '1', step: '0.001' }],
      } };
      if (path.includes('/orderbook')) return { orderbook_fp: {
        yes_dollars: [['0.39', '5'], ['0.40', '7']], no_dollars: [['0.58', '11']],
      } };
      if (path === '/portfolio/events/orders' && init?.method === 'POST') {
        writeBodies.push(init.body); return { order_id: 'venue-1' };
      }
      if (path.endsWith('/amend') && init?.method === 'POST') {
        writeBodies.push(init.body); return {};
      }
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
      count: 0.2, clientOrderId: liveEntryClientOrderId('live:test'),
      onObservation: async (observation) => { durable.push(observation); },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const fill = await pending;
    expect(fill.averagePriceCents).toBeCloseTo(40);
    expect(fill.exchangeIndex).toBe(2);
    expect(writeBodies).toHaveLength(2);
    expect(writeBodies[0]).toMatchObject({ ticker: 'TEST', exchange_index: 2, post_only: true });
    expect(writeBodies[1]).toMatchObject({ ticker: 'TEST', exchange_index: 2 });
    expect(fill.executionObservations.map((item) => item.event)).toEqual([
      'create_quote', 'accepted', 'management_quote', 'amend_accepted', 'terminal_fill',
    ]);
    expect(fill.executionObservations.find((item) => item.event === 'management_quote')).toMatchObject({
      selectedBid: 0.4, selectedAsk: 0.42, limitPrice: 0.4, exchangeIndex: 2,
      displayedAtLimit: 7, displayedAhead: 7, bestBidDepth: 7, bestAskDepth: 11,
    });
    expect(durable).toEqual(fill.executionObservations);
  });

  it('uses and persists the exact exchange index for taker entry and reduce-only exit', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    request.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/markets/TEST') return { market: {
        ticker: 'TEST', status: 'active', exchange_index: 2,
        yes_bid_dollars: '0.40', yes_ask_dollars: '0.42',
        price_ranges: [{ start: '0', end: '1', step: '0.001' }],
      } };
      if (path === '/portfolio/events/orders' && init?.method === 'POST') {
        bodies.push(init.body as Record<string, unknown>);
        return bodies.length === 1
          ? { order_id: 'taker-1', fill_count: '0' }
          : { order_id: 'exit-1', fill_count: '0', average_fill_price: '0', average_fee_paid: '0' };
      }
      if (path === '/portfolio/orders/taker-1') {
        return { order: { status: 'executed', remaining_count_fp: '0.00', order_id: 'taker-1' } };
      }
      if (path.startsWith('/portfolio/fills')) return { fills: [] };
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
    const accepted: Array<[string, number]> = [];
    const taker = await placeKalshiTakerBuy({
      ticker: 'TEST', positionSide: 'UP', maximumPriceCents: 45, count: 0.2,
      clientOrderId: liveEntryClientOrderId('live:test:taker'),
      onAccepted: async (venueOrderId, exchangeIndex) => { accepted.push([venueOrderId, exchangeIndex]); },
    });
    const exit = await placeKalshiSell({
      ticker: 'TEST', positionSide: 'UP', minimumPriceCents: 30, count: 0.2,
      clientOrderId: 'money-noodle-exit:test',
      onAccepted: async (venueOrderId, exchangeIndex) => { accepted.push([venueOrderId, exchangeIndex]); },
    });
    expect(taker.exchangeIndex).toBe(2);
    expect(exit.exchangeIndex).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ exchange_index: 2, reduce_only: false });
    expect(bodies[1]).toMatchObject({ exchange_index: 2, reduce_only: true });
    expect(accepted).toEqual([['taker-1', 2], ['exit-1', 2]]);
  });

  it('sends no post-only retry when refreshed exchange identity changes', async () => {
    let marketReads = 0;
    let posts = 0;
    request.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/markets/TEST') {
        marketReads += 1;
        return { market: {
          ticker: 'TEST', status: 'active', exchange_index: marketReads === 1 ? 2 : 3,
          yes_bid_dollars: '0.40', yes_ask_dollars: '0.42',
          price_ranges: [{ start: '0', end: '1', step: '0.001' }],
        } };
      }
      if (path === '/portfolio/events/orders' && init?.method === 'POST') {
        posts += 1;
        throw new Error('invalid_order · invalid order · post only cross');
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
    await expect(placeKalshiBuy({
      ticker: 'TEST', positionSide: 'UP', priceCents: 45, startPriceCents: 40,
      count: 0.2, clientOrderId: liveEntryClientOrderId('live:test:index-change'),
    })).rejects.toThrow('changed from 2 to 3');
    expect(posts).toBe(1);
  });

  it('sends no signed write when the exact market omits exchange identity', async () => {
    request.mockImplementation(async (path: string) => {
      if (path === '/markets/TEST') return { market: {
        ticker: 'TEST', status: 'active', yes_bid_dollars: '0.40', yes_ask_dollars: '0.42',
      } };
      throw new Error(`Unexpected signed write ${path}`);
    });
    await expect(placeKalshiBuy({
      ticker: 'TEST', positionSide: 'UP', priceCents: 45, startPriceCents: 40,
      count: 0.2, clientOrderId: liveEntryClientOrderId('live:test:missing-index'),
    })).rejects.toThrow('invalid exchange_index');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/markets/TEST');
  });
});
