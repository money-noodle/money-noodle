// Column readers, against the values a driver might plausibly hand over and the
// values it must never be allowed to pass off as data.
//
// Provider-free by construction: every input is a literal.

import { describe, expect, it } from 'vitest';

import { ProjectionFailure } from './projection-errors.js';
import {
  asBigInt,
  asBoolean,
  asDate,
  asDecimal,
  asInteger,
  asText,
  toBudget,
  toExecution,
  toPayload,
  toRoleAttributes,
} from './projection-rows.js';

const budgetRow = {
  available_cents: '123456789012345',
  bankroll_resets: 2,
  depleted: false,
  equity_cents: 2_500n,
  open_orders: '3',
  proposed_stake_cents: 100,
  realized_pnl_cents: '-12.3456789',
  reserved_cents: '0',
  running: 't',
  settled_orders: 41,
  source_updated_at: '2026-10-04T06:00:00.000Z',
  starting_cents: '100000',
};

const executionRow = {
  ask_price: '0.6150',
  closes_at: new Date('2026-10-04T07:00:00.000Z'),
  created_at: new Date('2026-10-04T06:00:00.000Z'),
  execution_key: 'platform-api-00041-abc',
  fee_cents: '1.5',
  liquidity_role: 'taker',
  no_fill_reason: null,
  outcome: null,
  pnl_cents: null,
  quantity: '10',
  side: 'UP',
  source_updated_at: new Date('2026-10-04T06:00:01.000Z'),
  stake_cents: '615',
  status: 'open',
  symbol: 'BTC-UP',
  venue: 'kalshi',
};

describe('column readers', () => {
  it('keeps cents exact by refusing to turn a 64-bit integer into a number', () => {
    // Beyond Number.MAX_SAFE_INTEGER: a double would lose the last digits, which
    // in this projection are cents.
    expect(asBigInt('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(asBigInt(-42)).toBe(-42n);
    expect(asBigInt(7n)).toBe(7n);
  });

  it('keeps arbitrary precision by carrying a numeric verbatim', () => {
    expect(asDecimal('0.10000000000000000000001')).toBe('0.10000000000000000000001');
    expect(asDecimal(12n)).toBe('12');
  });

  it('accepts the server spellings of a boolean', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean('t')).toBe(true);
    expect(asBoolean('false')).toBe(false);
    expect(asBoolean('f')).toBe(false);
  });

  it('accepts a timestamp as a Date or as text', () => {
    expect(asDate(new Date('2026-10-04T00:00:00Z')).toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(asDate('2026-10-04T00:00:00Z').toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it.each([
    ['asText', asText, 7],
    ['asBoolean', asBoolean, 'yes'],
    ['asBigInt', asBigInt, '12.5'],
    ['asBigInt on a lossy number', asBigInt, 1.5],
    ['asInteger', asInteger, '1.5'],
    ['asInteger beyond safe range', asInteger, 10n ** 30n],
    ['asDecimal', asDecimal, {}],
    ['asDate', asDate, 1_700_000_000],
    ['asDate on nonsense text', asDate, 'not a timestamp'],
  ])('%s refuses a value it cannot read rather than coercing it', (_label, read, value) => {
    expect(() => (read as (input: unknown) => unknown)(value)).toThrowError(ProjectionFailure);
  });

  it('reports an unreadable row as an unexpected shape and nothing more', () => {
    try {
      asDate('not a timestamp');
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as ProjectionFailure).code).toBe('projection-unexpected-shape');
      expect((error as ProjectionFailure).message).toBe(
        'The projection returned a row this API does not understand.',
      );
    }
  });
});

describe('toBudget', () => {
  it('reads the singleton budget row across the types a driver may use', () => {
    const budget = toBudget(budgetRow);

    expect(budget.availableCents).toBe(123_456_789_012_345n);
    expect(budget.equityCents).toBe(2_500n);
    expect(budget.proposedStakeCents).toBe(100n);
    expect(budget.realizedPnlCents).toBe('-12.3456789');
    expect(budget.openOrders).toBe(3);
    expect(budget.running).toBe(true);
    expect(budget.depleted).toBe(false);
    expect(budget.sourceUpdatedAt.toISOString()).toBe('2026-10-04T06:00:00.000Z');
    expect(Object.isFrozen(budget)).toBe(true);
  });

  it('refuses a budget row with a missing column rather than defaulting it', () => {
    const incomplete: Record<string, unknown> = { ...budgetRow };
    delete incomplete.equity_cents;
    expect(() => toBudget(incomplete)).toThrowError(ProjectionFailure);
  });
});

describe('toExecution', () => {
  it('reads an execution row and its nullable columns', () => {
    const execution = toExecution(executionRow);

    expect(execution.executionKey).toBe('platform-api-00041-abc');
    expect(execution.venue).toBe('kalshi');
    expect(execution.side).toBe('UP');
    expect(execution.liquidityRole).toBe('taker');
    expect(execution.outcome).toBeNull();
    expect(execution.pnlCents).toBeNull();
    expect(execution.noFillReason).toBeNull();
    expect(execution.stakeCents).toBe('615');
  });

  it('reads a settled execution with every nullable column present', () => {
    const execution = toExecution({
      ...executionRow,
      liquidity_role: 'maker',
      no_fill_reason: 'book too thin',
      outcome: 'DOWN',
      pnl_cents: '-615',
    });

    expect(execution.outcome).toBe('DOWN');
    expect(execution.pnlCents).toBe('-615');
    expect(execution.liquidityRole).toBe('maker');
    expect(execution.noFillReason).toBe('book too thin');
  });

  it.each([
    ['venue', { venue: 'binance' }],
    ['side', { side: 'SIDEWAYS' }],
    ['outcome', { outcome: 'MAYBE' }],
    ['liquidity_role', { liquidity_role: 'broker' }],
  ])('refuses an unrecognised %s rather than passing it through', (_column, override) => {
    expect(() => toExecution({ ...executionRow, ...override })).toThrowError(ProjectionFailure);
  });
});

describe('toPayload', () => {
  it('carries an opaque payload without inspecting it', () => {
    const payload = { anything: [1, 2, { nested: true }] };
    const row = toPayload({ payload, source_updated_at: '2026-10-04T06:00:00Z' });

    expect(row.payload).toBe(payload);
    expect(row.sourceUpdatedAt.toISOString()).toBe('2026-10-04T06:00:00.000Z');
  });

  it('reports an absent payload as null rather than undefined', () => {
    expect(
      toPayload({ payload: null, source_updated_at: '2026-10-04T06:00:00Z' }).payload,
    ).toBeNull();
    expect(toPayload({ source_updated_at: '2026-10-04T06:00:00Z' }).payload).toBeNull();
  });
});

describe('toRoleAttributes', () => {
  it('reads the attributes the probe asked for', () => {
    expect(
      toRoleAttributes({
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolsuper: false,
      }),
    ).toEqual({
      bypassRowLevelSecurity: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      superuser: false,
    });
  });

  it('treats an unanswered question as every attribute set, so readiness fails closed', () => {
    // No row for the current role is not "no elevated attributes".
    expect(toRoleAttributes(undefined)).toEqual({
      bypassRowLevelSecurity: true,
      createDatabase: true,
      createRole: true,
      replication: true,
      superuser: true,
    });
  });
});
