// Remote CI only. The restored-baseline reconciliation gate against a real PostgreSQL 16
// instance, in its own disposable database inside the same disposable container.
//
// The pure decision is covered exhaustively offline (src/forecast-baseline.test.ts). What
// only a real database can answer is whether the adapter's one read-only statement counts
// the right columns: restored attribution (`restore_run_id`) against each table's total,
// and the overlay split between rows a restore adopted (`origin_restore_run_id`) and rows
// a cycle recorded (`origin_run_id`). A separate database is used so these vectors can
// own every row that decides the answer, and so they cannot perturb the lane contract
// that runs beside them.
import assert from 'node:assert/strict';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { evaluateForecastBaseline } from '../dist/domain/forecast-baseline.js';
import { createPostgresForecastStore } from '../dist/adapters/engine-store/postgres-forecast-store.js';

const MIGRATIONS = [
  '0001-identity-budgets-and-control.sql',
  '0002-engine-restore-tables.sql',
  '0003-ledger-order-position.sql',
  '0004-engine-cycle-lease-and-runs.sql',
  '0005-forecast-cycle-overlay.sql',
  '0006-paper-cycle-overlay.sql',
];
const DATABASE = 'mn_baseline_probe';
const BASE = 'probe-baseline';
const OTHER = 'probe-other';

/** @param {import('postgres').Sql} admin the superuser connection to the container */
/** @param {string} port the container's mapped loopback port */
export async function forecastBaselinePostgresContract(admin, port) {
  await admin.unsafe('create database ' + DATABASE);
  const probe = postgres('postgres://postgres@127.0.0.1:' + port + '/' + DATABASE, {
    max: 1,
    prepare: false,
  });
  // The lane reads the baseline as `engine_writer`, on the grants migration 0002 and 0005
  // already give that role. This vector fails if the check needed a new grant.
  const store = createPostgresForecastStore(
    'postgres://engine_writer@127.0.0.1:' + port + '/' + DATABASE,
  );
  try {
    for (const file of MIGRATIONS)
      await probe.unsafe(
        readFileSync('services/platform-api/migrations/' + file, 'utf8').replaceAll(
          ":'account_id'",
          "'synthetic-baseline-account'",
        ),
      );
    // One completed restore run owning every restored row, one cycle run, and an overlay
    // holding both kinds of origin. This is what a reconciled baseline looks like.
    await probe.unsafe(
      `insert into engine.restore_run(run_id,manifest_digest,manifest_key,schema_version,started_at,completed_at)
         values('${BASE}','probe-digest','probe-key','probe',now() - interval '2 hours',now() - interval '1 hour');
       insert into engine.ledger_state(key,value,restore_run_id)
         values('probe-a','{}','${BASE}'),('probe-b','{}','${BASE}');
       insert into engine.ledger_order(order_id,ledger_position,execution_mode,status,stake_cents,row,restore_run_id)
         values('probe-order-a',0,'paper','unfilled',100,'{}','${BASE}'),
               ('probe-order-b',0,'paper','unfilled',100,'{}','${BASE}');
       insert into engine.forecast_row(forecast_id,status,row,restore_run_id)
         values('probe-f-a','pending','{}','${BASE}'),
               ('probe-f-b','pending','{}','${BASE}'),
               ('probe-f-c','pending','{}','${BASE}');
       insert into engine.job_run_record(run_id,capability,mode,started_at,outcome,reason)
         values('probe-run','budget:paper','forecast',now(),'applied','forecast-run');
       insert into engine.forecast_cycle(asset,closes_at,first_run_id)
         values('BTC',now() + interval '15 minutes','probe-run');
       insert into engine.forecast_cycle_row(forecast_id,asset,closes_at,issued_at,status,row,origin_restore_run_id,last_run_id)
         values('probe-adopted','BTC',now() + interval '15 minutes',now(),'pending','{}','${BASE}','probe-run');
       insert into engine.forecast_cycle_row(forecast_id,asset,closes_at,issued_at,status,row,origin_run_id,last_run_id)
         values('probe-recorded-a','BTC',now() + interval '15 minutes',now(),'pending','{}','probe-run','probe-run'),
               ('probe-recorded-b','BTC',now() + interval '15 minutes',now(),'pending','{}','probe-run','probe-run');`,
    );
    const totals = async () =>
      (
        await probe.unsafe(
          `select (select count(*) from engine.ledger_state)::text a,
                  (select count(*) from engine.ledger_order)::text b,
                  (select count(*) from engine.forecast_row)::text c,
                  (select count(*) from engine.forecast_cycle_row)::text d`,
        )
      )[0];
    const before = await totals();

    // 1. The reconciled case, asserted field by field: the adapter must read exactly these
    //    counts, not merely enough of them to pass.
    const snapshot = await store.readBaseline();
    assert.deepEqual(snapshot, {
      completedRuns: [{ manifestDigest: 'probe-digest', runId: BASE, schemaVersion: 'probe' }],
      cycleRows: { adoptedFromBaseline: 1, recordedByRuns: 2 },
      forecastRows: { attributedToBaseline: 3, total: 3 },
      ledgerOrders: { attributedToBaseline: 2, total: 2 },
      ledgerState: { attributedToBaseline: 2, total: 2 },
      openRuns: 0,
    });
    assert.deepEqual(evaluateForecastBaseline(snapshot), {
      baseline: { manifestDigest: 'probe-digest', runId: BASE, schemaVersion: 'probe' },
      kind: 'reconciled',
      recordedByRuns: 2,
    });
    // Reading the baseline is a read: it writes nothing, on any table it counts.
    assert.deepEqual(await totals(), before);

    const divergences = async () => {
      const decision = evaluateForecastBaseline(await store.readBaseline());
      assert.equal(decision.kind, 'refused');
      return decision.divergences;
    };

    // 2. A second completed restore run, started earlier so the newest completed run — the
    //    one the statement selects — is still the baseline. The baseline is ambiguous and
    //    nothing else has moved.
    await probe.unsafe(
      `insert into engine.restore_run(run_id,manifest_digest,manifest_key,schema_version,started_at,completed_at)
         values('${OTHER}','other-digest','other-key','probe',now() - interval '3 hours',now() - interval '3 hours')`,
    );
    assert.deepEqual(await divergences(), ['baseline-ambiguous']);

    // 3. Rows the baseline restore did not load, one table at a time. Each must be counted
    //    in the table's total and not in its attributed count.
    await probe.unsafe(
      `insert into engine.ledger_state(key,value,restore_run_id) values('probe-c','{}','${OTHER}')`,
    );
    assert.deepEqual(await divergences(), ['baseline-ambiguous', 'paper-state-changed']);
    await probe.unsafe(
      `insert into engine.ledger_order(order_id,ledger_position,execution_mode,status,stake_cents,row,restore_run_id)
         values('probe-order-c',0,'paper','unfilled',100,'{}','${OTHER}')`,
    );
    assert.deepEqual(await divergences(), [
      'baseline-ambiguous',
      'paper-state-changed',
      'paper-orders-changed',
    ]);
    await probe.unsafe(
      `insert into engine.forecast_row(forecast_id,status,row,restore_run_id)
         values('probe-f-d','pending','{}','${OTHER}')`,
    );
    assert.deepEqual(await divergences(), [
      'baseline-ambiguous',
      'paper-state-changed',
      'paper-orders-changed',
      'forecast-baseline-changed',
    ]);

    // 4. Removing exactly those rows returns the snapshot to reconciled, so the vectors
    //    above moved the decision and nothing else did.
    await probe.unsafe(
      `delete from engine.forecast_row where restore_run_id='${OTHER}';
       delete from engine.ledger_order where restore_run_id='${OTHER}';
       delete from engine.ledger_state where restore_run_id='${OTHER}';
       delete from engine.restore_run where run_id='${OTHER}'`,
    );
    assert.equal(evaluateForecastBaseline(await store.readBaseline()).kind, 'reconciled');

    // 5. More adopted overlay rows than the baseline restored: overlay attribution
    //    contradicts the baseline even though every table total agrees.
    await probe.unsafe(
      `insert into engine.forecast_cycle_row(forecast_id,asset,closes_at,issued_at,status,row,origin_restore_run_id,last_run_id)
         select 'probe-adopted-'||i,'BTC',(select closes_at from engine.forecast_cycle limit 1),now(),'pending','{}','${BASE}','probe-run'
           from generate_series(1,3) i`,
    );
    assert.deepEqual(await divergences(), ['baseline-adoption-exceeds-restored']);
    await probe.unsafe(
      "delete from engine.forecast_cycle_row where forecast_id like 'probe-adopted-%'",
    );
    assert.equal(evaluateForecastBaseline(await store.readBaseline()).kind, 'reconciled');

    // 6. A restore run still open, and then no completed run at all. With no baseline the
    //    attributed counts collapse to zero, so every attribution divergence is reported
    //    together rather than one hiding the rest.
    await probe.unsafe(
      `insert into engine.restore_run(run_id,manifest_digest,manifest_key,schema_version,started_at)
         values('probe-open','open-digest','open-key','probe',now())`,
    );
    assert.deepEqual(await divergences(), ['baseline-incomplete']);
    await probe.unsafe("delete from engine.restore_run where run_id='probe-open'");
    await probe.unsafe(`update engine.restore_run set completed_at=null where run_id='${BASE}'`);
    assert.deepEqual(await divergences(), [
      'baseline-missing',
      'baseline-incomplete',
      'paper-state-changed',
      'paper-orders-changed',
      'forecast-baseline-changed',
      'baseline-adoption-exceeds-restored',
    ]);
    await probe.unsafe(`update engine.restore_run set completed_at=now() where run_id='${BASE}'`);
    assert.equal(evaluateForecastBaseline(await store.readBaseline()).kind, 'reconciled');
    console.log('Synthetic restored-baseline reconciliation contract passed.');
  } finally {
    await store.close();
    await probe.end({ timeout: 5 });
  }
}
