// The schema this service owns, and the one connection that writes to it.
//
// `overview.md`'s accepted boundary has always reserved "its future explicitly
// owned schema" for the platform API. This is that schema: the account, its two
// budget records, and the session rows that make sign-in revocable. It is
// deliberately *not* the engine schema, because ADR-0013 §2 gives the engine's
// three roles no privilege outside `engine`, and a session table needs an
// `UPDATE` that none of them has. Putting sessions in the engine schema would
// have meant widening an engine role to carry this service's own state, which is
// the opposite of what that record decided.
//
// Custody is unchanged from the projection and the engine store (ADR-0005): the
// value arrives from a Secret Manager reference the maintainer fills out of band,
// and this module holds only the variable name.

/** `SELECT`, `INSERT`, `UPDATE` on this service's own schema, and nothing else. */
export const ACCOUNT_STORE_URL_ENV = 'PLATFORM_API_ACCOUNT_DATABASE_URL';

const SCHEMA_ENV = 'PLATFORM_API_ACCOUNT_SCHEMA';

export const DEFAULT_ACCOUNT_SCHEMA = 'platform';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

export interface AccountStoreConfig {
  /** Present only when a connection string was configured. */
  readonly connectionString: string | undefined;
  readonly schema: string;
}

export function readAccountStoreConfig(
  env: Readonly<Record<string, string | undefined>>,
): AccountStoreConfig {
  const configured = env[ACCOUNT_STORE_URL_ENV];
  const schema = env[SCHEMA_ENV];
  if (schema !== undefined && schema.length > 0 && !IDENTIFIER.test(schema)) {
    // Names the variable, never its value.
    throw new Error(`${SCHEMA_ENV} must be a lower-case unquoted SQL identifier.`);
  }

  return Object.freeze({
    connectionString:
      configured === undefined || configured.trim().length === 0 ? undefined : configured,
    schema: schema === undefined || schema.length === 0 ? DEFAULT_ACCOUNT_SCHEMA : schema,
  });
}
