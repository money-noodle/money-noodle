import { describe, expect, it } from 'vitest';
import { reconcileExecutionLedger } from './execution-reconciliation';
import type { KalshiReconciliationSnapshot } from './kalshi-reconciliation';
import type { PaperOrder } from './types';

const closesAt = '2026-01-01T00:15:00.000Z';
const local = (patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: `live:BTC:${closesAt}`, clientOrderId: `live:BTC:${closesAt}`, executionMode: 'live', symbol: 'BTC', venue: 'kalshi',
  contractId: 'KXBTC-TEST', side: 'UP', status: 'uncertain', createdAt: '2026-01-01T00:01:00.000Z',
  calculationAt: '2026-01-01T00:00:45.000Z', closesAt, modelProbabilityUp: 0.7, confidence: 0.7,
  askPrice: 0.3, bidPrice: 0.28, spread: 0.02, quantity: 0.3, stakeCents: 10, feeCents: 1, potentialPayoutCents: 30,
  ...patch,
});
const snapshot = (patch: Partial<KalshiReconciliationSnapshot> = {}): KalshiReconciliationSnapshot => ({
  balanceCents: 90, orders: [], fills: [], positions: [], restingOrders: [], restingOrdersCanceled: 0, ...patch,
});
const venueOrder = { orderId: 'venue-1', clientOrderId: `live:BTC:${closesAt}`, ticker: 'KXBTC-TEST', status: 'executed', action: 'buy', side: 'yes', fillCount: 0.3, initialCount: 0.3, remainingCount: 0, createdAt: '2026-01-01T00:01:01Z' };
const venueFill = { orderId: 'venue-1', fillId: 'fill-1', ticker: 'KXBTC-TEST', action: 'buy', side: 'yes', count: 0.3, yesPriceDollars: 0.29, feeDollars: 0, isTaker: false };

const now = Date.parse('2026-01-01T00:05:00.000Z');

describe('Kalshi execution ledger reconciliation', () => {
  it('recovers an accepted order and fill after the HTTP response was lost', () => {
    const result = reconcileExecutionLedger([local()], snapshot({
      orders: [venueOrder], fills: [venueFill],
      positions: [{ ticker: 'KXBTC-TEST', quantity: 0.3, exposureDollars: 0.087 }],
    }), now);
    expect(result.issues).toEqual([]);
    expect(result.recoveredFills).toBe(1);
    expect(result.targetReservedCents).toBe(9);
    expect(result.orders[0]).toMatchObject({ status: 'open', venueOrderId: 'venue-1', filledCount: 0.3, stakeCents: 9, actualStakeCents: 8.7 });
  });

  it('recovers signed DOWN entry fills using NO cost and negative venue quantity', () => {
    const downOrder = { ...venueOrder, action: 'sell' };
    const downFill = { ...venueFill, action: 'sell', yesPriceDollars: 0.71 };
    const result = reconcileExecutionLedger([local({ side: 'DOWN', modelProbabilityUp: 0.3 })], snapshot({
      orders: [downOrder], fills: [downFill],
      positions: [{ ticker: 'KXBTC-TEST', quantity: -0.3, exposureDollars: 0.087 }],
    }), now);
    expect(result.issues).toEqual([]);
    expect(result.orders[0]).toMatchObject({ side: 'DOWN', status: 'open', quantity: 0.3 });
    expect(result.orders[0].askPrice).toBeCloseTo(0.29);
    expect(result.orders[0].actualStakeCents).toBeCloseTo(8.7);
    expect(result.targetReservedCents).toBe(9);
  });

  it('keeps a fresh uncertain reservation while Kalshi client-id indexes may still be propagating', () => {
    const freshNow = Date.parse('2026-01-01T00:01:10.000Z');
    const result = reconcileExecutionLedger([local()], snapshot(), freshNow);
    expect(result.retryableIssues.join(' ')).toContain('consistency window');
    expect(result.targetReservedCents).toBe(10);
    expect(result.orders[0].status).toBe('uncertain');
  });

  it('releases an uncertain intent only after complete venue history confirms no accepted order', () => {
    const result = reconcileExecutionLedger([local()], snapshot(), now);
    expect(result.issues).toEqual([]);
    expect(result.targetReservedCents).toBe(0);
    expect(result.orders[0]).toMatchObject({ status: 'rejected', filledCount: 0 });
  });

  it('classifies a terminal accepted maker order with zero fills as unfilled', () => {
    const result = reconcileExecutionLedger([local()], snapshot({ orders: [{ ...venueOrder, status: 'canceled', fillCount: 0 }] }), now);
    expect(result.issues).toEqual([]);
    expect(result.targetReservedCents).toBe(0);
    expect(result.orders[0]).toMatchObject({ status: 'unfilled', venueOrderId: 'venue-1' });
  });

  it('recovers a partial maker fill and reserves only its authoritative all-in cost', () => {
    const result = reconcileExecutionLedger([local()], snapshot({
      orders: [{ ...venueOrder, status: 'canceled', fillCount: 0.1, remainingCount: 0 }],
      fills: [{ ...venueFill, count: 0.1 }],
      positions: [{ ticker: 'KXBTC-TEST', quantity: 0.1, exposureDollars: 0.029 }],
    }), now);
    expect(result.issues).toEqual([]);
    expect(result.orders[0]).toMatchObject({ status: 'open', quantity: 0.1, filledCount: 0.1, stakeCents: 3 });
    expect(result.targetReservedCents).toBe(3);
  });

  it('allows an amendment chain sharing one client id but blocks aggregate duplicate overfill', () => {
    const amendment = { ...venueOrder, orderId: 'venue-amendment' };
    const safe = reconcileExecutionLedger([local()], snapshot({
      orders: [venueOrder, amendment], fills: [venueFill],
      positions: [{ ticker: 'KXBTC-TEST', quantity: 0.3, exposureDollars: 0.087 }],
    }), now);
    expect(safe.issues).toEqual([]);

    const duplicateFill = { ...venueFill, orderId: 'venue-amendment', fillId: 'duplicate-fill' };
    const unsafe = reconcileExecutionLedger([local()], snapshot({
      orders: [venueOrder, amendment], fills: [venueFill, duplicateFill],
      positions: [{ ticker: 'KXBTC-TEST', quantity: 0.6, exposureDollars: 0.174 }],
    }), now);
    expect(unsafe.issues.join(' ')).toContain('exceed local requested quantity');
  });

  it('blocks when authoritative position quantity contradicts recovered fills', () => {
    const result = reconcileExecutionLedger([local()], snapshot({
      orders: [venueOrder], fills: [venueFill],
      positions: [{ ticker: 'KXBTC-TEST', quantity: 0.1, exposureDollars: 0.029 }],
    }), now);
    expect(result.issues.join(' ')).toContain('does not match local open quantity');
  });

  it('blocks for unrelated resting orders rather than canceling or ignoring them', () => {
    const manual = { ...venueOrder, orderId: 'manual', clientOrderId: 'manual-order', status: 'resting', remainingCount: 0.3 };
    const result = reconcileExecutionLedger([], snapshot({ restingOrders: [manual] }), now);
    expect(result.issues.join(' ')).toContain('unrelated resting Kalshi order');
  });

  it('recovers a partial reduce-only exit, retains the remainder, and withholds replacement', () => {
    const incumbent = local({ status: 'open', venueOrderId: 'venue-1', filledCount: 0.3, actualPurchaseCents: 8.7, actualFeeCents: 0, actualStakeCents: 8.7, stakeCents: 9, exitPending: true, exitClientOrderId: 'signal-desk-exit:partial' });
    const exitOrder = { ...venueOrder, orderId: 'exit-partial', clientOrderId: 'signal-desk-exit:partial', action: 'sell', fillCount: 0.1 };
    const exitFill = { ...venueFill, orderId: 'exit-partial', fillId: 'exit-partial-fill', action: 'sell', count: 0.1, yesPriceDollars: 0.2 };
    const result = reconcileExecutionLedger([incumbent], snapshot({ orders: [venueOrder, exitOrder], fills: [venueFill, exitFill], positions: [{ ticker: 'KXBTC-TEST', quantity: 0.2, exposureDollars: 0.058 }] }), now);
    expect(result.issues).toEqual([]);
    expect(result.orders.find((order) => order.id === incumbent.id)).toMatchObject({ status: 'open', quantity: 0.2, stakeCents: 6, exitPending: false });
    const partial = result.orders.find((order) => order.id.includes(':exit:'))!;
    expect(partial).toMatchObject({ status: 'sold', quantity: 0.1 });
    expect(partial.saleProceedsCents).toBeCloseTo(2);
    expect(result.targetReservedCents).toBe(6);
    expect(result.settlements).toEqual([{ stakeCents: 3, payoutCents: 2, relatedId: `${incumbent.id}:exit:exit-partial:partial-switch-exit` }]);
  });

  it('recovers a full DOWN reduce-only exit from a YES buy', () => {
    const incumbent = local({ side: 'DOWN', status: 'open', venueOrderId: 'venue-1', filledCount: 0.3, actualPurchaseCents: 8.7, actualFeeCents: 0, actualStakeCents: 8.7, stakeCents: 9, exitPending: true, exitClientOrderId: 'signal-desk-exit:down' });
    const entryOrder = { ...venueOrder, action: 'sell' };
    const entryFill = { ...venueFill, action: 'sell', yesPriceDollars: 0.71 };
    const exitOrder = { ...venueOrder, orderId: 'exit-down', clientOrderId: 'signal-desk-exit:down', action: 'buy', fillCount: 0.3 };
    const exitFill = { ...venueFill, orderId: 'exit-down', fillId: 'exit-down-fill', action: 'buy', yesPriceDollars: 0.8 };
    const result = reconcileExecutionLedger([incumbent], snapshot({ orders: [entryOrder, exitOrder], fills: [entryFill, exitFill] }), now);
    expect(result.issues).toEqual([]);
    expect(result.orders[0]).toMatchObject({ side: 'DOWN', status: 'sold' });
    expect(result.orders[0].saleProceedsCents).toBeCloseTo(6);
    expect(result.targetReservedCents).toBe(0);
  });

  it('recovers a full reduce-only exit without submitting a replacement', () => {
    const incumbent = local({ status: 'open', venueOrderId: 'venue-1', filledCount: 0.3, actualPurchaseCents: 8.7, actualFeeCents: 0, actualStakeCents: 8.7, stakeCents: 9, exitPending: true, exitClientOrderId: 'signal-desk-exit:test' });
    const exitOrder = { ...venueOrder, orderId: 'exit-venue', clientOrderId: 'signal-desk-exit:test', action: 'sell', fillCount: 0.3 };
    const exitFill = { ...venueFill, orderId: 'exit-venue', fillId: 'exit-fill', action: 'sell', yesPriceDollars: 0.2 };
    const result = reconcileExecutionLedger([incumbent], snapshot({ orders: [venueOrder, exitOrder], fills: [venueFill, exitFill] }), now);
    expect(result.issues).toEqual([]);
    expect(result.orders[0]).toMatchObject({ status: 'sold', exitPending: false, exitVenueOrderId: 'exit-venue', saleProceedsCents: 6 });
    expect(result.settlements).toEqual([{ stakeCents: 9, payoutCents: 6, relatedId: `${incumbent.id}:switch-exit` }]);
    expect(result.targetReservedCents).toBe(0);
  });
});
