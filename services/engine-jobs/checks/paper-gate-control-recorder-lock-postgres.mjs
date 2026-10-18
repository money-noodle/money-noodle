// The REAL platform-API control recorder against the REAL gate writer, both taking the
// same per-capability advisory lock. No hand-written SQL stands in for either side's
// participation: this imports `createPostgresControlRecorder` and
// `createEngineRecorderClient` from platform-api's built output and calls `record()` with
// the real client options.
//
// Recorder participation was approved by Rai on 2026-10-18 as CODE AND TESTS ONLY. This
// contract proves CODE ORDERING in one process against one database. It is NOT a
// deployment and NOT activation, and current write admission remains unclaimed.
//
// A MEASURED BLOCKER, found here and recorded rather than worked around (vector 1): the
// recorder's shipped statement cannot execute at all under the role the schema grants it.
// `engine_control_recorder` holds `INSERT` and no `SELECT` (migration 0001), and
// PostgreSQL requires `SELECT` on every column named in `RETURNING`, so
// `insert ... returning id` is refused `42501` for that role. That is TRUE OF THE
// STATEMENT AT `b7bc42b`, BEFORE the advisory lock was added: vector 1 runs both forms
// side by side and both are refused identically, and both forms without `returning`
// succeed identically, so the lock change is privilege-neutral and the refusal is
// pre-existing. The minimum sufficient grant was measured separately on a disposable
// cluster — `grant select (id) on engine.control_intent to engine_control_recorder` makes
// the shipped statement succeed and leaves the role unable to read any other column — but
// that is a grant and migration change, and dropping `returning id` is an API/port-shape
// change; this batch is authorized for neither, so the blocker is asserted as a negative
// control here and left for the principal to decide.
//
// Because of that, vectors 2 and 3 construct the real recorder over the `engine_writer`
// connection string, which does hold `select` and `insert` on the one table. REAL
// adapter, REAL client factory, REAL statement, SUBSTITUTE ROLE — and the ordering they
// prove is the statement's, not the granted role's, which vector 1 shows cannot run it.
//
// Every wait is observed in `pg_locks` joined to `pg_stat_activity`, never timed with a
// sleep, with a real elapsed deadline so a failure cannot hang. Nothing is awaited inside
// a writer barrier.
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { createPostgresPaperGateWriter as createTestArtifactPaperGateWriter } from '../dist-test-support/adapters/engine-store/postgres-paper-gate-writer.js';
import { AUDITED_POLICY_FIXTURE } from '../dist-test-support/test-support/paper-gate-audited-policy-fixture.js';
import {
  CONTROL_WRITE_LOCK_NAMESPACE,
  createPostgresControlRecorder,
} from '../../platform-api/dist/adapters/engine-store/postgres-engine-store.js';
import { createEngineRecorderClient } from '../../platform-api/dist/adapters/engine-store/engine-query-client.js';

const CAPABILITY = 'budget:paper';
// Its own epoch band again, so this contract cannot disturb or be disturbed by another.
const EPOCH = 13;
const ACTOR = 'recorder-actor';
const BUDGET = ACTOR + ':paper';
const FUNDING = 'recorder-funding';
const OWNER = 'recorder-owner';
const TOKEN = 17n;
const RUN = 'root-paper-run';
const CONFIG_INTENT = 'recorder-config';
const GRANT_PROBE_ACTOR = 'recorder-grant-probe';
const GEN = 'recorder-generation';
const POLICY = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
const T_CONFIG = '2026-10-12 04:00:00.000000+00';
const OBSERVED_ISO = '2026-10-14T00:00:00.000Z';
const CONFIG = {
  paper_config_version: 1,
  budget_id: BUDGET,
  funding_id: FUNDING,
  total_cap_cents: 1000,
  entry_cap_cents: 200,
  kalshi_cap_cents: 500,
  polymarket_cap_cents: 0,
  kalshi_market_percent: 100,
  polymarket_market_percent: 0,
  paper_providers: 'kalshi',
  market_id: 'crypto-15m',
  policy_bundle: 'paper-v1-blend04-neutral-v7',
};
const GENERATION_INPUTS = {
  bundleId: 'paper-regime-historical-warm-lineage-v1',
  enabled: true,
  evidenceHalfLifeWindows: '2.5',
  minimumPolicyWindows: 4,
  pauseConfidence: '0.99',
  profileClaim: 'synthetic-recorder-profile',
  resumeConfidence: '0.75',
};

export async function paperGateControlRecorderLockPostgresContract(admin, port) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(/^\d+$/.test(String(port)));
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';
  // The role the schema actually grants the recorder, used for the grant negative control.
  const grantedRecorderUrl = 'postgres://engine_control_recorder@127.0.0.1:' + port + '/postgres';
  // The role the shipped statement can actually execute under, used for the ordering
  // vectors. See the header: this is a substitute ROLE, not a substitute adapter.
  const executableRecorderUrl = writerUrl;
  // The lock text both sides must derive identically. The engine owns the namespace and
  // platform-api duplicates the literal; this contract is what keeps them honest, because
  // a mismatch would stop either side ever being observed waiting on the other.
  const LOCK_TEXT = CONTROL_WRITE_LOCK_NAMESPACE + ':' + CAPABILITY;
  assert.equal(LOCK_TEXT, 'money-noodle/paper-gate-capability-write/v1:' + CAPABILITY);
  const scope = {
    budget_id: BUDGET,
    epoch: EPOCH,
    funding_id: FUNDING,
    generation_config_intent_id: CONFIG_INTENT,
    generation_key: GEN,
    sample_policy: POLICY,
  };
  const fence = { capability: CAPABILITY, owner: OWNER, fencingToken: TOKEN };
  const [band] = await admin.unsafe(
    'select count(*)::text as n from engine.control_intent where capability=$1 and epoch>=$2',
    [CAPABILITY, EPOCH],
  );
  assert.equal(band.n, '0');
  assert.equal((await admin.unsafe('select count(*)::text as n from engine.job_lease'))[0].n, '0');

  await admin.unsafe(
    'insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters) values($1,$2,$3,$4,$5,$6::text::timestamptz,$7,$8::text::jsonb)',
    [CONFIG_INTENT, CAPABILITY, 'configure', ACTOR, EPOCH, T_CONFIG, RUN, JSON.stringify(CONFIG)],
  );
  await admin.unsafe(
    'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$6,clock_timestamp())',
    [FUNDING, EPOCH, BUDGET, ACTOR, CONFIG_INTENT, RUN],
  );
  await admin.unsafe(
    'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$4,1000,700,300,0,0,4,$5,clock_timestamp())',
    [FUNDING, EPOCH, BUDGET, CONFIG_INTENT, RUN],
  );
  await admin.unsafe(
    "insert into engine.job_lease(capability,owner,fencing_token,acquired_at,expires_at,heartbeat_at) values($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp())",
    [CAPABILITY, OWNER, TOKEN.toString()],
  );

  const lockHolders = async () => {
    const [row] = await admin.unsafe(
      "select count(*)::text as n from pg_locks where locktype='advisory' and granted and classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and objid::bigint = (hashtextextended($1::text,0) & 4294967295)",
      [LOCK_TEXT],
    );
    return row.n;
  };
  /** Ungranted waiters on exactly this key, confirmed as lock waits in activity. */
  const lockWaiters = async () => {
    const [row] = await admin.unsafe(
      "select count(*)::text as n from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and l.classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and l.objid::bigint = (hashtextextended($1::text,0) & 4294967295) and a.wait_event_type='Lock'",
      [LOCK_TEXT],
    );
    return row.n;
  };
  const untilAtLeast = async (probe, wanted, label) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 4000) {
      if (Number(await probe()) >= wanted) return;
      await delay(25);
    }
    assert.fail('never observed ' + label);
  };
  const pauseCount = async () => {
    const [row] = await admin.unsafe(
      "select count(*)::text as n from engine.control_intent where capability=$1 and epoch=$2 and action='pause'",
      [CAPABILITY, EPOCH],
    );
    return row.n;
  };
  const eventCount = async (eventKey) => {
    const [row] = await admin.unsafe(
      'select count(*)::text as n from engine.paper_gate_phase_event where event_key=$1',
      [eventKey],
    );
    return row.n;
  };
  const locked = (effects) =>
    createTestArtifactPaperGateWriter(writerUrl, effects, AUDITED_POLICY_FIXTURE, {
      capabilityWriteLock: 'required',
    });
  const describe = (value) =>
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const genesisRequest = {
    coverageCutoffAtIso: OBSERVED_ISO,
    coverageReceiptId: 'recorder-receipt',
    evidenceObservedAtIso: OBSERVED_ISO,
    eventKey: 'recorder-genesis',
    generation: GENERATION_INPUTS,
    kind: 'initialize',
    runId: RUN,
    scope,
  };
  const evaluateAt = (eventKey, expectedRevision) => ({
    coverageCutoffAtIso: OBSERVED_ISO,
    coverageReceiptId: 'recorder-receipt',
    evidenceObservedAtIso: OBSERVED_ISO,
    eventKey,
    expectedRevision,
    kind: 'evaluate',
    runId: RUN,
    scope,
  });

  // The REAL recorder, twice over: the same adapter and the same client factory, once on
  // the granted role (vector 1, where it is refused) and once on a role that can execute
  // the statement (vectors 2 and 3).
  const grantedClient = createEngineRecorderClient(grantedRecorderUrl);
  const grantedRecorder = createPostgresControlRecorder({
    client: grantedClient,
    schema: 'engine',
  });
  const recorderClient = createEngineRecorderClient(executableRecorderUrl);
  const recorder = createPostgresControlRecorder({ client: recorderClient, schema: 'engine' });
  const recordPause = (id) =>
    recorder.record({
      action: 'pause',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: { recorded_by: id },
      recordedAt: new Date('2026-10-12T04:30:00.000Z'),
      runId: RUN,
    });

  try {
    // 0. The recorder's own session, as the real client configures it. Its wait on the
    // advisory lock is bounded only by whatever timeouts actually exist, so they are
    // MEASURED and recorded rather than assumed or invented.
    const [timeouts] = await admin.unsafe(
      "select (select setting from pg_settings where name='lock_timeout') as lock_timeout, (select setting from pg_settings where name='statement_timeout') as statement_timeout",
    );
    const recorderProbe = postgres(grantedRecorderUrl, { max: 1, prepare: false });
    let recorderTimeouts;
    try {
      const [row] = await recorderProbe.unsafe(
        'select current_setting($1) as lock_timeout, current_setting($2) as statement_timeout',
        ['lock_timeout', 'statement_timeout'],
      );
      recorderTimeouts = row;
    } finally {
      await recorderProbe.end({ timeout: 5 });
    }
    // Recorded as the measured fact it is: with both at '0' the recorder's advisory wait
    // is UNBOUNDED. No timeout is introduced here — that would be a configuration
    // contract change, which this batch is not authorized to make.
    assert.ok(typeof recorderTimeouts.lock_timeout === 'string');
    assert.ok(typeof recorderTimeouts.statement_timeout === 'string');
    assert.equal(timeouts.lock_timeout, recorderTimeouts.lock_timeout);

    // 1. GRANT NEGATIVE CONTROL. The role the schema grants the recorder cannot execute
    // the recorder's statement at all. First through the REAL adapter, which refuses.
    const probeRows = async () => {
      const [row] = await admin.unsafe(
        'select count(*)::text as n from engine.control_intent where actor=$1',
        [GRANT_PROBE_ACTOR],
      );
      return row.n;
    };
    const grantProbeIntent = {
      action: 'pause',
      actor: GRANT_PROBE_ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: null,
      recordedAt: new Date('2026-10-12T04:45:00.000Z'),
      runId: RUN,
    };
    const grantedAttempt = await grantedRecorder.record(grantProbeIntent).then(
      () => 'recorded',
      (error) => String(error && error.code),
    );
    // The port maps every driver error to one code, so a permission refusal arrives as
    // `engine-unreachable` and an operator could not tell the two apart from the port.
    // Recorded as measured, not changed: narrowing that mapping is an API-shape question.
    assert.equal(grantedAttempt, 'engine-unreachable');
    assert.equal(await probeRows(), '0');

    // Then the cause, isolated. Four statement forms on the SAME granted role and the
    // SAME real client: the `b7bc42b` form and the current locked form, each with and
    // without `returning id`. The two `returning` forms are refused identically and the
    // two without succeed identically, so the refusal is caused by `returning id` against
    // a role holding no `SELECT` — pre-existing, and unaffected by the lock. The SQL here
    // is deliberately hand-written because one of the forms no longer exists in the
    // source; the authoritative result for the shipped form is the adapter call above.
    const columns = '(capability, action, actor, epoch, recorded_at, run_id, parameters)';
    const target = '"engine"."control_intent"';
    const seven = [
      CAPABILITY,
      'pause',
      GRANT_PROBE_ACTOR,
      EPOCH,
      grantProbeIntent.recordedAt,
      RUN,
      null,
    ];
    const grantForms = [
      [
        'b7bc42b-values-returning',
        `insert into ${target} ${columns} values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        seven,
      ],
      [
        'locked-select-returning',
        `insert into ${target} ${columns} select $1, $2, $3, $4, $5, $6, $7 from pg_advisory_xact_lock(hashtextextended($8::text, 0)) returning id`,
        [...seven, LOCK_TEXT],
      ],
      [
        'b7bc42b-values-no-returning',
        `insert into ${target} ${columns} values ($1, $2, $3, $4, $5, $6, $7)`,
        seven,
      ],
      [
        'locked-select-no-returning',
        `insert into ${target} ${columns} select $1, $2, $3, $4, $5, $6, $7 from pg_advisory_xact_lock(hashtextextended($8::text, 0))`,
        [...seven, LOCK_TEXT],
      ],
    ];
    const grantOutcomes = {};
    for (const [label, text, values] of grantForms)
      grantOutcomes[label] = await grantedClient.query(text, values).then(
        () => 'accepted',
        (error) => String(error && error.code),
      );
    assert.deepEqual(grantOutcomes, {
      'b7bc42b-values-no-returning': 'accepted',
      'b7bc42b-values-returning': '42501',
      'locked-select-no-returning': 'accepted',
      'locked-select-returning': '42501',
    });
    // Exactly the two accepted forms landed, and the lock each statement took is gone
    // with that statement's implicit commit.
    assert.equal(await probeRows(), '2');
    assert.equal(await lockHolders(), '0');
    // The grant itself, read from the catalog rather than assumed from the migration.
    const [granted] = await admin.unsafe(
      "select has_table_privilege('engine_control_recorder','engine.control_intent','select')::text as can_select, has_table_privilege('engine_control_recorder','engine.control_intent','insert')::text as can_insert",
    );
    assert.deepEqual(
      { can_insert: granted.can_insert, can_select: granted.can_select },
      { can_insert: 'true', can_select: 'false' },
    );
    await admin.unsafe('delete from engine.control_intent where actor=$1', [GRANT_PROBE_ACTOR]);
    assert.equal(await probeRows(), '0');

    // 2. A locked genesis, so there is a generation and head to transition from.
    const genesisWriter = locked();
    try {
      const genesis = await genesisWriter.write(genesisRequest, fence);
      assert.equal(genesis.kind, 'written', describe(genesis));
      assert.equal(genesis.receipt.revisionAfter, 0n);
    } finally {
      await genesisWriter.close();
    }
    assert.equal(await lockHolders(), '0');

    // 3. WRITER FIRST, against the REAL recorder. The writer holds the session lock from
    // before `BEGIN` through commit; the real `record()` is started inside the barrier and
    // NOT awaited there, is observed as an ungranted advisory waiter, and its row stays
    // invisible until the writer finishes.
    let queued;
    let ownershipVerdict;
    let cleanup;
    const holder = locked({
      onWriteLockOwnership: (verdict) => {
        ownershipVerdict = verdict;
      },
      onWriteLockCleanup: (outcome) => {
        cleanup = outcome;
      },
      afterAuthorityRead: async () => {
        if (queued !== undefined) return;
        queued = recordPause('writer-first').catch((error) => ({
          error: String(error && error.code),
        }));
        await untilAtLeast(lockWaiters, 1, 'the real recorder waiting on the advisory key');
        assert.equal(await pauseCount(), '0');
      },
    });
    let written;
    try {
      written = await holder.write(evaluateAt('recorder-eval-a', 0n), fence);
    } finally {
      await Promise.allSettled([queued]);
      await holder.close();
    }
    assert.equal(written.kind, 'written', describe(written));
    // The fail-closed ownership check ran and passed on this direct endpoint.
    assert.deepEqual(ownershipVerdict, { ok: true });
    assert.equal(cleanup, 'released');
    // The event bound the intent that was standing BEFORE the pause, read from the row.
    const [bound] = await admin.unsafe(
      'select latest_intent_id, current_effect_config_intent_id from engine.paper_gate_phase_event where event_key=$1',
      ['recorder-eval-a'],
    );
    assert.equal(bound.latest_intent_id, CONFIG_INTENT);
    assert.equal(bound.current_effect_config_intent_id, CONFIG_INTENT);
    // The real recorder then resolved with an id of its own.
    const recorded = await queued;
    assert.equal(typeof recorded.id, 'string', describe(recorded));
    assert.ok(recorded.id.length > 0);
    assert.equal(await pauseCount(), '1');
    assert.equal(await lockHolders(), '0');
    // And the next write sees that pause.
    const afterPause = locked();
    try {
      const refused = await afterPause.write(evaluateAt('recorder-eval-b', 1n), fence);
      assert.deepEqual(
        { detail: refused.detail, kind: refused.kind, reason: refused.reason },
        { detail: 'paused', kind: 'refused', reason: 'authority' },
      );
    } finally {
      await afterPause.close();
    }
    await admin.unsafe(
      "delete from engine.control_intent where capability=$1 and epoch=$2 and action='pause'",
      [CAPABILITY, EPOCH],
    );

    // 4. RECORDER FIRST. The real adapter autocommits its single statement, so holding its
    // transaction open through it is impossible by construction. Instead a THIRD session
    // holds the key, both participants queue behind it as observed waiters, and the
    // release lets PostgreSQL grant them in queue order: the recorder was first, so it
    // inserts and commits first, and the writer then snapshots after its own wait.
    const blocker = postgres('postgres://postgres@127.0.0.1:' + port + '/postgres', {
      max: 1,
      prepare: false,
      connection: { statement_timeout: 20000 },
    });
    let recorderFirst;
    let writerAfter;
    let bothObserved = false;
    try {
      await blocker.unsafe('select pg_advisory_lock(hashtextextended($1::text,0))', [LOCK_TEXT]);
      assert.equal(await lockHolders(), '1');
      recorderFirst = recordPause('recorder-first').catch((error) => ({
        error: String(error && error.code),
      }));
      await untilAtLeast(lockWaiters, 1, 'the real recorder queued behind the third session');
      assert.equal(await pauseCount(), '0');
      const queuedWriter = locked();
      try {
        writerAfter = queuedWriter.write(evaluateAt('recorder-eval-c', 1n), fence);
        await untilAtLeast(lockWaiters, 2, 'the writer queued behind the recorder');
        bothObserved = true;
      } finally {
        // Release only after BOTH waits were observed, so the queue order is the one
        // asserted below and not a race.
        await blocker.unsafe('select pg_advisory_unlock(hashtextextended($1::text,0))', [
          LOCK_TEXT,
        ]);
        const result = await writerAfter;
        await queuedWriter.close();
        writerAfter = result;
      }
    } finally {
      await blocker.end({ timeout: 5 });
    }
    assert.equal(bothObserved, true);
    const recordedFirst = await recorderFirst;
    assert.equal(typeof recordedFirst.id, 'string', describe(recordedFirst));
    assert.equal(await pauseCount(), '1');
    // The recorder was granted first, so the writer snapshotted after its wait and saw
    // the pause: refused, with nothing written.
    assert.deepEqual(
      { detail: writerAfter.detail, kind: writerAfter.kind, reason: writerAfter.reason },
      { detail: 'paused', kind: 'refused', reason: 'authority' },
    );
    assert.equal(await eventCount('recorder-eval-c'), '0');
    assert.equal(await lockHolders(), '0');

    // 5. A host this project KNOWS multiplexes sessions refuses `required` mode BEFORE
    // anything is acquired or connected, so a pooled endpoint can never carry this
    // protocol. An unclassified host is not thereby proven direct; that stays an explicit
    // wiring prerequisite.
    const pooled = createTestArtifactPaperGateWriter(
      'postgres://engine_writer@ep-synthetic-1234-pooler.eu-central-1.aws.neon.tech:5432/postgres',
      undefined,
      AUDITED_POLICY_FIXTURE,
      { capabilityWriteLock: 'required' },
    );
    try {
      const refused = await pooled.write(evaluateAt('recorder-eval-pooled', 1n), fence);
      assert.deepEqual(
        { detail: refused.detail, kind: refused.kind, reason: refused.reason },
        { detail: 'write-lock-endpoint-pooled', kind: 'refused', reason: 'conflict' },
      );
      assert.equal(await lockHolders(), '0');
    } finally {
      await pooled.close();
    }
    return {
      grantedRoleCanSelect: granted.can_select,
      grantedRoleStatementOutcomes: grantOutcomes,
      recorderLockTimeout: String(recorderTimeouts.lock_timeout),
      recorderStatementTimeout: String(recorderTimeouts.statement_timeout),
    };
  } finally {
    await recorderClient.close();
    await grantedClient.close();
    await admin.unsafe('delete from engine.control_intent where actor=$1', [GRANT_PROBE_ACTOR]);
    await admin.unsafe('delete from engine.paper_gate_head where generation_key=$1', [GEN]);
    await admin.unsafe('delete from engine.paper_gate_phase_event where generation_key=$1', [GEN]);
    await admin.unsafe('delete from engine.paper_gate_generation where generation_key=$1', [GEN]);
    await admin.unsafe('delete from engine.paper_budget_root where funding_id=$1', [FUNDING]);
    await admin.unsafe('delete from engine.paper_funding_root where funding_id=$1', [FUNDING]);
    await admin.unsafe('delete from engine.control_intent where capability=$1 and epoch>=$2', [
      CAPABILITY,
      EPOCH,
    ]);
    await admin.unsafe('delete from engine.job_lease where capability=$1', [CAPABILITY]);
  }
  // Both sides take the same key, proved by each being observed waiting on the other's
  // hold with the REAL adapters. That is CODE ORDERING in one process against one
  // database, under a role that can execute the statement. It is not a deployment:
  // current write admission still needs the engine writer running `required` on a DIRECT
  // endpoint, the recorder build live, and — per vector 1 — a principal decision on the
  // `returning id` / `select` grant conflict that today refuses the granted role.
}
