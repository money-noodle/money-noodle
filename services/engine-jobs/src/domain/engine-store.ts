import type { RowSet } from './restore-plan.js';

export interface RestoreRunKey {
  manifestDigest: string;
  manifestKey: string;
  schemaVersion: string;
  runId: string;
}

export interface LoadedCounts {
  /** Row count per table as the store reports it after the load, inside the transaction. */
  counts: Record<string, number>;
}

/**
 * The engine store as the restore job sees it: `engine_writer` only, no DDL.
 * `load` runs in one transaction and must throw (rolling back) when the
 * reconciliation callback rejects what the store reports.
 */
export interface EngineStore {
  /** Row counts of every restore target table plus any prior restore run. */
  inspect(): Promise<{ counts: Record<string, number>; priorRuns: RestoreRunKey[] }>;
  load(
    run: RestoreRunKey,
    rowSets: RowSet[],
    reconcile: (loaded: LoadedCounts) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

export const RESTORE_TARGET_TABLES = [
  'engine.ledger_order',
  'engine.ledger_state',
  'engine.evidence_row',
  'engine.trading_control',
  'engine.provider_registry',
  'engine.forecast_journal_event',
  'engine.forecast_shard',
  'engine.forecast_row',
  'engine.contract_provenance',
  'engine.model_promotion',
  'engine.research_journal_event',
  'engine.research_snapshot',
] as const;

export class RestoreRefusedError extends Error {
  override readonly name = 'RestoreRefusedError';
}
