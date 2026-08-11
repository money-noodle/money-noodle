export type ExecutionDrainPhase = 'unknown' | 'active' | 'draining' | 'quiescent' | 'blocked';

export interface ExecutionDrainStatus {
  phase: ExecutionDrainPhase;
  requestedAt?: string;
  completedAt?: string;
  reason: string;
  workingTransactions: number;
  restartSafe: boolean;
}

interface DrainRuntime { status: ExecutionDrainStatus }
const runtimeKey = Symbol.for('signal-desk.execution-drain');

function runtime(): DrainRuntime {
  const root = globalThis as typeof globalThis & { [runtimeKey]?: DrainRuntime };
  root[runtimeKey] ??= { status: { phase: 'unknown', reason: 'Execution drain has not been verified since startup.', workingTransactions: 0, restartSafe: false } };
  return root[runtimeKey]!;
}

export function getExecutionDrainStatus(): ExecutionDrainStatus {
  return { ...runtime().status };
}

export function beginLiveTransaction(reason: string): void {
  const current = runtime().status;
  runtime().status = {
    ...current, phase: current.phase === 'draining' ? 'draining' : 'active',
    reason, workingTransactions: current.workingTransactions + 1, restartSafe: false, completedAt: undefined,
  };
}

export function endLiveTransaction(): void {
  const current = runtime().status;
  runtime().status = { ...current, workingTransactions: Math.max(0, current.workingTransactions - 1) };
}

export function startExecutionDrain(reason: string): void {
  const current = runtime().status;
  runtime().status = {
    ...current, phase: 'draining', requestedAt: new Date().toISOString(), completedAt: undefined,
    reason, restartSafe: false,
  };
}

export function completeExecutionDrain(reason: string): void {
  const current = runtime().status;
  runtime().status = {
    ...current, phase: 'quiescent', completedAt: new Date().toISOString(), reason,
    workingTransactions: 0, restartSafe: true,
  };
}

export function resetExecutionDrainStateForTests(): void {
  runtime().status = { phase: 'unknown', reason: 'Execution drain has not been verified since startup.', workingTransactions: 0, restartSafe: false };
}

export function blockExecutionDrain(reason: string): void {
  const current = runtime().status;
  runtime().status = {
    ...current, phase: 'blocked', completedAt: new Date().toISOString(), reason, restartSafe: false,
  };
}
