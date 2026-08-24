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

export interface KalshiIncrementalReconciliationInput {
  minTs: number;
  maxTs: number;
  trackedVenueOrderIds: string[];
}

interface CursorResponse { cursor?: string }
interface RawOrderResponse extends CursorResponse { orders?: Array<Record<string, unknown>>; order?: Record<string, unknown> }
interface RawFillResponse extends CursorResponse { fills?: Array<Record<string, unknown>> }
interface RawPositionResponse extends CursorResponse { market_positions?: Array<Record<string, unknown>> }
interface RawHistoricalCutoffResponse { orders_updated_ts?: string; trades_created_ts?: string }
export type KalshiReconciliationRequester = <T>(path: string, init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number }) => Promise<T>;

const MAX_PAGES = 25;
export const KALSHI_RECONCILIATION_PAGE_LIMIT = 1_000;
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

const positionsPath = `/portfolio/positions?count_filter=position&limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`;
const restingOrdersPath = `/portfolio/orders?status=resting&limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`;

function positionRecord(row: Record<string, unknown>): KalshiPositionRecord {
  return {
    ticker: text(row.ticker, 'position ticker'), quantity: numeric(row.position_fp ?? row.position ?? 0, 'position quantity'),
    exposureDollars: numeric(row.market_exposure_dollars ?? Number(row.market_exposure ?? 0) / 100, 'position exposure'),
  };
}

function dedupeById<T>(rows: T[], id: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [id(row), row])).values()];
}

async function completeSnapshot(input: {
  balance: { balance?: number; balance_dollars?: string };
  orders: KalshiOrderRecord[];
  fills: KalshiFillRecord[];
  positions: KalshiPositionRecord[];
  resting: KalshiOrderRecord[];
  refreshFillsAfterCancellation: (canceledOrderIds: string[]) => Promise<KalshiFillRecord[]>;
}, request: KalshiReconciliationRequester): Promise<KalshiReconciliationSnapshot> {
  const byId = new Map([...input.orders, ...input.resting].map((order) => [order.orderId, order]));
  const canceledOrderIds: string[] = [];
  for (const order of input.resting.filter((item) => isMoneyNoodleClientOrderId(item.clientOrderId))) {
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
    canceledOrderIds.push(confirmed.orderId);
  }

  const remainingResting = await allPages<RawOrderResponse, KalshiOrderRecord>(request, restingOrdersPath, 'orders', orderRecord);
  const managedStillResting = remainingResting.filter((item) => isMoneyNoodleClientOrderId(item.clientOrderId));
  if (managedStillResting.length) throw new Error(`${managedStillResting.length} Money Noodle order(s) remain resting after cancellation.`);

  // Cancellation can race a final maker fill, so cash, positions and the canceled order's fills are refreshed.
  const [authoritativeBalance, authoritativePositions, cancellationFills] = canceledOrderIds.length
    ? await Promise.all([
      request<{ balance?: number; balance_dollars?: string }>('/portfolio/balance'),
      allPages<RawPositionResponse, KalshiPositionRecord>(request, positionsPath, 'market_positions', positionRecord),
      input.refreshFillsAfterCancellation(canceledOrderIds),
    ])
    : [input.balance, input.positions, [] as KalshiFillRecord[]];
  const balanceCents = authoritativeBalance.balance_dollars !== undefined
    ? numeric(authoritativeBalance.balance_dollars, 'balance_dollars') * 100
    : numeric(authoritativeBalance.balance, 'balance');
  return {
    balanceCents,
    orders: [...byId.values()],
    fills: dedupeById([...input.fills, ...cancellationFills], (fill) => fill.fillId),
    positions: authoritativePositions,
    restingOrders: remainingResting,
    restingOrdersCanceled: canceledOrderIds.length,
  };
}

/**
 * Reads the complete current Kalshi account tier and removes only Money Noodle resting orders.
 * Historical terminal records are intentionally not a current-account safety dependency.
 */
export async function fetchKalshiReconciliationSnapshot(
  trackedVenueOrderIds: string[] = [], request: KalshiReconciliationRequester = kalshiRequest,
): Promise<KalshiReconciliationSnapshot> {
  const [balance, orders, fills, positions, resting] = await Promise.all([
    request<{ balance?: number; balance_dollars?: string }>('/portfolio/balance'),
    allPages<RawOrderResponse, KalshiOrderRecord>(request, `/portfolio/orders?limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`, 'orders', orderRecord),
    allPages<RawFillResponse, KalshiFillRecord>(request, `/portfolio/fills?limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`, 'fills', fillRecord),
    allPages<RawPositionResponse, KalshiPositionRecord>(request, positionsPath, 'market_positions', positionRecord),
    allPages<RawOrderResponse, KalshiOrderRecord>(request, restingOrdersPath, 'orders', orderRecord),
  ]);
  const byId = new Map(orders.map((order) => [order.orderId, order]));
  for (const id of new Set(trackedVenueOrderIds.filter(Boolean))) {
    if (byId.has(id)) continue;
    const found = await getOrder(id, request);
    if (found) byId.set(id, found);
  }
  return completeSnapshot({
    balance, orders: [...byId.values()], fills, positions, resting,
    refreshFillsAfterCancellation: () => allPages<RawFillResponse, KalshiFillRecord>(
      request, `/portfolio/fills?limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`, 'fills', fillRecord,
    ),
  }, request);
}

/** Bounded current-account delta plus exact locally active transaction state. */
export async function fetchKalshiIncrementalReconciliationSnapshot(
  input: KalshiIncrementalReconciliationInput,
  request: KalshiReconciliationRequester = kalshiRequest,
): Promise<KalshiReconciliationSnapshot> {
  if (!Number.isSafeInteger(input.minTs) || !Number.isSafeInteger(input.maxTs)
    || input.minTs <= 0 || input.maxTs < input.minTs) {
    throw new Error('Kalshi incremental reconciliation received an invalid closed time interval.');
  }
  const cutoff = await request<RawHistoricalCutoffResponse>('/historical/cutoff');
  const ordersCutoffMs = Date.parse(cutoff.orders_updated_ts ?? '');
  const fillsCutoffMs = Date.parse(cutoff.trades_created_ts ?? '');
  if (!Number.isFinite(ordersCutoffMs) || !Number.isFinite(fillsCutoffMs)) {
    throw new Error('Kalshi incremental reconciliation received a malformed historical cutoff.');
  }
  if (input.minTs * 1_000 < Math.max(ordersCutoffMs, fillsCutoffMs)) {
    throw new Error('Kalshi reconciliation checkpoint predates the live order/fill tier; a full current-account audit is required.');
  }
  const interval = `min_ts=${input.minTs}&max_ts=${input.maxTs}&limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`;
  const [balance, intervalOrders, intervalFills, positions, resting] = await Promise.all([
    request<{ balance?: number; balance_dollars?: string }>('/portfolio/balance'),
    allPages<RawOrderResponse, KalshiOrderRecord>(request, `/portfolio/orders?${interval}`, 'orders', orderRecord),
    allPages<RawFillResponse, KalshiFillRecord>(request, `/portfolio/fills?${interval}`, 'fills', fillRecord),
    allPages<RawPositionResponse, KalshiPositionRecord>(request, positionsPath, 'market_positions', positionRecord),
    allPages<RawOrderResponse, KalshiOrderRecord>(request, restingOrdersPath, 'orders', orderRecord),
  ]);
  const ordersById = new Map([...intervalOrders, ...resting].map((order) => [order.orderId, order]));
  const trackedIds = [...new Set(input.trackedVenueOrderIds.filter(Boolean))];
  const [targetOrders, targetFillGroups] = await Promise.all([
    Promise.all(trackedIds.map((id) => ordersById.has(id) ? undefined : getOrder(id, request))),
    Promise.all(trackedIds.map((id) => allPages<RawFillResponse, KalshiFillRecord>(
      request, `/portfolio/fills?order_id=${encodeURIComponent(id)}&limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`, 'fills', fillRecord,
    ))),
  ]);
  for (const order of targetOrders) if (order) ordersById.set(order.orderId, order);
  const fills = dedupeById([...intervalFills, ...targetFillGroups.flat()], (fill) => fill.fillId);
  return completeSnapshot({
    balance, orders: [...ordersById.values()], fills, positions, resting,
    refreshFillsAfterCancellation: async (canceledOrderIds) => dedupeById((await Promise.all(canceledOrderIds.map((id) =>
      allPages<RawFillResponse, KalshiFillRecord>(
        request, `/portfolio/fills?order_id=${encodeURIComponent(id)}&limit=${KALSHI_RECONCILIATION_PAGE_LIMIT}`, 'fills', fillRecord,
      )))).flat(), (fill) => fill.fillId),
  }, request);
}
