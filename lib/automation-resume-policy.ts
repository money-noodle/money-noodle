import type { BudgetControl } from './types';

export function systemSuspensionFields(control: BudgetControl): Pick<BudgetControl, 'state' | 'operatorIntent' | 'pauseOrigin' | 'autoResumeEligible'> {
  const operatorStillWantsActive = control.state === 'active'
    || (control.operatorIntent === 'active' && control.autoResumeEligible === true && control.pauseOrigin === 'system');
  return {
    state: 'paused',
    operatorIntent: operatorStillWantsActive ? 'active' : 'paused',
    pauseOrigin: operatorStillWantsActive ? 'system' : (control.pauseOrigin ?? 'user'),
    autoResumeEligible: operatorStillWantsActive,
  };
}

export function mayAutoResumeAfterReconciliation(control: BudgetControl, allReadinessChecksPass: boolean): boolean {
  return control.state === 'paused'
    && control.operatorIntent === 'active'
    && control.pauseOrigin === 'system'
    && control.autoResumeEligible === true
    && allReadinessChecksPass;
}
