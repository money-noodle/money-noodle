import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { evaluateStakeExpansion } from './stake-expansion-policy';
import type { BudgetControl, PaperOrder } from './types';

const control = (over: Partial<BudgetControl> = {}): BudgetControl => ({
  revision: 1, state: 'active', mode: 'live', startingBudgetCents: 2_000,
  availableBudgetCents: 2_000, reservedBudgetCents: 0, realizedPnlCents: 0,
  perTradeCents: 200, purchasePercent: 10, enabledVenues: ['kalshi'],
  epochId: 'epoch-1', updatedAt: '2026-08-13T00:00:00.000Z', ...over,
});

/** One settled live order per window, so window count equals order count. */
function orders(count: number, pnlCents: number, epochId = 'epoch-1'): PaperOrder[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `o${i}`, executionMode: 'live', budgetEpochId: epochId, symbol: 'BTC', venue: 'kalshi',
    contractId: `c${i}`, side: 'UP', status: 'won', createdAt: '2026-08-13T00:00:00Z',
    calculationAt: '2026-08-13T00:00:00Z', closesAt: `2026-08-13T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
    modelProbabilityUp: 0.6, confidence: 0.7, askPrice: 0.5, bidPrice: 0.48, spread: 0.02,
    quantity: 10, stakeCents: 100, feeCents: 2, potentialPayoutCents: 200,
    payoutCents: 100 + pnlCents, pnlCents, settledAt: '2026-08-13T00:15:00Z', outcome: 'UP',
  } as PaperOrder));
}

const failing = (a: ReturnType<typeof evaluateStakeExpansion>) => a.criteria.filter((c) => !c.met).map((c) => c.id);

describe('stake expansion criteria', () => {
  it('refuses expansion on a thin sample even when every trade won', () => {
    const assessment = evaluateStakeExpansion(control(), orders(5, 50));
    expect(assessment.eligible).toBe(false);
    expect(failing(assessment)).toContain('window-evidence');
  });

  it('refuses when the clustered return does not clear two standard errors', () => {
    // Alternating wins and losses: positive-ish mean, large spread, no credible edge.
    const mixed = [...orders(20, 100), ...orders(20, -95).map((o, i) => ({ ...o, id: `l${i}`, closesAt: `2026-08-14T${String(i % 24).padStart(2, '0')}:00:00Z` }))];
    const assessment = evaluateStakeExpansion(control(), mixed);
    expect(failing(assessment)).toContain('positive-clustered-return');
    expect(assessment.eligible).toBe(false);
  });

  it('refuses while drawdown from peak exceeds the limit, even with good returns', () => {
    const assessment = evaluateStakeExpansion(
      control({ availableBudgetCents: 1_500, peakEquityCents: 2_000 }), orders(40, 60));
    expect(failing(assessment)).toContain('drawdown-from-peak');
    expect(assessment.drawdownPercent).toBeCloseTo(25, 0);
  });

  it('refuses while lifetime P&L is negative, however good the current epoch looks', () => {
    const good = orders(40, 60, 'epoch-2');
    const priorLoss = orders(10, -900, 'epoch-1').map((o, i) => ({ ...o, id: `p${i}` }));
    const assessment = evaluateStakeExpansion(control({ epochId: 'epoch-2' }), [...good, ...priorLoss]);
    expect(failing(assessment)).toContain('lifetime-not-negative');
  });

  it('refuses a depleted budget outright', () => {
    const assessment = evaluateStakeExpansion(control({ state: 'depleted' }), orders(40, 60));
    expect(failing(assessment)).toContain('automation-healthy');
  });

  it('allows expansion only when every criterion is met, and never applies it', () => {
    const assessment = evaluateStakeExpansion(control(), orders(40, 60));
    expect(assessment.eligible).toBe(true);
    expect(failing(assessment)).toEqual([]);
    expect(assessment.currentPerTradeCents).toBe(200);
    expect(assessment.proposedPerTradeCents).toBe(300);
  });

  it('reports the proposed cap even when ineligible, so the target is visible', () => {
    const assessment = evaluateStakeExpansion(control(), orders(3, 10));
    expect(assessment.eligible).toBe(false);
    expect(assessment.proposedPerTradeCents).toBe(300);
  });

  it('counts only the current epoch as evidence, not a previous one', () => {
    const assessment = evaluateStakeExpansion(control({ epochId: 'epoch-2' }), orders(40, 60, 'epoch-1'));
    expect(assessment.settledWindows).toBe(0);
    expect(failing(assessment)).toContain('window-evidence');
  });
});
