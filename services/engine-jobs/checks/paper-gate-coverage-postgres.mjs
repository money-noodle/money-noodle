// Drives the ACTUAL persisted coverage adapter against disposable fixtures. Reads
// only through `createPostgresGateCoverageStore`; no hand-written equivalent SQL
// stands in for it. Synthetic rows in existing approved tables only: no migration,
// no new grant, no production write, no account or money truth.
//
// Timing: the two natural-expiry vectors below need real elapsed time, because the
// thing under test is the DATABASE clock passing a lease expiry. They are driven by
// polling `clock_timestamp()` and by an explicit lock held until released, never by a
// sleep used as a race oracle, and never by freezing or faking a clock. Every other
// interleaving uses an explicit barrier with no timing at all.
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BLOCKED_SPAN_CEILING_MS,
  HOLDER_FAULT,
  LEASE_BUDGET_MS,
  OBSERVE_DEADLINE_MS,
  OBSERVE_STATEMENT_TIMEOUT_MS,
  createLeaseFenceHarness,
} from './lease-fence-harness.mjs';
import { createPostgresGateCoverageStore } from '../dist/adapters/engine-store/postgres-gate-coverage-store.js';
import { PAPER_GATE_COVERAGE_PROTOCOL } from '../dist/domain/paper-gate-coverage.js';

const POLICY = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
const CAPABILITY = 'budget:paper';
const OWNER = 'coverage-owner';
const TOKEN = 7n;
const CREATED = '2026-10-12T02:00:00.000Z';
const WINDOW_A = '2026-10-12T02:15:00.000Z';
const RESOLVED_A = '2026-10-12T02:15:01.000Z';
const RECORDED_A = '2026-10-12T02:15:02.000Z';
const OBSERVED = '2026-10-12T02:30:01.000Z';
const CUTOFF = '2026-10-12T02:30:02.000Z';
const POST_CUTOFF = '2026-10-12T02:30:03.000Z';
const WINDOW_B = '2026-10-12T02:45:00.000Z';
const WINDOW_PENDING = '2030-01-01T00:00:00.000Z';
// A pre-cutoff second window, so a candidate CAN become resolved before the cutoff.
const WINDOW_MID = '2026-10-12T02:30:00.000Z';
const CUTOFF_US = 1791772202000000n;
const EVALUATED = 'coverage-evaluated-generation';
const GENESIS = 'coverage-genesis-generation';
const HEADLESS = 'coverage-headless-generation';
const MIDREAD = 'coverage-midread-generation';
const SCOPED = 'coverage-cutoff-generation';
const RUNBIND = 'coverage-runbind-generation';

export async function paperGateCoveragePostgresContract(admin, port) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(/^\d+$/.test(String(port)));
  const scopeOf = (generationKey) => ({
    generation_key: generationKey,
    funding_id: 'root-funding',
    epoch: 1,
    budget_id: 'root-actor:paper',
    generation_config_intent_id: 'root-config',
    sample_policy: POLICY,
  });
  const fence = { capability: CAPABILITY, owner: OWNER, fencingToken: TOKEN };
  const generation = (generationKey, initRun = 'root-paper-run') =>
    admin.unsafe(
      "insert into engine.paper_gate_generation(generation_key,funding_id,epoch,budget_id,actor,generation_config_intent_id,initialization_run_id,source_kind,sample_policy,gate_formula,bundle_id,profile_claim,settings_descriptor,enabled,minimum_policy_windows,evidence_half_life_windows,pause_confidence,resume_confidence,reset_origin,initialized_at) values($1,'root-funding',1,'root-actor:paper','root-actor','root-config',$3,'prospective-engine-run',$2,'adaptive-fee-edge-window-v1','paper-regime-historical-warm-lineage-v1','synthetic-coverage-profile','regime-settings-v1:true:4:2.5:0.99:0.75',true,4,2.5,0.99,0.75,'none',now())",
      [generationKey, POLICY, initRun],
    );
  const candidate = (generationKey, key, closes, created = CREATED) =>
    admin.unsafe(
      "insert into engine.paper_gate_candidate(candidate_key,candidate_id,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,issuance_run_id,source_kind,symbol,venue,contract_id,side,created_at,closes_at,selected_side_probability,ask_price,estimated_fee_rate,fee_model_version,predicted_net_edge,evidence_version,qualification_receipt_id) values($1,$1,$2,'root-funding',1,'root-actor:paper','root-config',$3,'root-paper-run','prospective-engine-run','BTC','kalshi','synthetic-exact-kalshi-contract','UP',$4::text::timestamptz,$5::text::timestamptz,0.75,0.5,0.0175,'historical-kalshi-continuous-taker-0.07-v1',0.2325,'paper-regime-explicit-evidence-v1','synthetic-not-qualified')",
      [key, generationKey, POLICY, created, closes],
    );
  const outcome = (
    generationKey,
    key,
    candidateKey,
    closes,
    recorded = RECORDED_A,
    resolved = RESOLVED_A,
  ) =>
    admin.unsafe(
      "insert into engine.paper_gate_outcome(outcome_key,candidate_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,closes_at,contract_id,side,resolution_run_id,current_effect_config_intent_id,source_kind,evidence_version,resolution_receipt_id,winner,realized_edge,resolved_at,recorded_at) values($1,$2,$3,'root-funding',1,'root-actor:paper','root-config',$4,$5::text::timestamptz,'synthetic-exact-kalshi-contract','UP','root-paper-run','root-other-config','prospective-engine-run','paper-regime-explicit-evidence-v1','coverage-resolution-receipt','UP',0.4825,$6::text::timestamptz,$7::text::timestamptz)",
      [key, candidateKey, generationKey, POLICY, closes, resolved, recorded],
    );
  const genesisEvent = (generationKey, eventKey, runId = 'root-paper-run') =>
    admin.unsafe(
      "insert into engine.paper_gate_phase_event(event_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,event_kind,revision_after,projected_phase,current_effect_config_intent_id,latest_intent_id,run_id,source_kind,evidence_version,coverage_receipt_id,evidence_observed_at,coverage_cutoff_at,recorded_at,captured_candidate_count,captured_resolved_count,captured_unresolved_count,input_count,summary_resolved_windows,effective_windows) values($1,$2,'root-funding',1,'root-actor:paper','root-config',$3,'genesis',0,'warming','root-other-config','root-config',$8,'prospective-engine-run','paper-regime-explicit-evidence-v1',$4,$5::text::timestamptz,$6::text::timestamptz,$7::text::timestamptz,0,0,0,0,0,0)",
      [
        eventKey,
        generationKey,
        POLICY,
        'coverage-receipt-' + eventKey,
        OBSERVED,
        CUTOFF,
        CUTOFF,
        runId,
      ],
    );
  const evaluatedEvent = (generationKey, eventKey, latestIntent, firstWindow, lastWindow) =>
    admin.unsafe(
      "insert into engine.paper_gate_phase_event(event_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,event_kind,revision_after,prior_event_key,revision_before,previous_phase,result_phase,projected_phase,current_effect_config_intent_id,latest_intent_id,run_id,source_kind,evidence_version,coverage_receipt_id,evidence_observed_at,coverage_cutoff_at,recorded_at,captured_candidate_count,captured_resolved_count,captured_unresolved_count,input_count,universe_first_closes_at,universe_last_closes_at,summary_resolved_windows,effective_windows,weighted_mean_edge,standard_error,negative_return_confidence) values($1,$2,'root-funding',1,'root-actor:paper','root-config',$3,'evaluated',1,$4,0,'warming','open','open','root-other-config',$5,'root-paper-run','prospective-engine-run','paper-regime-explicit-evidence-v1',$6,$7::text::timestamptz,$8::text::timestamptz,$9::text::timestamptz,2,1,1,1,$10::text::timestamptz,$11::text::timestamptz,1,1,0.4825,0.25,0.1)",
      [
        eventKey,
        generationKey,
        POLICY,
        eventKey + '-genesis',
        latestIntent,
        'coverage-receipt-' + eventKey,
        OBSERVED,
        CUTOFF,
        CUTOFF,
        firstWindow,
        lastWindow,
      ],
    );
  const input = (generationKey, eventKey, candidateKey, closes) =>
    admin.unsafe(
      "insert into engine.paper_gate_phase_input(event_key,ordinal,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,revision_after,event_kind,projected_phase,candidate_key,closes_at,contract_id,side) values($1,0,$2,'root-funding',1,'root-actor:paper','root-config',$3,1,'evaluated','open',$4,$5::text::timestamptz,'synthetic-exact-kalshi-contract','UP')",
      [eventKey, generationKey, POLICY, candidateKey, closes],
    );
  const head = (generationKey, eventKey, revision, kind, phase) =>
    admin.unsafe(
      'insert into engine.paper_gate_head(generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,latest_event_key,revision,event_kind,projected_phase) values($1,$2,1,$3,$4,$5,$6,$7,$8,$9)',
      [
        generationKey,
        'root-funding',
        'root-actor:paper',
        'root-config',
        POLICY,
        eventKey,
        revision,
        kind,
        phase,
      ],
    );
  const [newest] = await admin.unsafe(
    'select id from engine.control_intent where capability=$1 order by epoch desc, recorded_at desc, id desc limit 1',
    [CAPABILITY],
  );
  const newestIntentId = newest.id;
  // A second genuine run row, so the genesis run-binding mismatch below is a real
  // mismatch with valid foreign keys rather than a masked FK violation.
  await admin.unsafe(
    "insert into engine.job_run_record(run_id,capability,mode,started_at,outcome,reason) values('coverage-other-run','budget:paper','paper',now(),'applied','synthetic-coverage-other')",
  );

  // One resolved plus one unresolved candidate, with a receipt capturing 2/1/1.
  const buildPair = async (key, eventKey, pendingWindow) => {
    await generation(key);
    await candidate(key, key + '-a', WINDOW_A);
    await candidate(key, key + '-pending', pendingWindow);
    await outcome(key, key + '-a-outcome', key + '-a', WINDOW_A);
    await genesisEvent(key, eventKey + '-genesis');
    await evaluatedEvent(key, eventKey, newestIntentId, WINDOW_A, pendingWindow);
    await input(key, eventKey, key + '-a', WINDOW_A);
    await head(key, eventKey, 1, 'evaluated', 'open');
  };
  await buildPair(EVALUATED, 'cov-eval', WINDOW_PENDING);
  await buildPair(MIDREAD, 'cov-midread', WINDOW_MID);
  await buildPair(SCOPED, 'cov-scoped', WINDOW_MID);
  await generation(GENESIS);
  await genesisEvent(GENESIS, 'cov-genesis-0');
  await head(GENESIS, 'cov-genesis-0', 0, 'genesis', 'warming');
  await generation(HEADLESS);
  await candidate(HEADLESS, 'cov-headless', WINDOW_A);
  // Generation whose declared initialization run is NOT the run that wrote its
  // genesis-shaped row. Both runs exist, so the refusal is the binding, not an FK.
  await generation(RUNBIND, 'coverage-other-run');
  await genesisEvent(RUNBIND, 'cov-runbind-0', 'root-paper-run');
  await head(RUNBIND, 'cov-runbind-0', 0, 'genesis', 'warming');

  const [existingLease] = await admin.unsafe('select count(*)::text as n from engine.job_lease');
  assert.equal(existingLease.n, '0');
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

  const before = await admin.unsafe(
    'select (select count(*) from engine.paper_gate_phase_event) as events, (select count(*) from engine.paper_gate_head) as heads, (select count(*) from engine.paper_gate_candidate) as candidates, (select count(*) from engine.paper_gate_outcome) as outcomes',
  );
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';
  const store = createPostgresGateCoverageStore(writerUrl);
  try {
    // 1. Correct non-empty read through the real adapter.
    const verified = await store.readCoverage(scopeOf(EVALUATED), fence);
    assert.equal(verified.kind, 'verified');
    assert.deepEqual(verified.receipt, {
      protocol: PAPER_GATE_COVERAGE_PROTOCOL,
      scope: scopeOf(EVALUATED),
      headEventKey: 'cov-eval',
      headRevision: 1n,
      eventKind: 'evaluated',
      projectedPhase: 'open',
      coverageReceiptId: 'coverage-receipt-cov-eval',
      coverageCutoffMicroseconds: CUTOFF_US,
      recordedAtMicroseconds: CUTOFF_US,
      evidenceObservedAtIso: OBSERVED,
      lineage: { kind: 'persisted', stateRunId: 'root-paper-run', revision: 1 },
      universeCandidateKeys: [EVALUATED + '-a', EVALUATED + '-pending'],
      resolvedCandidateKeys: [EVALUATED + '-a'],
      unresolvedCandidateKeys: [EVALUATED + '-pending'],
      unresolvedCause: 'unknown',
      universeFirstWindowIso: WINDOW_A,
      universeLastWindowIso: WINDOW_PENDING,
      recordedLatestIntentStillNewest: true,
      fence,
      validity: 'single-transaction-snapshot-only',
      completeness: 'persisted-universe-in-this-snapshot-only',
      replayCompareAndSet: 'not-proved',
    });

    // 2. Genuinely empty generation with a constrained persisted genesis row.
    const genesis = await store.readCoverage(scopeOf(GENESIS), fence);
    assert.equal(genesis.kind, 'verified');
    assert.deepEqual(genesis.receipt.lineage, {
      kind: 'initialized',
      initializationRunId: 'root-paper-run',
      priorGenerationState: 'none',
      revision: 0,
    });
    assert.deepEqual(genesis.receipt.universeCandidateKeys, []);
    assert.equal(genesis.receipt.universeFirstWindowIso, null);
    assert.equal(genesis.receipt.headRevision, 0n);

    // 3. Genesis run binding: the generation's declared initialization run must be the
    // run that wrote the genesis row. Both runs exist, so this is not an FK refusal.
    assert.deepEqual(await store.readCoverage(scopeOf(RUNBIND), fence), {
      kind: 'refused',
      reason: 'lineage',
      detail: 'genesis-run-binding',
    });

    // 4. Genuinely empty WITHOUT a proven lineage: no head, no receipt.
    assert.deepEqual(await store.readCoverage(scopeOf(HEADLESS), fence), {
      kind: 'refused',
      reason: 'head',
      detail: 'missing',
    });
    assert.deepEqual(await store.readCoverage(scopeOf('absent-generation'), fence), {
      kind: 'refused',
      reason: 'generation',
      detail: 'missing',
    });

    // 5. Wrong generation, config, epoch, budget and malformed scope.
    for (const patch of [
      { funding_id: 'other-funding' },
      { generation_config_intent_id: 'root-other-config' },
      { epoch: 2 },
      { budget_id: 'other-actor:paper' },
    ]) {
      const result = await store.readCoverage({ ...scopeOf(EVALUATED), ...patch }, fence);
      assert.equal(result.kind, 'refused');
      assert.equal(result.reason, 'generation');
    }
    for (const bad of [
      {},
      { ...scopeOf(EVALUATED), epoch: 0 },
      { ...scopeOf(EVALUATED), sample_policy: 'x' },
    ])
      assert.deepEqual(await store.readCoverage(bad, fence), {
        kind: 'refused',
        reason: 'scope',
        detail: 'namespace',
      });

    // 6. Stale owner, stale token and an already-expired lease at the START boundary.
    for (const bad of [
      { ...fence, owner: 'other-owner' },
      { ...fence, fencingToken: TOKEN + 1n },
      { ...fence, fencingToken: TOKEN - 1n },
    ])
      assert.deepEqual(await store.readCoverage(scopeOf(EVALUATED), bad), {
        kind: 'refused',
        reason: 'lease-not-held',
        detail: null,
      });
    await admin.unsafe('update engine.job_lease set expires_at=acquired_at where capability=$1', [
      CAPABILITY,
    ]);
    assert.equal(await leaseLive(), false);
    assert.deepEqual(await store.readCoverage(scopeOf(EVALUATED), fence), {
      kind: 'refused',
      reason: 'lease-not-held',
      detail: null,
    });
    await restoreLease();
    assert.equal((await store.readCoverage(scopeOf(EVALUATED), fence)).kind, 'verified');

    // 7. Cutoff scoping against real rows. POSITIVE: a candidate created AFTER the
    // receipt cutoff is outside this receipt's universe, so the older attestation
    // stays verified with its appropriately scoped universe.
    await candidate(SCOPED, SCOPED + '-later', WINDOW_B, POST_CUTOFF);
    const scoped = await store.readCoverage(scopeOf(SCOPED), fence);
    assert.equal(scoped.kind, 'verified');
    assert.deepEqual(scoped.receipt.universeCandidateKeys, [SCOPED + '-a', SCOPED + '-pending']);
    // An outcome recorded after the cutoff leaves its candidate unresolved, not absent.
    await outcome(
      SCOPED,
      SCOPED + '-pending-outcome',
      SCOPED + '-pending',
      WINDOW_MID,
      POST_CUTOFF,
      '2026-10-12T02:30:01.000Z',
    );
    const stillUnresolved = await store.readCoverage(scopeOf(SCOPED), fence);
    assert.equal(stillUnresolved.kind, 'verified');
    assert.deepEqual(stillUnresolved.receipt.unresolvedCandidateKeys, [SCOPED + '-pending']);
    assert.deepEqual(stillUnresolved.receipt.resolvedCandidateKeys, [SCOPED + '-a']);
    // NEGATIVE: a backdated candidate created AT the cutoff that the receipt never
    // captured is inside the universe, so the receipt no longer covers it.
    await candidate(SCOPED, SCOPED + '-backdated', '2026-10-12T03:00:00.000Z', CUTOFF);
    assert.deepEqual(await store.readCoverage(scopeOf(SCOPED), fence), {
      kind: 'refused',
      reason: 'universe-drift',
      detail: 'captured-counts-disagree',
    });
  } finally {
    await store.close();
  }

  // 8. MID-READ barrier. The commit lands BETWEEN two of the adapter's reads: after
  // the head and its event, before the universe. It resolves the unresolved candidate
  // with a pre-cutoff recorded clock, so a READ COMMITTED adapter would read 2/0 and
  // refuse with universe-drift, while one snapshot still reads 1/1 and verifies.
  let midReadRan = false;
  const midStore = createPostgresGateCoverageStore(writerUrl, {
    afterHeadRead: async () => {
      if (midReadRan) return;
      midReadRan = true;
      await outcome(
        MIDREAD,
        MIDREAD + '-pending-outcome',
        MIDREAD + '-pending',
        WINDOW_MID,
        CUTOFF,
        '2026-10-12T02:30:01.000Z',
      );
    },
  });
  try {
    const unmixed = await midStore.readCoverage(scopeOf(MIDREAD), fence);
    assert.equal(midReadRan, true);
    assert.equal(unmixed.kind, 'verified');
    assert.deepEqual(unmixed.receipt.resolvedCandidateKeys, [MIDREAD + '-a']);
    assert.deepEqual(unmixed.receipt.unresolvedCandidateKeys, [MIDREAD + '-pending']);
  } finally {
    await midStore.close();
  }
  const afterMid = createPostgresGateCoverageStore(writerUrl);
  try {
    // The barrier's commit was real and is visible to a FRESH transaction, which now
    // refuses: the pre/post values differ, so the verified read above was not a
    // coincidence of identical state.
    const [resolvedNow] = await admin.unsafe(
      'select count(*)::text as n from engine.paper_gate_outcome o join engine.paper_gate_candidate c on c.candidate_key=o.candidate_key where c.generation_key=$1',
      [MIDREAD],
    );
    assert.equal(resolvedNow.n, '2');
    assert.deepEqual(await afterMid.readCoverage(scopeOf(MIDREAD), fence), {
      kind: 'refused',
      reason: 'universe-drift',
      detail: 'captured-counts-disagree',
    });
  } finally {
    await afterMid.close();
  }

  // 9. Committed lease TAKEOVER between the reads and the final fence. Under
  // repeatable read the locking re-read of a row another transaction has committed
  // over must raise serialization failure 40001; nothing weaker is accepted, so a
  // read-committed adapter cannot pass this.
  let takeoverRan = false;
  const fenceStore = createPostgresGateCoverageStore(writerUrl, {
    beforeFinalFence: async () => {
      if (takeoverRan) return;
      takeoverRan = true;
      await admin.unsafe(
        "update engine.job_lease set owner='takeover-owner',fencing_token=fencing_token+1 where capability=$1",
        [CAPABILITY],
      );
    },
  });
  try {
    const lost = await fenceStore.readCoverage(scopeOf(GENESIS), fence);
    assert.equal(takeoverRan, true);
    assert.deepEqual(lost, {
      kind: 'refused',
      reason: 'lease-lost',
      detail: 'serialization-failure',
    });
  } finally {
    await fenceStore.close();
  }
  await restoreLease();

  // 10. A heartbeat by the SAME owner and token is still a committed update of the
  // row, so the fence fails closed the same way. Recorded as the conservative
  // behaviour it is, not as a desirable one.
  let heartbeatRan = false;
  const heartbeatStore = createPostgresGateCoverageStore(writerUrl, {
    beforeFinalFence: async () => {
      if (heartbeatRan) return;
      heartbeatRan = true;
      await admin.unsafe(
        "update engine.job_lease set heartbeat_at=clock_timestamp(),expires_at=clock_timestamp()+interval '2 hours' where capability=$1 and owner=$2",
        [CAPABILITY, OWNER],
      );
    },
  });
  try {
    const beaten = await heartbeatStore.readCoverage(scopeOf(GENESIS), fence);
    assert.equal(heartbeatRan, true);
    assert.deepEqual(beaten, {
      kind: 'refused',
      reason: 'lease-lost',
      detail: 'serialization-failure',
    });
  } finally {
    await heartbeatStore.close();
  }
  await restoreLease();

  // 11. NATURAL expiry between the reads and the final fence, with no UPDATE at all
  // (an update would raise 40001 instead and prove something else). The lease is
  // genuinely live when the read starts; the barrier waits on the DATABASE clock until
  // it is genuinely expired; the final fence must then refuse.
  const expiryEvidence = {};
  let expiryRan = false;
  const expiryStore = createPostgresGateCoverageStore(writerUrl, {
    beforeFinalFence: async () => {
      if (expiryRan) return;
      expiryRan = true;
      expiryEvidence.liveBeforeWait = await leaseLive();
      for (let i = 0; i < 100; i++) {
        if (!(await leaseLive())) break;
        await delay(50);
      }
      expiryEvidence.liveAfterWait = await leaseLive();
    },
  });
  try {
    await admin.unsafe(
      "update engine.job_lease set expires_at=clock_timestamp()+interval '600 milliseconds' where capability=$1",
      [CAPABILITY],
    );
    assert.equal(await leaseLive(), true);
    const expired = await expiryStore.readCoverage(scopeOf(GENESIS), fence);
    assert.equal(expiryRan, true);
    assert.equal(expiryEvidence.liveBeforeWait, true);
    assert.equal(expiryEvidence.liveAfterWait, false);
    // No UPDATE happened, so this is the expiry path and not the 40001 path.
    assert.deepEqual(expired, {
      kind: 'refused',
      reason: 'lease-lost',
      detail: 'final-boundary',
    });
  } finally {
    await expiryStore.close();
  }
  await restoreLease();

  // 12. Expiry WHILE the final `for update` genuinely WAITS for the lock on an
  // UNCHANGED row. Measured on PostgreSQL 16: that statement's qualification,
  // `clock_timestamp()` included, is evaluated BEFORE the lock wait, so it alone
  // returns an expired lease as live. The adapter therefore re-validates liveness in a
  // separate statement once the lock is held, and THIS vector is what fails without it.
  //
  // The proof is a direct observation, not a callback, a boolean the holder sets about
  // itself, or elapsed time: a separate observer connection watches
  // `pg_blocking_pids()` for the adapter's own backend id and must see it blocked BY
  // the holder's backend id, on the final locking statement, WHILE the lease is still
  // live on the database clock. Only after that observation does the holder wait for
  // the natural expiry and release the row unchanged. If the adapter never blocks,
  // returns early, is blocked by the wrong backend or on the wrong statement, or the
  // lease expires before the observation, the recorded evidence is missing and this
  // vector fails instead of passing by fall-through.
  //
  // BOUNDING, STATED PRECISELY. Every wait below is bounded by a REAL elapsed
  // deadline and by its own connection's `statement_timeout`, never by iteration
  // count: an iteration budget says nothing about elapsed time once query duration and
  // host scheduling are counted. The blocked span the adapter actually experiences is
  // anchored to the fixture lease's ABSOLUTE expiry instant — `LEASE_BUDGET_MS` after
  // the update that sets it — because the holder releases as soon as the DATABASE
  // clock passes that instant; it is not the sum of the diagnostic deadlines. Those
  // deadlines are fail-closed backstops for the case where that never happens, chosen
  // to leave margin under the adapter's unchanged 3000ms `lock_timeout`. This is an
  // engineered margin, NOT a hard real-time guarantee: host scheduling can stretch any
  // of it, and the deliberate property is that when it does, the vector FAILS with the
  // diagnostics below rather than hanging or passing vacuously.
  // The barrier is the shared one in `lease-fence-harness.mjs`, so the proof and the
  // two regressions below exercise exactly the code every other contract uses.
  const lockWaitBarrier = createLeaseFenceHarness({ capability: CAPABILITY, leaseLive, port });

  const lockWait = lockWaitBarrier();
  const lockEvidence = lockWait.evidence;
  const lockStore = createPostgresGateCoverageStore(writerUrl, {
    beforeFinalFence: lockWait.barrier,
  });
  try {
    // Live now, with a budget that must comfortably outlast the observation and still
    // expire well inside the adapter's configured 3000ms lock_timeout and 5000ms
    // statement_timeout, neither of which is changed here.
    await admin.unsafe(
      "update engine.job_lease set expires_at=clock_timestamp()+($2||' milliseconds')::interval where capability=$1",
      [CAPABILITY, String(LEASE_BUDGET_MS)],
    );
    assert.equal(await leaseLive(), true);
    const blockedStartedAt = Date.now();
    const blocked = await lockStore.readCoverage(scopeOf(GENESIS), fence);
    const blockedSpanMs = Date.now() - blockedStartedAt;
    // Flags captured AT read resolution, before any holder or observer cleanup.
    const atResolution = {
      blockedWhileLive: lockEvidence.blockedWhileLive,
      holderError: lockEvidence.holderError,
      observerError: lockEvidence.observerError,
      ran: lockEvidence.ran,
      readerPid: lockEvidence.readerPid,
    };
    await lockEvidence.observer;
    await lockEvidence.holder;
    assert.equal(atResolution.ran, true);
    assert.equal(lockEvidence.liveBeforeBlock, true);
    assert.equal(atResolution.observerError, undefined);
    assert.equal(atResolution.holderError, undefined);
    assert.equal(lockEvidence.lockAcquired, true);
    assert.ok(Number.isInteger(atResolution.readerPid) && atResolution.readerPid > 0);
    assert.ok(Number.isInteger(lockEvidence.holderPid) && lockEvidence.holderPid > 0);
    assert.notEqual(atResolution.readerPid, lockEvidence.holderPid);
    // THE observation: the adapter's own backend was blocked by the holder's backend,
    // on the final locking statement against engine.job_lease, while the lease was
    // still live. Absent this, the vector fails rather than silently proving nothing.
    assert.ok(
      atResolution.blockedWhileLive !== undefined,
      'adapter was never observed blocked by the holder while the lease was live ' +
        lockEvidence.diagnostics(),
    );
    assert.equal(atResolution.blockedWhileLive.blockers, String(lockEvidence.holderPid));
    assert.equal(atResolution.blockedWhileLive.leaseLiveAtObservation, true);
    assert.equal(atResolution.blockedWhileLive.waitEventType, 'Lock');
    // A row-lock wait reports the holder's transaction id, or the tuple itself when
    // several waiters queue; both are this lock wait, nothing else is.
    assert.ok(
      ['transactionid', 'tuple'].includes(atResolution.blockedWhileLive.waitEvent),
      'unexpected wait event ' +
        String(atResolution.blockedWhileLive.waitEvent) +
        ' ' +
        lockEvidence.diagnostics(),
    );
    // The lease then expired naturally, before the unchanged lock was released.
    assert.equal(lockEvidence.expiryWaitSkipped, undefined);
    assert.equal(lockEvidence.expiredBeforeRelease, true);
    assert.equal(await leaseLive(), false);
    // The blocked span really stayed inside the adapter's unchanged lock_timeout, so
    // the margin is measured rather than assumed. It is anchored to the lease's
    // absolute expiry, not to the sum of the diagnostic deadlines.
    assert.ok(
      blockedSpanMs < BLOCKED_SPAN_CEILING_MS,
      'blocked span ' + String(blockedSpanMs) + 'ms ' + lockEvidence.diagnostics(),
    );
    // The lock was released UNCHANGED, so this is not the 40001 path.
    assert.deepEqual(blocked, {
      kind: 'refused',
      reason: 'lease-lost',
      detail: 'final-boundary',
    });
  } finally {
    await lockStore.close();
    await lockWait.dispose();
  }
  await restoreLease();

  // 13 and 14 are focused regressions for the BARRIER ITSELF — the harness code the
  // proof above depends on — not for the adapter. Both faults are harness-only; no
  // production module is altered or fault-injected. Node reports an unhandled
  // rejection on a later turn of the microtask queue, so the collector stays installed
  // across both vectors and is drained before it is asserted.
  const unhandled = [];
  const collectUnhandled = (reason) => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', collectUnhandled);
  try {
    // 13. The holder fails BEFORE it acquires the lock. Previously the holder's catch
    // recorded the error and signalled only the OBSERVED gate, so the barrier's
    // `await locked` never settled: the adapter sat in an open transaction with the
    // contract hanging and nothing to diagnose. It must now settle promptly, preserve
    // the original error, and never start an observation that cannot happen.
    const faulted = lockWaitBarrier({ failBeforeLock: true });
    const faultStore = createPostgresGateCoverageStore(writerUrl, {
      beforeFinalFence: faulted.barrier,
    });
    try {
      const faultStartedAt = Date.now();
      await assert.rejects(
        () => faultStore.readCoverage(scopeOf(GENESIS), fence),
        (error) => {
          // The ORIGINAL error, not a substitute and not a timeout: the adapter
          // rethrows anything that is not a serialization failure.
          assert.equal(error.message, HOLDER_FAULT);
          return true;
        },
      );
      const faultSpanMs = Date.now() - faultStartedAt;
      // Promptly: a hang used to mean the adapter's own 8000ms
      // idle_in_transaction_session_timeout was the only thing that ended the run.
      assert.ok(
        faultSpanMs < BLOCKED_SPAN_CEILING_MS,
        'holder fault took ' + String(faultSpanMs) + 'ms ' + faulted.evidence.diagnostics(),
      );
      assert.equal(faulted.evidence.ran, true);
      assert.equal(faulted.evidence.lockedSettledWithFailure, true);
      assert.equal(faulted.evidence.holderErrorMessage, HOLDER_FAULT);
      // The lock was never taken and no observation was started, so there is no
      // dangling observer promise and no vacuous evidence either.
      assert.equal(faulted.evidence.lockAcquired, undefined);
      assert.equal(faulted.evidence.observer, undefined);
      assert.equal(faulted.evidence.blockedWhileLive, undefined);
      assert.equal(faulted.evidence.observations, 0);
    } finally {
      await faultStore.close();
      await faulted.dispose();
    }
    await restoreLease();

    // 14. The observer never matches. It must stop on its REAL elapsed deadline,
    // release the holder on that path too, surface its diagnostics, and leave the
    // contract running — all well inside the adapter's unchanged 3000ms lock_timeout,
    // which the old iteration-only budget of 200 polls at 25ms could not promise. The
    // blocker it looks for is forced to a value no backend id can take, so the real
    // polling, deadline and cleanup paths run unchanged. The lease is deliberately
    // left long here: the adapter should block, then complete normally once the holder
    // releases, which is what makes the cleanup observable.
    const nonMatch = lockWaitBarrier({ impossibleBlocker: true });
    const nonMatchStore = createPostgresGateCoverageStore(writerUrl, {
      beforeFinalFence: nonMatch.barrier,
    });
    try {
      const nonMatchStartedAt = Date.now();
      const stillVerified = await nonMatchStore.readCoverage(scopeOf(GENESIS), fence);
      const nonMatchSpanMs = Date.now() - nonMatchStartedAt;
      await nonMatch.evidence.observer;
      await nonMatch.evidence.holder;
      assert.equal(nonMatch.evidence.ran, true);
      assert.equal(nonMatch.evidence.lockAcquired, true);
      assert.equal(nonMatch.evidence.holderError, undefined);
      assert.equal(nonMatch.evidence.observerError, undefined);
      // It really polled and really timed out, rather than short-circuiting: the
      // last row is kept for diagnosis even though it never matched.
      assert.ok(
        nonMatch.evidence.observations > 0,
        'observer never polled ' + nonMatch.evidence.diagnostics(),
      );
      assert.notEqual(nonMatch.evidence.lastRow, undefined);
      assert.equal(nonMatch.evidence.observerTimedOut, true);
      assert.equal(nonMatch.evidence.blockedWhileLive, undefined);
      // Bounded by elapsed time: it ran to its deadline and no further than that
      // deadline plus one capped query.
      assert.ok(
        nonMatch.evidence.observeMs >= OBSERVE_DEADLINE_MS,
        'observer stopped early ' + nonMatch.evidence.diagnostics(),
      );
      assert.ok(
        nonMatch.evidence.observeMs <= OBSERVE_DEADLINE_MS + OBSERVE_STATEMENT_TIMEOUT_MS + 500,
        'observer overran ' + nonMatch.evidence.diagnostics(),
      );
      // The holder released on the no-observation path without spending the expiry
      // budget, so the whole blocked span stayed inside the adapter's lock_timeout and
      // the read completed instead of timing out.
      assert.equal(nonMatch.evidence.expiryWaitSkipped, true);
      assert.equal(nonMatch.evidence.expiryWaitMs, undefined);
      assert.ok(
        nonMatchSpanMs < BLOCKED_SPAN_CEILING_MS,
        'non-matching span ' + String(nonMatchSpanMs) + 'ms ' + nonMatch.evidence.diagnostics(),
      );
      assert.equal(stillVerified.kind, 'verified');
    } finally {
      await nonMatchStore.close();
      await nonMatch.dispose();
    }
    await restoreLease();
    // Drain the microtask queue so a rejection that was going to be reported has been.
    await delay(50);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', collectUnhandled);
  }

  // 15. No partial receipt and no write by the adapter. Every row added above came
  // from this contract's own fixture helpers, never from the adapter.
  const after = await admin.unsafe(
    'select (select count(*) from engine.paper_gate_phase_event) as events, (select count(*) from engine.paper_gate_head) as heads, (select count(*) from engine.paper_gate_candidate) as candidates, (select count(*) from engine.paper_gate_outcome) as outcomes',
  );
  assert.equal(Number(after[0].events), Number(before[0].events));
  assert.equal(Number(after[0].heads), Number(before[0].heads));
  // Two fixture candidates for the cutoff vectors; no other candidate row appeared.
  assert.equal(Number(after[0].candidates), Number(before[0].candidates) + 2);
  // Two fixture outcomes: the mid-read barrier's and the post-cutoff one.
  assert.equal(Number(after[0].outcomes), Number(before[0].outcomes) + 2);
  await admin.unsafe('delete from engine.job_lease where capability=$1', [CAPABILITY]);
  // A verified receipt attests the persisted universe in ONE snapshot under a live
  // fence, re-validated after the lock was held. It is a historical read attestation:
  // it does not assert the lease is still live when the caller reads it, does not
  // prove external or historical completeness, does not prove no later row exists,
  // grants no current admission authority, and does not prove any future write will
  // replay or compare-and-set correctly.
}
