import { describe, expect, it } from 'vitest';
import {
  MINIMUM_EXIT_COUNT, evaluateRestingExit, heldQuantity, restingExitSettlement,
  type RestingExitPosition,
} from './resting-exit-policy';

const closesAt = '2026-08-15T00:15:00Z';
const beforeClose = Date.parse('2026-08-15T00:07:00Z');
const afterClose = Date.parse('2026-08-15T00:15:30Z');

const position = (patch: Partial<RestingExitPosition> = {}): RestingExitPosition => ({
  status: 'open', filledQuantity: 1.8, soldQuantity: 0, closesAt, ...patch,
});

const evaluate = (patch: Partial<RestingExitPosition> = {}, options: Partial<Parameters<typeof evaluateRestingExit>[1]> = {}) =>
  evaluateRestingExit(position(patch), { exitMarkCents: 90, nowMs: beforeClose, ...options });

describe('reduce-only quantity bound', () => {
  it('never reports more held than was acquired', () => {
    expect(heldQuantity({ filledQuantity: 1.8, soldQuantity: 0 })).toBe(1.8);
    expect(heldQuantity({ filledQuantity: 1.8, soldQuantity: 0.8 })).toBe(1);
    expect(heldQuantity({ filledQuantity: 1.8, soldQuantity: 5 })).toBe(0);
    expect(heldQuantity({ filledQuantity: -1, soldQuantity: 0 })).toBe(0);
    expect(heldQuantity({ filledQuantity: Number.NaN, soldQuantity: 0 })).toBe(0);
    // Rounds down, never to nearest: 0.005 held must not become 0.01 sellable.
    expect(heldQuantity({ filledQuantity: 0.005, soldQuantity: 0 })).toBe(0);
    expect(heldQuantity({ filledQuantity: 1.799, soldQuantity: 0 })).toBe(1.79);
    expect(heldQuantity({ filledQuantity: 1.8, soldQuantity: 0.005 })).toBe(1.79);
  });

  it('withdraws a resting order larger than the position before anything else is considered', () => {
    // The independent check on top of the venue's reduce_only flag. Selling more than is held is the one
    // way this strategy could open a short, so it is caught ahead of every other condition.
    const decision = evaluate({ filledQuantity: 1, restingCount: 1.8, exitVenueOrderId: 'v1' });
    expect(decision.action).toBe('cancel');
    expect(decision).toMatchObject({ reason: expect.stringContaining('exceeds the 1 held') });
  });

  it('places for exactly the held quantity, never a rounded-up one', () => {
    expect(evaluate({ filledQuantity: 1.8 })).toEqual({ action: 'place', limitPriceCents: 90, count: 1.8 });
    expect(evaluate({ filledQuantity: 0.37 })).toEqual({ action: 'place', limitPriceCents: 90, count: 0.37 });
  });
});

describe('resting exit lifecycle', () => {
  it('places once the entry is filled and nothing is resting yet', () => {
    expect(evaluate()).toEqual({ action: 'place', limitPriceCents: 90, count: 1.8 });
  });

  it('leaves a correctly sized resting order alone', () => {
    expect(evaluate({ restingCount: 1.8, exitVenueOrderId: 'v1' })).toMatchObject({ action: 'hold' });
  });

  it('cancels to reach quiescence when execution is draining', () => {
    // A working order is exactly what stops the drain reporting restart-safe.
    expect(evaluate({ restingCount: 1.8, exitVenueOrderId: 'v1' }, { draining: true })).toMatchObject({ action: 'cancel' });
    expect(evaluate({}, { draining: true })).toMatchObject({ action: 'hold' });
  });

  it('cancels once the position is gone, and never places against one', () => {
    expect(evaluate({ filledQuantity: 0, restingCount: 1.8, exitVenueOrderId: 'v1' })).toMatchObject({ action: 'cancel' });
    expect(evaluate({ status: 'sold', restingCount: 1.8, exitVenueOrderId: 'v1' })).toMatchObject({ action: 'cancel' });
    for (const status of ['won', 'lost', 'invalid', 'unfilled', 'rejected', 'uncertain', 'pending_reservation'] as const) {
      expect(evaluate({ status }).action).not.toBe('place');
    }
  });

  it('lets an unfilled order expire at close rather than selling into it', () => {
    // There is no fallback exit. A mid-window "sell at any price" would forfeit the entire thesis, so
    // past close the correct action is nothing at all.
    const decision = evaluate({ restingCount: 1.8, exitVenueOrderId: 'v1' }, { nowMs: afterClose });
    expect(decision.action).toBe('hold');
    expect(decision).toMatchObject({ reason: expect.stringContaining('expires with the contract') });
    expect(evaluate({}, { nowMs: afterClose }).action).toBe('hold');
  });

  it('refuses a remainder below the venue minimum, and an unusable mark', () => {
    expect(evaluate({ filledQuantity: MINIMUM_EXIT_COUNT }).action).toBe('place');
    expect(evaluate({ filledQuantity: 0.005 }).action).toBe('hold');
    expect(evaluate({}, { exitMarkCents: 0 }).action).toBe('hold');
    expect(evaluate({}, { exitMarkCents: 100 }).action).toBe('hold');
  });
});

describe('resting exit settlement', () => {
  const entry = { entryQuantity: 1.8, entryStakeCents: 20 };

  it('books the designed round trip: 20c risked returns 140c', () => {
    const result = restingExitSettlement({ filledCount: 1.8, averagePriceCents: 90, feeCents: 2, ...entry });
    expect(result.proceedsCents).toBeCloseTo(160, 6);
    expect(result.realizedPnlCents).toBeCloseTo(140, 6);
    expect(result.remainingQuantity).toBe(0);
  });

  it('apportions cost by the fraction sold so the remainder keeps its own basis', () => {
    // A partial fill is an ordinary outcome here, not an error: the remainder simply keeps resting.
    const half = restingExitSettlement({ filledCount: 0.9, averagePriceCents: 90, feeCents: 1, ...entry });
    expect(half.costBasisCents).toBeCloseTo(10, 6);
    expect(half.proceedsCents).toBeCloseTo(80, 6);
    expect(half.realizedPnlCents).toBeCloseTo(70, 6);
    expect(half.remainingQuantity).toBe(0.9);
  });

  it('cannot book a gain from a fill that never happened', () => {
    const none = restingExitSettlement({ filledCount: 0, averagePriceCents: 0, feeCents: 0, ...entry });
    expect(none.proceedsCents).toBe(0);
    expect(none.costBasisCents).toBe(0);
    expect(none.realizedPnlCents).toBe(0);
    expect(none.remainingQuantity).toBe(1.8);
  });
});
