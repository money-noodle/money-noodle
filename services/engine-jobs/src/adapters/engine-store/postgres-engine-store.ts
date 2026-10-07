// The one place in this family that opens a database connection, as
// `engine_writer` (ADR-0013 §2): SELECT, INSERT, UPDATE on `engine` tables, no
// DDL. The tables are created by the schema owner from
// `services/platform-api/migrations/0002-engine-restore-tables.sql`, never here.

import postgres from 'postgres';

import type { EngineStore, LoadedCounts, RestoreRunKey } from '../../domain/engine-store.js';
import { RESTORE_TARGET_TABLES } from '../../domain/engine-store.js';
import type { RowSet } from '../../domain/restore-plan.js';

const TABLE = new Set<string>(RESTORE_TARGET_TABLES);

function splitTable(table: string): [string, string] {
  if (!TABLE.has(table)) throw new Error(`Refusing to write to undeclared table ${table}.`);
  const [schema, name] = table.split('.') as [string, string];
  return [schema, name];
}

export function createPostgresEngineStore(connectionString: string): EngineStore {
  const sql = postgres(connectionString, { max: 1, prepare: false });

  const countAll = async (tx: postgres.Sql | postgres.TransactionSql) => {
    const counts: Record<string, number> = {};
    for (const table of RESTORE_TARGET_TABLES) {
      const [schema, name] = splitTable(table);
      const [row] = await tx<
        { count: string }[]
      >`select count(*)::text as count from ${tx(schema)}.${tx(name)}`;
      counts[table] = Number(row?.count ?? 0);
    }
    return counts;
  };

  return {
    async inspect() {
      const counts = await countAll(sql);
      const priorRuns = await sql<
        { manifest_digest: string; manifest_key: string; schema_version: string; run_id: string }[]
      >`select manifest_digest, manifest_key, schema_version, run_id from engine.restore_run`;
      return {
        counts,
        priorRuns: priorRuns.map((row) => ({
          manifestDigest: row.manifest_digest,
          manifestKey: row.manifest_key,
          schemaVersion: row.schema_version,
          runId: row.run_id,
        })),
      };
    },
    async load(run: RestoreRunKey, rowSets: RowSet[], reconcile: (loaded: LoadedCounts) => void) {
      await sql.begin(async (tx) => {
        await tx`insert into engine.restore_run (run_id, manifest_digest, manifest_key, schema_version, started_at)
          values (${run.runId}, ${run.manifestDigest}, ${run.manifestKey}, ${run.schemaVersion}, now())`;
        for (const set of rowSets) {
          const [schema, name] = splitTable(set.table);
          for (let offset = 0; offset < set.rows.length; offset += 500) {
            const chunk = set.rows.slice(offset, offset + 500).map((row) => ({
              ...Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
                ]),
              ),
              restore_run_id: run.runId,
            }));
            await tx`insert into ${tx(schema)}.${tx(name)} ${tx(chunk)}`;
          }
        }
        // Throws on a discrepancy, which rolls the whole transaction back.
        reconcile({ counts: await countAll(tx) });
        await tx`update engine.restore_run set completed_at = now() where run_id = ${run.runId}`;
      });
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
