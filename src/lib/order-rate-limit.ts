import type { PaperOrder } from './types';

/**
 * Counts unique live orders that actually filled, not attempts or merely accepted resting orders.
 *
 * Maker orders canceled with zero fill, schema rejections, and local failures do not consume the
 * trading limit. Partial fills count as one filled order. Reduce-only exits count separately when
 * they sold any quantity, and IDs are deduplicated because partial-exit records copy entry data.
 */
export function countFilledLiveVenueOrders(orders: PaperOrder[], sinceMs: number): number {
  const filled = new Set<string>();
  for (const order of orders) {
    if (order.executionMode !== 'live') continue;
    if (order.venueOrderId && (order.filledCount ?? 0) > 0
      && Number.isFinite(Date.parse(order.createdAt)) && Date.parse(order.createdAt) >= sinceMs) {
      filled.add(order.venueOrderId);
    }
    if (order.exitVenueOrderId && order.status === 'sold' && order.saleProceedsCents !== undefined
      && order.settledAt && Number.isFinite(Date.parse(order.settledAt)) && Date.parse(order.settledAt) >= sinceMs) {
      filled.add(order.exitVenueOrderId);
    }
  }
  return filled.size;
}
