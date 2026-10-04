// The port's SQL, bounds and privilege interpretation, against a fake client.
//
// Provider-free by construction: the query client is a recording function, so
// nothing here opens a socket. The statements themselves are the thing worth
// asserting — a read-only port that accidentally issued a write, or interpolated
// a table name it had not validated, would be a quiet failure of ADR-0012.

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PROJECTION_TABLES, MAX_EXECUTION_ROWS } from '../../domain/paper-projection.js';
import { ProjectionFailure } from './projection-errors.js';
import {
  MAX_GRANT_ROWS,
  createPostgresPaperProjection,
  type ProjectionQueryClient,
} from './postgres-paper-projection.js';
import type { ProjectionRow } from './projection-rows.js';

interface Issued {
  readonly parameters: readonly unknown[];
  readonly text: string;
}

function fakeClient(answers: ProjectionRow[][] = [[]]) {
  const issued: Issued[] = [];
  let call = 0;
  const client: ProjectionQueryClient = {
    close: vi.fn(async () => undefined),
    query: vi.fn(async (text: string, parameters: readonly unknown[]) => {
      issued.push({ parameters, text });
      return answers[Math.min(call++, answers.length - 1)] ?? [];
    }),
  };
  return { client, issued };
}

const open = (client: ProjectionQueryClient, schema = 'public') =>
  createPostgresPaperProjection({ client, schema, tables: DEFAULT_PROJECTION_TABLES });

/** The failure a call rejected with. Refuses to let a resolved call pass as one. */
async function rejection(work: Promise<unknown>): Promise<ProjectionFailure> {
  let settled: unknown;
  let threw = false;
  try {
    settled = await work;
  } catch (error) {
    threw = true;
    settled = error;
  }
  if (!threw) throw new Error('expected a rejection, got a value');
  return settled as ProjectionFailure;
}

const budgetRow: ProjectionRow = {
  available_cents: '1',
  bankroll_resets: 0,
  depleted: false,
  equity_cents: '1',
  open_orders: 0,
  proposed_stake_cents: '0',
  realized_pnl_cents: '0',
  reserved_cents: '0',
  running: true,
  settled_orders: 0,
  source_updated_at: '2026-10-04T06:00:00Z',
  starting_cents: '1',
};

describe('createPostgresPaperProjection', () => {
  it('issues only read statements, on every method the port exposes', async () => {
    // The budget row answers the first read; later reads get nothing, because
    // this test is about the statements rather than the rows.
    const { client, issued } = fakeClient([[budgetRow], []]);
    const projection = open(client);

    await projection.readBudget();
    await projection.readPerformance();
    await projection.readLongShot();
    await projection.readExecutions(5);
    await projection.probePrivileges();

    expect(issued.length).toBeGreaterThan(0);
    for (const { text } of issued) {
      expect(text.trimStart().toLowerCase().startsWith('select')).toBe(true);
      // The port has no write, and this is what proves the SQL has none either.
      expect(text.toLowerCase()).not.toMatch(
        /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy)\b/u,
      );
    }
  });

  it('quotes the configured schema and table into the statement', async () => {
    const { client, issued } = fakeClient();
    await open(client, 'projection_v2').readBudget();

    expect(issued[0]?.text).toBe(
      `select * from "projection_v2"."${DEFAULT_PROJECTION_TABLES.budget}" limit 1`,
    );
  });

  it('refuses an identifier that did not pass validation instead of quoting it', async () => {
    // Defence in depth: configuration already refuses this, and the adapter does
    // not rely on that having happened.
    const { client } = fakeClient();
    const projection = createPostgresPaperProjection({
      client,
      schema: 'public',
      tables: { ...DEFAULT_PROJECTION_TABLES, budget: 'budget"; drop table t --' },
    });

    await expect(projection.readBudget()).rejects.toBeInstanceOf(ProjectionFailure);
  });

  it('reports an absent singleton row as null rather than inventing one', async () => {
    const { client } = fakeClient([[]]);
    await expect(open(client).readBudget()).resolves.toBeNull();
  });

  it('binds the execution limit as a parameter and clamps it', async () => {
    const { client, issued } = fakeClient();
    const projection = open(client);

    await projection.readExecutions(5);
    expect(issued[0]?.text).toContain('limit $1');
    expect(issued[0]?.parameters).toEqual([5]);

    await projection.readExecutions(Number.MAX_SAFE_INTEGER);
    expect(issued[1]?.parameters).toEqual([MAX_EXECUTION_ROWS]);
  });

  it.each([0, -1, 1.5, Number.NaN])('clamps a nonsensical limit (%p) to one row', async (limit) => {
    const { client, issued } = fakeClient();
    await open(client).readExecutions(limit);

    expect(issued[0]?.parameters).toEqual([1]);
  });

  it('orders executions newest first, with a deterministic tiebreak', async () => {
    const { client, issued } = fakeClient();
    await open(client).readExecutions(3);

    expect(issued[0]?.text).toContain('order by created_at desc, execution_key desc');
  });

  it('probes grants for the configured schema under a bounded limit', async () => {
    const { client, issued } = fakeClient([
      [{ privilege_type: 'SELECT', table_name: DEFAULT_PROJECTION_TABLES.budget }],
      [
        {
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolsuper: false,
        },
      ],
    ]);

    const observation = await open(client).probePrivileges();

    expect(issued[0]?.text).toContain('information_schema.role_table_grants');
    expect(issued[0]?.parameters).toEqual(['public', MAX_GRANT_ROWS]);
    expect(issued[1]?.text).toContain('pg_roles');
    expect(issued[1]?.text).toContain('current_user');
    expect(observation.grants).toEqual([
      { privilege: 'SELECT', table: DEFAULT_PROJECTION_TABLES.budget },
    ]);
    expect(observation.attributes.superuser).toBe(false);
  });

  it('fails closed when pg_roles returns no row for the connected role', async () => {
    const { client } = fakeClient([[], []]);
    const observation = await open(client).probePrivileges();

    // Every attribute set, which the privilege rule refuses. An unanswered
    // privilege question is not a passed one.
    expect(observation.attributes).toEqual({
      bypassRowLevelSecurity: true,
      createDatabase: true,
      createRole: true,
      replication: true,
      superuser: true,
    });
  });

  it('converts a client failure into a safe probe failure', async () => {
    const client: ProjectionQueryClient = {
      close: async () => undefined,
      query: async () => {
        throw new Error('connect ECONNREFUSED db.example.invalid:5432 as role reader');
      },
    };

    const failure = await rejection(open(client).probePrivileges());

    expect(failure).toBeInstanceOf(ProjectionFailure);
    expect(failure.code).toBe('projection-privilege-probe-failed');
    const reachable = `${failure.message} ${String(failure.stack)}`;
    for (const forbidden of ['ECONNREFUSED', 'db.example.invalid', '5432', 'reader']) {
      expect(reachable).not.toContain(forbidden);
    }
  });

  it('converts a read failure into a safe query failure', async () => {
    const client: ProjectionQueryClient = {
      close: async () => undefined,
      query: async () => {
        throw new Error('relation "money_noodle_public_paper_budget" does not exist');
      },
    };

    const failure = await rejection(open(client).readBudget());

    expect(failure.code).toBe('projection-query-failed');
    expect(failure.message).toBe('A projection read did not complete.');
  });

  it('closes the client once, however many times it is asked', async () => {
    const { client } = fakeClient();
    const projection = open(client);

    await projection.close();
    await projection.close();

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing close throw into a shutdown path', async () => {
    const client: ProjectionQueryClient = {
      close: async () => {
        throw new Error('socket already gone at db.example.invalid');
      },
      query: async () => [],
    };

    await expect(open(client).close()).resolves.toBeUndefined();
  });

  it('maps rows through the typed readers', async () => {
    const { client } = fakeClient([[budgetRow]]);
    const budget = await open(client).readBudget();

    expect(budget?.availableCents).toBe(1n);
    expect(budget?.sourceUpdatedAt).toBeInstanceOf(Date);
  });
});
