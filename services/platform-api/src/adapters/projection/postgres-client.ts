// The only file in this service that imports a database driver.
//
// Deliberately the thinnest thing that can satisfy `ProjectionQueryClient`: it
// opens a connection, runs parameterised text, and closes. Every decision worth
// testing lives in `postgres-paper-projection.ts` and `projection-rows.ts`, which
// is why those have tests and this has none — there is nothing here a test could
// assert that would not simply be asserting the driver.
//
// `postgres` (postgres.js) is pinned exactly and has an empty dependency closure,
// which is why it was chosen over `pg` and its six further packages (ADR-0012).

import postgres from 'postgres';

import type { ProjectionQueryClient } from './postgres-paper-projection.js';
import type { ProjectionRow } from './projection-rows.js';

export function createPostgresProjectionClient(connectionString: string): ProjectionQueryClient {
  const sql = postgres(connectionString, {
    // A scale-to-zero service serving one in-process read does not need a wide
    // pool, and a narrow one is kinder to a shared serverless database.
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    // Required by a connection pooler in transaction mode, which is how this
    // projection's provider presents its pooled endpoint: a prepared statement
    // does not survive the connection being handed to another client between
    // statements.
    prepare: false,
    connection: {
      application_name: 'platform-api-projection-reader',
      // Server-side belt to the port's braces: the session itself refuses a write
      // even if a future edit of the adapter tried to issue one.
      options: '-c default_transaction_read_only=on',
    },
    // Notices quote identifiers and settings. Nothing from the server is printed
    // by this adapter, notices included.
    onnotice: () => {},
  });

  return Object.freeze({
    close: async () => {
      await sql.end({ timeout: 5 });
    },
    query: async (text: string, parameters: readonly unknown[]) =>
      // `unsafe` names the escaping, not the parameters: the text is built from
      // validated identifiers in this repository and every value is still bound.
      (await sql.unsafe(text, parameters as never[])) as unknown as ProjectionRow[],
  });
}
