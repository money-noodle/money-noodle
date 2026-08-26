import { describe, expect, it } from 'vitest';
import { countFilledLiveVenueOrders } from './order-rate-limit';
import type { PaperOrder } from './types';

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: crypto.randomUUID(), executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: 'TEST',
    side: 'UP', status: 'rejected', createdAt: '2026-01-01T00:30:00.000Z', calculationAt: '2026-01-01T00:30:00.000Z',
    closesAt: '2026-01-01T00:45:00.000Z', modelProbabilityUp: 0.7, confidence: 0.7,
    askPrice: 0.4, bidPrice: 0.39, spread: 0.01, quantity: 0.2, stakeCents: 9, feeCents: 1,
    potentialPayoutCents: 20, ...overrides,
  };
}

const since = Date.parse('2026-01-01T00:00:00.000Z');

describe('filled venue order rate limit', () => {
  it('ignores failures without a fill', () => {
    expect(countFilledLiveVenueOrders([
      order({ status: 'rejected', reason: 'invalid order' }),
      order({ status: 'rejected', venueOrderId: 'accepted-rejected', filledCount: 0 }),
    ], since)).toBe(0);
  });

  it('ignores accepted-but-unfilled orders and counts actual entry fills', () => {
    expect(countFilledLiveVenueOrders([
      order({ status: 'unfilled', venueOrderId: 'accepted-unfilled', filledCount: 0 }),
      order({ status: 'open', venueOrderId: 'accepted-filled', filledCount: 0.2 }),
    ], since)).toBe(1);
  });

  it('counts a filled reduce-only exit separately and deduplicates copied entry ids', () => {
    const original = order({ status: 'open', venueOrderId: 'entry', filledCount: 0.2 });
    const partial = order({
      status: 'sold', venueOrderId: 'entry', filledCount: 0.2,
      exitVenueOrderId: 'exit', saleProceedsCents: 4.5, settledAt: '2026-01-01T00:40:00.000Z',
    });
    expect(countFilledLiveVenueOrders([original, partial], since)).toBe(2);
  });

  it('ignores fills outside the rolling hour', () => {
    expect(countFilledLiveVenueOrders([
      order({ venueOrderId: 'old', filledCount: 0.2, createdAt: '2025-12-31T23:59:59.999Z' }),
    ], since)).toBe(0);
  });
});
