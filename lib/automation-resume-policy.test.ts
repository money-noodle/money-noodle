import { describe, expect, it } from 'vitest';
import { mayAutoResumeAfterReconciliation, systemSuspensionFields } from './automation-resume-policy';
import type { BudgetControl } from './types';

const control = (patch: Partial<BudgetControl> = {}): BudgetControl => ({
  revision: 1, state: 'active', mode: 'live', startingBudgetCents: 100, availableBudgetCents: 100,
  reservedBudgetCents: 0, realizedPnlCents: 0, perTradeCents: 10, purchasePercent: 1,
  enabledVenues: ['kalshi'], operatorIntent: 'active', updatedAt: new Date(0).toISOString(), ...patch,
});

describe('automation resume policy', () => {
  it('retains active operator intent during a system suspension', () => {
    expect(systemSuspensionFields(control())).toEqual({ state: 'paused', operatorIntent: 'active', pauseOrigin: 'system', autoResumeEligible: true });
  });

  it('does not convert an existing manual pause into an auto-resumable pause', () => {
    expect(systemSuspensionFields(control({ state: 'paused', operatorIntent: 'paused', pauseOrigin: 'user', autoResumeEligible: false }))).toEqual({
      state: 'paused', operatorIntent: 'paused', pauseOrigin: 'user', autoResumeEligible: false,
    });
  });

  it('requires system origin, retained intent, eligibility, and all readiness checks', () => {
    const suspended = control({ state: 'paused', operatorIntent: 'active', pauseOrigin: 'system', autoResumeEligible: true });
    expect(mayAutoResumeAfterReconciliation(suspended, true)).toBe(true);
    expect(mayAutoResumeAfterReconciliation(suspended, false)).toBe(false);
    expect(mayAutoResumeAfterReconciliation({ ...suspended, pauseOrigin: 'user' }, true)).toBe(false);
    expect(mayAutoResumeAfterReconciliation({ ...suspended, operatorIntent: 'paused' }, true)).toBe(false);
  });
});
