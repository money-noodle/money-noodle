import { describe, expect, it } from 'vitest';

import {
  CONTROL_INTENT_TABLE,
  EngineStoreError,
  CONTROL_WRITE_LOCK_NAMESPACE,
  createPostgresControlRecorder,
  createPostgresEngineReader,
} from './postgres-engine-store.js';
import type { EngineQueryClient, EngineRow } from './engine-query-client.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');

/** A client that records what it was asked and answers from a script. */
function fakeClient(
  answers: readonly (readonly EngineRow[])[] | (() => never),
): EngineQueryClient & { statements: { text: string; parameters: readonly unknown[] }[] } {
  const statements: { text: string; parameters: readonly unknown[] }[] = [];
  let index = 0;
  return {
    close: async () => {},
    query: async (text: string, parameters: readonly unknown[]) => {
      statements.push({ parameters, text });
      if (typeof answers === 'function') return answers();
      return answers[index++] ?? [];
    },
    statements,
  };
}

const intentRow = (overrides: Partial<EngineRow> = {}): EngineRow => ({
  action: 'pause',
  actor: 'account',
  capability: 'budget:paper',
  epoch: 3,
  id: 'intent-1',
  parameters: null,
  recorded_at: NOW,
  run_id: 'run-1',
  ...overrides,
});

describe('reading intent history', () => {
  it('orders by (epoch, recorded_at, id) — the staleness rule of ADR-0013 §3', async () => {
    const client = fakeClient([[intentRow()], []]);
    const reader = createPostgresEngineReader({ client, schema: 'engine' });

    await reader.readIntentHistory('budget:paper', 50);

    const [first] = client.statements;
    expect(first?.text).toMatch(/order by epoch desc, recorded_at desc, id desc/u);
    expect(first?.parameters).toEqual(['budget:paper', 50]);
  });

  it('bounds the limit whatever it is asked for', async () => {
    const client = fakeClient([[intentRow()], []]);
    const reader = createPostgresEngineReader({ client, schema: 'engine' });

    await reader.readIntentHistory('budget:paper', 10_000);
    await reader.readIntentHistory('budget:paper', -5);

    expect(client.statements[0]?.parameters[1]).toBe(200);
    expect(client.statements[2]?.parameters[1]).toBe(1);
  });

  it('attaches each job’s outcome rows to the intent they answer', async () => {
    const client = fakeClient([
      [intentRow({ id: 'intent-a' }), intentRow({ id: 'intent-b' })],
      [
        {
          applied_at: NOW,
          applied_run_id: 'run-9',
          id: 'outcome-1',
          intent_id: 'intent-a',
          outcome: 'applied',
          reason: 'ok',
        },
      ],
    ]);
    const history = await createPostgresEngineReader({
      client,
      schema: 'engine',
    }).readIntentHistory('budget:paper', 50);

    expect(history).toHaveLength(2);
    expect(history[0]?.outcomes).toHaveLength(1);
    expect(history[0]?.outcomes[0]?.outcome).toBe('applied');
    // The second intent has not been read by any job, and nothing is invented.
    expect(history[1]?.outcomes).toEqual([]);
  });

  it('skips the outcome query entirely when there is no intent', async () => {
    const client = fakeClient([[]]);
    expect(
      await createPostgresEngineReader({ client, schema: 'engine' }).readIntentHistory('c', 50),
    ).toEqual([]);
    expect(client.statements).toHaveLength(1);
  });

  it('carries bounded scalar parameters through and refuses anything else', async () => {
    const good = fakeClient([[intentRow({ parameters: { enabled: true, mode: 'observe' } })], []]);
    const history = await createPostgresEngineReader({
      client: good,
      schema: 'engine',
    }).readIntentHistory('budget:paper', 50);
    expect(history[0]?.intent.parameters).toEqual({ enabled: true, mode: 'observe' });

    for (const parameters of [{ nested: { a: 1 } }, ['a']]) {
      const bad = fakeClient([[intentRow({ parameters })], []]);
      await expect(
        createPostgresEngineReader({ client: bad, schema: 'engine' }).readIntentHistory('c', 50),
      ).rejects.toThrow(EngineStoreError);
    }
  });

  it('refuses a row whose shape this API does not understand', async () => {
    for (const row of [
      intentRow({ action: 'arm' }),
      intentRow({ id: '' }),
      intentRow({ recorded_at: 'yesterday' }),
      intentRow({ epoch: 1.5 }),
    ]) {
      const client = fakeClient([[row], []]);
      await expect(
        createPostgresEngineReader({ client, schema: 'engine' }).readIntentHistory('c', 50),
      ).rejects.toMatchObject({ code: 'engine-unexpected-shape' });
    }
  });

  it('turns a driver failure into an unreachable store and carries no message', async () => {
    const client = fakeClient(() => {
      throw new Error('connection to host db.internal.example refused');
    });
    await expect(
      createPostgresEngineReader({ client, schema: 'engine' }).readIntentHistory('c', 50),
    ).rejects.toMatchObject({ code: 'engine-unreachable', message: 'engine-unreachable' });
  });
});

describe('reading job health', () => {
  it('reports a job that has never run as exactly that', async () => {
    const client = fakeClient([
      [
        { capability: 'budget:live', last_outcome: null, last_run_at: null, last_run_id: null },
        {
          capability: 'budget:paper',
          last_outcome: 'applied',
          last_run_at: NOW,
          last_run_id: 'run-1',
        },
      ],
    ]);
    const jobs = await createPostgresEngineReader({ client, schema: 'engine' }).readJobHealth();

    expect(jobs[0]).toEqual({
      capability: 'budget:live',
      lastOutcome: null,
      lastRunAt: null,
      lastRunId: null,
    });
    expect(jobs[1]?.lastOutcome).toBe('applied');
  });

  it('refuses an outcome value outside the published set', async () => {
    const client = fakeClient([
      [{ capability: 'c', last_outcome: 'maybe', last_run_at: null, last_run_id: null }],
    ]);
    await expect(
      createPostgresEngineReader({ client, schema: 'engine' }).readJobHealth(),
    ).rejects.toMatchObject({ code: 'engine-unexpected-shape' });
  });
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('recording intent', () => {
  it('generates the identity itself, writes it as a column, and returns that same value', async () => {
    // The driver answers with NO rows, which is what an insert without `returning`
    // produces. That is the success shape now, not a failure.
    const client = fakeClient([[]]);
    const recorder = createPostgresControlRecorder({ client, schema: 'engine' });

    const result = await recorder.record({
      action: 'pause',
      actor: 'account',
      capability: 'budget:paper',
      epoch: 3,
      parameters: { mode: 'observe' },
      recordedAt: NOW,
      runId: 'run-1',
    });

    expect(result.id).toMatch(UUID_V4);
    expect(client.statements).toHaveLength(1);
    const [statement] = client.statements;
    expect(statement?.text).toContain(`insert into "engine"."${CONTROL_INTENT_TABLE}"`);
    // The value returned to the caller is the value that was INSERTED, compared after the
    // query resolved — not a second generation and not a read-back.
    expect(statement?.parameters[0]).toBe(result.id);
    expect(statement?.parameters).toEqual([
      result.id,
      'budget:paper',
      'pause',
      'account',
      3,
      NOW,
      'run-1',
      '{"mode":"observe"}',
      'money-noodle/paper-gate-capability-write/v1:budget:paper',
    ]);
    // The document is bound as JSON TEXT and the statement casts it, so PostgreSQL parses
    // it exactly once. Parsing the bound value back gives the caller's document, which is
    // what every reader contract requires the column to hold.
    expect(statement?.text).toContain('$8::text::jsonb');
    expect(JSON.parse(String(statement?.parameters[7]))).toEqual({ mode: 'observe' });
    // No update, no delete, and now nothing read at all: the role behind this connection
    // holds `INSERT` and nothing else (ADR-0013 §2), and `returning` would have needed
    // `SELECT` on the column it returned.
    expect(statement?.text).not.toMatch(/\bupdate\b|\bdelete\b/u);
    expect(statement?.text).not.toContain('returning');
    // The response shape the port publishes is unchanged: one frozen `{ id }`.
    expect(Object.keys(result)).toEqual(['id']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('gives independent calls independent identities', async () => {
    const client = fakeClient([[], []]);
    const recorder = createPostgresControlRecorder({ client, schema: 'engine' });
    const intent = {
      action: 'pause' as const,
      actor: 'account',
      capability: 'budget:paper',
      epoch: 3,
      parameters: null,
      recordedAt: NOW,
      runId: 'run-1',
    };

    const first = await recorder.record(intent);
    const second = await recorder.record(intent);

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(UUID_V4);
    expect(second.id).toMatch(UUID_V4);
    // Each call wrote the identity it returned. Nothing here is an idempotency key: the
    // same intent recorded twice is two rows, as the append-only table intends.
    expect(client.statements[0]?.parameters[0]).toBe(first.id);
    expect(client.statements[1]?.parameters[0]).toBe(second.id);
  });

  it('takes the per-capability write lock in the same single statement', () => {
    const client = fakeClient([[]]);
    return createPostgresControlRecorder({ client, schema: 'engine' })
      .record({
        action: 'pause',
        actor: 'account',
        capability: 'budget:paper',
        epoch: 3,
        parameters: null,
        recordedAt: NOW,
        runId: 'run-1',
      })
      .then(() => {
        const [statement] = client.statements;
        // One statement, so the lock is acquired before the insert can take effect and
        // is released by that statement's implicit commit — which is all the pooled
        // endpoint this client targets allows.
        expect(client.statements).toHaveLength(1);
        expect(statement?.text).toContain(
          'from pg_advisory_xact_lock(hashtextextended($9::text, 0))',
        );
        expect(statement?.text).toContain('select $1, $2, $3, $4, $5, $6, $7, $8');
        expect(statement?.text).not.toContain('values (');
        expect(statement?.text).not.toContain('returning');
        expect(statement?.parameters).toHaveLength(9);
        // The key text is the engine's namespace plus the capability, verbatim, and it is
        // the LAST parameter — the one the lock function reads.
        expect(statement?.parameters[8]).toBe(`${CONTROL_WRITE_LOCK_NAMESPACE}:budget:paper`);
        expect(CONTROL_WRITE_LOCK_NAMESPACE).toBe('money-noodle/paper-gate-capability-write/v1');
      });
  });

  it('keys the lock by the capability it is recording for, not a fixed value', () => {
    const client = fakeClient([[]]);
    return createPostgresControlRecorder({ client, schema: 'engine' })
      .record({
        action: 'resume',
        actor: 'account',
        capability: 'budget:forecast',
        epoch: 2,
        parameters: null,
        recordedAt: NOW,
        runId: 'run-3',
      })
      .then(() => {
        expect(client.statements[0]?.parameters[8]).toBe(
          `${CONTROL_WRITE_LOCK_NAMESPACE}:budget:forecast`,
        );
      });
  });

  it('writes a null rather than an empty document when there are no parameters', async () => {
    const client = fakeClient([[]]);
    await createPostgresControlRecorder({ client, schema: 'engine' }).record({
      action: 'resume',
      actor: 'account',
      capability: 'budget:live',
      epoch: 1,
      parameters: null,
      recordedAt: NOW,
      runId: 'run-2',
    });

    // SQL NULL, not the text 'null': a NULL text cast to jsonb is still NULL.
    expect(client.statements[0]?.parameters[7]).toBeNull();
    expect(client.statements[0]?.parameters[7]).not.toBe('null');
  });

  it('carries every value the parameter domain allows, parsed back identically', async () => {
    // Exactly the domain `validateParameters` admits: strings, finite numbers and
    // booleans, at most twelve keys. Nested documents, arrays and null members are
    // refused upstream and by this port's own type, so they are not written here.
    const mixed = Object.freeze({
      enabled: true,
      mode: 'observe',
      paused: false,
      ratio: 0.125,
      threshold: -7,
      total_cap_cents: 1000,
    });
    const twelve = Object.freeze(
      Object.fromEntries(
        Array.from({ length: 12 }, (_unused, index) => [
          'key_' + index,
          index % 2 === 0 ? index : 'v' + index,
        ]),
      ) as Record<string, string | number | boolean>,
    );
    for (const document of [mixed, twelve, Object.freeze({})]) {
      const client = fakeClient([[]]);
      await createPostgresControlRecorder({ client, schema: 'engine' }).record({
        action: 'configure',
        actor: 'account',
        capability: 'budget:paper',
        epoch: 4,
        parameters: document,
        recordedAt: NOW,
        runId: 'run-9',
      });

      const bound = client.statements[0]?.parameters[7];
      expect(typeof bound).toBe('string');
      expect(JSON.parse(String(bound))).toEqual(document);
    }
    // An empty document stays an empty document and never becomes NULL.
    const empty = fakeClient([[]]);
    await createPostgresControlRecorder({ client: empty, schema: 'engine' }).record({
      action: 'configure',
      actor: 'account',
      capability: 'budget:paper',
      epoch: 4,
      parameters: Object.freeze({}),
      recordedAt: NOW,
      runId: 'run-9',
    });
    expect(empty.statements[0]?.parameters[7]).toBe('{}');
  });

  it('keeps the reader strict: a string-shaped jsonb column is refused, not parsed', async () => {
    // The no-tolerance decision, locked. A row whose `parameters` arrives as a STRING is
    // exactly what the double-encoding defect produced. The reader refuses it rather than
    // parsing it, so no reader was loosened to accept the old writer's output and no
    // legacy shape is quietly tolerated.
    const stringShaped = fakeClient([[intentRow({ parameters: '{"mode":"observe"}' })]]);
    await expect(
      createPostgresEngineReader({ client: stringShaped, schema: 'engine' }).readIntentHistory(
        'budget:paper',
        5,
      ),
    ).rejects.toMatchObject({ code: 'engine-unexpected-shape' });
  });

  it('rejects on a driver failure and returns no identity', async () => {
    const broken = fakeClient(() => {
      throw new Error('role "engine_control_recorder" cannot insert');
    });
    const recorder = createPostgresControlRecorder({ client: broken, schema: 'engine' });
    await expect(
      recorder.record({
        action: 'pause',
        actor: 'a',
        capability: 'c',
        epoch: 1,
        parameters: null,
        recordedAt: NOW,
        runId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'engine-unreachable', message: 'engine-unreachable' });
    // One attempt, and nothing retried behind the caller's back.
    expect(broken.statements).toHaveLength(1);
  });

  it('treats an unexpected row from the driver as success, not as a shape failure', async () => {
    // Defensive, and deliberate: the statement asks for nothing back, so whatever a
    // driver hands over is ignored rather than inspected. An insert that raises is the
    // only failure, and it is handled above.
    const chatty = fakeClient([[{ surprise: 'ignored' }]]);
    const result = await createPostgresControlRecorder({
      client: chatty,
      schema: 'engine',
    }).record({
      action: 'pause',
      actor: 'a',
      capability: 'c',
      epoch: 1,
      parameters: null,
      recordedAt: NOW,
      runId: 'r',
    });

    expect(result.id).toBe(chatty.statements[0]?.parameters[0]);
    expect(result.id).toMatch(UUID_V4);
  });
});
