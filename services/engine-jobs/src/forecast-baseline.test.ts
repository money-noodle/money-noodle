import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FORECAST_BASELINE_DIVERGENCES,
  evaluateForecastBaseline,
  type ForecastBaselineSnapshot,
} from './domain/forecast-baseline.js';
import { runCycleJob } from './application/cycle.js';
import { FakeCycleStore } from './adapters/engine-store/fake-cycle-store.js';
import { FakeForecastStore } from './adapters/engine-store/fake-forecast-store.js';
import { CYCLE_REASONS } from './domain/cycle-store.js';
import type { Contract, ForecastFeeds } from './domain/forecast.js';

const NOW = new Date('2026-11-13T00:00:00.000Z');

/** A restored, untouched baseline: one completed run, every restored table holding only
 * what that run loaded, and nothing recorded by a cycle yet. */
const reconciled: ForecastBaselineSnapshot = {
  completedRuns: [{ manifestDigest: 'sha256:manifest', runId: 'restore-1', schemaVersion: '0003' }],
  cycleRows: { adoptedFromBaseline: 1200, recordedByRuns: 0 },
  forecastRows: { attributedToBaseline: 1200, total: 1200 },
  ledgerOrders: { attributedToBaseline: 84, total: 84 },
  ledgerState: { attributedToBaseline: 7, total: 7 },
  openRuns: 0,
};
const patch = (over: Partial<ForecastBaselineSnapshot>): ForecastBaselineSnapshot => ({
  ...reconciled,
  ...over,
});

/** Cycle harness over the two fakes: real application, fake stores, no network. */
function harness(over: Partial<ForecastBaselineSnapshot> = {}) {
  let time = new Date(NOW);
  const now = (): Date => time;
  const cycle = new FakeCycleStore(
    [{ action: 'resume', capability: 'budget:paper', epoch: 1, id: 'intent', recordedAt: NOW }],
    now,
  );
  const store = new FakeForecastStore(cycle, now);
  store.baseline = patch(over);
  // Nothing to collect and nothing due: this suite is about the gate, not the arithmetic.
  const feeds: ForecastFeeds = {
    calculate: vi.fn(async () => []),
    resolve: vi.fn(async (c: Contract) => ({
      contractId: c.contractId,
      outcome: 'UP' as const,
      venue: c.venue,
    })),
  };
  return {
    cycle,
    feeds,
    store,
    job: (runId = 'run-1') =>
      runCycleJob({
        controlEpoch: 1,
        forecast: { feeds, store },
        mode: 'forecast',
        now,
        runId,
        sleep: async (ms) => {
          time = new Date(time.getTime() + ms);
        },
        store: cycle,
        ticks: 2,
      }),
  };
}

describe('restored baseline reconciliation before the first recording', () => {
  it('reconciles a restored, untouched baseline and reports what cycles already recorded', () => {
    const decision = evaluateForecastBaseline(reconciled);
    expect(decision).toMatchObject({ kind: 'reconciled', recordedByRuns: 0 });
    expect(decision.kind === 'reconciled' && decision.baseline.runId).toBe('restore-1');
    // After the first recording run there legitimately are cycle-recorded rows; that is
    // not a divergence, and the gate must keep passing.
    expect(
      evaluateForecastBaseline(
        patch({ cycleRows: { adoptedFromBaseline: 1200, recordedByRuns: 9 } }),
      ),
    ).toMatchObject({ kind: 'reconciled', recordedByRuns: 9 });
    // An empty database reconciles only because nothing claims to be restored there: zero
    // total equals zero attributed. It still needs a completed run to be a baseline.
    expect(
      evaluateForecastBaseline({
        completedRuns: reconciled.completedRuns,
        cycleRows: { adoptedFromBaseline: 0, recordedByRuns: 0 },
        forecastRows: { attributedToBaseline: 0, total: 0 },
        ledgerOrders: { attributedToBaseline: 0, total: 0 },
        ledgerState: { attributedToBaseline: 0, total: 0 },
        openRuns: 0,
      }),
    ).toMatchObject({ kind: 'reconciled' });
  });

  it('refuses every divergence, names them all at once, and never throws', () => {
    const cases: readonly (readonly [string, unknown, readonly string[]])[] = [
      ['no completed restore run', patch({ completedRuns: [] }), ['baseline-missing']],
      [
        'two completed restore runs',
        patch({
          completedRuns: [
            ...reconciled.completedRuns,
            { manifestDigest: 'sha256:other', runId: 'restore-2', schemaVersion: '0003' },
          ],
        }),
        ['baseline-ambiguous'],
      ],
      ['a restore run left open', patch({ openRuns: 1 }), ['baseline-incomplete']],
      [
        'paper balances changed',
        patch({ ledgerState: { attributedToBaseline: 7, total: 8 } }),
        ['paper-state-changed'],
      ],
      [
        'paper orders changed',
        patch({ ledgerOrders: { attributedToBaseline: 84, total: 85 } }),
        ['paper-orders-changed'],
      ],
      [
        'a restored forecast row removed',
        patch({ forecastRows: { attributedToBaseline: 1200, total: 1199 } }),
        ['forecast-baseline-changed'],
      ],
      [
        'more adopted overlay rows than the baseline has',
        patch({ cycleRows: { adoptedFromBaseline: 1201, recordedByRuns: 0 } }),
        ['baseline-adoption-exceeds-restored'],
      ],
      [
        'several at once, reported together in a fixed order',
        patch({
          completedRuns: [],
          ledgerOrders: { attributedToBaseline: 84, total: 90 },
          ledgerState: { attributedToBaseline: 7, total: 9 },
          openRuns: 2,
        }),
        ['baseline-missing', 'baseline-incomplete', 'paper-state-changed', 'paper-orders-changed'],
      ],
      // Unreadable shapes fail closed rather than reading as clean.
      ['not an object', 42, ['baseline-malformed']],
      ['null', null, ['baseline-malformed']],
      ['missing field', { completedRuns: [] }, ['baseline-malformed']],
      ['negative count', patch({ openRuns: -1 }), ['baseline-malformed']],
      [
        'fractional count',
        patch({ ledgerState: { attributedToBaseline: 7, total: 7.5 } }),
        ['baseline-malformed'],
      ],
      [
        'a run with an untrimmed id',
        patch({
          completedRuns: [
            { manifestDigest: 'sha256:manifest', runId: ' restore-1', schemaVersion: '0003' },
          ],
        }),
        ['baseline-malformed'],
      ],
      [
        'a run missing its digest',
        patch({
          completedRuns: [{ manifestDigest: '', runId: 'restore-1', schemaVersion: '0003' }],
        }),
        ['baseline-malformed'],
      ],
    ];
    for (const [name, snapshot, expected] of cases) {
      const decision = evaluateForecastBaseline(snapshot);
      expect(decision.kind, name).toBe('refused');
      expect(decision.kind === 'refused' && decision.divergences, name).toEqual(expected);
    }
    // Every documented code is reachable from the cases above, so the list is not
    // decoration, and no case invents a code outside it.
    const seen = new Set(
      cases.flatMap(([, snapshot]) => {
        const decision = evaluateForecastBaseline(snapshot);
        return decision.kind === 'refused' ? [...decision.divergences] : [];
      }),
    );
    expect([...seen].sort()).toEqual([...FORECAST_BASELINE_DIVERGENCES].sort());
  });

  it('refuses the run before any recording when the baseline does not reconcile', async () => {
    const h = harness({ ledgerOrders: { attributedToBaseline: 84, total: 85 } });
    const result = await h.job('run-unreconciled');
    expect(result).toMatchObject({
      baselineDivergences: ['paper-orders-changed'],
      outcome: 'refused',
      reason: 'forecast-baseline-unreconciled',
      ticksCompleted: 0,
    });
    // Nothing was collected, nothing recorded, nothing resolved, and the paper tables the
    // gate protects were never touched by this lane in the first place.
    expect(h.feeds.calculate).not.toHaveBeenCalled();
    expect(h.feeds.resolve).not.toHaveBeenCalled();
    expect(h.store.events).toHaveLength(0);
    expect(h.store.baselineReads).toBe(1);
    // The refusal is a complete run record with one outcome row, not a crash: the run id
    // is spent and the lease is released.
    expect(h.cycle.runRecords.get('run-unreconciled')).toMatchObject({
      outcome: 'refused',
      reason: 'forecast-baseline-unreconciled',
    });
    expect(h.cycle.outcomes).toHaveLength(1);
    expect(h.cycle.outcomes[0]).toMatchObject({
      intentId: 'intent',
      outcome: 'refused',
      reason: 'forecast-baseline-unreconciled',
    });
    expect(h.cycle.leases.get('budget:paper')?.expiresAt.getTime()).toBeLessThanOrEqual(
      NOW.getTime() + 1,
    );
  });

  it('runs the lane when the baseline reconciles, and reads the baseline first', async () => {
    const h = harness();
    const result = await h.job('run-ok');
    expect(result).toMatchObject({ outcome: 'applied', reason: 'forecast-run', ticksCompleted: 2 });
    expect(h.store.baselineReads).toBe(1);
    expect(h.feeds.calculate).toHaveBeenCalled();
  });

  it('keeps the earlier refusals ahead of the gate: pause, replay and a held lease', async () => {
    // Paused intent: the stronger statement wins and the baseline is never read.
    const paused = harness({ ledgerState: { attributedToBaseline: 7, total: 8 } });
    paused.cycle.intents.push({
      action: 'pause',
      capability: 'budget:paper',
      epoch: 1,
      id: 'intent-pause',
      recordedAt: new Date(NOW.getTime() + 1000),
    });
    expect(await paused.job('run-paused')).toMatchObject({
      outcome: 'refused',
      reason: 'intent-paused',
    });
    expect(paused.store.baselineReads).toBe(0);

    // Same run id twice: one record, and the retry does not reach the gate.
    const replay = harness();
    expect(await replay.job('run-same')).toMatchObject({ outcome: 'applied' });
    const readsAfterFirst = replay.store.baselineReads;
    expect(await replay.job('run-same')).toMatchObject({
      outcome: 'refused',
      reason: 'run-already-recorded',
      ticksCompleted: 0,
    });
    expect(replay.store.baselineReads).toBe(readsAfterFirst);
    expect(replay.cycle.runRecords.size).toBe(1);

    // Another owner holds the lease: no record is opened and the gate is not reached.
    const contended = harness();
    contended.cycle.seedLease({
      acquiredAt: NOW,
      capability: 'budget:paper',
      expiresAt: new Date(NOW.getTime() + 60_000),
      fencingToken: 9,
      heartbeatAt: NOW,
      owner: 'another-run',
    });
    expect(await contended.job('run-contended')).toMatchObject({
      outcome: 'refused',
      reason: 'lease-held',
    });
    expect(contended.store.baselineReads).toBe(0);
    expect(contended.cycle.runRecords.size).toBe(0);
  });

  it('reports the codes out of the job and keeps the lane off the paper tables', () => {
    // The refusal reason alone does not tell an operator which divergence refused the
    // run, so the entrypoint must put the codes on its one JSON line. The hosted vector
    // in checks/forecast-baseline-postgres.mjs asserts the printed line itself; this is
    // the cheap tripwire that the field is not dropped again.
    const entrypoint = readFileSync(join(import.meta.dirname, 'cycle', 'main.ts'), 'utf8');
    expect(entrypoint).toContain('baselineDivergences: result.baselineDivergences');
    // And nothing else about the baseline leaves the process: no snapshot, no count, no
    // row content.
    expect(entrypoint).not.toMatch(/readBaseline|ledger_state|ledger_order|forecastRows/u);

    // The forecast lane's own adapter may COUNT the paper tables for the gate and must
    // never write them. `engine_writer` holds `update` on both (migration 0002), so this
    // is a real boundary rather than a theoretical one, and the value-invariance vector
    // in checks/forecast-paper-invariance-postgres.mjs measures the same claim against a
    // real database.
    const adapter = readFileSync(
      join(import.meta.dirname, 'adapters', 'engine-store', 'postgres-forecast-store.ts'),
      'utf8',
    );
    for (const table of ['engine.ledger_state', 'engine.ledger_order']) {
      expect(adapter).toContain('from ' + table);
      for (const write of ['insert into ' + table, 'update ' + table, 'delete from ' + table])
        expect(adapter, `the forecast adapter must never ${write}`).not.toContain(write);
    }
  });

  it('places the gate before the tick loop and names its code in the runbook', () => {
    const application = readFileSync(join(import.meta.dirname, 'application', 'cycle.ts'), 'utf8');
    const gate = application.indexOf('evaluateForecastBaseline');
    const ticks = application.indexOf('// 6. The ticks.');
    expect(gate).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
    expect(gate, 'the baseline gate must run before the tick loop').toBeLessThan(ticks);
    // The reason code is part of the closed set and named by the forecast runbook, which
    // is the document an operator reads for this lane.
    expect(CYCLE_REASONS as readonly string[]).toContain('forecast-baseline-unreconciled');
    const runbook = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'operations', 'forecast-cycle.md'),
      'utf8',
    );
    expect(runbook).toContain('forecast-baseline-unreconciled');
    for (const divergence of FORECAST_BASELINE_DIVERGENCES)
      expect(runbook, `the runbook must name ${divergence}`).toContain(divergence);
  });
});
