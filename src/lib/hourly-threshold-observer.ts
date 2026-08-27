import 'server-only';

import { getHourlyThresholdMarkets } from './hourly-threshold-market-service';
import {
  HOURLY_THRESHOLD_OBSERVATION_VERSION, recordHourlyThresholdOutcome,
  recordHourlyThresholdSnapshot, unresolvedHourlyThresholdContracts,
  type HourlyThresholdOutcome,
} from './hourly-threshold-observation-store';
import { isStatelessDeployment } from './runtime-environment';
import { beginTaskCadenceRun } from './task-cadence-runtime';

export const HOURLY_THRESHOLD_OBSERVATION_INTERVAL_MS = 60_000;
const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const REQUEST_TIMEOUT_MS = 4_000;
interface ObserverRuntime { running: boolean; inFlight: boolean; timer?: ReturnType<typeof setInterval> }
const runtimeKey = Symbol.for('money-noodle.hourly-threshold-observer');
const root = globalThis as typeof globalThis & { [runtimeKey]?: ObserverRuntime };
const runtime = root[runtimeKey] ??= { running: false, inFlight: false };

export interface HourlyThresholdObserverDependencies {
  markets?: typeof getHourlyThresholdMarkets;
  unresolved?: typeof unresolvedHourlyThresholdContracts;
  recordSnapshot?: typeof recordHourlyThresholdSnapshot;
  recordOutcome?: typeof recordHourlyThresholdOutcome;
  outcome?: (ticker: string) => Promise<'YES' | 'NO' | 'INVALID' | undefined>;
  now?: () => number;
}

async function fetchOutcome(ticker: string): Promise<'YES' | 'NO' | 'INVALID' | undefined> {
  const source = `${KALSHI_BASE_URL}/markets/${encodeURIComponent(ticker)}`;
  const response = await fetch(source, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.2 hourly-observation' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} resolving hourly contract ${ticker}`);
  const market = ((await response.json()) as { market?: { result?: string; status?: string } }).market;
  const result = market?.result?.toLowerCase();
  if (result === 'yes') return 'YES';
  if (result === 'no') return 'NO';
  return ['canceled', 'cancelled', 'invalid'].includes(market?.status?.toLowerCase() ?? '') ? 'INVALID' : undefined;
}

/** Detached public-data cycle. No caller awaits it from forecasting, paper, reconciliation, or order work. */
export async function collectHourlyThresholdObservations(
  dependencies: HourlyThresholdObserverDependencies = {},
): Promise<void> {
  if (runtime.inFlight) return;
  runtime.inFlight = true;
  const cadence = beginTaskCadenceRun('hourly-threshold-observation');
  const now = dependencies.now ?? Date.now;
  try {
    const response = await (dependencies.markets ?? getHourlyThresholdMarkets)(true);
    await (dependencies.recordSnapshot ?? recordHourlyThresholdSnapshot)(response);
    const due = await (dependencies.unresolved ?? unresolvedHourlyThresholdContracts)(now(), 10);
    for (const contract of due) {
      const result = await (dependencies.outcome ?? fetchOutcome)(contract.ticker);
      if (!result) continue;
      const resolvedAt = new Date(now()).toISOString();
      const value: HourlyThresholdOutcome = {
        version: HOURLY_THRESHOLD_OBSERVATION_VERSION,
        providerId: 'kalshi', marketId: 'crypto-1h', ticker: contract.ticker,
        rulesFingerprint: contract.rulesFingerprint, closesAt: contract.closesAt,
        result, resolvedAt,
        resolutionSource: `${KALSHI_BASE_URL}/markets/${contract.ticker}`,
      };
      await (dependencies.recordOutcome ?? recordHourlyThresholdOutcome)(value);
    }
    cadence.succeed();
  } catch (error) {
    cadence.fail(error);
    console.error('Hourly threshold observation failed:', error);
  } finally {
    runtime.inFlight = false;
  }
}

/** Persistent worker only. Hosted/stateless processes remain unable to acquire writer ownership. */
export function startHourlyThresholdObserver(): boolean {
  if (isStatelessDeployment() || runtime.running) return false;
  runtime.running = true;
  runtime.timer = setInterval(() => void collectHourlyThresholdObservations(), HOURLY_THRESHOLD_OBSERVATION_INTERVAL_MS);
  runtime.timer.unref?.();
  void collectHourlyThresholdObservations();
  return true;
}

export function resetHourlyThresholdObserverForTests(): void {
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.running = false; runtime.inFlight = false; runtime.timer = undefined;
}
