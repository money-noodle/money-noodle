// Reading a projection row without trusting the driver's type parsing.
//
// The projection stores 64-bit integers and arbitrary-precision numerics. Whether
// a driver hands those over as a string, a number or a bigint is a configuration
// detail of that driver, not a contract — so every column goes through an
// explicit reader that accepts what a driver might plausibly produce and refuses
// anything else. A driver upgrade that changes a default then breaks a test here
// instead of silently rounding money.
//
// Pure on purpose: no driver import, no I/O. These are the functions most worth
// testing against hostile values, and they can be.

import {
  PROJECTION_LIQUIDITY_ROLES,
  PROJECTION_SIDES,
  PROJECTION_VENUES,
  type ObservedRoleAttributes,
  type PaperBudgetRow,
  type PaperExecutionRow,
  type PaperJsonPayloadRow,
  type ProjectionLiquidityRole,
  type ProjectionSide,
  type ProjectionVenue,
} from '../../domain/paper-projection.js';
import { ProjectionFailure } from './projection-errors.js';

export type ProjectionRow = Record<string, unknown>;

const unexpected = (): never => {
  throw new ProjectionFailure('projection-unexpected-shape');
};

export function asText(value: unknown): string {
  return typeof value === 'string' ? value : unexpected();
}

function asNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

export function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  // Some drivers hand booleans back as the server's own `t`/`f`.
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;
  return unexpected();
}

/** A 64-bit integer column. Never a `number`: cents do not round. */
export function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return unexpected();
}

export function asInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : unexpected();
  }
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : unexpected();
  }
  return unexpected();
}

/**
 * An arbitrary-precision numeric column, carried verbatim as a string.
 *
 * The projection's `numeric` columns may hold more precision than a double can
 * represent, and this API has no reason to decide how to lose it. A later read
 * endpoint formats for presentation.
 */
export function asDecimal(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return unexpected();
}

function asNullableDecimal(value: unknown): string | null {
  return value === null || value === undefined ? null : asDecimal(value);
}

export function asDate(value: unknown): Date {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? unexpected() : value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? unexpected() : parsed;
  }
  return unexpected();
}

function asMember<T extends string>(value: unknown, permitted: readonly T[]): T {
  const text = asText(value);
  return (permitted as readonly string[]).includes(text) ? (text as T) : unexpected();
}

function asNullableMember<T extends string>(value: unknown, permitted: readonly T[]): T | null {
  return value === null || value === undefined ? null : asMember(value, permitted);
}

export function toBudget(row: ProjectionRow): PaperBudgetRow {
  return Object.freeze({
    availableCents: asBigInt(row.available_cents),
    bankrollResets: asInteger(row.bankroll_resets),
    depleted: asBoolean(row.depleted),
    equityCents: asBigInt(row.equity_cents),
    openOrders: asInteger(row.open_orders),
    proposedStakeCents: asBigInt(row.proposed_stake_cents),
    realizedPnlCents: asDecimal(row.realized_pnl_cents),
    reservedCents: asBigInt(row.reserved_cents),
    running: asBoolean(row.running),
    settledOrders: asInteger(row.settled_orders),
    sourceUpdatedAt: asDate(row.source_updated_at),
    startingCents: asBigInt(row.starting_cents),
  });
}

export function toExecution(row: ProjectionRow): PaperExecutionRow {
  return Object.freeze({
    askPrice: asDecimal(row.ask_price),
    closesAt: asDate(row.closes_at),
    createdAt: asDate(row.created_at),
    executionKey: asText(row.execution_key),
    feeCents: asDecimal(row.fee_cents),
    liquidityRole: asNullableMember<ProjectionLiquidityRole>(
      row.liquidity_role,
      PROJECTION_LIQUIDITY_ROLES,
    ),
    noFillReason: asNullableText(row.no_fill_reason),
    outcome: asNullableMember<ProjectionSide>(row.outcome, PROJECTION_SIDES),
    pnlCents: asNullableDecimal(row.pnl_cents),
    quantity: asDecimal(row.quantity),
    side: asMember<ProjectionSide>(row.side, PROJECTION_SIDES),
    sourceUpdatedAt: asDate(row.source_updated_at),
    stakeCents: asDecimal(row.stake_cents),
    status: asText(row.status),
    symbol: asText(row.symbol),
    venue: asMember<ProjectionVenue>(row.venue, PROJECTION_VENUES),
  });
}

export function toPayload(row: ProjectionRow): PaperJsonPayloadRow {
  return Object.freeze({
    // `jsonb` arrives already parsed and its shape belongs to the writer, so it
    // is carried as `unknown` rather than inspected here.
    payload: row.payload ?? null,
    sourceUpdatedAt: asDate(row.source_updated_at),
  });
}

/**
 * The connected role's attributes, from the one row `pg_roles` should return.
 *
 * No row is not "no elevated attributes": it is a question the probe could not
 * answer, and an unanswered privilege question fails closed — so the absent case
 * reports every attribute as set, which the privilege rule refuses.
 */
export function toRoleAttributes(row: ProjectionRow | undefined): ObservedRoleAttributes {
  if (row === undefined) {
    return Object.freeze({
      bypassRowLevelSecurity: true,
      createDatabase: true,
      createRole: true,
      replication: true,
      superuser: true,
    });
  }
  return Object.freeze({
    bypassRowLevelSecurity: asBoolean(row.rolbypassrls),
    createDatabase: asBoolean(row.rolcreatedb),
    createRole: asBoolean(row.rolcreaterole),
    replication: asBoolean(row.rolreplication),
    superuser: asBoolean(row.rolsuper),
  });
}
