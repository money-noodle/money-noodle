// The REAL platform-API control recorder against the REAL gate writer, both taking the
// same per-capability advisory lock. No hand-written SQL stands in for either side's
// participation: this imports `createPostgresControlRecorder` and
// `createEngineRecorderClient` from platform-api's built output and calls `record()` with
// the real client options.
//
// Recorder participation was approved by Rai on 2026-10-18, and the API-generated
// identifier on 2026-10-19 (#orbit 1561601104473493547), both as CODE AND TESTS ONLY.
// This contract proves CODE ORDERING and ROLE PERMISSION in one process against one
// database. It is NOT a deployment and NOT activation, and current write admission
// remains unclaimed.
//
// THE ROLE QUALIFICATION, now executed rather than pending (vector 1). The recorder runs
// under `engine_control_recorder`, the role migration 0001 actually grants it — `INSERT`
// and no `SELECT` — and the real adapter SUCCEEDS there, because the API generates each
// intent's UUID before inserting and the statement asks PostgreSQL to return nothing. The
// row is read back by ADMIN only; the recorder's own client is then refused `42501` on
// `select id`, on `select *`, on its own row by id, and on another column, with the
// catalog agreeing (`has_table_privilege` select false, `has_column_privilege` on `id`
// false). The role still reads nothing, which is the invariant ADR-0013 §2 exists for.
//
// THE PRE-EXISTING DEFECT IS KEPT AS A REGRESSION, not deleted now that it is routed
// around: `insert ... returning id` is still refused `42501` for this role, in both the
// `b7bc42b` form and the locked form, while the same two forms without `returning` are
// still accepted. PostgreSQL requires `SELECT` on every column named in `RETURNING`, and
// migration 0001's comment claiming `INSERT` alone permits it is wrong — corrected in
// ADR-0013 and the port contract with a dated note, never by editing the applied
// migration. No grant was added, no migration was written, and the schema's own
// `gen_random_uuid()::text` default is untouched.
//
// Every wait is observed in `pg_locks` joined to `pg_stat_activity`, never timed with a
// sleep, with a real elapsed deadline so a failure cannot hang. Nothing is awaited inside
// a writer barrier.
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { createPostgresPaperGateWriter as createTestArtifactPaperGateWriter } from '../dist-test-support/adapters/engine-store/postgres-paper-gate-writer.js';
import { AUDITED_POLICY_FIXTURE } from '../dist-test-support/test-support/paper-gate-audited-policy-fixture.js';
import {
  CONTROL_WRITE_LOCK_NAMESPACE,
  createPostgresControlRecorder,
  createPostgresEngineReader,
} from '../../platform-api/dist/adapters/engine-store/postgres-engine-store.js';
import {
  createEngineReaderClient,
  createEngineRecorderClient,
} from '../../platform-api/dist/adapters/engine-store/engine-query-client.js';

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

/** The application name every blocking session in THIS contract sets, so a forced
 * termination can be restricted to a backend this test owns. */
const BLOCKER_APP = 'mn243-recorder-lock-test-blocker';

/**
 * TEST-ONLY cleanup for a vector that parks REAL participants behind a blocking key.
 *
 * The rule it exists to enforce: never await a participant that can only finish once the
 * key is free until the CATALOG proves the blocking backend no longer holds it. The
 * escalation is release -> force-end the blocking session -> terminate its backend, and
 * each step is verified by the caller's own per-pid probe before any dependent is awaited.
 *
 * What it does NOT promise: nothing here can guarantee "no leak" if the database is
 * unreachable. When every step fails, the owned handles are force-closed and the
 * dependents are deliberately NOT awaited, so the caller fails with its own error and the
 * collected cleanup errors instead of waiting without a bound. It never throws: a cleanup
 * must not replace the failure that caused it.
 *
 * `release` returns the server's own boolean. `holdGone` is a predicate over the catalog,
 * polled inside the caller's existing observation budget. `terminate` is optional and is
 * expected to refuse any backend it cannot prove belongs to this test.
 */
export async function freeKeyThenSettle(options) {
  const {
    budgetMs = 4000,
    closers = [],
    dependents = [],
    forceEnd,
    holdGone,
    pollMs = 25,
    release,
    terminate,
  } = options;
  const order = [];
  const closeErrors = [];
  const settle = async (value) => (typeof value === 'function' ? value() : value);
  const poll = async () => {
    const startedAt = Date.now();
    for (;;) {
      if ((await holdGone().catch(() => false)) === true) return true;
      if (Date.now() - startedAt >= budgetMs) return false;
      await delay(pollMs);
    }
  };
  const runClosers = async () => {
    for (const closer of closers)
      await settle(closer).catch((error) => {
        closeErrors.push(String((error && error.message) || error));
      });
    order.push('closers-run');
  };
  let released = false;
  try {
    released = (await release()) === true;
    order.push(released ? 'released' : 'release-false');
  } catch {
    order.push('release-rejected');
  }
  // Polled BEFORE escalating, deliberately: when the probe already proves this backend
  // holds nothing, destroying its session would be a cost with no purpose. A `false` or a
  // rejection that leaves the hold in place is exactly what the probe catches.
  let gone = await poll();
  let forced = false;
  let terminated = false;
  if (!gone && forceEnd !== undefined) {
    forced = true;
    order.push('force-end');
    await forceEnd().catch(() => order.push('force-end-failed'));
    gone = await poll();
  }
  if (!gone && terminate !== undefined) {
    terminated = true;
    order.push('terminate');
    order.push('terminate:' + String(await terminate().catch(() => 'terminate-failed')));
    gone = await poll();
  }
  order.push(gone ? 'hold-gone' : 'hold-still-held');
  if (!gone) {
    // Owned resources are force-closed and the dependents are NOT awaited: a participant
    // blocked on a key nobody could free would wait with no bound of its own.
    await runClosers();
    order.push('dependents-not-awaited');
    return {
      closeErrors,
      dependentsAwaited: false,
      forced,
      holdGone: false,
      order,
      released,
      terminated,
    };
  }
  await Promise.allSettled(dependents.filter((d) => d !== undefined).map((d) => settle(d)));
  order.push('dependents-settled');
  await runClosers();
  return {
    closeErrors,
    dependentsAwaited: true,
    forced,
    holdGone: true,
    order,
    released,
    terminated,
  };
}

export async function paperGateControlRecorderLockPostgresContract(admin, port) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(/^\d+$/.test(String(port)));
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';
  // The role the schema actually grants the recorder — and, since the API now generates
  // the identifier, the role every vector below runs the real adapter under.
  const recorderUrl = 'postgres://engine_control_recorder@127.0.0.1:' + port + '/postgres';
  // The API's OTHER engine role, used only to read back what the recorder wrote.
  const readerUrl = 'postgres://engine_reader@127.0.0.1:' + port + '/postgres';
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
  /** Granted holders of THIS key on ONE backend. `'0'` means that backend freed it —
   * which `lockHolders()` cannot tell us, because the recorder and the writer legitimately
   * hold the key the moment the blocker lets go. */
  const blockerHolds = async (pid) => {
    const [row] = await observe(
      "select count(*)::text as n from pg_locks where locktype='advisory' and granted and pid = $2::int and classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and objid::bigint = (hashtextextended($1::text,0) & 4294967295)",
      [LOCK_TEXT, pid],
    );
    return row.n;
  };
  /** Last resort, and deliberately narrow. It terminates ONE backend, only on this
   * disposable loopback test cluster, only the pid captured in the same statement that
   * took the hold, and only after the catalog confirms that backend is this test's own
   * blocking session (its application name), runs as the local superuser over loopback,
   * and is actually a granted holder of this key. Anything else is refused and reported.
   * No deployed or production session is ever a candidate: the only connection strings in
   * this contract are 127.0.0.1 on the disposable port asserted above. */
  const terminateBackendIfOurs = async (pid) => {
    if (pid === undefined) return 'no-pid';
    const [row] = await observe(
      "select a.usename as role, a.application_name as app, (a.client_addr is null or a.client_addr = '127.0.0.1'::inet) as loopback, (select count(*) from pg_locks l where l.locktype='advisory' and l.granted and l.pid = a.pid and l.classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and l.objid::bigint = (hashtextextended($1::text,0) & 4294967295))::text as holds from pg_stat_activity a where a.pid = $2::int",
      [LOCK_TEXT, pid],
    );
    if (row === undefined) return 'backend-gone';
    if (row.app !== BLOCKER_APP || row.role !== 'postgres' || row.loopback !== true)
      return 'refused-identity';
    if (row.holds === '0') return 'refused-not-holder';
    await admin.unsafe('select pg_terminate_backend($1::int)', [pid]);
    return 'terminated';
  };
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

  // The REAL recorder: the real adapter, the real client factory, and the role the schema
  // actually grants it. Every vector below runs under that role — there is no substitute
  // role anywhere in this contract any more.
  const recorderClient = createEngineRecorderClient(recorderUrl);
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

  let facts;
  let primary;
  let primaryPresent = false;
  try {
    // 0. The recorder's own session, as the real client configures it. Its wait on the
    // advisory lock is bounded only by whatever timeouts actually exist, so they are
    // MEASURED and recorded rather than assumed or invented.
    const [timeouts] = await admin.unsafe(
      "select (select setting from pg_settings where name='lock_timeout') as lock_timeout, (select setting from pg_settings where name='statement_timeout') as statement_timeout",
    );
    const recorderProbe = postgres(recorderUrl, { max: 1, prepare: false });
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
      parameters: { recorded_by: 'grant-probe' },
      recordedAt: new Date('2026-10-12T04:45:00.000Z'),
      runId: RUN,
    };
    // THE POSITIVE PATH, under the role the schema grants. The API now generates the
    // identifier before inserting (approved 2026-10-19), so the statement no longer asks
    // PostgreSQL to return a column the role may not read, and the real adapter succeeds
    // as `engine_control_recorder`.
    const grantProbeRecorded = await recorder.record(grantProbeIntent);
    assert.equal(typeof grantProbeRecorded.id, 'string');
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        grantProbeRecorded.id,
      ),
      'the recorder returned something that is not a v4 UUID: ' + describe(grantProbeRecorded),
    );
    // The row is read back by ADMIN only. The recorder cannot read it, which is the point.
    const [persisted] = await admin.unsafe(
      "select id, capability, action, actor, epoch, run_id, parameters::text as parameters, jsonb_typeof(parameters) as parameters_type, parameters->>'recorded_by' as recorded_by, (recorded_at = $2::text::timestamptz) as recorded_at_matches from engine.control_intent where id=$1",
      [grantProbeRecorded.id, '2026-10-12 04:45:00.000000+00'],
    );
    assert.ok(
      persisted !== undefined,
      'the generated id is not in the table: ' + grantProbeRecorded.id,
    );
    assert.deepEqual(
      {
        action: persisted.action,
        actor: persisted.actor,
        capability: persisted.capability,
        epoch: Number(persisted.epoch),
        id: persisted.id,
        parameters: persisted.parameters,
        parameters_type: persisted.parameters_type,
        recorded_at_matches: persisted.recorded_at_matches,
        recorded_by: persisted.recorded_by,
        run_id: persisted.run_id,
      },
      {
        action: 'pause',
        actor: GRANT_PROBE_ACTOR,
        capability: CAPABILITY,
        epoch: EPOCH,
        id: grantProbeRecorded.id,
        // The column holds the DOCUMENT, in jsonb's own canonical text — a space after
        // the colon — and `jsonb_typeof` says `object`, so the extraction operator works.
        // Until 2026-10-19 it held a JSON *string*, because the adapter bound JSON text
        // that the driver then encoded a second time; `$8::text::jsonb` makes PostgreSQL
        // parse it exactly once.
        parameters: '{"recorded_by": "grant-probe"}',
        parameters_type: 'object',
        recorded_at_matches: true,
        recorded_by: 'grant-probe',
        run_id: RUN,
      },
    );
    assert.equal(await probeRows(), '1');
    assert.equal(await lockHolders(), '0');
    // Success accounting, established rather than assumed. The statement selects FROM a
    // `void` function, which yields exactly one row; there is no `on conflict`; and the
    // catalog is asserted to carry no trigger and no rule on this table, so the insert
    // cannot have silently affected zero rows. The driver's own command tag is read HERE,
    // in the test, through the real client — production reads no count and needs none.
    const [suppressors] = await admin.unsafe(
      "select (select count(*) from pg_trigger t where t.tgrelid = 'engine.control_intent'::regclass and not t.tgisinternal)::text as triggers, (select count(*) from pg_rewrite r where r.ev_class = 'engine.control_intent'::regclass and r.rulename <> '_RETURN')::text as rules",
    );
    assert.deepEqual(
      { rules: suppressors.rules, triggers: suppressors.triggers },
      { rules: '0', triggers: '0' },
    );
    // A TEST-only copy of the production statement, and a drift guard so the copy cannot
    // silently stop matching: the built adapter's own source is read and asserted to
    // contain the same fragments. Nothing about production is changed to make this
    // possible — the artifact is already imported by this contract.
    const COPIED_INSERT_SQL = `insert into "engine"."control_intent" (id, capability, action, actor, epoch, recorded_at, run_id, parameters) select $1, $2, $3, $4, $5, $6, $7, $8::text::jsonb from pg_advisory_xact_lock(hashtextextended($9::text, 0))`;
    const shippedAdapter = readFileSync(
      new URL(
        '../../platform-api/dist/adapters/engine-store/postgres-engine-store.js',
        import.meta.url,
      ),
      'utf8',
    );
    assert.ok(
      shippedAdapter.includes(
        '(id, capability, action, actor, epoch, recorded_at, run_id, parameters)',
      ),
      'the production statement no longer names the same columns',
    );
    // One fragment, ending at the template literal's closing backtick, so it proves BOTH
    // that the cast is there and that the statement ENDS there — no `returning` can hide
    // after it. A substring search for the word alone would match this file's comments.
    assert.ok(
      shippedAdapter.includes(
        'select $1, $2, $3, $4, $5, $6, $7, $8::text::jsonb\n           from pg_advisory_xact_lock(hashtextextended($9::text, 0))`',
      ),
      'the production statement drifted from the copy this vector runs',
    );
    const accountingProbe = postgres(recorderUrl, { max: 1, prepare: false });
    let affectedRowCount;
    try {
      const result = await accountingProbe.unsafe(COPIED_INSERT_SQL, [
        'accounting-' + grantProbeRecorded.id,
        CAPABILITY,
        'pause',
        GRANT_PROBE_ACTOR,
        EPOCH,
        grantProbeIntent.recordedAt,
        RUN,
        null,
        LOCK_TEXT,
      ]);
      // postgres.js carries the command tag's row count on the result it returns, and the
      // statement returns no rows: one insert, zero rows read back.
      affectedRowCount = String(result.count);
      assert.equal(result.length, 0);
    } finally {
      await accountingProbe.end({ timeout: 5 }).catch(() => undefined);
    }
    assert.equal(affectedRowCount, '1');
    assert.equal(await probeRows(), '2');

    // THE ROLE'S READ DENIAL STILL HOLDS, which is what generating the id protects. Read
    // from the catalog, then attempted for real through the recorder's own client.
    const [granted] = await admin.unsafe(
      "select has_table_privilege('engine_control_recorder','engine.control_intent','insert')::text as can_insert, has_table_privilege('engine_control_recorder','engine.control_intent','select')::text as can_select, has_column_privilege('engine_control_recorder','engine.control_intent','id','select')::text as can_select_id, has_column_privilege('engine_control_recorder','engine.control_intent','capability','select')::text as can_select_capability, has_table_privilege('engine_control_recorder','engine.control_intent','update')::text as can_update, has_table_privilege('engine_control_recorder','engine.control_intent','delete')::text as can_delete",
    );
    assert.deepEqual(granted, {
      can_delete: 'false',
      can_insert: 'true',
      can_select: 'false',
      can_select_capability: 'false',
      can_select_id: 'false',
      can_update: 'false',
    });
    const readDenials = {};
    for (const [label, statement] of [
      ['select-id', 'select id from "engine"."control_intent" limit 1'],
      ['select-star', 'select * from "engine"."control_intent" limit 1'],
      ['select-own-row-by-id', 'select id from "engine"."control_intent" where id = $1'],
      ['select-capability', 'select capability from "engine"."control_intent" limit 1'],
    ])
      readDenials[label] = await recorderClient
        .query(statement, statement.includes('$1') ? [grantProbeRecorded.id] : [])
        .then(
          () => 'READ-WHICH-IS-WRONG',
          (error) => String(error && error.code),
        );
    // Every read is refused `42501`, including the role's OWN row by its own id: the
    // identifier it returned is not something it can look up. These go through the real
    // client, which surfaces the driver's code; the ADAPTER is what collapses every
    // failure to one `engine-unreachable`, which `record()` above demonstrates and which
    // stays measured and unchanged.
    assert.deepEqual(readDenials, {
      'select-capability': '42501',
      'select-id': '42501',
      'select-own-row-by-id': '42501',
      'select-star': '42501',
    });
    // And the raw code underneath, on a session of this same role, so the refusal is
    // named rather than inferred from the port's single error.
    const denialProbe = postgres(recorderUrl, { max: 1, prepare: false });
    const rawDenials = {};
    try {
      for (const [label, statement] of [
        ['select-id', 'select id from engine.control_intent limit 1'],
        ['select-star', 'select * from engine.control_intent limit 1'],
      ])
        rawDenials[label] = await denialProbe.unsafe(statement, []).then(
          () => 'READ-WHICH-IS-WRONG',
          (error) => String(error && error.code),
        );
    } finally {
      await denialProbe.end({ timeout: 5 }).catch(() => undefined);
    }
    assert.deepEqual(rawDenials, { 'select-id': '42501', 'select-star': '42501' });

    // ACTUAL-CONSUMER ROUND TRIP, the first time the API's writer and the API's reader
    // meet one real database. The row the recorder just wrote is read back through the
    // REAL `createPostgresEngineReader` over the REAL `createEngineReaderClient`, as
    // `engine_reader` — the role that actually holds `SELECT`. Signatures are taken from
    // the port rather than assumed: `readIntentHistory(capability, limit)` returns entries
    // shaped `{ intent, outcomes }`, and the entry is found BY ID, never by position.
    const readerClient = createEngineReaderClient(readerUrl);
    let roundTrip;
    try {
      const reader = createPostgresEngineReader({ client: readerClient, schema: 'engine' });
      const entryById = async (id) =>
        (await reader.readIntentHistory(CAPABILITY, 20)).find((entry) => entry.intent.id === id);
      const entry = await entryById(grantProbeRecorded.id);
      assert.ok(entry !== undefined, 'the real reader did not return the recorded intent');
      assert.deepEqual(
        {
          action: entry.intent.action,
          actor: entry.intent.actor,
          capability: entry.intent.capability,
          epoch: entry.intent.epoch,
          id: entry.intent.id,
          runId: entry.intent.runId,
        },
        {
          action: 'pause',
          actor: GRANT_PROBE_ACTOR,
          capability: CAPABILITY,
          epoch: EPOCH,
          id: grantProbeRecorded.id,
          runId: RUN,
        },
      );
      // The decoded document, which the reader REFUSES outright if the column holds a
      // string. Before 2026-10-19 this read was impossible.
      assert.deepEqual({ ...entry.intent.parameters }, { recorded_by: 'grant-probe' });

      // SQL NULL survives as NULL on both sides: nothing writes the text 'null'.
      const nullRecorded = await recorder.record({
        action: 'pause',
        actor: GRANT_PROBE_ACTOR,
        capability: CAPABILITY,
        epoch: EPOCH,
        parameters: null,
        recordedAt: new Date('2026-10-12T04:46:00.000Z'),
        runId: RUN,
      });
      const [nullPersisted] = await admin.unsafe(
        'select (parameters is null) as is_null, jsonb_typeof(parameters) as parameters_type from engine.control_intent where id=$1',
        [nullRecorded.id],
      );
      assert.deepEqual(
        { is_null: nullPersisted.is_null, parameters_type: nullPersisted.parameters_type },
        { is_null: true, parameters_type: null },
      );
      const nullEntry = await entryById(nullRecorded.id);
      assert.ok(
        nullEntry !== undefined,
        'the real reader did not return the null-parameter intent',
      );
      assert.equal(nullEntry.intent.parameters, null);

      // And a configure-shaped document of valid scalars only — strings, integers and a
      // boolean — so the whole typed domain round-trips and the extraction operator the
      // engine's own authority SQL uses can see a field. This stores no paper
      // configuration contract and activates nothing: it is synthetic, in this
      // contract's own epoch band, and deleted below.
      const configureDocument = Object.freeze({
        budget_id: BUDGET,
        enabled: true,
        funding_id: FUNDING,
        paper_config_version: 1,
        total_cap_cents: 1000,
      });
      const configureRecorded = await recorder.record({
        action: 'configure',
        actor: GRANT_PROBE_ACTOR,
        capability: CAPABILITY,
        epoch: EPOCH,
        parameters: configureDocument,
        recordedAt: new Date('2026-10-12T04:47:00.000Z'),
        runId: RUN,
      });
      const [configurePersisted] = await admin.unsafe(
        "select jsonb_typeof(parameters) as parameters_type, parameters->>'funding_id' as funding_id, parameters->>'total_cap_cents' as total_cap_cents, parameters->>'enabled' as enabled from engine.control_intent where id=$1",
        [configureRecorded.id],
      );
      assert.deepEqual(configurePersisted, {
        enabled: 'true',
        funding_id: FUNDING,
        parameters_type: 'object',
        total_cap_cents: '1000',
      });
      const configureEntry = await entryById(configureRecorded.id);
      assert.ok(
        configureEntry !== undefined,
        'the real reader did not return the configure intent',
      );
      assert.deepEqual({ ...configureEntry.intent.parameters }, configureDocument);
      roundTrip = {
        configureFundingIdExtracted: configurePersisted.funding_id,
        nullStaysSqlNull: nullPersisted.is_null === true,
        readerRole: 'engine_reader',
        readerReturnedId: entry.intent.id === grantProbeRecorded.id,
        readerReturnedParameters: { ...entry.intent.parameters },
      };
    } finally {
      await readerClient.close().catch(() => undefined);
    }

    // HISTORICAL REGRESSION, retained: the forms that asked PostgreSQL to RETURN the id
    // are still refused `42501` for this role, and the same forms without `returning` are
    // still accepted. That is the pre-existing defect this batch's approved change routes
    // around — not something the advisory lock introduced, and not something a grant was
    // added for. The SQL here is deliberately hand-written because these forms no longer
    // exist in the source; the authoritative result for the SHIPPED statement is the
    // adapter call above, which succeeds.
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
      grantOutcomes[label] = await recorderClient.query(text, values).then(
        () => 'accepted',
        (error) => String(error && error.code),
      );
    assert.deepEqual(grantOutcomes, {
      'b7bc42b-values-no-returning': 'accepted',
      'b7bc42b-values-returning': '42501',
      'locked-select-no-returning': 'accepted',
      'locked-select-returning': '42501',
    });
    // Four adapter/probe inserts plus the two accepted historical forms, and no lock left
    // behind.
    assert.equal(await probeRows(), '6');
    assert.equal(await lockHolders(), '0');
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
      // Settled, then closed, with the close collected so it cannot replace a failing
      // assertion from the barrier above.
      await Promise.allSettled([queued]);
      await holder.close().catch(() => undefined);
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
    // The waiting backend's ROLE is asserted, and it is the INTENDED one: the real
    // `engine_control_recorder`, not a substitute. Vector 1 proved it can now execute the
    // statement, so there is nothing left to stand in for it.
    assert.equal(writerFirstWaiters[0].role, 'engine_control_recorder');
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
      connection: { application_name: BLOCKER_APP, statement_timeout: 20000 },
    });
    let recorderFirst;
    let writerAfter;
    let writerSettled;
    let queuedWriter;
    let pendingWrite;
    let bothObserved = false;
    let queuedIdentities;
    let blockerPid;
    let keyAcquired = false;
    let keyReleased = false;
    let primary;
    let primaryPresent = false;
    let recorderFirstCleanup;
    // Returns the SERVER's own boolean and marks the key released only when PostgreSQL
    // says so, so a `false` — which is what a release landing on a different backend
    // looks like — escalates instead of being recorded as success. Idempotent, and a
    // no-op before the hold is taken.
    const releaseKey = async () => {
      if (!keyAcquired || keyReleased) return true;
      const [row] = await blocker.unsafe(
        'select pg_advisory_unlock(hashtextextended($1::text,0)) as released',
        [LOCK_TEXT],
      );
      keyReleased = row.released === true;
      return keyReleased;
    };
    try {
      // The holder's pid comes from the SAME statement that takes the hold, so it cannot
      // belong to a different backend than the one holding the key.
      const [held] = await blocker.unsafe(
        'select pg_backend_pid()::text as pid, pg_advisory_lock(hashtextextended($1::text,0))',
        [LOCK_TEXT],
      );
      keyAcquired = true;
      blockerPid = held.pid;
      assert.ok(/^\d+$/.test(String(blockerPid)));
      assert.equal(await lockHolders(), '1');
      assert.equal(await blockerHolds(blockerPid), '1');
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
      // Nothing is released or awaited here: the key is freed, verified and the
      // participants settled by ONE cleanup path below, so the body cannot take the
      // happy-path ordering while a failure takes a different one.
    } catch (error) {
      // An explicit flag, not truthiness: a thrown `undefined`, `null` or `false` is still
      // a primary failure and must not be swallowed by the cleanup result.
      primary = error;
      primaryPresent = true;
    } finally {
      recorderFirstCleanup = await freeKeyThenSettle({
        budgetMs: OBSERVATION_BUDGET_MS,
        closers: [
          () => (queuedWriter === undefined ? Promise.resolve() : queuedWriter.close()),
          () => blocker.end({ timeout: 5 }),
        ],
        dependents: [pendingWrite, recorderFirst],
        forceEnd: () => blocker.end({ timeout: 0 }),
        holdGone: async () => blockerPid === undefined || (await blockerHolds(blockerPid)) === '0',
        pollMs: 25,
        release: releaseKey,
        terminate: () => terminateBackendIfOurs(blockerPid),
      });
    }
    // The primary failure is rethrown with its identity intact, before anything is said
    // about the cleanup.
    if (primaryPresent) throw primary;
    assert.deepEqual(
      {
        closeErrors: recorderFirstCleanup.closeErrors,
        dependentsAwaited: recorderFirstCleanup.dependentsAwaited,
      },
      { closeErrors: [], dependentsAwaited: true },
      describe(recorderFirstCleanup),
    );
    assert.deepEqual(recorderFirstCleanup.order, [
      'released',
      'hold-gone',
      'dependents-settled',
      'closers-run',
    ]);
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
    // The recorder's waiter is the INTENDED role, and the other one is the engine writer:
    // two different roles on one key, which is the whole point of the protocol.
    assert.deepEqual(
      queuedIdentities
        .map((row) => (row.app === RECORDER_APP ? 'recorder:' + row.role : 'writer:' + row.role))
        .sort(),
      ['recorder:engine_control_recorder', 'writer:engine_writer'],
      describe(queuedIdentities),
    );
    // Both participants were settled by the cleanup, so reading them here cannot wait.
    writerSettled = await pendingWrite;
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

    // 4b. FAULT-INJECTION ORACLES for that cleanup. The failures the cleanup exists to
    // survive cannot be produced on a direct loopback connection, so they are INJECTED —
    // into the test helper's arguments only, never into production code and never through
    // a seam in the adapter. Everything else is real: a real blocking session, the real
    // recorder adapter and client on the INTENDED role, a real blocked wait observed by
    // application name, and the catalog's own per-pid answer. No sleep is used, and every
    // wait is bounded by the existing observation budget.
    const newBlocker = () =>
      postgres('postgres://postgres@127.0.0.1:' + port + '/postgres', {
        max: 1,
        prepare: false,
        connection: { application_name: BLOCKER_APP, statement_timeout: 20000 },
        // `pg_advisory_unlock` on a session holding nothing raises a WARNING; O2 expects
        // the `false` it returns, not its console output.
        onnotice: () => {},
      });
    const holdKeyWithPid = async (session) => {
      const [row] = await session.unsafe(
        'select pg_backend_pid()::text as pid, pg_advisory_lock(hashtextextended($1::text,0))',
        [LOCK_TEXT],
      );
      return row.pid;
    };
    const faults = {};

    // O1 + O3: a REJECTED unlock with a genuinely blocked real recorder behind the key.
    // The forced end has to be what frees it, and the dependent must still be pending at
    // that moment — ordering proved by state, not by timing.
    {
      const oracleBlocker = newBlocker();
      try {
        const pid = await holdKeyWithPid(oracleBlocker);
        let dependentSettled = false;
        const dependent = recordPause('oracle-forced').then(
          (recorded) => {
            dependentSettled = true;
            return { recorded };
          },
          (error) => {
            dependentSettled = true;
            return { error: String(error && error.code) };
          },
        );
        await untilAtLeast(
          recorderLockWaiters,
          1,
          'the real recorder queued behind the rejected-unlock oracle',
        );
        let settledAtForceEnd;
        const result = await freeKeyThenSettle({
          budgetMs: OBSERVATION_BUDGET_MS,
          closers: [],
          dependents: [dependent],
          forceEnd: () => {
            settledAtForceEnd = dependentSettled;
            return oracleBlocker.end({ timeout: 0 });
          },
          holdGone: async () => (await blockerHolds(pid)) === '0',
          pollMs: 25,
          release: () => Promise.reject(new Error('injected unlock failure')),
          terminate: () => terminateBackendIfOurs(pid),
        });
        assert.deepEqual(result.order.slice(0, 2), ['release-rejected', 'force-end']);
        assert.deepEqual(result.order.slice(-3), [
          'hold-gone',
          'dependents-settled',
          'closers-run',
        ]);
        assert.deepEqual(
          {
            dependentsAwaited: result.dependentsAwaited,
            forced: result.forced,
            holdGone: result.holdGone,
            released: result.released,
          },
          { dependentsAwaited: true, forced: true, holdGone: true, released: false },
        );
        // O3: it was the escalation that freed the key, not a polite unlock.
        assert.equal(settledAtForceEnd, false);
        const settledDependent = await dependent;
        assert.ok(settledDependent.recorded !== undefined, describe(settledDependent));
        assert.equal(typeof settledDependent.recorded.id, 'string');
        faults.rejectedUnlock = result.terminated ? 'forced-then-terminated' : 'forced';
        faults.dependentPendingAtForceEnd = settledAtForceEnd === false;
        faults.escalationOrder = result.order;
      } finally {
        await oracleBlocker.end({ timeout: 0 }).catch(() => undefined);
      }
      await admin.unsafe(
        "delete from engine.control_intent where capability=$1 and epoch=$2 and action='pause'",
        [CAPABILITY, EPOCH],
      );
      assert.equal(await lockHolders(), '0');
    }

    // O2: the real unlock on a session that holds NOTHING returns `false`, while a
    // DIFFERENT session holds the key. Nothing is given to the helper as a dependent,
    // because nothing may be parked behind a key this cleanup is not responsible for, and
    // the other holder releases explicitly below.
    {
      const idleBlocker = newBlocker();
      const otherHolder = newBlocker();
      try {
        const [self] = await idleBlocker.unsafe('select pg_backend_pid()::text as pid', []);
        const otherPid = await holdKeyWithPid(otherHolder);
        assert.notEqual(self.pid, otherPid);
        assert.equal(await lockHolders(), '1');
        const result = await freeKeyThenSettle({
          budgetMs: OBSERVATION_BUDGET_MS,
          closers: [],
          dependents: [],
          forceEnd: () => idleBlocker.end({ timeout: 0 }),
          holdGone: async () => (await blockerHolds(self.pid)) === '0',
          pollMs: 25,
          release: async () => {
            const [row] = await idleBlocker.unsafe(
              'select pg_advisory_unlock(hashtextextended($1::text,0)) as released',
              [LOCK_TEXT],
            );
            return row.released === true;
          },
          terminate: () => terminateBackendIfOurs(self.pid),
        });
        // The server said `false`, and the per-pid probe then proved there was nothing on
        // THIS backend to free — so no session was destroyed for no reason. The sketch for
        // this oracle expected `forced: true`; polling before escalating is the stricter
        // behaviour and this is the measured outcome, recorded as it is.
        assert.deepEqual(
          {
            forced: result.forced,
            holdGone: result.holdGone,
            released: result.released,
            terminated: result.terminated,
          },
          { forced: false, holdGone: true, released: false, terminated: false },
        );
        assert.deepEqual(result.order, [
          'release-false',
          'hold-gone',
          'dependents-settled',
          'closers-run',
        ]);
        // And the probe cannot false-positive on another holder: the key IS still held,
        // by the other session, at this exact point.
        assert.equal(await lockHolders(), '1');
        assert.equal(await blockerHolds(otherPid), '1');
        assert.equal(await blockerHolds(self.pid), '0');
        faults.falseUnlock = 'release-false-nothing-to-free';
      } finally {
        await otherHolder
          .unsafe('select pg_advisory_unlock(hashtextextended($1::text,0))', [LOCK_TEXT])
          .catch(() => undefined);
        await otherHolder.end({ timeout: 5 }).catch(() => undefined);
        await idleBlocker.end({ timeout: 5 }).catch(() => undefined);
      }
      assert.equal(await lockHolders(), '0');
    }

    // O4: a closer that rejects is COLLECTED, and the helper still resolves.
    {
      const result = await freeKeyThenSettle({
        budgetMs: OBSERVATION_BUDGET_MS,
        closers: [() => Promise.reject(new Error('injected close failure'))],
        dependents: [],
        holdGone: async () => true,
        pollMs: 25,
        release: async () => true,
      });
      assert.deepEqual(result.order, [
        'released',
        'hold-gone',
        'dependents-settled',
        'closers-run',
      ]);
      assert.equal(result.closeErrors.length, 1);
      assert.match(result.closeErrors[0], /injected close failure/);
      faults.closeFailure = 'collected';
    }

    // O5: the primary failure survives a cleanup that itself fails twice. Identity, by an
    // explicit present-flag rather than truthiness.
    {
      const primaryError = new Error('injected primary failure');
      let captured;
      let capturedPresent = false;
      let oracleCleanup;
      try {
        throw primaryError;
      } catch (error) {
        captured = error;
        capturedPresent = true;
      } finally {
        oracleCleanup = await freeKeyThenSettle({
          budgetMs: OBSERVATION_BUDGET_MS,
          closers: [() => Promise.reject(new Error('injected close failure'))],
          dependents: [],
          holdGone: async () => true,
          pollMs: 25,
          release: () => Promise.reject(new Error('injected unlock failure')),
        });
      }
      assert.equal(capturedPresent, true);
      assert.equal(captured === primaryError, true);
      assert.equal(oracleCleanup.closeErrors.length, 1);
      assert.deepEqual(oracleCleanup.order, [
        'release-rejected',
        'hold-gone',
        'dependents-settled',
        'closers-run',
      ]);
      faults.primaryPreserved = captured === primaryError;
    }

    // O5b: EVERY step fails and the hold never clears. The one thing that must not happen
    // is awaiting a participant that can only finish once the key is free: the owned
    // handles are closed, the dependent is left alone, and the helper returns. A short
    // budget is used because every input here is injected — this is the helper's own
    // logic, not an observation of the database.
    {
      // A THUNK dependent, so "was it awaited" is observable: the helper only calls it on
      // the path that settles dependents, and it would never resolve if it did.
      let neverSettledAwaited = false;
      let closersRan = false;
      const result = await freeKeyThenSettle({
        budgetMs: 200,
        closers: [
          () => {
            closersRan = true;
            return Promise.resolve();
          },
        ],
        dependents: [
          () => {
            neverSettledAwaited = true;
            return new Promise(() => {});
          },
        ],
        forceEnd: () => Promise.reject(new Error('injected force-end failure')),
        holdGone: async () => false,
        pollMs: 25,
        release: () => Promise.reject(new Error('injected unlock failure')),
        terminate: async () => 'refused-identity',
      });
      assert.deepEqual(
        {
          dependentsAwaited: result.dependentsAwaited,
          holdGone: result.holdGone,
          terminated: result.terminated,
        },
        { dependentsAwaited: false, holdGone: false, terminated: true },
      );
      assert.deepEqual(result.order.slice(-3), [
        'hold-still-held',
        'closers-run',
        'dependents-not-awaited',
      ]);
      assert.ok(result.order.includes('terminate:refused-identity'), describe(result.order));
      assert.equal(neverSettledAwaited, false);
      assert.equal(closersRan, true);
      assert.equal(result.closeErrors.length, 0);
      faults.allStepsFail = 'closed-without-settling';
    }

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
    facts = {
      grantedRoleAffectedRows: affectedRowCount,
      grantedRoleCanSelect: granted.can_select,
      grantedRoleCanSelectIdColumn: granted.can_select_id,
      grantedRoleReadDenials: readDenials,
      grantedRoleRawReadDenials: rawDenials,
      grantedRoleRecorded: 'succeeded-as-engine_control_recorder',
      parametersStoredEncoding: 'jsonb-object',
      realReaderRoundTrip: roundTrip,
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
      cleanupFaultInjection: faults,
      cleanupOrder: recorderFirstCleanup.order,
      ownershipRefusalPathTested: false,
      probeStatementTimeoutMs: PROBE_STATEMENT_TIMEOUT_MS,
      recorderLockTimeout: String(recorderTimeouts.lock_timeout),
      recorderStatementTimeout: String(recorderTimeouts.statement_timeout),
    };
  } catch (error) {
    // An explicit flag again, so a thrown `undefined` or `false` is still a failure.
    primary = error;
    primaryPresent = true;
  }
  // Teardown, with EVERY step collected rather than thrown: a close or a delete that
  // fails must not replace the failure that brought us here. These were bare awaits in a
  // `finally`, so the last one to fail decided what a reviewer saw.
  const teardownErrors = [];
  const teardown = async (step) => {
    await step().catch((error) => teardownErrors.push(String((error && error.message) || error)));
  };
  await teardown(() => recorderClient.close());
  for (const [statement, values] of [
    ['delete from engine.control_intent where actor=$1', [GRANT_PROBE_ACTOR]],
    ['delete from engine.paper_gate_head where generation_key=$1', [GEN]],
    ['delete from engine.paper_gate_phase_event where generation_key=$1', [GEN]],
    ['delete from engine.paper_gate_generation where generation_key=$1', [GEN]],
    ['delete from engine.paper_budget_root where funding_id=$1', [FUNDING]],
    ['delete from engine.paper_funding_root where funding_id=$1', [FUNDING]],
    ['delete from engine.control_intent where capability=$1 and epoch>=$2', [CAPABILITY, EPOCH]],
    ['delete from engine.job_lease where capability=$1', [CAPABILITY]],
  ])
    await teardown(() => admin.unsafe(statement, values));
  if (primaryPresent) throw primary;
  if (teardownErrors.length > 0) assert.fail('teardown failed: ' + describe(teardownErrors));
  // Both sides take the same key, proved by each being observed waiting on the other's
  // hold with the REAL adapters, under the REAL roles. That is CODE ORDERING and ROLE
  // PERMISSION in one process against one database. It is not a deployment: current write
  // admission still needs the engine writer running `required` on a proven DIRECT
  // endpoint and the recorder build live. The recorder's own advisory wait remains
  // unbounded as measured, and the paper runtime remains refused.
  return { ...facts, teardownErrors: teardownErrors.length };
}
