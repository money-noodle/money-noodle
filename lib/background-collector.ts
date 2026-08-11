import 'server-only';
import { collectorRuntime } from './collector-state';
import { getDashboard } from './dashboard';
import { processPaperTradingCycle } from './paper-execution';
import { maybeRunPeriodicReconciliation } from './periodic-reconciliation';
import { maybeRunWalkForwardEvaluation } from './model-evaluation-store';

async function collect(): Promise<void> {
  const state = collectorRuntime();
  if (state.inFlight) return;
  state.inFlight = true;
  state.lastAttemptAt = new Date().toISOString();
  try {
    // Regular cache policy is intentional: market TTLs are shorter than this loop, while slower inputs retain theirs.
    const dashboard = await getDashboard(false, false);
    await processPaperTradingCycle(dashboard);
    await maybeRunPeriodicReconciliation();
    if (dashboard.performance.calibrationReady) {
      await maybeRunWalkForwardEvaluation(dashboard.performance.calibrationWindows)
        .catch((error) => console.error('Automatic walk-forward evaluation failed:', error));
    }
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = undefined;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : 'Background collection failed';
    console.error('Money Noodle background collection failed:', error);
  } finally {
    state.inFlight = false;
  }
}

export function startBackgroundCollector(): void {
  const state = collectorRuntime();
  if (!state.enabled || state.running) return;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.timer = setInterval(() => void collect(), state.intervalMs);
  state.timer.unref?.();
  void collect();
}
