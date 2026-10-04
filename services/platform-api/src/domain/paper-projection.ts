// The public paper projection, as the API is allowed to see it.
//
// A separate system — the v1 worker — writes these four tables. This API only
// reads them, and ADR-0012 admits them as a read-only projection rather than as
// a schema this service owns. Nothing here may describe a write: there is no
// insert, update, delete or migration shape in this file, and adding one would
// be a change of authority, not a change of code.
//
// The row types are deliberately the projection's own shape rather than a
// presentation shape. Mapping to a DTO belongs to a later read-endpoint slice
// (#210); keeping the two apart stops a rendering convenience from quietly
// becoming the stored meaning. Financial amounts therefore stay as the
// projection stores them — integer cents, or a decimal the writer chose — and
// are carried as `string` where the source type is arbitrary precision, because
// turning a numeric into a JavaScript number is a silent loss of exactly the
// digits money is measured in.

/** The four tables, keyed by the role each plays. Names are configurable. */
export interface ProjectionTableNames {
  readonly budget: string;
  readonly executions: string;
  readonly longShot: string;
  readonly performance: string;
}

export const DEFAULT_PROJECTION_TABLES: ProjectionTableNames = Object.freeze({
  budget: 'money_noodle_public_paper_budget',
  executions: 'money_noodle_public_paper_executions',
  longShot: 'money_noodle_public_long_shot',
  performance: 'money_noodle_public_paper_performance',
});

export const DEFAULT_PROJECTION_SCHEMA = 'public';

/** Venues the projection records. A value outside this set is not understood. */
export const PROJECTION_VENUES = Object.freeze(['polymarket', 'kalshi'] as const);
export type ProjectionVenue = (typeof PROJECTION_VENUES)[number];

/** Direction of a paper position. */
export const PROJECTION_SIDES = Object.freeze(['UP', 'DOWN'] as const);
export type ProjectionSide = (typeof PROJECTION_SIDES)[number];

/** Who supplied liquidity, when the projection recorded it. */
export const PROJECTION_LIQUIDITY_ROLES = Object.freeze(['maker', 'taker'] as const);
export type ProjectionLiquidityRole = (typeof PROJECTION_LIQUIDITY_ROLES)[number];

/**
 * The singleton paper budget row.
 *
 * `*_cents` fields are integer cents and are carried as `bigint`, because the
 * projection stores them as 64-bit integers and a balance is not a value to
 * round. `realizedPnlCents` is arbitrary precision in the projection and is
 * carried verbatim as a string for the same reason.
 */
export interface PaperBudgetRow {
  readonly availableCents: bigint;
  readonly bankrollResets: number;
  readonly depleted: boolean;
  readonly equityCents: bigint;
  readonly openOrders: number;
  readonly proposedStakeCents: bigint;
  readonly realizedPnlCents: string;
  readonly reservedCents: bigint;
  readonly running: boolean;
  readonly settledOrders: number;
  readonly sourceUpdatedAt: Date;
  readonly startingCents: bigint;
}

/** One recorded paper execution. `executionKey` is the projection's own key. */
export interface PaperExecutionRow {
  readonly askPrice: string;
  readonly closesAt: Date;
  readonly createdAt: Date;
  readonly executionKey: string;
  readonly feeCents: string;
  readonly liquidityRole: ProjectionLiquidityRole | null;
  readonly noFillReason: string | null;
  readonly outcome: ProjectionSide | null;
  readonly pnlCents: string | null;
  readonly quantity: string;
  readonly side: ProjectionSide;
  readonly sourceUpdatedAt: Date;
  readonly stakeCents: string;
  readonly status: string;
  readonly symbol: string;
  readonly venue: ProjectionVenue;
}

/**
 * A singleton row whose meaning lives in an opaque JSON payload.
 *
 * The payload is deliberately not typed here. Its shape is the writer's, not
 * this service's, and inventing a type for it would be this API claiming
 * ownership of a contract it does not control. A later read endpoint validates
 * the subset it actually renders.
 */
export interface PaperJsonPayloadRow {
  readonly payload: unknown;
  readonly sourceUpdatedAt: Date;
}

/**
 * What the API may do with the projection.
 *
 * Readers only, plus the privilege probe readiness depends on. Every method may
 * fail; the adapter converts any failure into a safe error carrying no
 * connection, host or role detail.
 */
export interface PaperProjectionPort {
  /** Closes the underlying connection. Idempotent. */
  readonly close: () => Promise<void>;
  /** The singleton budget row, or `null` when the projection has none yet. */
  readonly readBudget: () => Promise<PaperBudgetRow | null>;
  /** Recent executions, newest first, bounded by `limit`. */
  readonly readExecutions: (limit: number) => Promise<readonly PaperExecutionRow[]>;
  /** The singleton long-shot payload row, or `null`. */
  readonly readLongShot: () => Promise<PaperJsonPayloadRow | null>;
  /** The singleton performance payload row, or `null`. */
  readonly readPerformance: () => Promise<PaperJsonPayloadRow | null>;
  /**
   * What the connected role may actually do. Readiness refuses to pass when
   * this reports anything beyond SELECT on the projection tables, so the probe
   * is part of the port rather than an adapter detail.
   */
  readonly probePrivileges: () => Promise<ProjectionPrivilegeObservation>;
}

/** The largest number of execution rows a single read may return. */
export const MAX_EXECUTION_ROWS = 500;

/** One grant the database reported for the connected role. */
export interface ObservedTableGrant {
  readonly privilege: string;
  readonly table: string;
}

/** Role attributes that would make "SELECT-only" meaningless if set. */
export interface ObservedRoleAttributes {
  readonly bypassRowLevelSecurity: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly superuser: boolean;
}

/** Exactly what the probe saw, with no judgement applied yet. */
export interface ProjectionPrivilegeObservation {
  readonly attributes: ObservedRoleAttributes;
  readonly grants: readonly ObservedTableGrant[];
}
