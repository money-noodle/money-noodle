import { describe, expect, it } from 'vitest';
import {
  applyHypeIdentityControlCorrection, applyHypeIdentityLedgerCorrection,
  HYPE_CANONICAL_ORDER_ID, HYPE_CANONICAL_VENUE_ORDER_ID, HYPE_CONTROL_CORRECTION_CENTS,
  HYPE_FALSE_ORDER_IDS, HYPE_IDENTITY_CORRECTION_ID,
  type CorrectableLiveLedger, type CorrectableTradingControl,
} from './live-order-identity-correction';
import type { BudgetAuditEvent, BudgetControl, PaperOrder } from './types';

const at = '2026-08-21T01:00:00.000Z';
const terminal = (filledCount: number) => [{ at, event: 'terminal_fill' as const, filledCount }];

function order(id: string, requested: number, terminalCount: number): PaperOrder {
  return {
    id, logicalOrderId: HYPE_FALSE_ORDER_IDS[0], executionMode: 'live', strategyId: 'edge-binary-buy',
    symbol: 'HYPE', venue: 'kalshi', providerId: 'kalshi', contractId: 'KXHYPE', side: 'UP',
    status: 'lost', createdAt: at, calculationAt: at, closesAt: '2026-08-20T14:30:00Z',
    modelProbabilityUp: 0.7, confidence: 0.7, askPrice: 0.6, bidPrice: 0.57, spread: 0.03,
    venueOrderId: HYPE_CANONICAL_VENUE_ORDER_ID, filledCount: 0.47, quantity: 0.47,
    requestedQuantity: requested, reservedStakeCents: 30, stakeCents: 27, feeCents: 0,
    actualPurchaseCents: 26.79, actualFeeCents: 0, actualStakeCents: 26.79,
    potentialPayoutCents: 47, outcome: 'DOWN', payoutCents: 0, pnlCents: -27,
    actualPnlCents: -26.79, settledAt: at, noFillReason: id === HYPE_CANONICAL_ORDER_ID ? undefined : 'rested_no_fill',
    entryExecutionObservations: terminal(terminalCount),
  };
}

function ledger(): CorrectableLiveLedger {
  return { version: 7, liveCorrections: [], orders: [
    order(HYPE_FALSE_ORDER_IDS[0], 0.58, 0),
    order(HYPE_FALSE_ORDER_IDS[1], 0.55, 0),
    order(HYPE_CANONICAL_ORDER_ID, 0.47, 0.47),
  ] };
}

function control(): CorrectableTradingControl {
  const value = {
    revision: 10, state: 'paused', mode: 'live', startingBudgetCents: 2_000,
    availableBudgetCents: 1_755, reservedBudgetCents: 0, realizedPnlCents: -245,
    perTradeCents: 100, purchasePercent: 10, enabledVenues: ['kalshi'],
    operatorIntent: 'paused', pauseOrigin: 'user', autoResumeEligible: false,
    updatedAt: '2026-08-21T00:00:00Z',
  } as BudgetControl;
  const audit = [...HYPE_FALSE_ORDER_IDS, HYPE_CANONICAL_ORDER_ID].map((relatedId, index): BudgetAuditEvent => ({
    id: `settlement-${index}`, timestamp: at, revision: index, type: 'settled', reason: 'Trade settled',
    previousState: 'active', newState: 'active', amountCents: 27, payoutCents: 0,
    venue: 'kalshi', relatedId,
  }));
  return { control: value, audit };
}

describe('HYPE repeated-episode identity correction', () => {
  it('restores only the two observed zero-fills and preserves a complete correction record', () => {
    const value = ledger();
    const result = applyHypeIdentityLedgerCorrection(value, at);
    expect(result.changed).toBe(true);
    expect(value.version).toBe(8);
    expect(value.liveCorrections).toHaveLength(1);
    expect(result.correction).toMatchObject({
      id: HYPE_IDENTITY_CORRECTION_ID, canonicalOrderId: HYPE_CANONICAL_ORDER_ID,
      exactPnlDeltaCents: 53.58, controlAvailableDeltaCents: HYPE_CONTROL_CORRECTION_CENTS,
    });
    expect(result.correction.before.map((item) => item.status)).toEqual(['lost', 'lost']);
    expect(result.correction.after.map((item) => item.status)).toEqual(['unfilled', 'unfilled']);
    expect(value.orders.slice(0, 2)).toMatchObject([
      { status: 'unfilled', filledCount: 0, quantity: 0.58, stakeCents: 30, potentialPayoutCents: 58, identityCorrectionId: HYPE_IDENTITY_CORRECTION_ID },
      { status: 'unfilled', filledCount: 0, quantity: 0.55, stakeCents: 30, potentialPayoutCents: 55, identityCorrectionId: HYPE_IDENTITY_CORRECTION_ID },
    ]);
    for (const restored of value.orders.slice(0, 2)) {
      expect(restored.venueOrderId).toBeUndefined();
      expect(restored.actualStakeCents).toBeUndefined();
      expect(restored.pnlCents).toBeUndefined();
      expect(restored.entryExecutionObservations?.at(-1)?.filledCount).toBe(0);
    }
    expect(value.orders[2]).toMatchObject({ status: 'lost', venueOrderId: HYPE_CANONICAL_VENUE_ORDER_ID, filledCount: 0.47 });
  });

  it('is idempotent and refuses drifted source evidence', () => {
    const value = ledger();
    applyHypeIdentityLedgerCorrection(value, at);
    expect(applyHypeIdentityLedgerCorrection(value, at).changed).toBe(false);
    expect(value.liveCorrections).toHaveLength(1);

    const drifted = ledger();
    drifted.orders[0].entryExecutionObservations = terminal(0.01);
    expect(() => applyHypeIdentityLedgerCorrection(drifted, at)).toThrow('preconditions');
  });

  it('returns the two false whole-cent settlements exactly once', () => {
    const stored = control();
    expect(applyHypeIdentityControlCorrection(stored, at)).toEqual({ changed: true, amountCents: 54 });
    expect(stored.control).toMatchObject({ availableBudgetCents: 1_809, realizedPnlCents: -191, revision: 11 });
    expect(stored.audit.at(-1)).toMatchObject({
      id: HYPE_IDENTITY_CORRECTION_ID, type: 'corrected', amountCents: 54,
      relatedId: HYPE_CANONICAL_ORDER_ID,
    });
    expect(applyHypeIdentityControlCorrection(stored, at).changed).toBe(false);
    expect(stored.control).toMatchObject({ availableBudgetCents: 1_809, realizedPnlCents: -191 });
  });

  it('refuses to correct active or internally inconsistent control', () => {
    const active = control();
    active.control.state = 'active';
    expect(() => applyHypeIdentityControlCorrection(active, at)).toThrow('operator-paused');
    const inconsistent = control();
    inconsistent.control.availableBudgetCents += 1;
    expect(() => applyHypeIdentityControlCorrection(inconsistent, at)).toThrow('already inconsistent');
  });
});
