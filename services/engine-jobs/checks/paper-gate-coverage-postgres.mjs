// Drives the ACTUAL persisted coverage adapter against disposable fixtures. Reads
// only through `createPostgresGateCoverageStore`; no hand-written equivalent SQL
// stands in for it. Synthetic rows in existing approved tables only: no migration,
// no new grant, no production write, no account or money truth.
import assert from 'node:assert/strict';
import process from 'node:process';
import { createPostgresGateCoverageStore } from '../dist/adapters/engine-store/postgres-gate-coverage-store.js';
import { PAPER_GATE_COVERAGE_PROTOCOL } from '../dist/domain/paper-gate-coverage.js';

const POLICY = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
const CAPABILITY = 'budget:paper';
const OWNER = 'coverage-owner';
const TOKEN = 7n;
// Independent literal fixture instants and their exact microsecond equivalents.
const CREATED = '2026-10-12T02:00:00.000Z';
const WINDOW_A = '2026-10-12T02:15:00.000Z';
const RESOLVED_A = '2026-10-12T02:15:01.000Z';
const RECORDED_A = '2026-10-12T02:15:02.000Z';
const OBSERVED = '2026-10-12T02:30:01.000Z';
const CUTOFF = '2026-10-12T02:30:02.000Z';
const WINDOW_PENDING = '2030-01-01T00:00:00.000Z';
const CUTOFF_US = 1791772202000000n;
const EVALUATED = 'coverage-evaluated-generation';
const GENESIS = 'coverage-genesis-generation';
const HEADLESS = 'coverage-headless-generation';

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
  const generation = (generationKey) =>
    admin.unsafe(
      "insert into engine.paper_gate_generation(generation_key,funding_id,epoch,budget_id,actor,generation_config_intent_id,initialization_run_id,source_kind,sample_policy,gate_formula,bundle_id,profile_claim,settings_descriptor,enabled,minimum_policy_windows,evidence_half_life_windows,pause_confidence,resume_confidence,reset_origin,initialized_at) values($1,'root-funding',1,'root-actor:paper','root-actor','root-config','root-paper-run','prospective-engine-run',$2,'adaptive-fee-edge-window-v1','paper-regime-historical-warm-lineage-v1','synthetic-coverage-profile','regime-settings-v1:true:4:2.5:0.99:0.75',true,4,2.5,0.99,0.75,'none',now())",
      [generationKey, POLICY],
    );
  const candidate = (generationKey, key, display, closes) =>
    admin.unsafe(
      "insert into engine.paper_gate_candidate(candidate_key,candidate_id,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,issuance_run_id,source_kind,symbol,venue,contract_id,side,created_at,closes_at,selected_side_probability,ask_price,estimated_fee_rate,fee_model_version,predicted_net_edge,evidence_version,qualification_receipt_id) values($1,$2,$3,'root-funding',1,'root-actor:paper','root-config',$4,'root-paper-run','prospective-engine-run','BTC','kalshi','synthetic-exact-kalshi-contract','UP',$5::text::timestamptz,$6::text::timestamptz,0.75,0.5,0.0175,'historical-kalshi-continuous-taker-0.07-v1',0.2325,'paper-regime-explicit-evidence-v1','synthetic-not-qualified')",
      [key, display, generationKey, POLICY, CREATED, closes],
    );
  const outcome = (generationKey, key, candidateKey, closes) =>
    admin.unsafe(
      "insert into engine.paper_gate_outcome(outcome_key,candidate_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,closes_at,contract_id,side,resolution_run_id,current_effect_config_intent_id,source_kind,evidence_version,resolution_receipt_id,winner,realized_edge,resolved_at,recorded_at) values($1,$2,$3,'root-funding',1,'root-actor:paper','root-config',$4,$5::text::timestamptz,'synthetic-exact-kalshi-contract','UP','root-paper-run','root-other-config','prospective-engine-run','paper-regime-explicit-evidence-v1','coverage-resolution-receipt','UP',0.4825,$6::text::timestamptz,$7::text::timestamptz)",
      [key, candidateKey, generationKey, POLICY, closes, RESOLVED_A, RECORDED_A],
    );
  const genesisEvent = (generationKey, eventKey, latestIntent) =>
    admin.unsafe(
      "insert into engine.paper_gate_phase_event(event_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,event_kind,revision_after,projected_phase,current_effect_config_intent_id,latest_intent_id,run_id,source_kind,evidence_version,coverage_receipt_id,evidence_observed_at,coverage_cutoff_at,recorded_at,captured_candidate_count,captured_resolved_count,captured_unresolved_count,input_count,summary_resolved_windows,effective_windows) values($1,$2,'root-funding',1,'root-actor:paper','root-config',$3,'genesis',0,'warming','root-other-config',$4,'root-paper-run','prospective-engine-run','paper-regime-explicit-evidence-v1',$5,$6::text::timestamptz,$7::text::timestamptz,$8::text::timestamptz,0,0,0,0,0,0)",
      [
        eventKey,
        generationKey,
        POLICY,
        latestIntent,
        'coverage-receipt-' + eventKey,
        OBSERVED,
        CUTOFF,
        CUTOFF,
      ],
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
  // The lease the fence proves. engine.job_lease is empty at this point in the
  // contract order; assert that rather than share or overwrite another check's lease,
  // and remove the row again at the end so the later cycle acquisition is unaffected.
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

  // Evaluated generation: one resolved and one unresolved candidate.
  await generation(EVALUATED);
  await candidate(EVALUATED, 'cov-a', 'cov-a-display', WINDOW_A);
  await candidate(EVALUATED, 'cov-pending', 'cov-pending-display', WINDOW_PENDING);
  await outcome(EVALUATED, 'cov-a-outcome', 'cov-a', WINDOW_A);
  await genesisEvent(EVALUATED, 'cov-eval-genesis', 'root-config');
  await admin.unsafe(
    "insert into engine.paper_gate_phase_event(event_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,event_kind,revision_after,prior_event_key,revision_before,previous_phase,result_phase,projected_phase,current_effect_config_intent_id,latest_intent_id,run_id,source_kind,evidence_version,coverage_receipt_id,evidence_observed_at,coverage_cutoff_at,recorded_at,captured_candidate_count,captured_resolved_count,captured_unresolved_count,input_count,universe_first_closes_at,universe_last_closes_at,summary_resolved_windows,effective_windows,weighted_mean_edge,standard_error,negative_return_confidence) values('cov-eval-1',$1,'root-funding',1,'root-actor:paper','root-config',$2,'evaluated',1,'cov-eval-genesis',0,'warming','open','open','root-other-config',$3,'root-paper-run','prospective-engine-run','paper-regime-explicit-evidence-v1','coverage-receipt-1',$4::text::timestamptz,$5::text::timestamptz,$6::text::timestamptz,2,1,1,1,$7::text::timestamptz,$8::text::timestamptz,1,1,0.4825,0.25,0.1)",
    [EVALUATED, POLICY, newestIntentId, OBSERVED, CUTOFF, CUTOFF, WINDOW_A, WINDOW_PENDING],
  );
  await admin.unsafe(
    "insert into engine.paper_gate_phase_input(event_key,ordinal,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,revision_after,event_kind,projected_phase,candidate_key,closes_at,contract_id,side) values('cov-eval-1',0,$1,'root-funding',1,'root-actor:paper','root-config',$2,1,'evaluated','open','cov-a',$3::text::timestamptz,'synthetic-exact-kalshi-contract','UP')",
    [EVALUATED, POLICY, WINDOW_A],
  );
  await head(EVALUATED, 'cov-eval-1', 1, 'evaluated', 'open');

  // Genesis generation: a constrained genesis row and no candidates at all.
  await generation(GENESIS);
  await genesisEvent(GENESIS, 'cov-genesis-0', 'root-config');
  await head(GENESIS, 'cov-genesis-0', 0, 'genesis', 'warming');

  // Headless generation: real candidates, no head. Absence must refuse, never
  // synthesise a genesis.
  await generation(HEADLESS);
  await candidate(HEADLESS, 'cov-headless', 'cov-headless-display', WINDOW_A);

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
      headEventKey: 'cov-eval-1',
      headRevision: 1n,
      eventKind: 'evaluated',
      projectedPhase: 'open',
      coverageReceiptId: 'coverage-receipt-1',
      coverageCutoffMicroseconds: CUTOFF_US,
      recordedAtMicroseconds: CUTOFF_US,
      evidenceObservedAtIso: OBSERVED,
      lineage: { kind: 'persisted', stateRunId: 'root-paper-run', revision: 1 },
      universeCandidateKeys: ['cov-a', 'cov-pending'],
      resolvedCandidateKeys: ['cov-a'],
      unresolvedCandidateKeys: ['cov-pending'],
      unresolvedCause: 'unknown',
      universeFirstWindowIso: WINDOW_A,
      universeLastWindowIso: WINDOW_PENDING,
      recordedLatestIntentStillNewest: true,
      fence,
      validity: 'single-transaction-snapshot-only',
      completeness: 'persisted-universe-in-this-snapshot-only',
      replayCompareAndSet: 'not-proved',
    });

    // 2. Genuinely empty generation with a PROVEN persisted genesis lineage.
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
    assert.equal(genesis.receipt.universeLastWindowIso, null);
    assert.equal(genesis.receipt.headRevision, 0n);
    assert.equal(genesis.receipt.recordedLatestIntentStillNewest, 'root-config' === newestIntentId);

    // 3. Genuinely empty WITHOUT a proven lineage: no head, so no receipt.
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

    // 4. Wrong generation, config, epoch, budget, funding and policy.
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

    // 5. Stale owner, stale token and an expired lease, all at the start boundary.
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
    assert.deepEqual(await store.readCoverage(scopeOf(EVALUATED), fence), {
      kind: 'refused',
      reason: 'lease-not-held',
      detail: null,
    });
    await restoreLease();
    assert.equal((await store.readCoverage(scopeOf(EVALUATED), fence)).kind, 'verified');
  } finally {
    await store.close();
  }

  // 6. No query mix. An explicit barrier commits a NEW candidate from another
  // connection after the snapshot is taken; the repeatable-read snapshot must not
  // see it, so the same read still verifies the pre-existing universe.
  let barrierRan = false;
  const mixStore = createPostgresGateCoverageStore(writerUrl, {
    afterSnapshot: async () => {
      if (barrierRan) return;
      barrierRan = true;
      await candidate(EVALUATED, 'cov-late', 'cov-late-display', '2026-10-12T02:45:00.000Z');
    },
  });
  try {
    const unmixed = await mixStore.readCoverage(scopeOf(EVALUATED), fence);
    assert.equal(barrierRan, true);
    assert.equal(unmixed.kind, 'verified');
    // Still the two-candidate universe: the committed insert was invisible.
    assert.deepEqual(unmixed.receipt.universeCandidateKeys, ['cov-a', 'cov-pending']);
  } finally {
    await mixStore.close();
  }

  const driftStore = createPostgresGateCoverageStore(writerUrl);
  try {
    // 7. A fresh transaction sees the extra candidate, so the receipt no longer
    // covers the universe and fails closed instead of reporting stale completeness.
    assert.deepEqual(await driftStore.readCoverage(scopeOf(EVALUATED), fence), {
      kind: 'refused',
      reason: 'universe-drift',
      detail: 'captured-counts-disagree',
    });
  } finally {
    await driftStore.close();
  }

  // 8. Final-boundary fence loss. The barrier commits a lease takeover; the locked
  // re-read must abort the whole transaction, returning no receipt.
  let takeoverRan = false;
  const fenceStore = createPostgresGateCoverageStore(writerUrl, {
    afterSnapshot: async () => {
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
    assert.equal(lost.kind, 'refused');
    assert.equal(lost.reason, 'lease-lost');
    assert.ok(lost.detail === 'serialization-failure' || lost.detail === 'final-boundary');
  } finally {
    await fenceStore.close();
  }
  await restoreLease();

  // 9. No partial receipt and no write: the only row change across the whole
  // contract is the barrier's own fixture candidate.
  const after = await admin.unsafe(
    'select (select count(*) from engine.paper_gate_phase_event) as events, (select count(*) from engine.paper_gate_head) as heads, (select count(*) from engine.paper_gate_candidate) as candidates, (select count(*) from engine.paper_gate_outcome) as outcomes',
  );
  assert.equal(Number(after[0].events), Number(before[0].events));
  assert.equal(Number(after[0].heads), Number(before[0].heads));
  assert.equal(Number(after[0].candidates), Number(before[0].candidates) + 1);
  assert.equal(Number(after[0].outcomes), Number(before[0].outcomes));
  // Restore an empty lease table for the later cycle acquisition.
  await admin.unsafe('delete from engine.job_lease where capability=$1', [CAPABILITY]);
  // A verified receipt proves the persisted universe in ONE snapshot under a live
  // fence. It does not prove external or historical completeness, that no later row
  // exists, current admission authority, or that any future write will replay or
  // compare-and-set correctly.
}
