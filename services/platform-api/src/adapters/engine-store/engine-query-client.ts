// The engine store's two connections, and the only place in this service besides
// the projection adapter that imports a database driver.
//
// Two factories rather than one with a flag, because the two connections are two
// different authorities (ADR-0013 §2) and a flag is a thing a later edit flips.
// The reader opens a session that is read-only at the server as well as by grant;
// the recorder does not, because it must `INSERT`, which is exactly why it is a
// separate connection with a separate role and a separate secret.
//
// `postgres` (postgres.js) is the driver ADR-0012 already chose for this service:
// pinned exactly, empty dependency closure, and already in the lockfile.

import postgres from 'postgres';

export interface EngineQueryClient {
  close(): Promise<void>;
  query(text: string, parameters: readonly unknown[]): Promise<readonly EngineRow[]>;
}

/** Whatever the driver hands back. Shaped by the mappers, never trusted here. */
export type EngineRow = Record<string, unknown>;

function create(
  connectionString: string,
  applicationName: string,
  readOnly: boolean,
): EngineQueryClient {
  const sql = postgres(connectionString, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    // Required by a connection pooler in transaction mode, which is how this
    // provider presents its pooled endpoint.
    prepare: false,
    connection: {
      application_name: applicationName,
      ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
    },
    // Notices quote identifiers and settings. Nothing from the server is printed.
    onnotice: () => {},
  });

  return Object.freeze({
    close: async () => {
      await sql.end({ timeout: 5 });
    },
    query: async (text: string, parameters: readonly unknown[]) =>
      // `unsafe` names the escaping, not the parameters: the text is built from
      // validated identifiers in this repository and every value is still bound.
      (await sql.unsafe(text, parameters as never[])) as unknown as EngineRow[],
  });
}

/**
 * The read connection. `engine_reader`, and the session refuses a write even if a
 * future edit of a mapper tried to issue one.
 */
export function createEngineReaderClient(connectionString: string): EngineQueryClient {
  return create(connectionString, 'platform-api-engine-reader', true);
}

/**
 * The control connection. `engine_control_recorder`, which may `INSERT` into one
 * append-only table and holds no other grant anywhere in the database, so the
 * narrowness is the role's rather than this file's.
 */
export function createEngineRecorderClient(connectionString: string): EngineQueryClient {
  return create(connectionString, 'platform-api-control-recorder', false);
}
