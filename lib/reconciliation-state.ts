export type ReconciliationPhase = 'pending' | 'running' | 'ready' | 'blocked';

export interface KalshiReconciliationStatus {
  phase: ReconciliationPhase;
  trigger?: 'startup' | 'manual' | 'automatic' | 'periodic';
  startedAt?: string;
  completedAt?: string;
  reason: string;
  venueBalanceCents?: number;
  localOpenPositions?: number;
  venueManagedPositions?: number;
  restingOrdersCanceled?: number;
  recoveredFills?: number;
  nextScheduledAt?: string;
  consecutivePeriodicFailures?: number;
}

interface ReconciliationRuntime { status: KalshiReconciliationStatus; inFlight?: Promise<KalshiReconciliationStatus> }

const runtimeKey = Symbol.for('signal-desk.kalshi-reconciliation');

function runtime(): ReconciliationRuntime {
  const root = globalThis as typeof globalThis & { [runtimeKey]?: ReconciliationRuntime };
  root[runtimeKey] ??= { status: { phase: 'pending', reason: 'Startup Kalshi reconciliation has not completed.' } };
  return root[runtimeKey]!;
}

export function getKalshiReconciliationStatus(): KalshiReconciliationStatus {
  return { ...runtime().status };
}

export function setKalshiReconciliationStatus(status: KalshiReconciliationStatus): void {
  runtime().status = status;
}

export function serializedReconciliation(operation: () => Promise<KalshiReconciliationStatus>): Promise<KalshiReconciliationStatus> {
  const state = runtime();
  if (state.inFlight) return state.inFlight;
  const promise = operation();
  state.inFlight = promise;
  void promise.finally(() => { if (state.inFlight === promise) state.inFlight = undefined; });
  return promise;
}
