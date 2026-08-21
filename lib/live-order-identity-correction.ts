import type { BudgetAuditEvent, BudgetControl, LiveLedgerCorrection, LiveOrderCorrectionSnapshot, PaperOrder } from './types';

export const LIVE_ORDER_IDENTITY_CORRECTION_VERSION = 'live-order-identity-correction-v1' as const;
export const HYPE_IDENTITY_CORRECTION_ID = 'live-order-identity-correction:hype-up:2026-08-20T14:30:00Z';
export const HYPE_CANONICAL_ORDER_ID = 'live:HYPE:UP:2026-08-20T14:30:00Z:episode:3';
export const HYPE_CANONICAL_VENUE_ORDER_ID = '01a01f8a-3f48-7bce-9aeb-ceabbbdace9b';
export const HYPE_CANONICAL_VENUE_CLIENT_ORDER_ID = 'live:HYPE:UP:2026-08-20T14:30:-2';
export const HYPE_FALSE_ORDER_IDS = [
  'live:HYPE:UP:2026-08-20T14:30:00Z',
  'live:HYPE:UP:2026-08-20T14:30:00Z:episode:2',
] as const;
export const HYPE_CONTROL_CORRECTION_CENTS = 54;
const EXPECTED_REQUESTED = new Map<string, number>([
  [HYPE_FALSE_ORDER_IDS[0], 0.58], [HYPE_FALSE_ORDER_IDS[1], 0.55],
]);

export interface CorrectableLiveLedger {
  version: number;
  orders: PaperOrder[];
  liveCorrections?: LiveLedgerCorrection[];
}

export interface CorrectableTradingControl {
  control: BudgetControl;
  audit: BudgetAuditEvent[];
}

function close(left: number | undefined, right: number, epsilon = 1e-9): boolean {
  return left !== undefined && Math.abs(left - right) <= epsilon;
}

function snapshot(order: PaperOrder): LiveOrderCorrectionSnapshot {
  return {
    orderId: order.id, status: order.status, venueOrderId: order.venueOrderId,
    filledCount: order.filledCount, quantity: order.quantity, stakeCents: order.stakeCents,
    potentialPayoutCents: order.potentialPayoutCents,
    actualPurchaseCents: order.actualPurchaseCents, actualFeeCents: order.actualFeeCents,
    actualStakeCents: order.actualStakeCents, outcome: order.outcome,
    payoutCents: order.payoutCents, pnlCents: order.pnlCents,
    actualPnlCents: order.actualPnlCents, settledAt: order.settledAt,
  };
}

function terminalFill(order: PaperOrder): number | undefined {
  return order.entryExecutionObservations?.filter((item) => item.event === 'terminal_fill').at(-1)?.filledCount;
}

function assertCorrectedOrder(order: PaperOrder, requested: number): void {
  if (order.identityCorrectionId !== HYPE_IDENTITY_CORRECTION_ID || order.status !== 'unfilled'
    || order.venueOrderId !== undefined || order.filledCount !== 0 || !close(order.quantity, requested)
    || order.stakeCents !== 30 || order.actualStakeCents !== undefined || order.pnlCents !== undefined) {
    throw new Error(`${order.id}: existing HYPE identity correction projection is inconsistent.`);
  }
}

/** Mutates a stopped-worker ledger projection and appends the complete before/after correction evidence. */
export function applyHypeIdentityLedgerCorrection(
  ledger: CorrectableLiveLedger, at: string,
): { changed: boolean; correction: LiveLedgerCorrection } {
  const existing = (ledger.liveCorrections ?? []).find((item) => item.id === HYPE_IDENTITY_CORRECTION_ID);
  if (existing) {
    for (const id of HYPE_FALSE_ORDER_IDS) {
      const order = ledger.orders.find((item) => item.id === id);
      if (!order) throw new Error(`${id}: corrected row is missing.`);
      assertCorrectedOrder(order, EXPECTED_REQUESTED.get(id)!);
    }
    if (existing.controlAvailableDeltaCents !== HYPE_CONTROL_CORRECTION_CENTS
      || existing.controlRealizedPnlDeltaCents !== HYPE_CONTROL_CORRECTION_CENTS) {
      throw new Error('Existing HYPE identity correction has the wrong whole-cent control delta.');
    }
    ledger.version = 8;
    return { changed: false, correction: existing };
  }

  const falseOrders = HYPE_FALSE_ORDER_IDS.map((id) => {
    const order = ledger.orders.find((item) => item.id === id);
    if (!order) throw new Error(`${id}: required false-attribution row is missing.`);
    return order;
  });
  const canonical = ledger.orders.find((item) => item.id === HYPE_CANONICAL_ORDER_ID);
  if (!canonical) throw new Error(`${HYPE_CANONICAL_ORDER_ID}: canonical row is missing.`);
  for (const order of [...falseOrders, canonical]) {
    if (order.executionMode !== 'live' || order.venue !== 'kalshi' || order.side !== 'UP'
      || order.symbol !== 'HYPE' || order.closesAt !== '2026-08-20T14:30:00Z') {
      throw new Error(`${order.id}: correction identity does not match the approved HYPE incident.`);
    }
    if (order.venueOrderId !== HYPE_CANONICAL_VENUE_ORDER_ID) {
      throw new Error(`${order.id}: expected canonical venue order ID is absent.`);
    }
  }
  for (const order of falseOrders) {
    const requested = EXPECTED_REQUESTED.get(order.id)!;
    if (order.status !== 'lost' || !close(order.filledCount, 0.47) || !close(order.quantity, 0.47)
      || !close(order.requestedQuantity, requested) || order.stakeCents !== 27
      || order.reservedStakeCents !== 30 || !close(order.actualStakeCents, 26.79)
      || order.pnlCents !== -27 || !close(order.actualPnlCents, -26.79)
      || !close(terminalFill(order), 0)) {
      throw new Error(`${order.id}: row no longer matches the approved false-attribution preconditions.`);
    }
  }
  if (canonical.status !== 'lost' || !close(canonical.filledCount, 0.47)
    || !close(canonical.quantity, 0.47) || canonical.stakeCents !== 27
    || !close(canonical.actualStakeCents, 26.79) || !close(terminalFill(canonical), 0.47)) {
    throw new Error(`${canonical.id}: canonical episode-3 fill no longer matches the approved incident.`);
  }

  const before = falseOrders.map(snapshot);
  const exactPnlDeltaCents = -falseOrders.reduce((sum, order) => sum + order.actualPnlCents!, 0);
  if (!close(exactPnlDeltaCents, 53.58)) throw new Error(`Exact correction delta ${exactPnlDeltaCents}c is not 53.58c.`);

  for (const order of falseOrders) {
    const requested = EXPECTED_REQUESTED.get(order.id)!;
    order.status = 'unfilled';
    order.filledCount = 0;
    order.quantity = requested;
    order.stakeCents = order.reservedStakeCents!;
    order.potentialPayoutCents = Math.round(requested * 100);
    order.identityCorrectionId = HYPE_IDENTITY_CORRECTION_ID;
    order.noFillReason = 'rested_no_fill';
    order.reason = 'Identity correction restored the authoritative managed-maker terminal zero-fill; the later episode-3 venue fill had been attributed here by a truncated client-ID collision.';
    delete order.venueOrderId;
    delete order.authoritativeFillPrice;
    delete order.actualPurchaseCents;
    delete order.actualFeeCents;
    delete order.actualStakeCents;
    delete order.outcome;
    delete order.payoutCents;
    delete order.pnlCents;
    delete order.actualPnlCents;
    delete order.settledAt;
  }

  const correction: LiveLedgerCorrection = {
    id: HYPE_IDENTITY_CORRECTION_ID, version: LIVE_ORDER_IDENTITY_CORRECTION_VERSION, at,
    reason: 'Restored HYPE episodes 1 and 2 to their authoritative terminal zero-fills after truncated acknowledgement-race client IDs caused episode 3’s one venue fill to match all three rows.',
    canonicalOrderId: HYPE_CANONICAL_ORDER_ID,
    canonicalVenueOrderId: HYPE_CANONICAL_VENUE_ORDER_ID,
    canonicalVenueClientOrderId: HYPE_CANONICAL_VENUE_CLIENT_ORDER_ID,
    affectedOrderIds: [...HYPE_FALSE_ORDER_IDS], exactPnlDeltaCents,
    controlAvailableDeltaCents: HYPE_CONTROL_CORRECTION_CENTS,
    controlRealizedPnlDeltaCents: HYPE_CONTROL_CORRECTION_CENTS,
    before, after: falseOrders.map(snapshot),
  };
  ledger.version = 8;
  ledger.liveCorrections = [...(ledger.liveCorrections ?? []), correction];
  return { changed: true, correction };
}

/** Applies the whole-cent projection once; old settlement events remain immutable in the audit trail. */
export function applyHypeIdentityControlCorrection(
  stored: CorrectableTradingControl, at: string,
): { changed: boolean; amountCents: number } {
  const existing = stored.audit.find((item) => item.id === HYPE_IDENTITY_CORRECTION_ID);
  if (existing) {
    if (existing.type !== 'corrected' || existing.amountCents !== HYPE_CONTROL_CORRECTION_CENTS) {
      throw new Error('Existing HYPE control correction audit event is inconsistent.');
    }
    return { changed: false, amountCents: HYPE_CONTROL_CORRECTION_CENTS };
  }
  const control = stored.control;
  if (control.state !== 'paused' || control.operatorIntent !== 'paused' || control.reservedBudgetCents !== 0) {
    throw new Error('HYPE identity correction requires operator-paused control with zero reserved budget.');
  }
  if (control.availableBudgetCents + control.reservedBudgetCents
    !== control.startingBudgetCents + control.realizedPnlCents) {
    throw new Error('Live budget identity is already inconsistent; refusing to hide another discrepancy.');
  }
  for (const orderId of [...HYPE_FALSE_ORDER_IDS, HYPE_CANONICAL_ORDER_ID]) {
    const settlements = stored.audit.filter((item) => item.type === 'settled'
      && item.relatedId === orderId && item.amountCents === 27 && item.payoutCents === 0);
    if (settlements.length !== 1) throw new Error(`${orderId}: expected exactly one 27c/0c settlement audit event.`);
  }
  const previousState = control.state;
  control.availableBudgetCents += HYPE_CONTROL_CORRECTION_CENTS;
  control.realizedPnlCents += HYPE_CONTROL_CORRECTION_CENTS;
  control.revision += 1;
  control.updatedAt = at;
  stored.audit.push({
    id: HYPE_IDENTITY_CORRECTION_ID, timestamp: at, revision: control.revision, type: 'corrected',
    reason: 'Returned two false 27c HYPE losses created when one episode-3 venue fill was attributed to episodes 1 and 2 by the truncated client-ID matcher.',
    previousState, newState: control.state, amountCents: HYPE_CONTROL_CORRECTION_CENTS,
    venue: 'kalshi', relatedId: HYPE_CANONICAL_ORDER_ID,
  });
  return { changed: true, amountCents: HYPE_CONTROL_CORRECTION_CENTS };
}
