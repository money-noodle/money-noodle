// Projection configuration, read once at startup.
//
// The connection string arrives as an environment variable whose value comes from
// a Secret Manager reference bound by the api stack. This module therefore holds
// the one env name the maintainer must fill, and nothing else about it: it never
// parses the URL, never logs it, and never puts it in an error. The driver is the
// only thing that reads the value, and the adapter hands it over without
// inspecting it.
//
// Table names are configurable with the projection's current names as defaults,
// because the writer owns those names and this API should not need a release to
// follow a rename. Each is validated as a bare identifier so a configured value
// cannot carry SQL: the adapter builds statements from these names, so this
// validation is the boundary that keeps that safe.

import {
  DEFAULT_PROJECTION_SCHEMA,
  DEFAULT_PROJECTION_TABLES,
  type ProjectionTableNames,
} from '../../domain/paper-projection.js';

/**
 * The environment variable carrying the connection string.
 *
 * Bound from Secret Manager by `infra/stacks/api`. Absent means "no projection
 * configured", which is a legitimate state until the maintainer enters a value.
 */
export const PROJECTION_URL_ENV = 'PLATFORM_API_PROJECTION_DATABASE_URL';

const SCHEMA_ENV = 'PLATFORM_API_PROJECTION_SCHEMA';

const TABLE_ENV: Readonly<Record<keyof ProjectionTableNames, string>> = Object.freeze({
  budget: 'PLATFORM_API_PROJECTION_TABLE_BUDGET',
  executions: 'PLATFORM_API_PROJECTION_TABLE_EXECUTIONS',
  longShot: 'PLATFORM_API_PROJECTION_TABLE_LONG_SHOT',
  performance: 'PLATFORM_API_PROJECTION_TABLE_PERFORMANCE',
});

// Unquoted lower-case identifiers only. Deliberately narrower than PostgreSQL
// allows: the projection's names fit, and anything that does not fit is far more
// likely to be a mistake or an injection attempt than a real table.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

export interface ProjectionConfig {
  /** Present only when a connection string was configured. */
  readonly connectionString: string | undefined;
  readonly schema: string;
  readonly tables: ProjectionTableNames;
}

function identifier(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) return fallback;
  if (!IDENTIFIER.test(value)) {
    // Names the variable, never its value: a rejected value may well be the
    // thing someone pasted into the wrong variable.
    throw new Error(`${name} must be a lower-case unquoted SQL identifier.`);
  }
  return value;
}

export function readProjectionConfig(
  env: Readonly<Record<string, string | undefined>>,
): ProjectionConfig {
  const configured = env[PROJECTION_URL_ENV];
  // An empty string is how an unset Secret Manager reference can arrive. Treat it
  // as absent rather than handing the driver something it will fail on later.
  const connectionString =
    configured === undefined || configured.trim().length === 0 ? undefined : configured;

  return Object.freeze({
    connectionString,
    schema: identifier(env, SCHEMA_ENV, DEFAULT_PROJECTION_SCHEMA),
    tables: Object.freeze({
      budget: identifier(env, TABLE_ENV.budget, DEFAULT_PROJECTION_TABLES.budget),
      executions: identifier(env, TABLE_ENV.executions, DEFAULT_PROJECTION_TABLES.executions),
      longShot: identifier(env, TABLE_ENV.longShot, DEFAULT_PROJECTION_TABLES.longShot),
      performance: identifier(env, TABLE_ENV.performance, DEFAULT_PROJECTION_TABLES.performance),
    }),
  });
}

/** The table list the privilege rule must be satisfied about. */
export function expectedTableList(tables: ProjectionTableNames): readonly string[] {
  return Object.freeze([tables.budget, tables.executions, tables.longShot, tables.performance]);
}
