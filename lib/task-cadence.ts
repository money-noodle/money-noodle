import { DATA_FRESHNESS, formatCadence } from './freshness';
import { MAKER_MANAGEMENT_CHECKS, MAKER_MANAGEMENT_POLL_MS } from './managed-maker';

export const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
export const MINIMUM_RECONCILIATION_INTERVAL_MS = 60_000;
export const MAXIMUM_RECONCILIATION_INTERVAL_MS = 60 * 60_000;

export type TaskCadenceId =
  | 'dashboard-calculation'
  | 'edge-observation'
  | 'exact-pre-submit-quote'
  | 'managed-maker'
  | 'reconciliation';

export type TaskCadenceHealth = 'healthy' | 'running' | 'degraded' | 'idle' | 'unavailable';
export type TaskCadenceKind = 'interval' | 'bucket' | 'bounded' | 'on-demand' | 'periodic-and-event';

export interface TaskCadenceDefinition {
  id: TaskCadenceId;
  task: string;
  cadenceKind: TaskCadenceKind;
  cadenceMs: number | null;
  cadenceLabel: string;
  activation: string;
  purpose: string;
  requestCost: string;
  workerOnly: boolean;
  /** Only unconditional clocks become degraded when a prior success stops advancing. */
  staleAfterMs?: number;
}

export interface TaskCadenceStatus extends TaskCadenceDefinition {
  health: TaskCadenceHealth;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

function shortCadence(milliseconds: number): string {
  if (milliseconds < 1_000) return `Every ${milliseconds} ms`;
  return milliseconds === 1_000 ? 'Every 1 second' : formatCadence(milliseconds);
}

export function configuredReconciliationIntervalMs(
  environment: Record<string, string | undefined> = {},
): number {
  const seconds = Number(environment.MONEY_NOODLE_RECONCILIATION_INTERVAL_SECONDS
    ?? DEFAULT_RECONCILIATION_INTERVAL_MS / 1_000);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RECONCILIATION_INTERVAL_MS;
  return Math.min(MAXIMUM_RECONCILIATION_INTERVAL_MS,
    Math.max(MINIMUM_RECONCILIATION_INTERVAL_MS, seconds * 1_000));
}

export const TASK_CADENCE: readonly TaskCadenceDefinition[] = [
  {
    id: 'dashboard-calculation', task: 'Dashboard calculation prefetch', cadenceKind: 'interval',
    cadenceMs: DATA_FRESHNESS.calculationRefreshMs,
    cadenceLabel: `${formatCadence(DATA_FRESHNESS.calculationRefreshMs)} after the prior build`,
    activation: 'Continuous on the persistent worker; request-driven on a stateless dashboard.',
    purpose: 'Builds forecasts ahead of the 15-second calculation expiry without coupling execution to browser reads.',
    requestCost: 'Shared cached feed assembly; only inputs whose TTL is due make an upstream request.',
    workerOnly: false, staleAfterMs: DATA_FRESHNESS.observationBucketMs * 3,
  },
  {
    id: 'edge-observation', task: 'Edge observation and persistence', cadenceKind: 'bucket',
    cadenceMs: DATA_FRESHNESS.observationBucketMs,
    cadenceLabel: `One record per ${DATA_FRESHNESS.observationBucketMs / 1_000}-second bucket`,
    activation: 'Each durable edge-policy cycle; duplicate observations in one bucket are suppressed.',
    purpose: 'Advances signal persistence, candidate selection, settlements, and execution bookkeeping.',
    requestCost: 'No additional broad quote poll; consumes the shared dashboard snapshot.',
    workerOnly: true, staleAfterMs: DATA_FRESHNESS.observationBucketMs * 3,
  },
  {
    id: 'exact-pre-submit-quote', task: 'Exact pre-submit quote', cadenceKind: 'on-demand',
    cadenceMs: null, cadenceLabel: 'On demand',
    activation: 'Only after an entry reaches submission; retries refresh again after an acknowledgement race.',
    purpose: 'Revalidates the exact contract price immediately before an order can be submitted.',
    requestCost: 'One exact-contract quote per look; managed paper quotes also include one depth read.',
    workerOnly: true,
  },
  {
    id: 'managed-maker', task: 'Managed maker', cadenceKind: 'bounded',
    cadenceMs: MAKER_MANAGEMENT_POLL_MS,
    cadenceLabel: `${shortCadence(MAKER_MANAGEMENT_POLL_MS)}, ${MAKER_MANAGEMENT_CHECKS} checks over ${(MAKER_MANAGEMENT_POLL_MS * MAKER_MANAGEMENT_CHECKS) / 1_000} seconds`,
    activation: 'An accepted maker entry with a remaining quantity; live and paper managers run independently.',
    purpose: 'Walks a passive order toward its approved ceiling, then cancels and confirms every remainder.',
    requestCost: 'Bounded exact-contract quote, depth, trade, and fill reads; never broad candidate polling.',
    workerOnly: true,
  },
  {
    id: 'reconciliation', task: 'Authoritative reconciliation', cadenceKind: 'periodic-and-event',
    cadenceMs: DEFAULT_RECONCILIATION_INTERVAL_MS,
    cadenceLabel: `${formatCadence(DEFAULT_RECONCILIATION_INTERVAL_MS)} plus startup, manual, and uncertainty events`,
    activation: 'Full startup/manual/drain barrier; then an independent incremental timer while live is enabled, plus uncertain-order recovery.',
    purpose: 'Checks venue cash, positions, order/fill deltas, exact pending transactions, resting remainders, and local reservations.',
    requestCost: 'Bounded signed account/delta reads outside the ledger serializer; full current-tier pagination only at explicit barriers.',
    workerOnly: true,
  },
] as const;
