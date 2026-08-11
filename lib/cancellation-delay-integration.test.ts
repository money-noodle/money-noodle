import { describe, expect, it } from 'vitest';
import { systemSuspensionFields } from './automation-resume-policy';
import { reconcileBudgetReservations, releaseBudget, reserveBudget } from './budget-ledger';
import { confirmKalshiCancellation } from './live-orders';
import type { BudgetControl } from './types';

const activeControl = (): BudgetControl => ({
  revision: 1, state: 'active', mode: 'live', startingBudgetCents: 100,
  availableBudgetCents: 100, reservedBudgetCents: 0, realizedPnlCents: 0,
  perTradeCents: 10, purchasePercent: 1, enabledVenues: ['kalshi'],
  operatorIntent: 'active', autoResumeEligible: false, updatedAt: '2026-01-01T00:00:00Z',
});

describe('managed cancellation consistency integration', () => {
  it('releases an unfilled reservation without changing active operator intent after bounded polling confirms cancellation', async () => {
    const reserved = reserveBudget(activeControl(), 10);
    const responses = [
      { order: { status: 'resting', remaining_count_fp: '0.20' } },
      { order: { status: 'canceled', remaining_count_fp: '0.00' } },
    ];

    await confirmKalshiCancellation(
      'venue-lagged',
      async () => responses.shift()!,
      async () => undefined,
      [0, 250],
    );
    const released = releaseBudget(reserved, 10);

    expect(released).toMatchObject({
      state: 'active', operatorIntent: 'active', autoResumeEligible: false,
      availableBudgetCents: 100, reservedBudgetCents: 0, realizedPnlCents: 0,
    });
  });

  it('retains the reservation and active intent behind a guarded system suspension when confirmation expires', async () => {
    const reserved = reserveBudget(activeControl(), 10);
    await expect(confirmKalshiCancellation(
      'venue-ambiguous',
      async () => ({ order: { status: 'resting', remaining_count_fp: '0.20' } }),
      async () => undefined,
      [0, 250, 750],
    )).rejects.toThrow(/remains uncertain/);

    const suspended = { ...reserved, ...systemSuspensionFields(reserved) };
    expect(suspended).toMatchObject({
      state: 'paused', operatorIntent: 'active', pauseOrigin: 'system', autoResumeEligible: true,
      availableBudgetCents: 90, reservedBudgetCents: 10,
    });

    // Only an authoritative zero-position snapshot may release the retained reservation. The
    // operator's active intent remains eligible for the separate guarded-resume readiness check.
    const reconciled = reconcileBudgetReservations(suspended, 0, 100);
    expect(reconciled).toMatchObject({
      state: 'paused', operatorIntent: 'active', autoResumeEligible: true,
      availableBudgetCents: 100, reservedBudgetCents: 0, realizedPnlCents: 0,
    });
  });
});
