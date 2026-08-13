import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { drawdownReferenceCents, settleBudget, withPeakEquity } from './budget-ledger';
import { evaluateLiveRisk } from './live-risk-policy';
import type { BudgetControl } from './types';

const control = (over: Partial<BudgetControl> = {}): BudgetControl => ({
  revision: 1, state: 'active', mode: 'live', startingBudgetCents: 2_000,
  availableBudgetCents: 2_000, reservedBudgetCents: 0, realizedPnlCents: 0,
  perTradeCents: 200, purchasePercent: 10, enabledVenues: ['kalshi'],
  updatedAt: '2026-08-13T00:00:00.000Z', ...over,
});

describe('peak-equity drawdown', () => {
  it('falls back to the funded amount before any peak is recorded', () => {
    expect(drawdownReferenceCents(control())).toBe(2_000);
  });

  it('never drops below the funded amount, so the stop cannot loosen', () => {
    expect(drawdownReferenceCents(control({ peakEquityCents: 500 }))).toBe(2_000);
  });

  it('records a new peak as equity rises', () => {
    const grown = withPeakEquity(control({ availableBudgetCents: 3_000 }));
    expect(grown.peakEquityCents).toBe(3_000);
    // and holds it as equity falls back
    expect(withPeakEquity({ ...grown, availableBudgetCents: 2_200 }).peakEquityCents).toBe(3_000);
  });

  it('is the case the old measure missed: a fall after a run-up now registers', () => {
    const afterRunUp = control({ availableBudgetCents: 2_200, peakEquityCents: 3_000 });
    const old = Math.max(0, afterRunUp.startingBudgetCents - 2_200);
    const now = evaluateLiveRisk(afterRunUp, []).currentEpochDrawdownCents;
    expect(old).toBe(0);      // funded 2000, equity 2200 -> looked like no drawdown at all
    expect(now).toBe(800);    // peak 3000 -> the real 800c fall is visible
  });

  it('can only tighten: the new figure is never below the old one', () => {
    for (const [starting, equity, peak] of [[2_000, 1_500, 2_500], [2_000, 1_500, undefined], [2_000, 2_400, 2_400], [500, 100, 900]] as const) {
      const c = control({ startingBudgetCents: starting, availableBudgetCents: equity, peakEquityCents: peak });
      const old = Math.max(0, starting - equity);
      expect(evaluateLiveRisk(c, []).currentEpochDrawdownCents).toBeGreaterThanOrEqual(old);
    }
  });

  it('trips the stop after a run-up that the old measure would have ignored', () => {
    // 25% of a 2000c budget is a 500c stop. Equity 2200 is above funded, so the old measure allowed it.
    const risk = evaluateLiveRisk(control({ availableBudgetCents: 2_200, peakEquityCents: 3_000 }), []);
    expect(risk.allowed).toBe(false);
    expect(risk.reasons.join(' ')).toMatch(/drawdown/i);
  });

  it('updates the peak through a winning settlement', () => {
    const reserved = control({ availableBudgetCents: 1_800, reservedBudgetCents: 200 });
    const settled = settleBudget(reserved, 200, 600);
    expect(settled.peakEquityCents).toBe(2_400);
  });
});
