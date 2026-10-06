import { describe, expect, it } from 'vitest';

import {
  CONTROL_INTENT_TABLE,
  EngineStoreError,
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

describe('recording intent', () => {
  it('appends one row to the control table and returns its identity', async () => {
    const client = fakeClient([[{ id: 'intent-7' }]]);
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

    expect(result).toEqual({ id: 'intent-7' });
    expect(client.statements).toHaveLength(1);
    const [statement] = client.statements;
    expect(statement?.text).toContain(`insert into "engine"."${CONTROL_INTENT_TABLE}"`);
    // No update, no delete, and nothing read beyond the row it just wrote: the role
    // behind this connection holds `INSERT` and nothing else (ADR-0013 §2).
    expect(statement?.text).not.toMatch(/\bupdate\b|\bdelete\b/u);
    expect(statement?.parameters).toEqual([
      'budget:paper',
      'pause',
      'account',
      3,
      NOW,
      'run-1',
      '{"mode":"observe"}',
    ]);
  });

  it('writes a null rather than an empty document when there are no parameters', async () => {
    const client = fakeClient([[{ id: 'intent-8' }]]);
    await createPostgresControlRecorder({ client, schema: 'engine' }).record({
      action: 'resume',
      actor: 'account',
      capability: 'budget:live',
      epoch: 1,
      parameters: null,
      recordedAt: NOW,
      runId: 'run-2',
    });

    expect(client.statements[0]?.parameters[6]).toBeNull();
  });

  it('refuses an insert that returned nothing, and reports a failure safely', async () => {
    const empty = fakeClient([[]]);
    await expect(
      createPostgresControlRecorder({ client: empty, schema: 'engine' }).record({
        action: 'pause',
        actor: 'a',
        capability: 'c',
        epoch: 1,
        parameters: null,
        recordedAt: NOW,
        runId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'engine-unexpected-shape' });

    const broken = fakeClient(() => {
      throw new Error('role "engine_control_recorder" cannot insert');
    });
    await expect(
      createPostgresControlRecorder({ client: broken, schema: 'engine' }).record({
        action: 'pause',
        actor: 'a',
        capability: 'c',
        epoch: 1,
        parameters: null,
        recordedAt: NOW,
        runId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'engine-unreachable', message: 'engine-unreachable' });
  });
});
