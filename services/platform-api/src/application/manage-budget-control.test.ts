import { describe, expect, it } from 'vitest';

import {
  createListBudgets,
  createReadBudgetDetail,
  createReadIntentHistory,
  createReadJobHealth,
  createRecordBudgetControl,
  validateParameters,
  type BudgetControlDependencies,
} from './manage-budget-control.js';
import type {
  BudgetRecord,
  BudgetRecordStore,
  ControlRecorderPort,
  EngineReadPort,
  IntentHistoryEntry,
  IntentRow,
} from '../domain/budget-control.js';

const ACCOUNT = 'account-under-test';
const NOW = new Date('2026-10-06T12:00:00.000Z');

const record = (kind: 'paper' | 'live'): BudgetRecord => ({
  accountId: ACCOUNT,
  createdAt: NOW,
  id: `${ACCOUNT}:${kind}`,
  kind,
});

function fakeBudgets(records: readonly BudgetRecord[] = [record('paper'), record('live')]): {
  port: BudgetRecordStore;
  fail: boolean;
} {
  const holder = {
    fail: false,
    port: {
      readBudgets: async () => {
        if (holder.fail) throw new Error('unavailable');
        return records;
      },
    },
  };
  return holder;
}

function fakeRecorder(): {
  port: ControlRecorderPort;
  appended: Omit<IntentRow, 'id'>[];
  fail: boolean;
} {
  const appended: Omit<IntentRow, 'id'>[] = [];
  const holder = {
    appended,
    fail: false,
    port: {
      record: async (intent: Omit<IntentRow, 'id'>) => {
        if (holder.fail) throw new Error('unavailable');
        appended.push(intent);
        return { id: `intent-${appended.length}` };
      },
    },
  };
  return holder;
}

function fakeEngine(history: readonly IntentHistoryEntry[] = []): {
  port: EngineReadPort;
  fail: boolean;
} {
  const holder = {
    fail: false,
    port: {
      readIntentHistory: async () => {
        if (holder.fail) throw new Error('unavailable');
        return history;
      },
      readJobHealth: async () => {
        if (holder.fail) throw new Error('unavailable');
        return [
          { capability: 'budget:live', lastOutcome: null, lastRunAt: null, lastRunId: null },
          { capability: 'budget:paper', lastOutcome: null, lastRunAt: null, lastRunId: null },
        ];
      },
    },
  };
  return holder;
}

function dependencies(
  overrides: Partial<BudgetControlDependencies> = {},
): BudgetControlDependencies {
  return {
    budgets: fakeBudgets().port,
    clock: { now: () => NOW },
    engine: fakeEngine().port,
    epoch: 7,
    newRunId: () => 'run-identifier',
    recorder: fakeRecorder().port,
    ...overrides,
  };
}

describe('recording a control', () => {
  it('appends one intent row carrying exactly what ADR-0013 §3 requires', async () => {
    const recorder = fakeRecorder();
    const outcome = await createRecordBudgetControl(dependencies({ recorder: recorder.port }))({
      accountId: ACCOUNT,
      action: 'pause',
      actor: ACCOUNT,
      kind: 'paper',
      parameters: null,
    });

    expect(outcome).toEqual({ capability: 'budget:paper', intentId: 'intent-1', ok: true });
    expect(recorder.appended).toEqual([
      {
        action: 'pause',
        actor: ACCOUNT,
        capability: 'budget:paper',
        epoch: 7,
        parameters: null,
        recordedAt: NOW,
        runId: 'run-identifier',
      },
    ]);
  });

  it('records the same way for the live budget, and performs nothing for either', async () => {
    // The two budgets are identical in structure and in control surface; what makes
    // `live` inert is that nothing downstream of the row is wired to it (ADR-0013
    // §4). That is asserted over the repository tree in
    // `tools/live-budget-inertness.test.mjs`; here the point is that the recording
    // path does not branch on kind.
    const recorder = fakeRecorder();
    const record = createRecordBudgetControl(dependencies({ recorder: recorder.port }));

    await record({
      accountId: ACCOUNT,
      action: 'resume',
      actor: ACCOUNT,
      kind: 'paper',
      parameters: null,
    });
    await record({
      accountId: ACCOUNT,
      action: 'resume',
      actor: ACCOUNT,
      kind: 'live',
      parameters: null,
    });

    const [paper, live] = recorder.appended;
    expect(paper?.capability).toBe('budget:paper');
    expect(live?.capability).toBe('budget:live');
    // Same shape, same epoch, same action: nothing about the live row is special.
    expect({ ...paper, capability: undefined }).toEqual({ ...live, capability: undefined });
  });

  it('carries bounded scalar parameters and refuses anything richer', async () => {
    const recorder = fakeRecorder();
    const record = createRecordBudgetControl(dependencies({ recorder: recorder.port }));

    const accepted = await record({
      accountId: ACCOUNT,
      action: 'configure',
      actor: ACCOUNT,
      kind: 'paper',
      parameters: { cycle_seconds: 15, enabled: true, mode: 'observe' },
    });
    expect(accepted.ok).toBe(true);

    for (const parameters of [
      { 'Bad-Key': 'x' },
      { nested: { a: 1 } as unknown as string },
      { unbounded: 'x'.repeat(121) },
      { infinite: Number.POSITIVE_INFINITY },
      Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`k${index}`, 1])),
    ]) {
      const refused = await record({
        accountId: ACCOUNT,
        action: 'configure',
        actor: ACCOUNT,
        kind: 'paper',
        parameters: parameters as Record<string, string | number | boolean>,
      });
      expect(refused).toEqual({ ok: false, refusal: 'invalid-parameters' });
    }
    expect(recorder.appended).toHaveLength(1);
  });

  it('refuses a budget the account does not hold, and records nothing', async () => {
    const recorder = fakeRecorder();
    const outcome = await createRecordBudgetControl(
      dependencies({ budgets: fakeBudgets([record('paper')]).port, recorder: recorder.port }),
    )({ accountId: ACCOUNT, action: 'pause', actor: ACCOUNT, kind: 'live', parameters: null });

    expect(outcome).toEqual({ ok: false, refusal: 'unknown-budget' });
    expect(recorder.appended).toHaveLength(0);
  });

  it('refuses while the control path is unconfigured', async () => {
    expect(
      await createRecordBudgetControl(dependencies({ recorder: null }))({
        accountId: ACCOUNT,
        action: 'pause',
        actor: ACCOUNT,
        kind: 'paper',
        parameters: null,
      }),
    ).toEqual({ ok: false, refusal: 'not-configured' });
  });

  it('reports a store failure without carrying its message', async () => {
    const budgets = fakeBudgets();
    budgets.fail = true;
    expect(
      await createRecordBudgetControl(dependencies({ budgets: budgets.port }))({
        accountId: ACCOUNT,
        action: 'pause',
        actor: ACCOUNT,
        kind: 'paper',
        parameters: null,
      }),
    ).toEqual({ ok: false, refusal: 'store-unavailable' });

    const recorder = fakeRecorder();
    recorder.fail = true;
    expect(
      await createRecordBudgetControl(dependencies({ recorder: recorder.port }))({
        accountId: ACCOUNT,
        action: 'pause',
        actor: ACCOUNT,
        kind: 'paper',
        parameters: null,
      }),
    ).toEqual({ ok: false, refusal: 'store-unavailable' });
  });
});

describe('parameter validation', () => {
  it('accepts null and the empty object', () => {
    expect(validateParameters(null)).toBe(true);
    expect(validateParameters({})).toBe(true);
  });
});

describe('the signed-in reads', () => {
  it('lists the account’s budgets', async () => {
    const outcome = await createListBudgets(dependencies())(ACCOUNT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.map((entry) => entry.kind)).toEqual(['paper', 'live']);
  });

  it('derives detail from the intent history', async () => {
    const entry: IntentHistoryEntry = {
      intent: {
        action: 'pause',
        actor: ACCOUNT,
        capability: 'budget:paper',
        epoch: 7,
        id: 'intent-1',
        parameters: null,
        recordedAt: NOW,
        runId: 'run',
      },
      outcomes: [],
    };
    const outcome = await createReadBudgetDetail(
      dependencies({ engine: fakeEngine([entry]).port }),
    )(ACCOUNT, 'paper');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.desiredState).toBe('paused');
    // No job has read the row, so nothing claims it was applied.
    expect(outcome.value.appliedState).toBeNull();
    expect(outcome.value.hasExecutionAuthority).toBe(true);
  });

  it('reports an unknown budget distinctly from an unreachable store', async () => {
    expect(
      await createReadBudgetDetail(dependencies({ budgets: fakeBudgets([record('paper')]).port }))(
        ACCOUNT,
        'live',
      ),
    ).toEqual({ failure: 'unknown-budget', ok: false });

    const engine = fakeEngine();
    engine.fail = true;
    expect(
      await createReadBudgetDetail(dependencies({ engine: engine.port }))(ACCOUNT, 'paper'),
    ).toEqual({ failure: 'unreachable', ok: false });
  });

  it('returns intent history and job health, and says so when unconfigured', async () => {
    const history = await createReadIntentHistory(dependencies())('paper');
    expect(history).toEqual({ ok: true, value: [] });

    const health = await createReadJobHealth(dependencies())();
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    // Every job has never run, which in this milestone is the honest answer.
    expect(health.value.every((job) => job.lastRunAt === null)).toBe(true);

    expect(await createReadIntentHistory(dependencies({ engine: null }))('paper')).toEqual({
      failure: 'not-configured',
      ok: false,
    });
    expect(await createReadJobHealth(dependencies({ engine: null }))()).toEqual({
      failure: 'not-configured',
      ok: false,
    });
    expect(await createListBudgets(dependencies({ budgets: null }))(ACCOUNT)).toEqual({
      failure: 'not-configured',
      ok: false,
    });
    expect(await createReadBudgetDetail(dependencies({ engine: null }))(ACCOUNT, 'paper')).toEqual({
      failure: 'not-configured',
      ok: false,
    });
  });

  it('reports an unreachable store for every read', async () => {
    const budgets = fakeBudgets();
    budgets.fail = true;
    expect(await createListBudgets(dependencies({ budgets: budgets.port }))(ACCOUNT)).toEqual({
      failure: 'unreachable',
      ok: false,
    });

    const engine = fakeEngine();
    engine.fail = true;
    expect(await createReadIntentHistory(dependencies({ engine: engine.port }))('paper')).toEqual({
      failure: 'unreachable',
      ok: false,
    });
    expect(await createReadJobHealth(dependencies({ engine: engine.port }))()).toEqual({
      failure: 'unreachable',
      ok: false,
    });
  });
});
