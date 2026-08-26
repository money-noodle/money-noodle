import type { CollectorStatus } from './types';
import { DATA_FRESHNESS } from './freshness';

interface CollectorRuntime extends CollectorStatus {
  timer?: ReturnType<typeof setInterval>;
  inFlight: boolean;
}

declare global {
  var __moneyNoodleCollector: CollectorRuntime | undefined;
}

export function collectorRuntime(): CollectorRuntime {
  if (!globalThis.__moneyNoodleCollector) {
    globalThis.__moneyNoodleCollector = {
      enabled: process.env.MONEY_NOODLE_BACKGROUND_INGESTION !== 'false' && process.env.VERCEL !== '1' && process.env.MONEY_NOODLE_STATELESS !== 'true',
      running: false,
      inFlight: false,
      intervalMs: DATA_FRESHNESS.dashboardPollMs,
    };
  }
  return globalThis.__moneyNoodleCollector;
}

export function collectorStatus(): CollectorStatus {
  const { timer: _timer, inFlight: _inFlight, ...status } = collectorRuntime();
  return { ...status };
}
