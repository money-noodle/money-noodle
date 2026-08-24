import 'server-only';
import { liveTradingEnabled } from './live-orders';
import { reconcileLiveExecution } from './paper-execution';
import { getKalshiReconciliationStatus, setKalshiReconciliationStatus } from './reconciliation-state';
import { configuredReconciliationIntervalMs } from './task-cadence';

const FAILURE_RETRY_MS = 30_000;

interface PeriodicRuntime {
  nextAtMs: number;
  consecutiveFailures: number;
  inFlight: boolean;
  started: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
const runtimeKey = Symbol.for('money-noodle.periodic-reconciliation');

function runtime(): PeriodicRuntime {
  const root = globalThis as typeof globalThis & { [runtimeKey]?: PeriodicRuntime };
  root[runtimeKey] ??= { nextAtMs: 0, consecutiveFailures: 0, inFlight: false, started: false };
  return root[runtimeKey]!;
}

export function periodicReconciliationIntervalMs(environment: Record<string, string | undefined> = process.env): number {
  return configuredReconciliationIntervalMs(environment);
}

export function initialPeriodicReconciliationAt(completedAt: string | undefined, nowMs: number, intervalMs: number): number {
  const completed = completedAt ? Date.parse(completedAt) : Number.NaN;
  return Number.isFinite(completed) ? Math.max(nowMs, completed + intervalMs) : nowMs + intervalMs;
}

/** Performs at most one account reconciliation when the independently owned deadline is due. */
export async function maybeRunPeriodicReconciliation(nowMs = Date.now()): Promise<void> {
  if (!liveTradingEnabled()) return;
  const state = runtime();
  if (state.inFlight) return;
  const intervalMs = periodicReconciliationIntervalMs();
  if (!state.nextAtMs) {
    state.nextAtMs = initialPeriodicReconciliationAt(getKalshiReconciliationStatus().completedAt, nowMs, intervalMs);
    const status = getKalshiReconciliationStatus();
    setKalshiReconciliationStatus({ ...status, nextScheduledAt: new Date(state.nextAtMs).toISOString(), consecutivePeriodicFailures: state.consecutiveFailures });
    return;
  }
  if (nowMs < state.nextAtMs) return;
  state.inFlight = true;
  try {
    // First failure soft-blocks live orders via reconciliation phase and gets one quick retry. A
    // second consecutive failure persists a hard pause and audit event.
    const status = await reconcileLiveExecution({ trigger: 'periodic', pauseOnFailure: state.consecutiveFailures >= 1 });
    if (status.phase === 'ready') {
      state.consecutiveFailures = 0;
      state.nextAtMs = Date.now() + intervalMs;
    } else {
      state.consecutiveFailures += 1;
      state.nextAtMs = Date.now() + FAILURE_RETRY_MS;
    }
    setKalshiReconciliationStatus({
      ...getKalshiReconciliationStatus(),
      nextScheduledAt: new Date(state.nextAtMs).toISOString(),
      consecutivePeriodicFailures: state.consecutiveFailures,
    });
  } finally {
    state.inFlight = false;
  }
}

function scheduleNext(delayMs: number): void {
  const state = runtime();
  state.timer = setTimeout(() => void periodicTick(), Math.max(1_000, delayMs));
  state.timer.unref?.();
}

async function periodicTick(): Promise<void> {
  const state = runtime();
  try {
    if (!liveTradingEnabled()) {
      scheduleNext(60_000);
      return;
    }
    await maybeRunPeriodicReconciliation();
  } catch (error) {
    // `reconcileLiveExecution` normally returns a blocked status. This guard keeps an unexpected scheduler
    // error observable without terminating the timer that must retry it.
    console.error('Periodic reconciliation scheduler failed:', error);
    state.nextAtMs = Date.now() + FAILURE_RETRY_MS;
  }
  scheduleNext(state.nextAtMs ? state.nextAtMs - Date.now() : 60_000);
}

/** Starts a process-global background timer. It is never awaited by collection or request handling. */
export function startPeriodicReconciliationScheduler(): void {
  const state = runtime();
  if (state.started) return;
  state.started = true;
  void periodicTick();
}
