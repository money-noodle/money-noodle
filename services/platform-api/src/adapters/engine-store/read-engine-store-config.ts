// Engine store configuration, read once at startup.
//
// Two connection strings, because ADR-0013 §2 gives the API two roles and they
// are the point: `engine_reader` holds `SELECT` on a granted subset and can
// record nothing, `engine_control_recorder` holds `INSERT` on the one append-only
// control table and can read nothing. One connection holding both would be one
// merge away from being a role that reads and writes, which is the thing the
// separation exists to prevent.
//
// Custody is the projection's, unchanged (ADR-0005, ADR-0012): the value arrives
// as an environment variable bound from a Secret Manager reference the maintainer
// fills out of band, this module holds only the names, and no value is parsed,
// logged or put into an error.
//
// The schema name is configurable with `engine` as the default, for the same
// reason the projection's table names are: the schema owner owns the name, and
// this API should not need a release to follow a rename. It is validated as a
// bare identifier because statements are built from it.

/** `SELECT` on a granted subset of the engine schema. */
export const ENGINE_READER_URL_ENV = 'PLATFORM_API_ENGINE_READER_DATABASE_URL';

/** `INSERT` on the append-only control table, and nothing else. */
export const ENGINE_RECORDER_URL_ENV = 'PLATFORM_API_ENGINE_RECORDER_DATABASE_URL';

const SCHEMA_ENV = 'PLATFORM_API_ENGINE_SCHEMA';

/**
 * The control epoch new intent is recorded under (ADR-0013 §3).
 *
 * Configuration rather than a stored counter, because the epoch increments on
 * events this service does not perform — a restore, a reseed, a migration — and
 * a service that could increment it could silently invalidate the operator's
 * standing intent. The schema owner raises it with the event that caused it.
 */
const EPOCH_ENV = 'PLATFORM_API_ENGINE_CONTROL_EPOCH';

export const DEFAULT_ENGINE_SCHEMA = 'engine';
export const DEFAULT_CONTROL_EPOCH = 1;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

export interface EngineStoreConfig {
  /** Present only when a connection string was configured. */
  readonly readerConnectionString: string | undefined;
  readonly recorderConnectionString: string | undefined;
  readonly schema: string;
  readonly epoch: number;
}

function connectionString(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  // An empty string is how an unset Secret Manager reference can arrive. Treat it
  // as absent rather than handing the driver something it will fail on later.
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

export function readEngineStoreConfig(
  env: Readonly<Record<string, string | undefined>>,
): EngineStoreConfig {
  const schema = env[SCHEMA_ENV];
  if (schema !== undefined && schema.length > 0 && !IDENTIFIER.test(schema)) {
    // Names the variable, never its value.
    throw new Error(`${SCHEMA_ENV} must be a lower-case unquoted SQL identifier.`);
  }

  const configuredEpoch = env[EPOCH_ENV];
  let epoch = DEFAULT_CONTROL_EPOCH;
  if (configuredEpoch !== undefined && configuredEpoch.length > 0) {
    // The whole string must be digits. `parseInt` would read "1.5" as 1 and a
    // silently truncated epoch is exactly the kind of quiet wrong answer the
    // staleness rule cannot survive (ADR-0013 §3).
    const parsed = /^[0-9]{1,15}$/u.test(configuredEpoch) ? Number(configuredEpoch) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${EPOCH_ENV} must be a positive integer.`);
    }
    epoch = parsed;
  }

  return Object.freeze({
    epoch,
    readerConnectionString: connectionString(env, ENGINE_READER_URL_ENV),
    recorderConnectionString: connectionString(env, ENGINE_RECORDER_URL_ENV),
    schema: schema === undefined || schema.length === 0 ? DEFAULT_ENGINE_SCHEMA : schema,
  });
}
