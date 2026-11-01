// Per-capability write-lock PREPARATION, driven against the ACTUAL writer and a SYNTHETIC
// participating recorder. Synthetic rows in existing approved tables only: no migration,
// no new grant, no production write, and NO change to `services/platform-api` — the real
// control recorder does not participate, approval for that has been requested and is not
// yet granted, so nothing here is current write admission.
//
// Every wait is observed directly in `pg_locks` joined to `pg_stat_activity`, never timed
// with a sleep, and every observation has a real elapsed deadline so a failure cannot
// hang. A recorder is never awaited inside a writer barrier.
//
// Note, October 18, 2026: the REAL recorder now takes this same key, as code and tests
// only and not deployed — see `./paper-gate-control-recorder-lock-postgres.mjs`, which
// drives it and records the permission fact that still blocks its granted role. The
// synthetic participant below is kept because it exercises the writer against a
// participant whose timing this contract controls; it is not a claim about the real one.
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { createPostgresPaperGateWriter as createTestArtifactPaperGateWriter } from '../dist-test-support/adapters/engine-store/postgres-paper-gate-writer.js';
import { AUDITED_POLICY_FIXTURE } from '../dist-test-support/test-support/paper-gate-audited-policy-fixture.js';
// The PRODUCTION constant, imported from the production artifact so the statement this
// contract executes is the one the writer ships, not a copy of it.
import { PAPER_GATE_WRITE_LOCK_RELEASE_ALL_SQL } from '../dist/adapters/engine-store/paper-gate-write-lock.js';

const CAPABILITY = 'budget:paper';
// Its own epoch band, so this contract cannot disturb or be disturbed by another.
const EPOCH = 12;
const ACTOR = 'lock-actor';
const BUDGET = ACTOR + ':paper';
const FUNDING = 'lock-funding';
const OWNER = 'lock-owner';
const TOKEN = 13n;
const RUN = 'root-paper-run';
const CONFIG_INTENT = 'lock-config';
const GEN = 'lock-generation';
const POLICY = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
const T_CONFIG = '2026-10-12 03:00:00.000000+00';
const T_PAUSE = '2026-10-12 03:30:00.000000+00';
const OBSERVED_ISO = '2026-10-14T00:00:00.000Z';
const LOCK_TEXT = 'money-noodle/paper-gate-capability-write/v1:' + CAPABILITY;
const CONFIG = {
  paper_config_version: 2,
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
  // The operator-recorded generation profile (D1 = A). Synthetic in-bounds values only;
  // no strategy value is selected anywhere in this repository. `2.50` and `0.970` are
  // deliberate spellings the writer's own grammar accepts unchanged.
  regime_bundle_id: 'paper-regime-historical-warm-lineage-v1',
  regime_profile_claim: 'synthetic-profile-claim',
  regime_enabled: true,
  regime_minimum_policy_windows: 4,
  regime_evidence_half_life_windows: '2.50',
  regime_pause_confidence: '0.970',
  regime_resume_confidence: '0.9',
};
const GENERATION_INPUTS = {
  bundleId: 'paper-regime-historical-warm-lineage-v1',
  enabled: true,
  evidenceHalfLifeWindows: '2.5',
  minimumPolicyWindows: 4,
  pauseConfidence: '0.99',
  profileClaim: 'synthetic-lock-profile',
  resumeConfidence: '0.75',
};

export async function paperGateWriteLockPostgresContract(admin, port) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(/^\d+$/.test(String(port)));
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';
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
  const [leases] = await admin.unsafe('select count(*)::text as n from engine.job_lease');
  assert.equal(leases.n, '0');

  const intent = (id, action, recordedAt, parameters) =>
    admin.unsafe(
      'insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters) values($1,$2,$3,$4,$5,$6::text::timestamptz,$7,$8::text::jsonb)',
      [id, CAPABILITY, action, ACTOR, EPOCH, recordedAt, RUN, JSON.stringify(parameters)],
    );
  await intent(CONFIG_INTENT, 'configure', T_CONFIG, CONFIG);
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
  const restoreLease = () =>
    admin.unsafe(
      "update engine.job_lease set owner=$2,fencing_token=$3,expires_at=clock_timestamp()+interval '1 hour' where capability=$1",
      [CAPABILITY, OWNER, TOKEN.toString()],
    );
  const leaseLive = async () => {
    const [row] = await admin.unsafe(
      'select (expires_at>clock_timestamp()) as live from engine.job_lease where capability=$1',
      [CAPABILITY],
    );
    return row.live === true;
  };
  /** Granted holders of exactly this advisory key. `pg_locks` splits a bigint key into
   * `classid` (high 32 bits) and `objid` (low 32), which is recovered arithmetically. */
  const lockHolders = async () => {
    const [row] = await admin.unsafe(
      "select count(*)::text as n from pg_locks where locktype='advisory' and granted and classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and objid::bigint = (hashtextextended($1::text,0) & 4294967295)",
      [LOCK_TEXT],
    );
    return row.n;
  };
  /** A backend genuinely waiting, ungranted, on that same key. */
  const lockWaiters = async () => {
    const [row] = await admin.unsafe(
      "select count(*)::text as n from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and l.classid::bigint = ((hashtextextended($1::text,0) >> 32) & 4294967295) and l.objid::bigint = (hashtextextended($1::text,0) & 4294967295) and a.wait_event_type='Lock'",
      [LOCK_TEXT],
    );
    return row.n;
  };
  const until = async (probe, label) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 4000) {
      if ((await probe()) !== '0') return;
      await delay(25);
    }
    assert.fail('never observed ' + label);
  };
  const eventCount = async (eventKey) => {
    const [row] = await admin.unsafe(
      'select count(*)::text as n from engine.paper_gate_phase_event where event_key=$1',
      [eventKey],
    );
    return row.n;
  };
  const intentCount = async (id) => {
    const [row] = await admin.unsafe(
      'select count(*)::text as n from engine.control_intent where id=$1',
      [id],
    );
    return row.n;
  };
  const locked = (effects) =>
    createTestArtifactPaperGateWriter(writerUrl, effects, AUDITED_POLICY_FIXTURE, {
      capabilityWriteLock: 'required',
    });
  const request = (over = {}) => ({
    coverageCutoffAtIso: OBSERVED_ISO,
    coverageReceiptId: 'lock-receipt',
    evidenceObservedAtIso: OBSERVED_ISO,
    eventKey: 'lock-genesis',
    generation: GENERATION_INPUTS,
    kind: 'initialize',
    runId: RUN,
    scope,
    ...over,
  });
  const evaluateAt = (eventKey, expectedRevision, effects) => ({
    coverageCutoffAtIso: OBSERVED_ISO,
    coverageReceiptId: 'lock-receipt',
    effects,
    evidenceObservedAtIso: OBSERVED_ISO,
    eventKey,
    expectedRevision,
    kind: 'evaluate',
    runId: RUN,
    scope,
  });
  const describe = (value) =>
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  // The SYNTHETIC participating recorder: ONE statement that takes the same key by the
  // same derivation and inserts, as the real `engine_control_recorder` role, which holds
  // only INSERT on this table.
  const recorderSql = postgres(
    'postgres://engine_control_recorder@127.0.0.1:' + port + '/postgres',
    {
      max: 1,
      prepare: false,
      connection: { statement_timeout: 20000, idle_in_transaction_session_timeout: 20000 },
    },
  );
  const RECORDER_INSERT =
    "insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters) select $1,$2,'pause',$3,$4,$5::text::timestamptz,$6,'{}'::jsonb from pg_advisory_xact_lock(hashtextextended($7::text,0))";
  const recorderArgs = (id) => [id, CAPABILITY, ACTOR, EPOCH, T_PAUSE, RUN, LOCK_TEXT];

  try {
    assert.equal(
      (await recorderSql.unsafe('select current_user as role'))[0].role,
      'engine_control_recorder',
    );
    assert.equal(await lockHolders(), '0');

    // 1. A locked genesis write, so there is a generation and a head to transition from,
    // and so the ordinary path is proved to work with the lock taken.
    const genesisWriter = locked();
    try {
      const genesis = await genesisWriter.write(request(), fence);
      assert.equal(genesis.kind, 'written', describe(genesis));
      assert.equal(genesis.receipt.revisionAfter, 0n);
      assert.equal(await lockHolders(), '0');
    } finally {
      await genesisWriter.close();
    }

    // 2. RECORDER FIRST. It takes the lock and inserts in ONE statement, then holds both
    // to commit. The writer is started and NOT awaited inside any barrier; it is observed
    // waiting on the advisory key, which proves the recorder's single statement acquired
    // BEFORE its insert could take effect and still holds it.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let committed = false;
    const recorderTx = recorderSql
      .begin(async (tx) => {
        await tx.unsafe(RECORDER_INSERT, recorderArgs('lock-pause-a'));
        await held;
        committed = true;
      })
      .catch((error) => ({ error: error.code ?? String(error) }));
    const waiter = locked();
    let waited;
    try {
      await until(lockHolders, 'the recorder holding the advisory key');
      // Its insert has not taken effect outside its own transaction.
      assert.equal(await intentCount('lock-pause-a'), '0');
      const pending = waiter.write(evaluateAt('lock-eval-a', 0n), fence);
      try {
        await until(lockWaiters, 'the writer waiting on the advisory key');
      } finally {
        release();
      }
      waited = await pending;
    } finally {
      release();
      await Promise.allSettled([recorderTx]);
      await waiter.close();
    }
    assert.equal(committed, true);
    assert.equal(await intentCount('lock-pause-a'), '1');
    // The writer snapshotted AFTER the wait, so it sees the committed pause and refuses.
    assert.deepEqual(
      { detail: waited.detail, kind: waited.kind, reason: waited.reason },
      { detail: 'paused', kind: 'refused', reason: 'authority' },
    );
    assert.equal(await eventCount('lock-eval-a'), '0');
    assert.equal(await lockHolders(), '0');
    await admin.unsafe('delete from engine.control_intent where id=$1', ['lock-pause-a']);

    // 3. WRITER FIRST. The writer holds the session lock from before `BEGIN` through
    // commit, so the recorder's single statement blocks — observed — and its row stays
    // invisible until the writer finishes.
    let queued;
    let cleanup;
    const holder = locked({
      onWriteLockCleanup: (outcome) => {
        cleanup = outcome;
      },
      afterAuthorityRead: async () => {
        if (queued !== undefined) return;
        // Started, never awaited here: awaiting it inside the barrier would deadlock.
        queued = recorderSql
          .unsafe(RECORDER_INSERT, recorderArgs('lock-pause-b'))
          .catch((error) => ({ error: error.code ?? String(error) }));
        await until(lockWaiters, 'the recorder waiting on the advisory key');
        assert.equal(await intentCount('lock-pause-b'), '0');
      },
    });
    try {
      const written = await holder.write(evaluateAt('lock-eval-b', 0n), fence);
      assert.equal(written.kind, 'written', describe(written));
      assert.equal(cleanup, 'released');
    } finally {
      await Promise.allSettled([queued]);
      await holder.close();
    }
    assert.equal(await intentCount('lock-pause-b'), '1');
    assert.equal(await lockHolders(), '0');
    // The recorder's pause is committed now, so the next write refuses.
    const next = locked();
    try {
      const refused = await next.write(evaluateAt('lock-eval-c', 1n), fence);
      assert.deepEqual(
        { detail: refused.detail, kind: refused.kind, reason: refused.reason },
        { detail: 'paused', kind: 'refused', reason: 'authority' },
      );
    } finally {
      await next.close();
    }
    await admin.unsafe('delete from engine.control_intent where id=$1', ['lock-pause-b']);
    assert.equal(await lockHolders(), '0');

    // 4. Bounded acquisition. A lock held by another session for longer than the writer's
    // EXISTING `lock_timeout` refuses BEFORE any mutation and writes nothing. A dedicated
    // connection, never a reservation out of the harness's single `admin` handle.
    const blocker = postgres('postgres://postgres@127.0.0.1:' + port + '/postgres', {
      max: 1,
      prepare: false,
      connection: { statement_timeout: 20000 },
    });
    try {
      await blocker.unsafe('select pg_advisory_lock(hashtextextended($1::text,0))', [LOCK_TEXT]);
      assert.equal(await lockHolders(), '1');
      const timedOut = locked();
      try {
        const refused = await timedOut.write(evaluateAt('lock-eval-timeout', 1n), fence);
        assert.deepEqual(
          { detail: refused.detail, kind: refused.kind, reason: refused.reason },
          { detail: 'write-lock-timeout', kind: 'refused', reason: 'conflict' },
        );
        assert.equal(await eventCount('lock-eval-timeout'), '0');
      } finally {
        await timedOut.close();
      }
    } finally {
      // Ending the session releases its advisory lock even if an unlock were missed.
      await blocker.end({ timeout: 5 });
    }
    assert.equal(await lockHolders(), '0');

    // 5. Two concurrent calls on the SAME factory each get their own physical connection,
    // so neither can re-enter the other's session lock; exactly one write lands.
    const shared = locked();
    try {
      const results = await Promise.all([
        shared.write(evaluateAt('lock-same-1', 1n), fence),
        shared.write(evaluateAt('lock-same-2', 1n), fence),
      ]);
      const written = results.filter((result) => result.kind === 'written');
      assert.equal(written.length, 1, describe(results));
      assert.equal(await lockHolders(), '0');
    } finally {
      await shared.close();
    }

    // 6. A refusal decided AFTER the mutations still releases the lock on the same session
    // and rolls the work back, so nothing is left behind on either side. The short lease
    // budget is set BEFORE the write and the barrier only polls, so this is the
    // fresh-clock refusal rather than a serialization failure.
    await admin.unsafe(
      "update engine.job_lease set expires_at=clock_timestamp()+interval '600 milliseconds' where capability=$1",
      [CAPABILITY],
    );
    assert.equal(await leaseLive(), true);
    let expiredCleanup;
    const expiring = locked({
      onWriteLockCleanup: (outcome) => {
        expiredCleanup = outcome;
      },
      beforeFinalFence: async () => {
        for (let i = 0; i < 100; i++) {
          if (!(await leaseLive())) break;
          await delay(50);
        }
      },
    });
    try {
      const lost = await expiring.write(evaluateAt('lock-eval-rolled-back', 2n), fence);
      assert.deepEqual(
        { detail: lost.detail, kind: lost.kind, reason: lost.reason },
        { detail: 'final-boundary', kind: 'refused', reason: 'lease-lost' },
      );
      assert.equal(expiredCleanup, 'released');
      assert.equal(await eventCount('lock-eval-rolled-back'), '0');
      assert.equal(await lockHolders(), '0');
    } finally {
      await expiring.close();
    }
    await restoreLease();

    // The production release-all statement, EXECUTED rather than only asserted. The
    // writer reaches it only when `pg_advisory_unlock` reports false, which does not
    // happen on a direct endpoint, so without this vector the shipped constant is run by
    // no PostgreSQL-backed test at all. A dedicated session takes the key, runs the
    // imported constant, and the catalog shows the key free afterwards. `void` is all it
    // returns, so nothing in the result is read as a confirmation.
    const releaseAllSession = postgres('postgres://postgres@127.0.0.1:' + port + '/postgres', {
      max: 1,
      prepare: false,
      connection: { statement_timeout: 20000 },
    });
    try {
      await releaseAllSession.unsafe('select pg_advisory_lock(hashtextextended($1::text,0))', [
        LOCK_TEXT,
      ]);
      assert.equal(await lockHolders(), '1');
      assert.equal(PAPER_GATE_WRITE_LOCK_RELEASE_ALL_SQL, 'select pg_advisory_unlock_all()');
      const rows = await releaseAllSession.unsafe(PAPER_GATE_WRITE_LOCK_RELEASE_ALL_SQL, []);
      assert.equal(rows.length, 1);
      assert.equal(await lockHolders(), '0');
    } finally {
      await releaseAllSession.end({ timeout: 5 }).catch(() => undefined);
    }
  } finally {
    await recorderSql.end({ timeout: 5 });
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
  // The lock orders this writer against a PARTICIPATING recorder. The real recorder in
  // `services/platform-api` does not participate and this batch did not change it, so the
  // superseded-intent gap measured in the writer contract still stands and no current
  // write admission is claimed.
}
