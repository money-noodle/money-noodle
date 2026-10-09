import type { EngineStore, LoadedCounts, RestoreRunKey } from '../../domain/engine-store.js';
import { RESTORE_TARGET_TABLES } from '../../domain/engine-store.js';
import type { RowSet } from '../../domain/restore-plan.js';

/**
 * The primary key of each restore target table, as the schema owner's migrations
 * declare it (`0002-engine-restore-tables.sql`, and `0003-ledger-order-position.sql`
 * for the ledger).
 *
 * The fake enforces them because the first real load did not get this far on
 * trust: it passed every in-process check and then rolled back on
 * `ledger_order_pkey`. A fake that accepts any row would have let that through
 * again, so uniqueness is part of the contract this double honours.
 */
const PRIMARY_KEYS: Record<(typeof RESTORE_TARGET_TABLES)[number], readonly string[]> = {
  'engine.ledger_order': ['order_id', 'ledger_position'],
  'engine.ledger_state': ['key'],
  'engine.evidence_row': ['batch_sha256', 'row_key'],
  'engine.trading_control': ['key'],
  'engine.provider_registry': ['provider_id'],
  'engine.provider_budget': ['provider_id'],
  'engine.forecast_journal_event': ['sequence'],
  'engine.forecast_shard': ['shard_id'],
  'engine.forecast_row': ['forecast_id'],
  'engine.contract_provenance': ['registry_id'],
  'engine.model_promotion': ['sequence'],
  'engine.research_journal_event': ['store', 'sequence'],
  'engine.research_snapshot': ['store'],
};

export class UniqueViolationError extends Error {
  override readonly name = 'UniqueViolationError';
}

const keyOf = (row: Record<string, unknown>, columns: readonly string[]) =>
  JSON.stringify(columns.map((column) => row[column] ?? null));

/** In-memory store with the same transactional contract, for tests only. */
export class FakeEngineStore implements EngineStore {
  readonly tables = new Map<string, Record<string, unknown>[]>(
    RESTORE_TARGET_TABLES.map((table) => [table, []]),
  );
  readonly runs: RestoreRunKey[] = [];
  closed = false;

  async inspect() {
    return {
      counts: Object.fromEntries([...this.tables].map(([table, rows]) => [table, rows.length])),
      priorRuns: [...this.runs],
    };
  }

  async load(run: RestoreRunKey, rowSets: RowSet[], reconcile: (loaded: LoadedCounts) => void) {
    const snapshot = new Map([...this.tables].map(([table, rows]) => [table, [...rows]]));
    const previousRuns = [...this.runs];
    try {
      for (const set of rowSets) {
        const rows = this.tables.get(set.table);
        if (!rows) throw new Error(`Unknown restore target table ${set.table}.`);
        const columns = PRIMARY_KEYS[set.table as (typeof RESTORE_TARGET_TABLES)[number]];
        const seen = new Set(rows.map((row) => keyOf(row, columns)));
        for (const row of set.rows) {
          const key = keyOf(row, columns);
          if (seen.has(key)) {
            // The shape a plain INSERT fails with. The loader must never answer
            // this with an upsert: an order record is append-only evidence.
            throw new UniqueViolationError(
              `duplicate key value violates unique constraint "${set.table.split('.')[1]}_pkey"`,
            );
          }
          seen.add(key);
          rows.push(row);
        }
      }
      this.runs.push(run);
      reconcile({
        counts: Object.fromEntries([...this.tables].map(([table, rows]) => [table, rows.length])),
      });
    } catch (error) {
      for (const [table, rows] of snapshot) this.tables.set(table, rows);
      this.runs.splice(0, this.runs.length, ...previousRuns);
      throw error;
    }
  }

  async close() {
    this.closed = true;
  }
}
