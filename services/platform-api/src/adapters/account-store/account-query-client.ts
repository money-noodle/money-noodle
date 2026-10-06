// The connection to this service's own schema.
//
// Self-contained rather than shared with the engine store's client, deliberately:
// the two connect as different roles to different schemas under different
// secrets, and a shared factory is the seam along which that distinction gets
// lost. The projection adapter owns its client for the same reason.
//
// This is the one connection in the service that may write, and what it may write
// to is bounded by the role rather than by this file: `platform_app` holds
// `SELECT`, `INSERT`, `UPDATE` on this service's own schema and nothing anywhere
// else, so it cannot reach the public projection or the engine schema at all.

import postgres from 'postgres';

export interface AccountQueryClient {
  close(): Promise<void>;
  query(text: string, parameters: readonly unknown[]): Promise<readonly AccountRow[]>;
}

/** Whatever the driver hands back. Shaped by the mappers, never trusted here. */
export type AccountRow = Record<string, unknown>;

export function createAccountQueryClient(connectionString: string): AccountQueryClient {
  const sql = postgres(connectionString, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    // Required by a connection pooler in transaction mode, which is how this
    // provider presents its pooled endpoint.
    prepare: false,
    connection: { application_name: 'platform-api-account-store' },
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
      (await sql.unsafe(text, parameters as never[])) as unknown as AccountRow[],
  });
}
