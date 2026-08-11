import 'server-only';
import { kalshiRequest } from './kalshi-api';

export interface KalshiOrderRecord {
  orderId: string;
  clientOrderId: string;
  ticker: string;
  status: string;
  action: string;
  side: string;
  fillCount: number;
  initialCount: number;
  remainingCount: number;
  createdAt: string;
}

export interface KalshiFillRecord {
  orderId: string;
  fillId: string;
  ticker: string;
  action: string;
  side: string;
  count: number;
  yesPriceDollars: number;
  feeDollars: number;
  isTaker: boolean;
}

export interface KalshiPositionRecord { ticker: string; quantity: number; exposureDollars: number }

export interface KalshiReconciliationSnapshot {
  balanceCents: number;
  orders: KalshiOrderRecord[];
  fills: KalshiFillRecord[];
  positions: KalshiPositionRecord[];
  restingOrders: KalshiOrderRecord[];
  restingOrdersCanceled: number;
}

interface CursorResponse { cursor?: string }
interface RawOrderResponse extends CursorResponse { orders?: Array<Record<string, unknown>>; order?: Record<string, unknown> }
interface RawFillResponse extends CursorResponse { fills?: Array<Record<string, unknown>> }
interface RawPositionResponse extends CursorResponse { market_positions?: Array<Record<string, unknown>> }
export type KalshiReconciliationRequester = <T>(path: string, init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number }) => Promise<T>;

const MAX_PAGES = 25;
const numeric = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Kalshi reconciliation received malformed ${label}.`);
  return parsed;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`Kalshi reconciliation received malformed ${label}.`);
  return value;
};

function orderRecord(row: Record<string, unknown>): KalshiOrderRecord {
  return {
    orderId: text(row.order_id, 'order_id'), clientOrderId: typeof row.client_order_id === 'string' ? row.client_order_id : '',
    ticker: text(row.ticker, 'order ticker'), status: text(row.status, 'order status'),
    action: typeof row.action === 'string' ? row.action : '', side: typeof row.side === 'string' ? row.side : '',
    fillCount: numeric(row.fill_count_fp ?? 0, 'fill_count_fp'), initialCount: numeric(row.initial_count_fp ?? 0, 'initial_count_fp'),
    remainingCount: numeric(row.remaining_count_fp ?? 0, 'remaining_count_fp'),
    createdAt: typeof row.created_time === 'string' ? row.created_time : '',
  };
}

function fillRecord(row: Record<string, unknown>): KalshiFillRecord {
  return {
    orderId: text(row.order_id, 'fill order_id'), fillId: text(row.fill_id ?? row.trade_id, 'fill_id'),
    ticker: text(row.ticker ?? row.market_ticker, 'fill ticker'), action: typeof row.action === 'string' ? row.action : '',
    side: typeof row.side === 'string' ? row.side : '', count: numeric(row.count_fp, 'fill count_fp'),
    yesPriceDollars: numeric(row.yes_price_dollars, 'fill yes_price_dollars'), feeDollars: numeric(row.fee_cost ?? 0, 'fill fee_cost'),
    isTaker: row.is_taker === true,
  };
}

async function allPages<T extends CursorResponse, R>(request: KalshiReconciliationRequester, path: string, field: string, map: (row: Record<string, unknown>) => R): Promise<R[]> {
  const result: R[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await request<T>(`${path}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ''}`);
    const rows = (response as Record<string, unknown>)[field];
    if (rows !== undefined && !Array.isArray(rows)) throw new Error(`Kalshi reconciliation received malformed ${field}.`);
    for (const row of (rows as Array<Record<string, unknown>> | undefined) ?? []) result.push(map(row));
    cursor = typeof response.cursor === 'string' ? response.cursor : '';
    if (!cursor) return result;
  }
  throw new Error(`Kalshi reconciliation exceeded ${MAX_PAGES} pages while reading ${field}; history is incomplete.`);
}

export function isMoneyNoodleClientOrderId(clientOrderId: string): boolean {
  // Keep recognizing pre-rename exit IDs so an upgrade can still cancel and reconcile them safely.
  return clientOrderId.startsWith('live:') || clientOrderId.startsWith('money-noodle-exit:')
    || clientOrderId.startsWith('signal-desk-exit:') || clientOrderId.startsWith('exit-');
}

async function getOrder(orderId: string, request: KalshiReconciliationRequester): Promise<KalshiOrderRecord | undefined> {
  try {
    const response = await request<RawOrderResponse>(`/portfolio/orders/${encodeURIComponent(orderId)}`);
    return response.order ? orderRecord(response.order) : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('not found') || message.includes('404')) return undefined;
    throw error;
  }
}

/**
 * Reads a complete authoritative account snapshot and removes only Money Noodle resting orders.
 * Every managed cancellation is re-read by order id; a lost/uncertain cancel response blocks startup.
 */
export async function fetchKalshiReconciliationSnapshot(trackedVenueOrderIds: string[] = [], request: KalshiReconciliationRequester = kalshiRequest): Promise<KalshiReconciliationSnapshot> {
  const [balance, orders, fills, positions, resting] = await Promise.all([
    request<{ balance?: number; balance_dollars?: string }>('/portfolio/balance'),
    allPages<RawOrderResponse, KalshiOrderRecord>(request, '/portfolio/orders?limit=200', 'orders', orderRecord),
    allPages<RawFillResponse, KalshiFillRecord>(request, '/portfolio/fills?limit=200', 'fills', fillRecord),
    allPages<RawPositionResponse, KalshiPositionRecord>(request, '/portfolio/positions?limit=200', 'market_positions', (row) => ({
      ticker: text(row.ticker, 'position ticker'), quantity: numeric(row.position_fp ?? row.position ?? 0, 'position quantity'),
      exposureDollars: numeric(row.market_exposure_dollars ?? Number(row.market_exposure ?? 0) / 100, 'position exposure'),
    })),
    allPages<RawOrderResponse, KalshiOrderRecord>(request, '/portfolio/orders?status=resting&limit=200', 'orders', orderRecord),
  ]);
  const byId = new Map(orders.map((order) => [order.orderId, order]));
  for (const id of new Set(trackedVenueOrderIds.filter(Boolean))) {
    if (byId.has(id)) continue;
    const found = await getOrder(id, request);
    if (found) { byId.set(id, found); orders.push(found); }
  }

  let restingOrdersCanceled = 0;
  for (const order of resting.filter((item) => isMoneyNoodleClientOrderId(item.clientOrderId))) {
    let cancelError: unknown;
    try {
      await request(`/portfolio/events/orders/${encodeURIComponent(order.orderId)}?market_ticker=${encodeURIComponent(order.ticker)}`, { method: 'DELETE' });
    } catch (error) { cancelError = error; }
    const confirmed = await getOrder(order.orderId, request).catch(() => undefined);
    if (!confirmed || confirmed.status === 'resting' || confirmed.remainingCount > 1e-8) {
      const detail = cancelError instanceof Error ? ` ${cancelError.message}` : '';
      throw new Error(`Cancellation of Money Noodle order ${order.orderId} could not be confirmed.${detail}`);
    }
    byId.set(confirmed.orderId, confirmed);
    const index = orders.findIndex((item) => item.orderId === confirmed.orderId);
    if (index >= 0) orders[index] = confirmed; else orders.push(confirmed);
    restingOrdersCanceled += 1;
  }
  const remainingResting = await allPages<RawOrderResponse, KalshiOrderRecord>(request, '/portfolio/orders?status=resting&limit=200', 'orders', orderRecord);
  const managedStillResting = remainingResting.filter((item) => isMoneyNoodleClientOrderId(item.clientOrderId));
  if (managedStillResting.length) throw new Error(`${managedStillResting.length} Money Noodle order(s) remain resting after cancellation.`);

  // Cancellation can race a final maker fill, so refresh fills after every managed cancellation.
  const authoritativeBalance = restingOrdersCanceled
    ? await request<{ balance?: number; balance_dollars?: string }>('/portfolio/balance')
    : balance;
  const authoritativeBalanceCents = authoritativeBalance.balance_dollars !== undefined
    ? numeric(authoritativeBalance.balance_dollars, 'balance_dollars') * 100
    : numeric(authoritativeBalance.balance, 'balance');
  const authoritativeFills = restingOrdersCanceled
    ? await allPages<RawFillResponse, KalshiFillRecord>(request, '/portfolio/fills?limit=200', 'fills', fillRecord)
    : fills;
  const authoritativePositions = restingOrdersCanceled
    ? await allPages<RawPositionResponse, KalshiPositionRecord>(request, '/portfolio/positions?limit=200', 'market_positions', (row) => ({
      ticker: text(row.ticker, 'position ticker'), quantity: numeric(row.position_fp ?? row.position ?? 0, 'position quantity'),
      exposureDollars: numeric(row.market_exposure_dollars ?? Number(row.market_exposure ?? 0) / 100, 'position exposure'),
    }))
    : positions;
  return {
    balanceCents: authoritativeBalanceCents, orders: [...byId.values()], fills: authoritativeFills, positions: authoritativePositions,
    restingOrders: remainingResting, restingOrdersCanceled,
  };
}
