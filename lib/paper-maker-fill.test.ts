import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { resolveRestingPaperOrders, restAtBid } from './paper-execution';
import type { DashboardData, PaperOrder } from './types';

const CLOSES = new Date(Date.now() + 600_000).toISOString();

const order = (over: Partial<PaperOrder> = {}): PaperOrder => ({
  id: 'paper:BTC:UP:x', logicalOrderId: 'paper:BTC:UP:x', attemptNumber: 1, clientOrderId: 'paper:BTC:UP:x',
  executionMode: 'paper', marketId: 'crypto-15m', providerId: 'kalshi', symbol: 'BTC', venue: 'kalshi',
  contractId: 'KX', side: 'UP', status: 'pending_reservation', createdAt: new Date().toISOString(),
  calculationAt: new Date().toISOString(), closesAt: CLOSES, modelProbabilityUp: 0.62, confidence: 0.7,
  askPrice: 0.45, bidPrice: 0.43, spread: 0.02, quantity: 4, requestedQuantity: 4,
  feeCents: 1, stakeCents: 181, potentialPayoutCents: 400,
  restingUntil: new Date(Date.now() + 12_000).toISOString(),
  ...over,
} as PaperOrder);

const dashboard = (ask: number, closesAt = CLOSES): DashboardData => ({
  predictions: [{
    symbol: 'BTC', market: { live: true, closesAt, askUp: ask, askDown: 1 - ask, bidUp: ask - 0.02, bidDown: 0.5 },
    kalshi: { venue: 'kalshi', live: true, closesAt, askUp: ask, askDown: 1 - ask, bidUp: ask - 0.02, bidDown: 0.5 },
  }],
} as unknown as DashboardData);

describe('paper maker simulation', () => {
  it('re-prices the candidate to rest at the bid, not the ask', () => {
    const resting = restAtBid(order(), 200)!;
    expect(resting.askPrice).toBe(0.45);           // immutable issuance ask
    expect(resting.initialSubmittedPrice).toBe(0.43); // limit actually posted
    expect(resting.entryExecutionObservations?.[0]).toMatchObject({ event: 'paper_submitted', limitPrice: 0.43 });
    expect(resting.status).toBe('pending_reservation');
    expect(resting.liquidityRole).toBe('maker');
    expect(resting.restingUntil).toBeDefined();
    // A cheaper limit buys more contracts for the same cap, which is the price improvement live earns.
    expect(resting.quantity).toBeGreaterThan(order().quantity);
  });

  it('fills only when the ask actually reaches the resting limit', () => {
    const ledger: any = { orders: [order({ askPrice: 0.43 })], paperBudget: { availableCents: 1000 } };
    expect(resolveRestingPaperOrders(dashboard(0.44), ledger)).toBe(false);
    expect(ledger.orders[0].status).toBe('pending_reservation');
    expect(resolveRestingPaperOrders(dashboard(0.43), ledger)).toBe(true);
    expect(ledger.orders[0].status).toBe('open');
    expect(ledger.orders[0].filledCount).toBe(ledger.orders[0].quantity);
    expect(ledger.orders[0].authoritativeFillPrice).toBe(0.43);
    expect(ledger.orders[0].entryExecutionObservations.at(-1)).toMatchObject({ event: 'paper_fill', limitPrice: 0.43 });
  });

  it('returns the reserved stake when the horizon expires without a fill', () => {
    const stale = order({ askPrice: 0.43, restingUntil: new Date(Date.now() - 1_000).toISOString() });
    const ledger: any = { orders: [stale], paperBudget: { availableCents: 1000 } };
    expect(resolveRestingPaperOrders(dashboard(0.48), ledger)).toBe(true);
    expect(ledger.orders[0].status).toBe('unfilled');
    expect(ledger.orders[0].noFillReason).toBe('rested_no_fill');
    expect(ledger.orders[0].makerCompletedAt).toBeDefined();
    // An unfilled attempt must cost the mirror nothing but the opportunity.
    expect(ledger.paperBudget.availableCents).toBe(1000 + stale.stakeCents);
  });

  it('never fills against a different contract window', () => {
    const ledger: any = { orders: [order({ askPrice: 0.43 })], paperBudget: { availableCents: 1000 } };
    const other = new Date(Date.parse(CLOSES) + 900_000).toISOString();
    resolveRestingPaperOrders(dashboard(0.30, other), ledger);
    expect(ledger.orders[0].status).toBe('pending_reservation');
  });

  it('expires a resting order once its own contract has closed', () => {
    const closed = order({ askPrice: 0.43, closesAt: new Date(Date.now() - 1).toISOString() });
    const ledger: any = { orders: [closed], paperBudget: { availableCents: 0 } };
    expect(resolveRestingPaperOrders(dashboard(0.48), ledger)).toBe(true);
    expect(ledger.orders[0].status).toBe('unfilled');
  });
});
