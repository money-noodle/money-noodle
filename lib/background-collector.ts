import 'server-only';
import { collectorRuntime } from './collector-state';
import { getDashboard, MODEL_VERSION } from './dashboard';
import { recordCollectorCalculations, resolveDueForecasts } from './forecast-tracker';
import { processPaperTradingCycle } from './paper-execution';
import { maybeRunPeriodicReconciliation } from './periodic-reconciliation';
import { maybeRunWalkForwardEvaluation } from './model-evaluation-store';
import { replicatePublicPaperPerformance } from './public-paper-performance';
import { replicatePublicLongShot } from './long-shot-projection';

async function collect(): Promise<void> {
  const state = collectorRuntime();
  if (state.inFlight) return;
  state.inFlight = true;
  state.lastAttemptAt = new Date().toISOString();
  try {
    // Regular cache policy is intentional: market TTLs are shorter than this loop, while slower inputs retain theirs.
    const dashboard = await getDashboard(false, false);
    // Forecast mutation authority belongs to this durable collector, never to request-triggered builds.
    // A persistence failure is advisory to execution: historical storage does not enter predictions,
    // policy, sizing, budgets, or orders.
    dashboard.performance = await recordCollectorCalculations(dashboard.predictions, MODEL_VERSION)
      .catch((error) => {
        console.error('Forecast tracking failed:', error);
        return dashboard.performance;
      });
    await processPaperTradingCycle(dashboard);
    // Settlement of already-closed windows is deliberately not awaited by the calculation above: it is
    // bookkeeping about the past, and letting it block the present is what made every cycle late.
    void resolveDueForecasts()
      .catch((error) => console.error('Forecast resolution pass failed:', error));
    // Best effort and never awaited: hosted-dashboard freshness must not delay reconciliation or a cycle.
    void replicatePublicPaperPerformance()
      .catch((error) => console.error('Postgres public paper performance sync failed:', error));
    void replicatePublicLongShot()
      .catch((error) => console.error('Postgres public long-shot sync failed:', error));
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
