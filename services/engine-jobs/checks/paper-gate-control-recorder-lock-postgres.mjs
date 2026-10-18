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
// the shipped statement succeed — but that grant is NOT restricted to the role's own
// inserted rows: a column privilege lets it read `id` for every row of the table. It is a
// grant and migration change, dropping `returning id` is an API/port-shape change, and a
// third option (generate the id in the API, response shape unchanged, no extra grant) is
// PROPOSED AND NOT APPROVED. This batch is authorized for none of them, so the blocker is
// asserted as a negative control here and left for the principal to decide.
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

  // The application name the REAL recorder's own client factory sets, which is how a
  // waiter is identified as the recorder rather than merely counted.
  const RECORDER_APP = 'platform-api-control-recorder';
  // How long an observation may take to appear. This is the EXISTING harness budget for
  // these vectors; it is a TEST bound only.
  const OBSERVATION_BUDGET_MS = 4000;
  // And a per-query bound DERIVED from it rather than from any production setting: one
  // probe may not consume more than half the budget it is polling inside. Applied with
  // `set local`, so it lives and dies with the probe's own transaction and changes no
  // session, role or production default. No production timeout is introduced anywhere by
  // this contract — the recorder's own wait is measured as unbounded and left that way.
  const PROBE_STATEMENT_TIMEOUT_MS = OBSERVATION_BUDGET_MS / 2;
  const observe = (text, values) =>
    admin.begin(async (tx) => {
      await tx.unsafe('set local statement_timeout = ' + PROBE_STATEMENT_TIMEOUT_MS, []);
      return tx.unsafe(text, values);
    });
  const lockHolders = async () => {
    const [row] = await observe(
      "select count(*)::text as n from pg_locks where locktype='advisory' and granted and classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and objid::bigint = (hashtextextended($1::text,0) & 4294967295)",
      [LOCK_TEXT],
    );
    return row.n;
  };
  /** Ungranted waiters on exactly this key, confirmed as lock waits in activity. */
  const lockWaiters = async () => {
    const [row] = await observe(
      "select count(*)::text as n from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and l.classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and l.objid::bigint = (hashtextextended($1::text,0) & 4294967295) and a.wait_event_type='Lock'",
      [LOCK_TEXT],
    );
    return row.n;
  };
  /** The same, narrowed to the REAL recorder's own session by application name, so the
   * identity of the waiter is asserted and not inferred from a count. */
  const recorderLockWaiters = async () => {
    const [row] = await observe(
      "select count(*)::text as n from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and l.classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and l.objid::bigint = (hashtextextended($1::text,0) & 4294967295) and a.wait_event_type='Lock' and a.application_name=$2",
      [LOCK_TEXT, RECORDER_APP],
    );
    return row.n;
  };
  /** Who is actually waiting: backend pid, role and application name, from the catalog. */
  const waiterIdentities = async () =>
    observe(
      "select a.pid::text as pid, a.usename as role, a.application_name as app, a.wait_event_type as wait_type from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and l.classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and l.objid::bigint = (hashtextextended($1::text,0) & 4294967295) and a.wait_event_type='Lock' order by a.application_name asc, a.pid asc",
      [LOCK_TEXT],
    );
  const untilAtLeast = async (probe, wanted, label) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < OBSERVATION_BUDGET_MS) {
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
    // And a failure-path regression for the observer bound this contract adds, so the
    // bound is proven to be in effect rather than merely written: a probe that outlasts
    // PROBE_STATEMENT_TIMEOUT_MS is cancelled with 57014 instead of hanging. This bounds
    // the TEST observer only — it is applied with `set local` inside the probe's own
    // transaction and changes no production setting, role or default.
    const probeBound = await observe(
      'select pg_sleep(' + (PROBE_STATEMENT_TIMEOUT_MS / 1000 + 1) + ')',
      [],
    ).then(
      () => 'not-bounded',
      (error) => String(error && error.code),
    );
    assert.equal(probeBound, '57014');

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
    let writerFirstWaiters;
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
        await untilAtLeast(recorderLockWaiters, 1, 'the real recorder waiting on the advisory key');
        // Not a count: the waiter's own backend pid, role and application name, read from
        // the catalog while it is genuinely blocked on THIS key.
        writerFirstWaiters = await waiterIdentities();
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
    // Exactly one waiter was observed, it was the REAL recorder's own session, and it was
    // waiting on a lock — pid, role and application name, not a timer.
    assert.equal(writerFirstWaiters.length, 1, describe(writerFirstWaiters));
    assert.equal(writerFirstWaiters[0].app, RECORDER_APP);
    assert.equal(writerFirstWaiters[0].wait_type, 'Lock');
    assert.ok(/^\d+$/.test(String(writerFirstWaiters[0].pid)), describe(writerFirstWaiters));
    // The substitute ROLE is asserted, so the limit is in the evidence and not only in
    // the prose: this is `engine_writer`, because vector 1 showed the granted recorder
    // role cannot execute the statement at all.
    assert.equal(writerFirstWaiters[0].role, 'engine_writer');
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
    let writerSettled;
    let queuedWriter;
    let pendingWrite;
    let bothObserved = false;
    let queuedIdentities;
    let keyReleased = false;
    // Idempotent: a second call after a mid-vector failure is a no-op rather than a
    // second unlock that would report false and raise over the real failure.
    const releaseKey = async () => {
      if (keyReleased) return;
      keyReleased = true;
      await blocker.unsafe('select pg_advisory_unlock(hashtextextended($1::text,0))', [LOCK_TEXT]);
    };
    try {
      await blocker.unsafe('select pg_advisory_lock(hashtextextended($1::text,0))', [LOCK_TEXT]);
      assert.equal(await lockHolders(), '1');
      // Settle-shaped, so a rejection becomes data instead of an unhandled rejection that
      // could surface over the assertions below.
      recorderFirst = recordPause('recorder-first').then(
        (recorded) => ({ recorded }),
        (error) => ({ error: String(error && error.code) }),
      );
      await untilAtLeast(
        recorderLockWaiters,
        1,
        'the real recorder, by application name, queued behind the third session',
      );
      assert.equal(await pauseCount(), '0');
      queuedWriter = locked();
      pendingWrite = queuedWriter.write(evaluateAt('recorder-eval-c', 1n), fence).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      await untilAtLeast(lockWaiters, 2, 'the writer queued behind the recorder');
      queuedIdentities = await waiterIdentities();
      bothObserved = true;
      // Released only after BOTH waits were observed, so the queue order asserted below
      // is the one PostgreSQL granted and not a race — and released BEFORE anything is
      // awaited, so no queued participant is ever awaited while the key is still held.
      await releaseKey();
      writerSettled = await pendingWrite;
    } finally {
      // Cleanup in this order on EVERY path, including an assertion failure above: free
      // the key first so neither queued participant can be stuck, then let both settle,
      // then close every handle. Nothing here throws over the primary failure.
      await releaseKey().catch(() => undefined);
      await Promise.allSettled([pendingWrite, recorderFirst]);
      if (queuedWriter !== undefined) await queuedWriter.close().catch(() => undefined);
      await blocker.end({ timeout: 5 });
    }
    assert.equal(bothObserved, true);
    // Two waiters, exactly one of them the REAL recorder's own session, so the second is
    // the writer and not a second recorder — identity, not arithmetic on a count.
    assert.equal(queuedIdentities.length, 2, describe(queuedIdentities));
    assert.equal(
      queuedIdentities.filter((row) => row.app === RECORDER_APP).length,
      1,
      describe(queuedIdentities),
    );
    assert.deepEqual(
      [...new Set(queuedIdentities.map((row) => row.wait_type))],
      ['Lock'],
      describe(queuedIdentities),
    );
    // The queued write resolved rather than rejected, and its rejection would be reported
    // here instead of being masked by the comparison that follows.
    assert.ok(
      writerSettled !== undefined && 'result' in writerSettled,
      'the queued writer did not resolve: ' + describe(writerSettled),
    );
    writerAfter = writerSettled.result;
    const firstSettled = await recorderFirst;
    assert.ok(firstSettled.recorded !== undefined, describe(firstSettled));
    const recordedFirst = firstSettled.recorded;
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
      observedQueuedWaiters: queuedIdentities.map((row) => ({
        app: row.app,
        role: row.role,
        wait: row.wait_type,
      })),
      observedRecorderWaiter: {
        app: writerFirstWaiters[0].app,
        role: writerFirstWaiters[0].role,
        wait: writerFirstWaiters[0].wait_type,
      },
      ownershipRefusalPathTested: false,
      probeStatementTimeoutMs: PROBE_STATEMENT_TIMEOUT_MS,
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
