import type { CollectorStatus } from './types';
import { DATA_FRESHNESS } from './freshness';

interface CollectorRuntime extends CollectorStatus {
  timer?: ReturnType<typeof setInterval>;
  inFlight: boolean;
}

declare global {
  var __signalDeskCollector: CollectorRuntime | undefined;
}

export function collectorRuntime(): CollectorRuntime {
  if (!globalThis.__signalDeskCollector) {
    globalThis.__signalDeskCollector = {
      enabled: process.env.SIGNAL_DESK_BACKGROUND_INGESTION !== 'false',
      running: false,
      inFlight: false,
      intervalMs: DATA_FRESHNESS.dashboardPollMs,
    };
  }
  return globalThis.__signalDeskCollector;
}

export function collectorStatus(): CollectorStatus {
  const { timer: _timer, inFlight: _inFlight, ...status } = collectorRuntime();
  return { ...status };
}
