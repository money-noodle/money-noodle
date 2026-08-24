import type { BudgetControl } from './types';

export const OFFLINE_EVALUATION_CONFIRMATION = 'CONFIRM_STOPPED';

type OfflineEvaluationControl = Pick<BudgetControl, 'state' | 'operatorIntent' | 'reservedBudgetCents'>;

/**
 * This gate cannot observe another process's in-memory drain state. Passing it is necessary, not sufficient:
 * the operator must also establish restart-safe drain and stop the funded worker or use an isolated snapshot.
 */
export function offlineEvaluationBlockers(
  control: OfflineEvaluationControl,
  confirmation: string | undefined,
): string[] {
  const blockers: string[] = [];
  if (confirmation !== OFFLINE_EVALUATION_CONFIRMATION) {
    blockers.push(`Set MONEY_NOODLE_OFFLINE_EVALUATION=${OFFLINE_EVALUATION_CONFIRMATION} after stopping the funded worker.`);
  }
  if (control.state !== 'paused') blockers.push('Funded control must be paused before offline evaluation.');
  if (control.operatorIntent !== 'paused') blockers.push('Operator intent must be paused before offline evaluation.');
  if (!Number.isSafeInteger(control.reservedBudgetCents) || control.reservedBudgetCents !== 0) {
    blockers.push('Reserved funded budget must be exactly zero before offline evaluation.');
  }
  return blockers;
}
