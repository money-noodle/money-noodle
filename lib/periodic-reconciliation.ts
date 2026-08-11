import 'server-only';
import { liveTradingEnabled } from './live-orders';
import { reconcileLiveExecution } from './paper-execution';
import { getKalshiReconciliationStatus, setKalshiReconciliationStatus } from './reconciliation-state';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MINIMUM_INTERVAL_MS = 60_000;
const MAXIMUM_INTERVAL_MS = 60 * 60_000;
const FAILURE_RETRY_MS = 30_000;

interface PeriodicRuntime { nextAtMs: number; consecutiveFailures: number; inFlight: boolean }
const runtimeKey = Symbol.for('signal-desk.periodic-reconciliation');

function runtime(): PeriodicRuntime {
  const root = globalThis as typeof globalThis & { [runtimeKey]?: PeriodicRuntime };
  root[runtimeKey] ??= { nextAtMs: 0, consecutiveFailures: 0, inFlight: false };
  return root[runtimeKey]!;
}

export function periodicReconciliationIntervalMs(environment: Record<string, string | undefined> = process.env): number {
  const seconds = Number(environment.SIGNAL_DESK_RECONCILIATION_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_MS / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(MAXIMUM_INTERVAL_MS, Math.max(MINIMUM_INTERVAL_MS, seconds * 1000));
}

export function initialPeriodicReconciliationAt(completedAt: string | undefined, nowMs: number, intervalMs: number): number {
  const completed = completedAt ? Date.parse(completedAt) : Number.NaN;
  return Number.isFinite(completed) ? Math.max(nowMs, completed + intervalMs) : nowMs + intervalMs;
}

/** Called by the 15-second collector; performs at most one serialized account reconciliation. */
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
