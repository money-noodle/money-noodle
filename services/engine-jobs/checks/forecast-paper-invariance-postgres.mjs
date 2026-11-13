// Remote CI only. Does a real forecast cycle leave the excluded paper balances and orders
// byte-for-byte unchanged?
//
// The runtime baseline gate counts attribution (`restore_run_id`), and a count is not an
// answer to that question: a row updated in place keeps both its count and its
// attribution. `engine_writer` holds `update` on `engine.ledger_state` and
// `engine.ledger_order` (migration 0002), so the possibility is real and has to be
// measured rather than argued. This vector therefore seeds NONZERO balances and orders
// with meaningful content, runs the real lane through the real adapters until it actually
// records and resolves, and compares every column of those rows before and after —
// including through a same-run-id replay and a paused control. It then mutates one value
// in place, with the count and the attribution untouched, to show that the comparison
// catches what the count-based gate cannot.
//
// Two different claims are kept apart on purpose:
//   (1) the cycle changes nothing in the paper tables — what this file proves;
//   (2) the restored contents equal the source archive's — NOT proven here, and not
//       provable from inside this job today. See the record in docs/validation.
import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { evaluateForecastBaseline } from '../dist/domain/forecast-baseline.js';
import { createPostgresForecastStore } from '../dist/adapters/engine-store/postgres-forecast-store.js';
import { createPostgresCycleStore } from '../dist/adapters/engine-store/postgres-cycle-store.js';
import { runCycleJob } from '../dist/application/cycle.js';

const MIGRATIONS = [
  '0001-identity-budgets-and-control.sql',
  '0002-engine-restore-tables.sql',
  '0003-ledger-order-position.sql',
  '0004-engine-cycle-lease-and-runs.sql',
  '0005-forecast-cycle-overlay.sql',
  '0006-paper-cycle-overlay.sql',
];
const DATABASE = 'mn_paper_invariance_probe';
const RESTORE = 'inv-restore';
/** New recording requires the current Polymarket 15-minute target, whose slug carries
 * the `-updown-15m-` identity the model checks. */
const SLUG = 'btc-updown-15m-inv';
// The lease rows are checked against the database clock, and the forecast model only
// accepts the CURRENT 15-minute target, so both ends of the fixture are derived from the
// real clock rather than frozen: the recorded observation is issued against the next
// quarter-hour boundary, and the restored row closed two boundaries ago so it is already
// due for resolution on the first tick.
const quarterHour = 900000;
/** The next quarter-hour boundary at least a minute away, so a tick cannot cross it, and
 * a close two boundaries before it, which is therefore already past. */
const boundaries = () => {
  const open = new Date(Math.ceil((Date.now() + 60000) / quarterHour) * quarterHour);
  return {
    due: new Date(open.getTime() - 2 * quarterHour).toISOString(),
    open: open.toISOString(),
  };
};
const closes = Array.from({ length: 121 }, (_, i) => 100 * Math.exp(0.001 * Math.sin(i)));

/** The restored paper balances. Nonzero, and the kind of content a value comparison can
 * actually fail on: cents, counters and an identifier, not an empty object. */
const BALANCES = [
  [
    'paper-bankroll',
    {
      cashCents: 1234567,
      equityCents: 2345678,
      openRiskCents: 45600,
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  [
    'paper-persistence',
    { consecutiveLosses: 3, dailyRealizedCents: -8900, lastSettledOrderId: 'inv-order-2' },
  ],
];
/** The restored paper orders, with content on the row as well as in the columns. */
const ORDERS = [
  {
    evidence_row_key: 'batch-a/0',
    evidence_sha256: 'a'.repeat(64),
    ledger_position: 0,
    mirror_pair_id: 'mirror-1',
    order_id: 'inv-order-1',
    paper_bankroll_id: 'bankroll-1',
    pnl_cents: 918,
    row: {
      feeRate: 0.02,
      filledAt: '2026-11-01T00:01:00.000Z',
      price: 0.47,
      side: 'UP',
      symbol: 'BTC',
    },
    stake_cents: 4200,
    status: 'filled',
  },
  {
    evidence_row_key: 'batch-a/1',
    evidence_sha256: 'b'.repeat(64),
    ledger_position: 0,
    mirror_pair_id: 'mirror-2',
    order_id: 'inv-order-2',
    paper_bankroll_id: 'bankroll-1',
    pnl_cents: -1375,
    row: {
      feeRate: 0.02,
      filledAt: '2026-11-01T00:02:00.000Z',
      price: 0.53,
      side: 'DOWN',
      symbol: 'BTC',
    },
    stake_cents: 13750,
    status: 'filled',
  },
];

const forecastRow = (id, closesAt) => ({
  basisProbabilityUp: 0.6,
  calibrationReplay: {},
  candidateEvaluation: [],
  closesAt,
  confidence: 0.7,
  direction: 'UP',
  id,
  issuedAt: new Date(Date.parse(closesAt) - 900000).toISOString(),
  marketUrl: 'https://polymarket.com/event/' + SLUG,
  modelVersion: 'test',
  probabilityUp: 0.6,
  qualified: true,
  slowTiltLogOdds: 0,
  status: 'pending',
  symbol: 'BTC',
  venueContracts: {},
});

/** @param {import('postgres').Sql} admin superuser connection to the container */
/** @param {string} port the container's mapped loopback port */
export async function forecastPaperInvariancePostgresContract(admin, port) {
  const { due: DUE_CLOSE } = boundaries();
  await admin.unsafe('create database ' + DATABASE);
  const probe = postgres('postgres://postgres@127.0.0.1:' + port + '/' + DATABASE, {
    max: 1,
    prepare: false,
  });
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/' + DATABASE;
  const forecastStore = createPostgresForecastStore(writerUrl);
  const cycleStore = createPostgresCycleStore(writerUrl);
  try {
    for (const file of MIGRATIONS)
      await probe.unsafe(
        readFileSync('services/platform-api/migrations/' + file, 'utf8').replaceAll(
          ":'account_id'",
          "'synthetic-invariance-account'",
        ),
      );
    await probe.unsafe(
      `insert into engine.restore_run(run_id,manifest_digest,manifest_key,schema_version,started_at,completed_at)
         values('${RESTORE}','inv-digest','inv-key','inv',now() - interval '2 hours',now() - interval '1 hour')`,
    );
    for (const [key, value] of BALANCES)
      await probe.unsafe(
        'insert into engine.ledger_state(key,value,restore_run_id) values($1,$2::text::jsonb,$3)',
        [key, JSON.stringify(value), RESTORE],
      );
    for (const o of ORDERS)
      await probe.unsafe(
        `insert into engine.ledger_order(order_id,ledger_position,execution_mode,status,stake_cents,
           pnl_cents,paper_bankroll_id,mirror_pair_id,evidence_sha256,evidence_row_key,row,restore_run_id)
         values($1,$2,'paper',$3,$4,$5,$6,$7,$8,$9,$10::text::jsonb,$11)`,
        [
          o.order_id,
          o.ledger_position,
          o.status,
          o.stake_cents,
          o.pnl_cents,
          o.paper_bankroll_id,
          o.mirror_pair_id,
          o.evidence_sha256,
          o.evidence_row_key,
          JSON.stringify(o.row),
          RESTORE,
        ],
      );
    // Paper provider enabled by the restored controls, so the lane has a venue to work
    // on; a provider record is not execution authority (see the forecast runbook).
    await probe.unsafe(
      'insert into engine.provider_registry(provider_id,record,restore_run_id) values($1,$2::text::jsonb,$3)',
      ['polymarket', JSON.stringify({ paperEnabled: true }), RESTORE],
    );
    // One restored forecast row, already past its close, with a provenance record its
    // resolution target validates against.
    // The restored row carries a slim `{registryId}` reference, and the adapter rehydrates
    // it from `engine.contract_provenance`. That record has to be canonical or the
    // resolution is disposed of as `missing-provenance` instead of resolving, so it is
    // built exactly the way the existing provenance contract requires — the field order,
    // the fingerprint over the canonical record and the registry id derived from it are
    // that contract's, not a new scheme introduced here.
    const fields = {
      venue: 'polymarket',
      contractId: 'inv-contract',
      marketUrl: 'https://polymarket.com/event/' + SLUG,
      closesAt: DUE_CLOSE,
      rulesSource: 'https://gamma-api.polymarket.com/events?slug=' + SLUG,
      rulesText: 'Simple average of the final minute',
      settlementPriceMethod: 'simple-average',
      referenceWindowSeconds: 60,
      settlementWindowSeconds: 60,
      comparability: 'approximate',
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const contract = {
      version: 'contract-provenance-v1',
      registryId: 'polymarket:' + fields.contractId + ':' + fingerprint,
      ...fields,
      rulesFingerprint: fingerprint,
      slug: SLUG,
    };
    await probe.unsafe(
      'insert into engine.contract_provenance(registry_id,record,restore_run_id) values($1,$2::text::jsonb,$3)',
      [contract.registryId, JSON.stringify(contract), RESTORE],
    );
    const seed = {
      ...forecastRow('inv-seed', DUE_CLOSE),
      venueContracts: { polymarket: { registryId: contract.registryId } },
    };
    await probe.unsafe(
      "insert into engine.forecast_row(forecast_id,status,row,restore_run_id) values('inv-seed','pending',$1::text::jsonb,$2)",
      [JSON.stringify(seed), RESTORE],
    );
    await probe.unsafe(
      `insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters)
         values('inv-resume','budget:paper','resume','synthetic-principal',1,now() - interval '30 minutes','inv-seed-run',null)`,
    );

    /** Every column of both paper tables, jsonb rendered as text so a value difference
     * is a string difference. This is the comparison the acceptance item needs. */
    const paperRows = async () => ({
      orders: await probe.unsafe(
        `select order_id,ledger_position,execution_mode,status,strategy_id,stake_cents::text,
                pnl_cents::text,paper_bankroll_id,mirror_pair_id,evidence_sha256,evidence_row_key,
                row::text as row_text,restore_run_id
           from engine.ledger_order order by order_id,ledger_position`,
      ),
      state: await probe.unsafe(
        `select key,value::text as value_text,restore_run_id
           from engine.ledger_state order by key`,
      ),
    });
    const counts = async () =>
      (
        await probe.unsafe(
          `select (select count(*) from engine.ledger_state)::text s,
                  (select count(*) from engine.ledger_order)::text o,
                  (select count(*) from engine.ledger_state where restore_run_id='${RESTORE}')::text sa,
                  (select count(*) from engine.ledger_order where restore_run_id='${RESTORE}')::text oa`,
        )
      )[0];
    const before = await paperRows();
    const countsBefore = await counts();
    // The fixture is nonzero and has content: a comparison against empty rows would pass
    // for the wrong reason.
    assert.equal(before.state.length, 2);
    assert.equal(before.orders.length, 2);
    assert.ok(
      before.state.every((r) => r.value_text.length > 2),
      'seeded balances must carry content',
    );
    assert.ok(
      before.orders.every((r) => Number(r.stake_cents) > 0 && r.row_text.length > 2),
      'seeded orders must carry nonzero stakes and content',
    );

    const feeds = {
      // The model accepts a calculation at most 15 seconds old and a close strictly in
      // the future, so both are taken at call time rather than when the fixture was
      // built.
      calculate: async () => [
        {
          asset: 'BTC',
          calculatedAt: new Date().toISOString(),
          change1h: 0.8,
          change24h: 1,
          change30d: 2,
          change1y: 10,
          closesAt: boundaries().open,
          coinPrice: 100,
          currentPrice: 101,
          high24h: 105,
          low24h: 95,
          minuteCloses: closes,
          newsScores: [0.5],
          oracleHistory: [],
          quotes: [
            {
              askDown: 0.52,
              askUp: 0.5,
              contract: {
                closesAt: boundaries().open,
                contractId: 'inv-open-contract',
                slug: SLUG,
                venue: 'polymarket',
              },
              probabilityUp: 0.6,
            },
          ],
          referencePrice: 100,
          relevantNewsCount: 1,
          seasonalReturns: [2, 3],
        },
      ],
      resolve: async (c) => ({ contractId: c.contractId, outcome: 'UP', venue: c.venue }),
    };
    const run = (runId) =>
      runCycleJob({
        controlEpoch: 1,
        forecast: { feeds, store: forecastStore },
        mode: 'forecast',
        now: () => new Date(),
        runId,
        sleep: async () => undefined,
        store: cycleStore,
        ticks: 1,
      });

    // 1. A real cycle that really records and really resolves.
    const applied = await run('inv-run-1');
    assert.deepEqual(
      { outcome: applied.outcome, reason: applied.reason, ticks: applied.ticksCompleted },
      { outcome: 'applied', reason: 'forecast-run', ticks: 1 },
      'the lane must actually run',
    );
    const [recorded] = await probe.unsafe(
      `select (select count(*) from engine.forecast_cycle_row where origin_run_id='inv-run-1')::text new_rows,
              (select count(*) from engine.forecast_oracle_sample where run_id='inv-run-1')::text samples,
              (select count(*) from engine.forecast_cycle_row
                where forecast_id='inv-seed' and origin_restore_run_id='${RESTORE}' and status='resolved')::text resolved`,
    );
    assert.deepEqual(
      recorded,
      { new_rows: '1', resolved: '1', samples: '1' },
      'the cycle must have recorded an observation and resolved the restored row',
    );
    assert.deepEqual(await paperRows(), before, 'a recording cycle must not touch paper rows');

    // 2. The same run id again: refused, and still nothing moves.
    const replay = await run('inv-run-1');
    assert.deepEqual(
      { outcome: replay.outcome, reason: replay.reason, ticks: replay.ticksCompleted },
      { outcome: 'refused', reason: 'run-already-recorded', ticks: 0 },
    );
    assert.deepEqual(await paperRows(), before, 'a replayed run must not touch paper rows');

    // 3. A paused control: refused ahead of the lane, and still nothing moves.
    await probe.unsafe(
      `insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters)
         values('inv-pause','budget:paper','pause','synthetic-principal',1,now(),'inv-pause-run',null)`,
    );
    const paused = await run('inv-run-2');
    assert.deepEqual(
      { outcome: paused.outcome, reason: paused.reason, ticks: paused.ticksCompleted },
      { outcome: 'refused', reason: 'intent-paused', ticks: 0 },
    );
    assert.deepEqual(await paperRows(), before, 'a paused run must not touch paper rows');
    // The pause intent stays: the refusal recorded an outcome row that references it, and
    // nothing after this point runs the cycle again.

    // 4. The discriminating mutation. One balance and one order are edited IN PLACE:
    //    the row counts and every `restore_run_id` stay exactly as they were, so the
    //    count-based gate has nothing to see. The comparison above must still catch it,
    //    and the gate must still say `reconciled` — that gap is the point of this step.
    await probe.unsafe(
      `update engine.ledger_state
          set value=jsonb_set(value,'{cashCents}','1234568'::jsonb)
        where key='paper-bankroll'`,
    );
    await probe.unsafe(
      `update engine.ledger_order
          set stake_cents=4201, row=jsonb_set(row,'{price}','0.48'::jsonb)
        where order_id='inv-order-1'`,
    );
    const mutated = await paperRows();
    assert.deepEqual(await counts(), countsBefore, 'the mutation must not change any count');
    assert.deepEqual(
      mutated.state
        .map((r) => r.restore_run_id)
        .concat(mutated.orders.map((r) => r.restore_run_id)),
      before.state.map((r) => r.restore_run_id).concat(before.orders.map((r) => r.restore_run_id)),
      'the mutation must not change any attribution',
    );
    assert.throws(
      () => assert.deepEqual(mutated, before),
      /AssertionError/,
      'the value comparison must fail on an in-place edit — otherwise it proves nothing',
    );
    const blindSpot = evaluateForecastBaseline(await forecastStore.readBaseline());
    assert.equal(
      blindSpot.kind,
      'reconciled',
      'measured gap: the count-based gate cannot see an in-place value edit',
    );
    // Put the fixture back and prove the comparison is two-sided.
    await probe.unsafe(
      `update engine.ledger_state
          set value=jsonb_set(value,'{cashCents}','1234567'::jsonb)
        where key='paper-bankroll'`,
    );
    await probe.unsafe(
      `update engine.ledger_order
          set stake_cents=4200, row=jsonb_set(row,'{price}','0.47'::jsonb)
        where order_id='inv-order-1'`,
    );
    assert.deepEqual(await paperRows(), before, 'the restored fixture must compare equal again');
    console.log(
      'Synthetic paper-row value invariance across recording, replay and pause verified; ' +
        'count-only gate blind spot to in-place edits measured.',
    );
  } finally {
    await forecastStore.close();
    await cycleStore.close();
    await probe.end({ timeout: 5 });
  }
}
