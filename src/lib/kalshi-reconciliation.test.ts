import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  fetchKalshiIncrementalReconciliationSnapshot,
  fetchKalshiReconciliationSnapshot,
  isMoneyNoodleClientOrderId,
  type KalshiReconciliationRequester,
} from './kalshi-reconciliation';

const rawOrder = (patch: Record<string, unknown> = {}) => ({
  order_id: 'venue-1', client_order_id: 'live:BTC:2026-01-01T00:15:00Z', ticker: 'KXBTC-TEST',
  status: 'resting', action: 'buy', side: 'yes', fill_count_fp: '0.00', initial_count_fp: '0.30',
  remaining_count_fp: '0.30', created_time: '2026-01-01T00:01:00Z', ...patch,
});

function requester(options: { cancelThrows?: boolean; confirmationStatus?: 'resting' | 'canceled'; malformedOrders?: boolean } = {}) {
  let restingReads = 0;
  const calls: Array<{ path: string; method?: string }> = [];
  const request = (async <T>(path: string, init?: { method?: 'GET' | 'POST' | 'DELETE' }) => {
    calls.push({ path, method: init?.method });
    if (init?.method === 'DELETE') {
      if (options.cancelThrows) throw new Error('injected lost cancellation response');
      return {} as T;
    }
    if (path === '/portfolio/balance') return { balance_dollars: '1.00' } as T;
    if (path.startsWith('/portfolio/orders/venue-1')) return { order: rawOrder({
      status: options.confirmationStatus ?? 'canceled', remaining_count_fp: options.confirmationStatus === 'resting' ? '0.30' : '0.00',
    }) } as T;
    if (path.startsWith('/portfolio/orders?status=resting')) {
      restingReads += 1;
      return { cursor: '', orders: restingReads === 1 ? [rawOrder()] : [] } as T;
    }
    if (path.startsWith('/portfolio/orders?limit')) return (options.malformedOrders ? { cursor: '', orders: {} } : { cursor: '', orders: [rawOrder()] }) as T;
    if (path.startsWith('/portfolio/fills')) return { cursor: '', fills: [] } as T;
    if (path.startsWith('/portfolio/positions')) return { cursor: '', market_positions: [] } as T;
    throw new Error(`Unexpected mock path ${path}`);
  }) as KalshiReconciliationRequester;
  return { request, calls };
}

describe('Kalshi reconciliation API failure injection', () => {
  beforeAll(() => { vi.useRealTimers(); });

  it('recognizes current and pre-rename durable client IDs', () => {
    expect(isMoneyNoodleClientOrderId('money-noodle-exit:new')).toBe(true);
    expect(isMoneyNoodleClientOrderId('signal-desk-exit:legacy')).toBe(true);
    expect(isMoneyNoodleClientOrderId('external-order')).toBe(false);
  });

  it('confirms cancellation by order read when the DELETE response is lost', async () => {
    const mock = requester({ cancelThrows: true, confirmationStatus: 'canceled' });
    const result = await fetchKalshiReconciliationSnapshot([], mock.request);
    expect(result.restingOrdersCanceled).toBe(1);
    expect(result.restingOrders).toEqual([]);
    expect(mock.calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect(mock.calls.some((call) => call.path === '/portfolio/orders/venue-1')).toBe(true);
  });

  it('fails closed when cancellation remains resting after a lost response', async () => {
    const mock = requester({ cancelThrows: true, confirmationStatus: 'resting' });
    await expect(fetchKalshiReconciliationSnapshot([], mock.request)).rejects.toThrow(/could not be confirmed.*lost cancellation response/i);
  });

  it('rejects malformed venue collection responses', async () => {
    const mock = requester({ malformedOrders: true });
    await expect(fetchKalshiReconciliationSnapshot([], mock.request)).rejects.toThrow(/malformed orders/i);
  });

  it('uses a fixed bounded delta and exact reads for locally tracked transactions', async () => {
    const calls: string[] = [];
    let restingReads = 0;
    const request = (async <T>(path: string) => {
      calls.push(path);
      if (path === '/historical/cutoff') return {
        orders_updated_ts: '2025-12-01T00:00:00Z', trades_created_ts: '2025-12-01T00:00:00Z',
      } as T;
      if (path === '/portfolio/balance') return { balance_dollars: '1.00' } as T;
      if (path.startsWith('/portfolio/orders?min_ts=')) return { cursor: '', orders: [rawOrder({ order_id: 'delta-order', status: 'canceled' })] } as T;
      if (path === '/portfolio/orders/tracked-order') return { order: rawOrder({ order_id: 'tracked-order', status: 'executed', fill_count_fp: '0.30', remaining_count_fp: '0.00' }) } as T;
      if (path.startsWith('/portfolio/fills?min_ts=')) return { cursor: '', fills: [] } as T;
      if (path.startsWith('/portfolio/fills?order_id=tracked-order')) return { cursor: '', fills: [{
        order_id: 'tracked-order', fill_id: 'fill-1', ticker: 'KXBTC-TEST', action: 'buy', side: 'yes',
        count_fp: '0.30', yes_price_dollars: '0.30', fee_cost: '0.00', is_taker: false,
      }] } as T;
      if (path.startsWith('/portfolio/positions?')) return { cursor: '', market_positions: [] } as T;
      if (path.startsWith('/portfolio/orders?status=resting')) {
        restingReads += 1;
        return { cursor: '', orders: [] } as T;
      }
      throw new Error(`Unexpected mock path ${path}`);
    }) as KalshiReconciliationRequester;

    const snapshot = await fetchKalshiIncrementalReconciliationSnapshot({
      minTs: 1_767_225_480, maxTs: 1_767_225_600, trackedVenueOrderIds: ['tracked-order'],
    }, request);
    expect(snapshot.orders.map((order) => order.orderId).sort()).toEqual(['delta-order', 'tracked-order']);
    expect(snapshot.fills.map((fill) => fill.fillId)).toEqual(['fill-1']);
    expect(restingReads).toBe(2);
    expect(calls).toContain('/portfolio/orders?min_ts=1767225480&max_ts=1767225600&limit=1000');
    expect(calls).toContain('/portfolio/fills?min_ts=1767225480&max_ts=1767225600&limit=1000');
    expect(calls).not.toContain('/portfolio/orders?limit=1000');
  });

  it('rejects an invalid incremental interval before making a venue request', async () => {
    const request = vi.fn() as unknown as KalshiReconciliationRequester;
    await expect(fetchKalshiIncrementalReconciliationSnapshot({
      minTs: 200, maxTs: 100, trackedVenueOrderIds: [],
    }, request)).rejects.toThrow(/invalid closed time interval/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses to advance an incremental checkpoint across Kalshi historical-tier movement', async () => {
    const request = vi.fn(async () => ({
      orders_updated_ts: '2026-01-02T00:00:00Z', trades_created_ts: '2026-01-02T00:00:00Z',
    })) as unknown as KalshiReconciliationRequester;
    await expect(fetchKalshiIncrementalReconciliationSnapshot({
      minTs: 1_767_225_480, maxTs: 1_767_225_600, trackedVenueOrderIds: [],
    }, request)).rejects.toThrow(/predates the live order\/fill tier/i);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
