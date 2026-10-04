// The paper projection port, over a parameterised query client.
//
// The SQL and the port behaviour live here; the driver does not. A
// `ProjectionQueryClient` is injected, which makes the statements, the bounds and
// the privilege interpretation testable without a database — and leaves
// `postgres-client.ts` as the only file in the service that imports a driver at
// all.
//
// Three deliberate properties.
//
//   * Read-only at every layer that can express it. The port exposes no write,
//     the SQL below contains none, and the client opens its session with
//     `default_transaction_read_only=on`. The privilege probe is the fourth
//     layer, and the only one an attacker cannot remove by editing this file.
//   * Identifiers are never user input. Schema and table names arrive already
//     validated against a strict identifier pattern by `read-projection-config`,
//     and are re-validated here before being quoted into a statement, because
//     this is where getting it wrong would matter. Everything else is a bound
//     parameter.
//   * Nothing a driver says is re-thrown or copied. See `projection-errors.ts`.

import {
  MAX_EXECUTION_ROWS,
  type PaperProjectionPort,
  type ProjectionPrivilegeObservation,
  type ProjectionTableNames,
} from '../../domain/paper-projection.js';
import { ProjectionFailure, withSafeFailure } from './projection-errors.js';
import {
  asText,
  toBudget,
  toExecution,
  toPayload,
  toRoleAttributes,
  type ProjectionRow,
} from './projection-rows.js';

/** The upper bound on grant rows the probe will read. A guard, not a filter. */
export const MAX_GRANT_ROWS = 1000;

/**
 * A parameterised query channel.
 *
 * Deliberately smaller than any driver's surface: text plus positional
 * parameters. Anything a driver offers beyond this — transactions, listen,
 * copy — is not available to this port, which is the point.
 */
export interface ProjectionQueryClient {
  readonly close: () => Promise<void>;
  readonly query: (text: string, parameters: readonly unknown[]) => Promise<ProjectionRow[]>;
}

export interface PostgresPaperProjectionOptions {
  readonly client: ProjectionQueryClient;
  readonly schema: string;
  readonly tables: ProjectionTableNames;
}

// Matches `read-projection-config`'s rule. Restated rather than imported so this
// file's safety does not depend on another module's constant staying as it is.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

/** A validated, quoted identifier. Refuses rather than escapes. */
function quoted(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new ProjectionFailure('projection-unexpected-shape');
  }
  return `"${identifier}"`;
}

export function createPostgresPaperProjection(
  options: PostgresPaperProjectionOptions,
): PaperProjectionPort {
  const { client } = options;
  const relation = (table: string) => `${quoted(options.schema)}.${quoted(table)}`;
  let closed = false;

  const singleton = async <T>(table: string, map: (row: ProjectionRow) => T): Promise<T | null> =>
    withSafeFailure('projection-query-failed', async () => {
      const rows = await client.query(`select * from ${relation(table)} limit 1`, []);
      const first = rows.at(0);
      return first === undefined ? null : map(first);
    });

  return Object.freeze({
    close: async () => {
      // Idempotent: shutdown paths run more than once more often than they look
      // like they will.
      if (closed) return;
      closed = true;
      // A failing close must not mask the reason the caller was shutting down,
      // and there is nothing useful to do about it either way.
      await client.close().catch(() => undefined);
    },

    readBudget: async () => singleton(options.tables.budget, toBudget),

    readExecutions: async (limit: number) => {
      const bounded =
        Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_EXECUTION_ROWS) : 1;
      return withSafeFailure('projection-query-failed', async () => {
        const rows = await client.query(
          `select * from ${relation(options.tables.executions)}` +
            ` order by created_at desc, execution_key desc limit $1`,
          [bounded],
        );
        return Object.freeze(rows.map(toExecution));
      });
    },

    readLongShot: async () => singleton(options.tables.longShot, toPayload),

    readPerformance: async () => singleton(options.tables.performance, toPayload),

    probePrivileges: async (): Promise<ProjectionPrivilegeObservation> =>
      withSafeFailure('projection-privilege-probe-failed', async () => {
        // Grants are read for the whole schema rather than filtered to the four
        // table names. The pure rule ignores tables it was not asked about, and a
        // schema-wide read keeps this statement free of array binding, which is a
        // driver detail. The limit guards against a schema far larger than this
        // projection's.
        const grantRows = await client.query(
          `select table_name, privilege_type from information_schema.role_table_grants` +
            ` where table_schema = $1 limit $2`,
          [options.schema, MAX_GRANT_ROWS],
        );

        const attributeRows = await client.query(
          `select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication` +
            ` from pg_roles where rolname = current_user`,
          [],
        );

        return Object.freeze({
          attributes: toRoleAttributes(attributeRows.at(0)),
          grants: Object.freeze(
            grantRows.map((row) =>
              Object.freeze({
                privilege: asText(row.privilege_type),
                table: asText(row.table_name),
              }),
            ),
          ),
        });
      }),
  });
}
