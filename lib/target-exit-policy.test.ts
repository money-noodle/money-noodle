import { describe, expect, it } from 'vitest';
import {
  MINIMUM_EXIT_COUNT, TARGET_EXIT_POLL_MS, evaluateTargetExit, heldQuantity, observePeakBid,
  targetExitSettlement, type TargetExitPosition,
} from './target-exit-policy';

const closesAt = '2026-08-15T00:15:00Z';
const beforeClose = Date.parse('2026-08-15T00:07:00Z');
const afterClose = Date.parse('2026-08-15T00:15:30Z');

const position = (patch: Partial<TargetExitPosition> = {}): TargetExitPosition => ({
  status: 'open', filledQuantity: 1.8, soldQuantity: 0, closesAt, ...patch,
});

const evaluate = (
  patch: Partial<TargetExitPosition> = {},
  options: Partial<Parameters<typeof evaluateTargetExit>[1]> = {},
) => evaluateTargetExit(position(patch), { exitMarkCents: 90, ownedSideBidCents: 90, nowMs: beforeClose, ...options });

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

  it('sells exactly the held quantity, never a rounded-up one', () => {
    expect(evaluate({ filledQuantity: 1.8 })).toEqual({ action: 'sell', limitPriceCents: 90, count: 1.8 });
    expect(evaluate({ filledQuantity: 0.37 })).toEqual({ action: 'sell', limitPriceCents: 90, count: 0.37 });
  });
});

describe('polled target exit', () => {
  it('polls fast enough that only a sub-two-second spike is missed', () => {
    // Kalshi refuses reduce_only with good_till_canceled, so a resting order cannot do this. The
    // objection to polling was to a 15-second cadence: at two seconds a 90-second excursion is sampled
    // roughly 45 times.
    expect(TARGET_EXIT_POLL_MS).toBe(2_000);
    expect(90_000 / TARGET_EXIT_POLL_MS).toBeGreaterThan(40);
  });

  it('sells the moment the owned-side bid reaches the mark', () => {
    expect(evaluate({}, { ownedSideBidCents: 90 }).action).toBe('sell');
    expect(evaluate({}, { ownedSideBidCents: 95 }).action).toBe('sell');
  });

  it('waits below the mark rather than chasing', () => {
    expect(evaluate({}, { ownedSideBidCents: 89 })).toMatchObject({ action: 'wait' });
    expect(evaluate({}, { ownedSideBidCents: 10 })).toMatchObject({ action: 'wait' });
  });

  it('limits at the mark, not the observed bid, so a retreating quote produces no fill', () => {
    // The next tick re-evaluates; a worse fill is never accepted just because the quote moved.
    expect(evaluate({}, { ownedSideBidCents: 97 })).toEqual({ action: 'sell', limitPriceCents: 90, count: 1.8 });
  });

  it('never submits twice for one position', () => {
    expect(evaluate({ exitPending: true }, { ownedSideBidCents: 95 })).toMatchObject({ action: 'wait' });
  });

  it('starts no new exit while execution is draining', () => {
    expect(evaluate({}, { draining: true })).toMatchObject({ action: 'wait' });
  });

  it('never sells a position that is not open', () => {
    for (const status of ['won', 'lost', 'invalid', 'sold', 'unfilled', 'rejected', 'uncertain', 'pending_reservation'] as const) {
      expect(evaluate({ status }).action).toBe('wait');
    }
  });

  it('lets the position settle at close rather than selling into it', () => {
    // There is no fallback exit. A mid-window "sell at any price" would forfeit the entire thesis.
    const decision = evaluate({}, { nowMs: afterClose, ownedSideBidCents: 95 });
    expect(decision.action).toBe('wait');
    expect(decision).toMatchObject({ reason: expect.stringContaining('settles rather than selling') });
  });

  it('refuses a remainder below the venue minimum, an unusable mark, and a missing quote', () => {
    expect(evaluate({ filledQuantity: MINIMUM_EXIT_COUNT }).action).toBe('sell');
    expect(evaluate({ filledQuantity: 0.005 }).action).toBe('wait');
    expect(evaluate({}, { exitMarkCents: 0 }).action).toBe('wait');
    expect(evaluate({}, { exitMarkCents: 100 }).action).toBe('wait');
    expect(evaluate({}, { ownedSideBidCents: 0 }).action).toBe('wait');
    expect(evaluate({}, { ownedSideBidCents: Number.NaN }).action).toBe('wait');
  });
});

describe('peak bid evidence', () => {
  it('keeps the highest bid seen so every candidate mark stays evaluable later', () => {
    // Without this the only recoverable fact is whether the one mark in force was reached, and
    // re-choosing the mark would need another month of collection.
    let peak = observePeakBid(undefined, 12);
    peak = observePeakBid(peak, 47);
    peak = observePeakBid(peak, 88);
    peak = observePeakBid(peak, 31);
    expect(peak).toBe(88);
  });

  it('is not moved by a missing or nonsense quote', () => {
    expect(observePeakBid(80, Number.NaN)).toBe(80);
    expect(observePeakBid(80, -5)).toBe(80);
    expect(observePeakBid(undefined, Number.NaN)).toBe(0);
  });
});

describe('target exit settlement', () => {
  const entry = { entryQuantity: 1.8, entryStakeCents: 20 };

  it('books the designed round trip: 20c risked returns 140c', () => {
    const result = targetExitSettlement({ filledCount: 1.8, averagePriceCents: 90, feeCents: 2, ...entry });
    expect(result.proceedsCents).toBeCloseTo(160, 6);
    expect(result.realizedPnlCents).toBeCloseTo(140, 6);
    expect(result.remainingQuantity).toBe(0);
  });

  it('apportions cost by the fraction sold so the remainder keeps its own basis', () => {
    const half = targetExitSettlement({ filledCount: 0.9, averagePriceCents: 90, feeCents: 1, ...entry });
    expect(half.costBasisCents).toBeCloseTo(10, 6);
    expect(half.proceedsCents).toBeCloseTo(80, 6);
    expect(half.realizedPnlCents).toBeCloseTo(70, 6);
    expect(half.remainingQuantity).toBe(0.9);
  });

  it('cannot book a gain from a fill that never happened', () => {
    const none = targetExitSettlement({ filledCount: 0, averagePriceCents: 0, feeCents: 0, ...entry });
    expect(none.proceedsCents).toBe(0);
    expect(none.realizedPnlCents).toBe(0);
    expect(none.remainingQuantity).toBe(1.8);
  });
});
