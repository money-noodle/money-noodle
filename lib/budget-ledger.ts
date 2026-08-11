import type { BudgetControl } from './types';

export const DEFAULT_MAX_PURCHASE_PERCENT = 10;
export const MIN_PURCHASE_PERCENT = 0.01;

export function normalizeEnabledVenues(input: string[]): Array<'polymarket' | 'kalshi'> {
  return [...new Set(input)].filter((venue): venue is 'polymarket' | 'kalshi' => venue === 'polymarket' || venue === 'kalshi');
}

export function isTradingVenueEnabled(control: BudgetControl, venue: 'polymarket' | 'kalshi'): boolean {
  return control.enabledVenues.includes(venue);
}

export function workingEquityCents(control: BudgetControl): number {
  return control.availableBudgetCents + control.reservedBudgetCents;
}

/**
 * The all-in amount the next purchase may spend, fees included.
 *
 * This is a fixed amount rather than a percentage of equity so risk per transaction stays where the
 * user set it. Kalshi execution can reduce quantity to 0.01-contract increments when a whole
 * contract would exceed this all-in amount.
 */
export function proposedStakeCents(control: BudgetControl): number {
  if (control.state === 'unconfigured' || control.state === 'depleted') return 0;
  const perTrade = control.perTradeCents > 0
    ? control.perTradeCents
    : Math.floor(workingEquityCents(control) * control.purchasePercent / 100);
  return Math.max(0, Math.min(control.availableBudgetCents, perTrade));
}

export function reserveBudget(control: BudgetControl, amountCents: number): BudgetControl {
  if (control.state !== 'active') throw new Error('Automation must be active before reserving budget.');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Reservation must be a positive whole-cent amount.');
  if (amountCents > control.availableBudgetCents) throw new Error('Reservation exceeds available working budget.');
  return {
    ...control,
    revision: control.revision + 1,
    availableBudgetCents: control.availableBudgetCents - amountCents,
    reservedBudgetCents: control.reservedBudgetCents + amountCents,
    updatedAt: new Date().toISOString(),
  };
}

/** Returns an unused portion of a reservation without recognizing profit or loss. */
export function releaseBudget(control: BudgetControl, amountCents: number): BudgetControl {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > control.reservedBudgetCents) throw new Error('Release does not match reserved budget.');
  return {
    ...control,
    revision: control.revision + 1,
    availableBudgetCents: control.availableBudgetCents + amountCents,
    reservedBudgetCents: control.reservedBudgetCents - amountCents,
    updatedAt: new Date().toISOString(),
  };
}

/** Rebuilds reservations from authoritative exposure while preserving total working equity and P&L. */
export function reconcileBudgetReservations(control: BudgetControl, targetReservedCents: number, venueBalanceCents: number): BudgetControl {
  const total = workingEquityCents(control);
  if (!Number.isSafeInteger(targetReservedCents) || targetReservedCents < 0 || targetReservedCents > total) {
    throw new Error(`Reconciliation cannot reserve ${targetReservedCents}c from ${total}c working equity.`);
  }
  const availableBudgetCents = total - targetReservedCents;
  if (!Number.isFinite(venueBalanceCents) || venueBalanceCents + 0.01 < availableBudgetCents) {
    throw new Error(`Reconciled Kalshi cash ${venueBalanceCents.toFixed(2)}c is below local uncommitted budget ${availableBudgetCents}c.`);
  }
  return {
    ...control, revision: control.revision + 1, availableBudgetCents,
    reservedBudgetCents: targetReservedCents, updatedAt: new Date().toISOString(),
  };
}

export function settleBudget(control: BudgetControl, stakeCents: number, payoutCents: number): BudgetControl {
  if (!Number.isInteger(stakeCents) || stakeCents <= 0 || stakeCents > control.reservedBudgetCents) throw new Error('Settlement stake does not match reserved budget.');
  if (!Number.isInteger(payoutCents) || payoutCents < 0) throw new Error('Settlement payout must be a non-negative whole-cent amount.');
  const next: BudgetControl = {
    ...control,
    revision: control.revision + 1,
    availableBudgetCents: control.availableBudgetCents + payoutCents,
    reservedBudgetCents: control.reservedBudgetCents - stakeCents,
    realizedPnlCents: control.realizedPnlCents + payoutCents - stakeCents,
    updatedAt: new Date().toISOString(),
  };
  if (workingEquityCents(next) <= 0) {
    next.state = 'depleted';
    next.pauseReason = 'Working budget depleted';
  }
  return next;
}
