import { describe, expect, it } from 'vitest';
import { isTradingVenueEnabled, normalizeEnabledVenues, proposedStakeCents, reconcileBudgetReservations, releaseBudget, reserveBudget, settleBudget, workingEquityCents } from './budget-ledger';
import type { BudgetControl } from './types';

function control(overrides: Partial<BudgetControl> = {}): BudgetControl {
  return {
    revision: 1, state: 'active', mode: 'paper', startingBudgetCents: 10_000,
    availableBudgetCents: 10_000, reservedBudgetCents: 0, realizedPnlCents: 0,
    perTradeCents: 100, purchasePercent: 1, enabledVenues: ['polymarket', 'kalshi'], updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('dynamic working-budget ledger', () => {
  it('sizes each trade at the configured all-in amount, independent of equity', () => {
    // Risk per transaction stays where the user set it rather than drifting with the bankroll.
    expect(proposedStakeCents(control({ perTradeCents: 100 }))).toBe(100);
    expect(proposedStakeCents(control({ perTradeCents: 100, availableBudgetCents: 12_345, startingBudgetCents: 12_345 }))).toBe(100);
  });

  it('never stakes more than the budget still holds', () => {
    expect(proposedStakeCents(control({ perTradeCents: 500, availableBudgetCents: 120 }))).toBe(120);
    expect(proposedStakeCents(control({ perTradeCents: 500, availableBudgetCents: 0 }))).toBe(0);
  });

  it('falls back to legacy percentage sizing for records saved before per-trade amounts', () => {
    expect(proposedStakeCents(control({ perTradeCents: 0, purchasePercent: 1 }))).toBe(100);
  });

  it('reserves stake without changing equity', () => {
    const reserved = reserveBudget(control(), 100);
    expect(reserved.availableBudgetCents).toBe(9_900);
    expect(reserved.reservedBudgetCents).toBe(100);
    expect(workingEquityCents(reserved)).toBe(10_000);
  });

  it('releases unused maker-order reserve without recording P&L', () => {
    const reserved = reserveBudget(control(), 100);
    const adjusted = releaseBudget(reserved, 35);
    expect(adjusted.availableBudgetCents).toBe(9_935);
    expect(adjusted.reservedBudgetCents).toBe(65);
    expect(adjusted.realizedPnlCents).toBe(0);
    expect(workingEquityCents(adjusted)).toBe(10_000);
  });

  it('tracks equity through wins and losses while holding stake size fixed', () => {
    const reserved = reserveBudget(control({ perTradeCents: 100 }), 100);
    const won = settleBudget(reserved, 100, 200);
    expect(won.realizedPnlCents).toBe(100);
    expect(workingEquityCents(won)).toBe(10_100);
    expect(proposedStakeCents(won)).toBe(100);

    const lost = settleBudget(reserved, 100, 0);
    expect(lost.realizedPnlCents).toBe(-100);
    expect(workingEquityCents(lost)).toBe(9_900);
    expect(proposedStakeCents(lost)).toBe(100);
  });

  it('moves to depleted after settlement consumes all working equity', () => {
    const depleted = settleBudget(control({ availableBudgetCents: 0, reservedBudgetCents: 100 }), 100, 0);
    expect(depleted.state).toBe('depleted');
    expect(depleted.pauseReason).toBe('Working budget depleted');
    expect(proposedStakeCents(depleted)).toBe(0);
  });

  it('rebuilds reservations without changing equity or realized P&L', () => {
    const stale = control({ availableBudgetCents: 9_970, reservedBudgetCents: 30, realizedPnlCents: -12 });
    const reconciled = reconcileBudgetReservations(stale, 55, 10_000);
    expect(reconciled.availableBudgetCents).toBe(9_945);
    expect(reconciled.reservedBudgetCents).toBe(55);
    expect(reconciled.realizedPnlCents).toBe(-12);
    expect(workingEquityCents(reconciled)).toBe(10_000);
  });

  it('fails closed on stale venue cash or impossible recovered exposure', () => {
    expect(() => reconcileBudgetReservations(control(), 10_001, 20_000)).toThrow(/cannot reserve/i);
    expect(() => reconcileBudgetReservations(control(), 100, 9_899)).toThrow(/below local uncommitted budget/i);
    expect(() => reconcileBudgetReservations(control(), 100, Number.NaN)).toThrow(/below local uncommitted budget/i);
  });

  it('supports independent venue enablement and rejects unknown values', () => {
    expect(normalizeEnabledVenues(['kalshi', 'kalshi', 'unknown'])).toEqual(['kalshi']);
    expect(isTradingVenueEnabled(control({ enabledVenues: ['kalshi'] }), 'kalshi')).toBe(true);
    expect(isTradingVenueEnabled(control({ enabledVenues: ['kalshi'] }), 'polymarket')).toBe(false);
  });

  it('never reserves while paused or above available budget', () => {
    expect(() => reserveBudget(control({ state: 'paused' }), 100)).toThrow(/active/);
    expect(() => reserveBudget(control(), 10_001)).toThrow(/exceeds/);
  });
});
