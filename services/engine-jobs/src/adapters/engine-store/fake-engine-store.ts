import type { EngineStore, LoadedCounts, RestoreRunKey } from '../../domain/engine-store.js';
import { RESTORE_TARGET_TABLES } from '../../domain/engine-store.js';
import type { RowSet } from '../../domain/restore-plan.js';

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
        rows.push(...set.rows);
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
