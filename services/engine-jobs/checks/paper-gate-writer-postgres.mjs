// Drives the ACTUAL atomic paper-gate writer against disposable fixtures. Writes only
// through `createPostgresPaperGateWriter` and the test-only audited-policy factory under
// `src/test-support/`; no hand-written equivalent SQL stands in for either. Synthetic
// rows in existing approved tables only: no migration, no new grant, no production
// write, no account or money truth. Every cent and edge value below is a disposable
// fixture number.
//
// Timing: the fence vectors need real elapsed time, because the thing under test is the
// DATABASE clock passing a lease expiry. They use the shared `lease-fence-harness.mjs`
// barrier rather than a second copy of fragile timing logic. Every other interleaving
// uses an explicit barrier with no timing at all: a concurrent writer or recorder is run
// to completion inside a seam, so the ordering is deterministic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import {
  BLOCKED_SPAN_CEILING_MS,
  LEASE_BUDGET_MS,
  createLeaseFenceHarness,
} from './lease-fence-harness.mjs';
import { createPostgresPaperGateWriter } from '../dist/adapters/engine-store/postgres-paper-gate-writer.js';
// Two artifacts, one real adapter. The PRODUCTION factory comes from `dist`, which is
// what the Dockerfile copies; the positive path comes from the separate
// `dist-test-support` artifact, compiled from the same source with the one admission-gate
// file replaced, and is unlocked only by the identity-bound fixture symbol that lives
// solely in that artifact. There is no availability-taking export in either.
import { createPostgresPaperGateWriter as createTestArtifactPaperGateWriter } from '../dist-test-support/adapters/engine-store/postgres-paper-gate-writer.js';
import { AUDITED_POLICY_FIXTURE } from '../dist-test-support/test-support/paper-gate-audited-policy-fixture.js';
import { createPostgresGateCoverageStore } from '../dist/adapters/engine-store/postgres-gate-coverage-store.js';

const CAPABILITY = 'budget:paper';
// Epoch 11 dominates every earlier fixture epoch under `epoch desc`, so these vectors
// never depend on another contract's ordering.
const EPOCH = 11;
const ACTOR = 'writer-actor';
const BUDGET = ACTOR + ':paper';
const FUNDING = 'writer-funding';
const OWNER = 'writer-owner';
const TOKEN = 5n;
const RUN = 'root-paper-run';
const CONFIG_INTENT = 'writer-config';
const POLICY = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
const BUNDLE = 'paper-regime-historical-warm-lineage-v1';
const GEN = 'writer-generation';
const GEN_RESET = 'writer-generation-post-reset';
const T_CONFIG = '2026-10-12 01:00:00.000000+00';
const T_RESET = '2026-10-12 01:30:00.000000+00';
const T_CONFIG_2 = '2026-10-12 01:45:00.000000+00';
const T_RESET_2 = '2026-10-12 01:50:00.000000+00';
const T_CONFIG_3 = '2026-10-12 01:55:00.000000+00';
const T_RESET_3 = '2026-10-12 02:05:00.000000+00';
const T_CONFIG_4 = '2026-10-12 02:10:00.000000+00';
const OBSERVED_ISO = '2026-10-14T00:00:00.000Z';
const CUTOFF_ISO = '2026-10-14T00:00:00.000Z';
// Four 15 minute windows from 2026-10-12T02:15:00Z, all before the cutoff above.
const WINDOWS = [
  '2026-10-12T02:15:00.000Z',
  '2026-10-12T02:30:00.000Z',
  '2026-10-12T02:45:00.000Z',
  '2026-10-12T03:00:00.000Z',
  '2026-10-12T03:15:00.000Z',
];
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
  bundleId: BUNDLE,
  enabled: true,
  evidenceHalfLifeWindows: '2.5',
  minimumPolicyWindows: 4,
  pauseConfidence: '0.99',
  profileClaim: 'synthetic-writer-profile',
  resumeConfidence: '0.75',
};

export async function paperGateWriterPostgresContract(admin, port) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(/^\d+$/.test(String(port)));
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';
  const scopeOf = (generationKey) => ({
    budget_id: BUDGET,
    epoch: EPOCH,
    funding_id: FUNDING,
    generation_config_intent_id: CONFIG_INTENT,
    generation_key: generationKey,
    sample_policy: POLICY,
  });
  const fence = { capability: CAPABILITY, owner: OWNER, fencingToken: TOKEN };

  const counts = () =>
    admin.unsafe(
      'select (select count(*) from engine.paper_gate_generation) as generations, (select count(*) from engine.paper_gate_phase_event) as events, (select count(*) from engine.paper_gate_phase_input) as inputs, (select count(*) from engine.paper_gate_head) as heads, (select count(*) from engine.job_lease) as leases',
    );
  const before = await counts();
  assert.equal(Number(before[0].leases), 0);
  const [bandAbove] = await admin.unsafe(
    'select count(*)::text as n from engine.control_intent where capability=$1 and epoch>=$2',
    [CAPABILITY, EPOCH],
  );
  assert.equal(bandAbove.n, '0');

  const intent = (id, action, recordedAt, parameters, actor = ACTOR, epoch = EPOCH) =>
    admin.unsafe(
      'insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters) values($1,$2,$3,$4,$5,$6::text::timestamptz,$7,$8::text::jsonb)',
      [id, CAPABILITY, action, actor, epoch, recordedAt, RUN, JSON.stringify(parameters)],
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
  const clearVectorIntents = () =>
    admin.unsafe('delete from engine.control_intent where capability=$1 and epoch>=$2 and id<>$3', [
      CAPABILITY,
      EPOCH,
      CONFIG_INTENT,
    ]);
  /** The exact persisted state every refusal must leave untouched. */
  const stateSnapshot = async () => {
    const rows = await admin.unsafe(
      'select (select coalesce(json_agg(g order by g.generation_key)::text,$$[]$$) from engine.paper_gate_generation g) as generations, (select coalesce(json_agg(e order by e.event_key)::text,$$[]$$) from engine.paper_gate_phase_event e) as events, (select coalesce(json_agg(i order by i.event_key,i.ordinal)::text,$$[]$$) from engine.paper_gate_phase_input i) as inputs, (select coalesce(json_agg(h order by h.generation_key)::text,$$[]$$) from engine.paper_gate_head h) as heads',
    );
    return rows[0];
  };
  const refusal = async (result, reason, detail, baseline) => {
    assert.deepEqual(
      { detail: result.detail, kind: result.kind, reason: result.reason },
      { detail, kind: 'refused', reason },
    );
    // No evidence ever escapes a refusal.
    assert.equal(Object.hasOwn(result, 'receipt'), false);
    if (baseline !== undefined) assert.deepEqual(await stateSnapshot(), baseline);
  };
  /** Assertion messages only. A receipt carries bigint revisions, which `JSON.stringify`
   * refuses, so they are rendered as text rather than serialized wholesale. */
  const describe = (result) =>
    JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));

  const requestOf = (over = {}) => ({
    coverageCutoffAtIso: CUTOFF_ISO,
    coverageReceiptId: 'writer-receipt',
    evidenceObservedAtIso: OBSERVED_ISO,
    eventKey: 'writer-genesis',
    generation: GENERATION_INPUTS,
    kind: 'initialize',
    runId: RUN,
    scope: scopeOf(GEN),
    ...over,
  });

  const production = createPostgresPaperGateWriter(writerUrl);
  /** The positive path, from the test-support ARTIFACT, unlocked by the identity-bound
   * fixture. The same call against the `dist` factory refuses, which vector 0 proves. */
  const auditedWriter = (effects) =>
    createTestArtifactPaperGateWriter(writerUrl, effects, AUDITED_POLICY_FIXTURE);
  const audited = auditedWriter();
  const coverage = createPostgresGateCoverageStore(writerUrl);
  try {
    const empty = await stateSnapshot();

    // 0. THE ARTIFACT BOUNDARY, executed rather than asserted in prose.
    //
    // The production module exports exactly the intended factory and nothing that takes
    // availability; the fixture is physically absent from `dist`; the `dist` gate refuses
    // the GENUINE fixture and refuses forged values; and the image copies only `dist`.
    const prodWriterModule =
      await import('../dist/adapters/engine-store/postgres-paper-gate-writer.js');
    assert.deepEqual(Object.keys(prodWriterModule).sort(), ['createPostgresPaperGateWriter']);
    const prodGate =
      await import('../dist/adapters/engine-store/paper-gate-audited-policy-gate.js');
    // No token exists in the shipped artifact, so nothing can be it.
    assert.equal(prodGate.AUDITED_POLICY_ADMISSION, undefined);
    assert.equal(prodGate.grantsAuditedPolicy(AUDITED_POLICY_FIXTURE), false);
    for (const forged of [
      Symbol('paper-gate-audited-policy-fixture'),
      Symbol.for('paper-gate-audited-policy-fixture'),
      {},
      true,
      'paper-gate-audited-policy-fixture',
    ])
      assert.equal(prodGate.grantsAuditedPolicy(forged), false);
    // The test artifact's gate is the ONLY one that holds a token, and it is bound to the
    // fixture's identity: a forged symbol of the same description is refused.
    const testGate =
      await import('../dist-test-support/adapters/engine-store/paper-gate-audited-policy-gate.js');
    assert.equal(testGate.grantsAuditedPolicy(AUDITED_POLICY_FIXTURE), true);
    assert.equal(testGate.grantsAuditedPolicy(Symbol('paper-gate-audited-policy-fixture')), false);
    assert.equal(testGate.grantsAuditedPolicy({}), false);
    assert.equal(testGate.grantsAuditedPolicy(true), false);
    // The test artifact exports the same single factory: it is the same adapter source,
    // not a surrogate.
    const testWriterModule =
      await import('../dist-test-support/adapters/engine-store/postgres-paper-gate-writer.js');
    assert.deepEqual(Object.keys(testWriterModule).sort(), ['createPostgresPaperGateWriter']);
    // The fixture and the test gate are not in the production artifact at all.
    for (const absent of [
      '../dist/test-support/paper-gate-audited-policy-fixture.js',
      '../dist/test-support/paper-gate-audited-policy-gate.test-artifact.js',
    ])
      await assert.rejects(
        () => import(absent),
        (error) => {
          assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
          return true;
        },
      );
    // The image copies `dist` and nothing else from the project, and the support artifact
    // is ignored by the build context.
    const dockerfile = readFileSync('services/engine-jobs/Dockerfile', 'utf8');
    const copies = dockerfile
      .split('\n')
      .filter((line) => line.startsWith('COPY') && line.includes('services/engine-jobs'));
    assert.ok(copies.length > 0, 'no project COPY lines found');
    for (const line of copies) assert.equal(line.includes('dist-test-support'), false);
    assert.ok(
      copies.some((line) => line.includes('/services/engine-jobs/dist ')),
      'the image must copy the production dist',
    );
    const dockerignore = readFileSync('.dockerignore', 'utf8').split('\n');
    assert.ok(dockerignore.includes('**/dist-test-support'));
    assert.ok(dockerignore.includes('**/.test-support-src'));

    // 1. Request, scope and fence are refused BEFORE any statement runs.
    for (const [over, reason] of [
      [{ scope: { ...scopeOf(GEN), epoch: 0 } }, 'scope'],
      [{ scope: { ...scopeOf(GEN), epoch: 1.5 } }, 'scope'],
      [{ scope: { ...scopeOf(GEN), generation_key: ' bad' } }, 'scope'],
      [{ eventKey: '' }, 'request'],
      [{ runId: ' bad' }, 'request'],
      [{ coverageReceiptId: '' }, 'request'],
      [{ evidenceObservedAtIso: '2026-10-14T00:00:00Z' }, 'request'],
      [{ generation: { ...GENERATION_INPUTS, pauseConfidence: '0.5' } }, 'request'],
      [{ generation: { ...GENERATION_INPUTS, minimumPolicyWindows: 3 } }, 'request'],
    ])
      await refusal(await audited.write(requestOf(over), fence), reason, reason, empty);
    for (const badFence of [
      { ...fence, owner: '' },
      { ...fence, fencingToken: 0n },
      { ...fence, fencingToken: 5 },
    ])
      await refusal(await audited.write(requestOf(), badFence), 'scope', 'scope', empty);

    // 2. The start fence. A wrong owner, a wrong token and an expired lease all refuse
    // with nothing written.
    for (const wrong of [
      { ...fence, owner: 'not-the-owner' },
      { ...fence, fencingToken: TOKEN + 1n },
    ])
      await refusal(
        await audited.write(requestOf(), wrong),
        'lease-not-held',
        'start-boundary',
        empty,
      );
    // `job_lease` checks `expires_at >= acquired_at`, so an already expired lease has to
    // move both columns back rather than only the expiry.
    await admin.unsafe(
      "update engine.job_lease set acquired_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' where capability=$1",
      [CAPABILITY],
    );
    await refusal(
      await audited.write(requestOf(), fence),
      'lease-not-held',
      'start-boundary',
      empty,
    );
    await restoreLease();

    // 3. The run record must exist and name this capability.
    await refusal(
      await audited.write(requestOf({ runId: 'no-such-run' }), fence),
      'run-record',
      'run-binding',
      empty,
    );
    await admin.unsafe(
      "insert into engine.job_run_record(run_id,capability,mode,started_at,outcome,reason) values('writer-foreign-run','budget:forecast','forecast',now(),'applied','synthetic-writer-foreign')",
    );
    await admin.unsafe(
      "insert into engine.job_run_record(run_id,capability,mode,started_at,outcome,reason) values('writer-alt-run','budget:paper','paper',now(),'applied','synthetic-writer-alt')",
    );
    await refusal(
      await audited.write(requestOf({ runId: 'writer-foreign-run' }), fence),
      'run-record',
      'run-binding',
      empty,
    );

    // 4. THE PRODUCTION WRITER REFUSES. Availability is compiled false and the factory
    // exposes no way to change it, so an otherwise entirely valid record is refused for
    // the unavailable bundle and writes nothing.
    await refusal(
      await production.write(requestOf(), fence),
      'authority',
      'bundle-unavailable',
      empty,
    );

    // 5. Genesis, through the test-only audited-policy factory. Revision is EXACTLY 0,
    // the phase is warming, and the event's run id is the generation's own
    // initialization run.
    const genesis = await audited.write(requestOf(), fence);
    assert.equal(genesis.kind, 'written', describe(genesis));
    assert.equal(genesis.receipt.protocol, 'paper-gate-persisted-write-result-v1');
    assert.equal(genesis.receipt.lifetime, 'committed-write-record-not-standing-authority');
    assert.equal(genesis.receipt.admission, 'none');
    assert.equal(genesis.receipt.authority, 'validated-in-this-transaction');
    assert.equal(genesis.receipt.eventKind, 'genesis');
    assert.equal(genesis.receipt.revisionAfter, 0n);
    assert.equal(genesis.receipt.revisionBefore, undefined);
    assert.equal(genesis.receipt.projectedPhase, 'warming');
    assert.equal(genesis.receipt.generationCreated, true);
    assert.equal(genesis.receipt.headMoved, true);
    assert.equal(genesis.receipt.boundConfigureIntentId, CONFIG_INTENT);
    const [persistedGenesis] = await admin.unsafe(
      'select e.revision_after::text as revision, e.projected_phase, e.event_kind, e.run_id, e.prior_event_key, e.revision_before, g.initialization_run_id, g.reset_origin, g.reset_barrier_intent_id, g.settings_descriptor, h.revision::text as head_revision, h.latest_event_key from engine.paper_gate_phase_event e join engine.paper_gate_generation g on g.generation_key=e.generation_key join engine.paper_gate_head h on h.generation_key=e.generation_key where e.event_key=$1',
      ['writer-genesis'],
    );
    assert.equal(persistedGenesis.revision, '0');
    assert.equal(persistedGenesis.projected_phase, 'warming');
    assert.equal(persistedGenesis.event_kind, 'genesis');
    assert.equal(persistedGenesis.prior_event_key, null);
    assert.equal(persistedGenesis.revision_before, null);
    // The genesis run binding the coverage reader requires.
    assert.equal(persistedGenesis.run_id, RUN);
    assert.equal(persistedGenesis.initialization_run_id, RUN);
    assert.equal(persistedGenesis.reset_origin, 'none');
    assert.equal(persistedGenesis.reset_barrier_intent_id, null);
    // The descriptor the server wrote is the settings identity of its own columns.
    assert.equal(persistedGenesis.settings_descriptor, 'regime-settings-v1:true:4:2.5:0.99:0.75');
    assert.equal(persistedGenesis.head_revision, '0');
    assert.equal(persistedGenesis.latest_event_key, 'writer-genesis');
    // Scoped to this generation: earlier contracts in the chain have their own input
    // rows, and a global count would be measuring them.
    assert.equal(
      (
        await admin.unsafe(
          'select count(*)::text as n from engine.paper_gate_phase_input where generation_key=$1',
          [GEN],
        )
      )[0].n,
      '0',
    );

    // 6. The independent coverage READER accepts this revision 0 genesis lineage.
    const read = await coverage.readCoverage(scopeOf(GEN), fence);
    assert.equal(read.kind, 'verified', describe(read));
    assert.equal(read.receipt.headRevision, 0n);
    assert.equal(read.receipt.eventKind, 'genesis');
    assert.equal(read.receipt.projectedPhase, 'warming');
    // The reader's own lineage: a genuine initialization at revision 0, bound to the
    // run the writer recorded.
    assert.deepEqual(read.receipt.lineage, {
      initializationRunId: RUN,
      kind: 'initialized',
      priorGenerationState: 'none',
      revision: 0,
    });

    const afterGenesis = await stateSnapshot();

    // 7. Replay. An exactly equal request is idempotent and has no duplicate effect; a
    // changed field refuses and names it.
    const replay = await audited.write(requestOf(), fence);
    assert.equal(replay.kind, 'replayed', describe(replay));
    assert.equal(replay.receipt.authority, 'not-evaluated-on-replay');
    assert.equal(replay.receipt.generationCreated, false);
    assert.equal(replay.receipt.headMoved, false);
    assert.deepEqual(await stateSnapshot(), afterGenesis);
    for (const [over, field] of [
      // The GENERATION comparison runs first on a genesis replay, so a changed run id is
      // reported against the generation's own initialization run.
      [{ runId: 'writer-alt-run' }, 'initialization_run_id'],
      [{ coverageReceiptId: 'other-receipt' }, 'coverage_receipt_id'],
      [{ evidenceObservedAtIso: '2026-10-13T00:00:00.000Z' }, 'evidence_observed_at'],
      [{ coverageCutoffAtIso: '2026-10-13T00:00:00.000Z' }, 'coverage_cutoff_at'],
      // A changed namespace names a generation that does not exist, so there is nothing
      // to compare against and the refusal says so rather than guessing a field.
      [{ scope: { ...scopeOf(GEN), funding_id: 'other-funding' } }, 'generation'],
    ])
      await refusal(
        await audited.write(requestOf(over), fence),
        'replay-mismatch',
        field,
        afterGenesis,
      );
    // A second genesis for the SAME generation under a NEW event key is not a replay.
    await refusal(
      await audited.write(requestOf({ eventKey: 'writer-genesis-2' }), fence),
      'generation-exists',
      'present',
      afterGenesis,
    );

    // 8. Reset creates a properly authorized FRESH generation and never mutates history.
    // A barrier that is not a reset, is not ordered after the prior configure, or names
    // another namespace all refuse.
    await intent('writer-reset', 'reset', T_RESET, {});
    await intent('writer-config-2', 'configure', T_CONFIG_2, CONFIG);
    const resetRequest = (over = {}) =>
      requestOf({
        eventKey: 'writer-reset-genesis',
        kind: 'reset',
        priorGenerationKey: GEN,
        resetBarrierIntentId: 'writer-reset',
        scope: { ...scopeOf(GEN_RESET), generation_config_intent_id: 'writer-config-2' },
        ...over,
      });
    for (const over of [
      { resetBarrierIntentId: CONFIG_INTENT },
      { resetBarrierIntentId: 'writer-config-2' },
      { priorGenerationKey: 'no-such-generation' },
    ])
      await refusal(
        await audited.write(resetRequest(over), fence),
        'reset-barrier',
        'barrier-ordering',
        afterGenesis,
      );
    const reset = await audited.write(resetRequest(), fence);
    assert.equal(reset.kind, 'written', describe(reset));
    assert.equal(reset.receipt.revisionAfter, 0n);
    assert.equal(reset.receipt.generationCreated, true);
    const [resetRow] = await admin.unsafe(
      'select reset_origin,reset_barrier_intent_id,initialization_run_id from engine.paper_gate_generation where generation_key=$1',
      [GEN_RESET],
    );
    assert.equal(resetRow.reset_origin, 'post-reset');
    assert.equal(resetRow.reset_barrier_intent_id, 'writer-reset');
    assert.equal(resetRow.initialization_run_id, RUN);
    // History is untouched: the prior generation, its event and its head are unchanged.
    const [prior] = await admin.unsafe(
      'select g.reset_origin, e.revision_after::text as revision, h.revision::text as head_revision, h.latest_event_key from engine.paper_gate_generation g join engine.paper_gate_phase_event e on e.generation_key=g.generation_key join engine.paper_gate_head h on h.generation_key=g.generation_key where g.generation_key=$1',
      [GEN],
    );
    assert.deepEqual(prior, {
      head_revision: '0',
      latest_event_key: 'writer-genesis',
      reset_origin: 'none',
      revision: '0',
    });

    // The post-reset generation is now the one under test; its configure intent is the
    // newest, so it is the authority the writer binds.
    const resetScope = { ...scopeOf(GEN_RESET), generation_config_intent_id: 'writer-config-2' };
    const evaluateRequest = (over = {}) => ({
      coverageCutoffAtIso: CUTOFF_ISO,
      coverageReceiptId: 'writer-receipt',
      evidenceObservedAtIso: OBSERVED_ISO,
      eventKey: 'writer-eval-1',
      expectedRevision: 0n,
      kind: 'evaluate',
      runId: RUN,
      scope: resetScope,
      ...over,
    });

    // 9. A stale expected revision refuses before any mutation.
    const afterReset = await stateSnapshot();
    for (const revision of [1n, 7n])
      await refusal(
        await audited.write(evaluateRequest({ expectedRevision: revision }), fence),
        'stale-revision',
        'head-at-0',
        afterReset,
      );
    // An evaluate against a generation that does not exist, and one whose head is absent.
    await refusal(
      await audited.write(evaluateRequest({ scope: scopeOf('no-such-generation') }), fence),
      'authority',
      'scope-not-authorised',
      afterReset,
    );

    // 10. The first evaluated transition from genesis. The qualified lineage requires an
    // empty observation set at revision 0, so this is warming with nothing resolved, and
    // every count is DERIVED from the persisted universe rather than supplied.
    const firstEval = await audited.write(evaluateRequest(), fence);
    assert.equal(firstEval.kind, 'written', describe(firstEval));
    assert.equal(firstEval.receipt.eventKind, 'evaluated');
    assert.equal(firstEval.receipt.revisionBefore, 0n);
    assert.equal(firstEval.receipt.revisionAfter, 1n);
    assert.equal(firstEval.receipt.previousPhase, 'warming');
    assert.equal(firstEval.receipt.projectedPhase, 'warming');
    assert.deepEqual(firstEval.receipt.inputCandidateKeys, []);
    assert.equal(firstEval.receipt.headMoved, true);
    assert.equal(firstEval.receipt.generationCreated, false);
    const [firstRow] = await admin.unsafe(
      'select e.revision_before::text as revision_before, e.previous_phase, e.result_phase, e.projected_phase, e.input_count::text as input_count, e.captured_candidate_count::text as candidates, e.summary_resolved_windows::text as summary, e.effective_windows::text as effective, e.weighted_mean_edge, e.prior_event_key, h.revision::text as head_revision from engine.paper_gate_phase_event e join engine.paper_gate_head h on h.generation_key=e.generation_key where e.event_key=$1',
      ['writer-eval-1'],
    );
    assert.deepEqual(firstRow, {
      candidates: '0',
      effective: '0',
      head_revision: '1',
      input_count: '0',
      previous_phase: 'warming',
      prior_event_key: 'writer-reset-genesis',
      projected_phase: 'warming',
      result_phase: 'warming',
      revision_before: '0',
      summary: '0',
      weighted_mean_edge: null,
    });

    // 11. The second transition, with a REAL resolved universe. Candidates and outcomes
    // are fixture rows; the writer derives the counts, the ordered input set, the window
    // bounds and the phase from them through the qualified regime arithmetic.
    const candidate = (key, closes) =>
      admin.unsafe(
        "insert into engine.paper_gate_candidate(candidate_key,candidate_id,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,issuance_run_id,source_kind,symbol,venue,contract_id,side,created_at,closes_at,selected_side_probability,ask_price,estimated_fee_rate,fee_model_version,predicted_net_edge,evidence_version,qualification_receipt_id) values($1,$1,$2,$3,$4,$5,$6,$7,$8,'prospective-engine-run','BTC','kalshi','synthetic-exact-kalshi-contract','UP',$9::text::timestamptz,$10::text::timestamptz,0.75,0.5,0.0175,'historical-kalshi-continuous-taker-0.07-v1',0.2325,'paper-regime-explicit-evidence-v1','synthetic-not-qualified')",
        [
          key,
          GEN_RESET,
          FUNDING,
          EPOCH,
          BUDGET,
          'writer-config-2',
          POLICY,
          RUN,
          '2026-10-12T02:00:00.000Z',
          closes,
        ],
      );
    const outcome = (key, candidateKey, closes, edge) =>
      admin.unsafe(
        "insert into engine.paper_gate_outcome(outcome_key,candidate_key,generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,closes_at,contract_id,side,resolution_run_id,current_effect_config_intent_id,source_kind,evidence_version,resolution_receipt_id,winner,realized_edge,resolved_at,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9::text::timestamptz,'synthetic-exact-kalshi-contract','UP',$10,$11,'prospective-engine-run','paper-regime-explicit-evidence-v1','writer-resolution-receipt','UP',$12::text::numeric,$13::text::timestamptz,$14::text::timestamptz)",
        [
          key,
          candidateKey,
          GEN_RESET,
          FUNDING,
          EPOCH,
          BUDGET,
          'writer-config-2',
          POLICY,
          closes,
          RUN,
          'writer-config-2',
          edge,
          closes.replace('00.000Z', '01.000Z'),
          closes.replace('00.000Z', '02.000Z'),
        ],
      );
    for (const [index, closes] of WINDOWS.entries()) {
      await candidate('writer-c' + index, closes);
      await outcome('writer-o' + index, 'writer-c' + index, closes, '0.2');
    }
    // The fixture universe is exactly what the writer must derive, asserted against the
    // rows rather than assumed.
    const [universeShape] = await admin.unsafe(
      'select count(*)::text as candidates, count(o.candidate_key)::text as resolved from engine.paper_gate_candidate c left join engine.paper_gate_outcome o on o.candidate_key=c.candidate_key and o.recorded_at <= $2::text::timestamptz where c.generation_key=$1 and c.created_at <= $2::text::timestamptz',
      [GEN_RESET, CUTOFF_ISO],
    );
    assert.deepEqual(universeShape, { candidates: '5', resolved: '5' });
    const secondEval = await audited.write(
      evaluateRequest({ eventKey: 'writer-eval-2', expectedRevision: 1n }),
      fence,
    );
    assert.equal(secondEval.kind, 'written', describe(secondEval));
    assert.equal(secondEval.receipt.revisionAfter, 2n);
    // Derived, in window order, from the actual rows.
    assert.deepEqual(secondEval.receipt.inputCandidateKeys, [
      'writer-c0',
      'writer-c1',
      'writer-c2',
      'writer-c3',
      'writer-c4',
    ]);
    assert.equal(secondEval.receipt.derived.capturedCandidateCount, 5);
    assert.equal(secondEval.receipt.derived.capturedResolvedCount, 5);
    assert.equal(secondEval.receipt.derived.capturedUnresolvedCount, 0);
    assert.equal(secondEval.receipt.projectedPhase, 'open');
    const [secondRow] = await admin.unsafe(
      'select e.input_count::text as input_count, e.captured_candidate_count::text as candidates, e.captured_resolved_count::text as resolved, e.summary_resolved_windows::text as summary, e.effective_windows::text as effective, e.weighted_mean_edge::text as edge, e.result_phase, e.projected_phase, (select count(*)::text from engine.paper_gate_phase_input i where i.event_key=e.event_key) as inputs, (select string_agg(i.candidate_key, $$,$$ order by i.ordinal) from engine.paper_gate_phase_input i where i.event_key=e.event_key) as ordered, h.revision::text as head_revision, h.projected_phase as head_phase from engine.paper_gate_phase_event e join engine.paper_gate_head h on h.generation_key=e.generation_key where e.event_key=$1',
      ['writer-eval-2'],
    );
    assert.equal(secondRow.input_count, '5');
    assert.equal(secondRow.candidates, '5');
    assert.equal(secondRow.resolved, '5');
    assert.equal(secondRow.summary, '5');
    assert.equal(secondRow.inputs, '5');
    assert.equal(secondRow.ordered, 'writer-c0,writer-c1,writer-c2,writer-c3,writer-c4');
    assert.equal(secondRow.result_phase, 'open');
    assert.equal(secondRow.projected_phase, 'open');
    assert.equal(secondRow.head_revision, '2');
    assert.equal(secondRow.head_phase, 'open');
    // Exact decimals, not floats: the text PostgreSQL stored is the text it was given.
    assert.equal(secondRow.edge, '0.2');
    assert.equal(secondRow.effective, '4.355775552152003');

    // A replay of that evaluated event, with its real ordered inputs, is idempotent.
    const afterSecond = await stateSnapshot();
    const replayEval = await audited.write(
      evaluateRequest({ eventKey: 'writer-eval-2', expectedRevision: 1n }),
      fence,
    );
    assert.equal(replayEval.kind, 'replayed', describe(replayEval));
    assert.deepEqual(replayEval.receipt.inputCandidateKeys, [
      'writer-c0',
      'writer-c1',
      'writer-c2',
      'writer-c3',
      'writer-c4',
    ]);
    assert.deepEqual(await stateSnapshot(), afterSecond);
    // And a replay whose expected revision names a DIFFERENT intent refuses. It is
    // compared against the RECORDED revision, never against the present head.
    await refusal(
      await audited.write(
        evaluateRequest({ eventKey: 'writer-eval-2', expectedRevision: 2n }),
        fence,
      ),
      'replay-mismatch',
      'expected_revision',
      afterSecond,
    );

    // 12. Simultaneous head writers against the SAME head. The loser is run to
    // completion inside the winner's own authority barrier, so the interleaving is
    // deterministic and no sleep is used as an oracle.
    let raceRan = false;
    let raceDetail;
    const loser = auditedWriter({
      afterAuthorityRead: async () => {
        if (raceRan) return;
        raceRan = true;
        const inner = auditedWriter();
        try {
          const won = await inner.write(
            evaluateRequest({ eventKey: 'writer-eval-3-winner', expectedRevision: 2n }),
            fence,
          );
          assert.equal(won.kind, 'written', describe(won));
          assert.equal(won.receipt.revisionAfter, 3n);
        } finally {
          await inner.close();
        }
      },
    });
    try {
      const lost = await loser.write(
        evaluateRequest({ eventKey: 'writer-eval-3-loser', expectedRevision: 2n }),
        fence,
      );
      assert.equal(raceRan, true);
      assert.equal(lost.kind, 'refused', describe(lost));
      assert.equal(lost.reason, 'conflict');
      assert.ok(
        ['serialization-failure', 'head-cas', 'unique-violation'].includes(lost.detail),
        'unexpected conflict detail ' + String(lost.detail),
      );
      raceDetail = lost.detail;
      // Exactly one transition exists and nothing of the loser's survives.
      const [race] = await admin.unsafe(
        "select (select count(*)::text from engine.paper_gate_phase_event where event_key like 'writer-eval-3-%') as events, (select count(*)::text from engine.paper_gate_phase_input where event_key like 'writer-eval-3-%') as inputs, (select h.revision::text from engine.paper_gate_head h where h.generation_key=$1) as head, (select h.latest_event_key from engine.paper_gate_head h where h.generation_key=$1) as latest",
        [GEN_RESET],
      );
      assert.equal(race.events, '1');
      assert.equal(race.inputs, '5');
      assert.equal(race.head, '3');
      assert.equal(race.latest, 'writer-eval-3-winner');
    } finally {
      await loser.close();
    }

    // 14. A failure thrown AFTER the event insert and BEFORE the head move rolls the
    // whole transaction back. DELETE is revoked on these tables, so rollback is the only
    // thing that can undo a partial write, and a normal return would have committed it.
    const beforeRollback = await stateSnapshot();
    let rollbackRan = false;
    const rollback = auditedWriter({
      afterEventInsert: async () => {
        rollbackRan = true;
        throw new Error('harness-failure-after-event-insert');
      },
    });
    try {
      await assert.rejects(
        () =>
          rollback.write(
            evaluateRequest({ eventKey: 'writer-eval-rolled-back', expectedRevision: 3n }),
            fence,
          ),
        (error) => {
          assert.equal(error.message, 'harness-failure-after-event-insert');
          return true;
        },
      );
      assert.equal(rollbackRan, true);
      assert.deepEqual(await stateSnapshot(), beforeRollback);
      assert.equal(
        (
          await admin.unsafe(
            'select count(*)::text as n from engine.paper_gate_phase_event where event_key=$1',
            ['writer-eval-rolled-back'],
          )
        )[0].n,
        '0',
      );
    } finally {
      await rollback.close();
    }

    // 15. The authority boundary, exercised rather than asserted.
    //
    // (a) A control change committed BEFORE the writer's snapshot IS seen and refuses:
    //     the authority really is read from the live control record in this transaction.
    await intent('writer-pause', 'pause', '2026-10-12 02:00:00.000000+00', {});
    await refusal(
      await audited.write(
        evaluateRequest({ eventKey: 'writer-eval-paused', expectedRevision: 3n }),
        fence,
      ),
      'authority',
      'paused',
      beforeRollback,
    );
    await admin.unsafe('delete from engine.control_intent where id=$1', ['writer-pause']);
    //
    // (b) A concurrent UPDATE of the exact control row the decision bound IS caught, by
    //     the `for share` revalidation after the mutations.
    let boundRan = false;
    const boundWriter = auditedWriter({
      afterAuthorityRead: async () => {
        if (boundRan) return;
        boundRan = true;
        await admin.unsafe(
          'update engine.control_intent set parameters=$2::text::jsonb where id=$1',
          ['writer-config-2', JSON.stringify({ ...CONFIG, total_cap_cents: 999 })],
        );
      },
    });
    try {
      const result = await boundWriter.write(
        evaluateRequest({ eventKey: 'writer-eval-bound', expectedRevision: 3n }),
        fence,
      );
      assert.equal(boundRan, true);
      assert.equal(result.kind, 'refused', describe(result));
      assert.equal(result.reason, 'conflict');
      assert.equal(result.detail, 'serialization-failure');
      assert.deepEqual(await stateSnapshot(), beforeRollback);
    } finally {
      await boundWriter.close();
    }
    await admin.unsafe('update engine.control_intent set parameters=$2::text::jsonb where id=$1', [
      'writer-config-2',
      JSON.stringify(CONFIG),
    ]);
    //
    // (c) THE DOCUMENTED LIMIT, measured rather than claimed solved. A NEWER control
    //     intent inserted and committed by a reader-committed recorder AFTER this
    //     transaction's snapshot is invisible to it, and PostgreSQL's serializable
    //     guarantee does not order it against this write because the recorder is not
    //     serializable. The vector records whichever way it actually goes, so the
    //     boundary in the documentation is the measured one.
    let laterRan = false;
    const laterWriter = auditedWriter({
      afterAuthorityRead: async () => {
        if (laterRan) return;
        laterRan = true;
        await intent('writer-pause-late', 'pause', '2026-10-12 02:00:00.000000+00', {});
      },
    });
    let lateOutcome;
    try {
      const result = await laterWriter.write(
        evaluateRequest({ eventKey: 'writer-eval-late', expectedRevision: 3n }),
        fence,
      );
      assert.equal(laterRan, true);
      lateOutcome = result.kind === 'written' ? 'committed-under-superseded-intent' : result.reason;
      // Either way exactly one of the two outcomes holds, and the recorded row count
      // matches the outcome: this is a measurement, not an assumption.
      const [late] = await admin.unsafe(
        'select count(*)::text as n from engine.paper_gate_phase_event where event_key=$1',
        ['writer-eval-late'],
      );
      assert.equal(late.n, result.kind === 'written' ? '1' : '0');
    } finally {
      await laterWriter.close();
    }
    assert.ok(
      ['committed-under-superseded-intent', 'authority', 'conflict'].includes(lateOutcome),
      'unexpected late-intent outcome ' + String(lateOutcome),
    );
    await admin.unsafe('delete from engine.control_intent where id=$1', ['writer-pause-late']);
    const headAfterLate = await admin.unsafe(
      'select revision::text as revision from engine.paper_gate_head where generation_key=$1',
      [GEN_RESET],
    );
    const liveRevision = BigInt(headAfterLate[0].revision);

    // 16. Lease takeover and a same-owner heartbeat are both strict serialization
    // failures, and nothing is written.
    const beforeFenceVectors = await stateSnapshot();
    for (const [label, update, values] of [
      [
        'takeover',
        'update engine.job_lease set owner=$2,fencing_token=$3 where capability=$1',
        [CAPABILITY, 'other-owner', (TOKEN + 1n).toString()],
      ],
      [
        'heartbeat',
        'update engine.job_lease set heartbeat_at=clock_timestamp() where capability=$1',
        [CAPABILITY],
      ],
    ]) {
      let ran = false;
      const fenceWriter = auditedWriter({
        beforeFinalFence: async () => {
          if (ran) return;
          ran = true;
          await admin.unsafe(update, values);
        },
      });
      try {
        await refusal(
          await fenceWriter.write(
            evaluateRequest({
              eventKey: 'writer-eval-fence-' + label,
              expectedRevision: liveRevision,
            }),
            fence,
          ),
          'conflict',
          'serialization-failure',
          beforeFenceVectors,
        );
        assert.equal(ran, true, label);
      } finally {
        await fenceWriter.close();
      }
      await restoreLease();
    }

    // 17. NATURAL expiry between the mutations and the final fence, with no UPDATE of the
    // lease at all, so this is the expiry path and not the 40001 path. The refusal is
    // decided AFTER the writes, so it must roll back.
    const expiryEvidence = {};
    let expiryRan = false;
    const expiryWriter = auditedWriter({
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
      await refusal(
        await expiryWriter.write(
          evaluateRequest({ eventKey: 'writer-eval-expired', expectedRevision: liveRevision }),
          fence,
        ),
        'lease-lost',
        'final-boundary',
        beforeFenceVectors,
      );
      assert.equal(expiryRan, true);
      assert.equal(expiryEvidence.liveBeforeWait, true);
      assert.equal(expiryEvidence.liveAfterWait, false);
    } finally {
      await expiryWriter.close();
    }
    await restoreLease();

    // 18. Expiry WHILE the final `for update` genuinely WAITS for the lock on an
    // UNCHANGED row, proved by direct observation through the SHARED barrier. Without
    // the writer's separate fresh-clock read this would commit an event under an expired
    // lease; with it, the whole transaction rolls back.
    const lockWaitBarrier = createLeaseFenceHarness({ capability: CAPABILITY, leaseLive, port });
    const lockWait = lockWaitBarrier();
    const lockEvidence = lockWait.evidence;
    const lockWriter = auditedWriter({
      beforeFinalFence: lockWait.barrier,
    });
    try {
      await admin.unsafe(
        "update engine.job_lease set expires_at=clock_timestamp()+($2||' milliseconds')::interval where capability=$1",
        [CAPABILITY, String(LEASE_BUDGET_MS)],
      );
      assert.equal(await leaseLive(), true);
      const startedAt = Date.now();
      const blocked = await lockWriter.write(
        evaluateRequest({ eventKey: 'writer-eval-lockwait', expectedRevision: liveRevision }),
        fence,
      );
      const spanMs = Date.now() - startedAt;
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
      assert.notEqual(atResolution.readerPid, lockEvidence.holderPid);
      assert.ok(
        atResolution.blockedWhileLive !== undefined,
        'writer was never observed blocked by the holder while the lease was live ' +
          lockEvidence.diagnostics(),
      );
      assert.equal(atResolution.blockedWhileLive.blockers, String(lockEvidence.holderPid));
      assert.equal(atResolution.blockedWhileLive.leaseLiveAtObservation, true);
      assert.equal(atResolution.blockedWhileLive.waitEventType, 'Lock');
      assert.ok(
        ['transactionid', 'tuple'].includes(atResolution.blockedWhileLive.waitEvent),
        'unexpected wait event ' + String(atResolution.blockedWhileLive.waitEvent),
      );
      assert.equal(lockEvidence.expiryWaitSkipped, undefined);
      assert.equal(lockEvidence.expiredBeforeRelease, true);
      assert.equal(await leaseLive(), false);
      assert.ok(
        spanMs < BLOCKED_SPAN_CEILING_MS,
        'blocked span ' + String(spanMs) + 'ms ' + lockEvidence.diagnostics(),
      );
      // Refused AFTER the mutations, so the proof is the rollback: no event, no input,
      // and the head exactly where it was.
      await refusal(blocked, 'lease-lost', 'final-boundary', beforeFenceVectors);
    } finally {
      await lockWriter.close();
      await lockWait.dispose();
    }
    await restoreLease();

    // 18b. F4: the generation KEY is not the namespace. A second initialize for the same
    // real (funding, epoch, budget, config intent, policy) under a DIFFERENT key is
    // refused, and the lineage kind must match what history derives rather than what the
    // caller labelled.
    const beforeNamespace = await stateSnapshot();
    await refusal(
      await audited.write(
        requestOf({
          eventKey: 'writer-dup-namespace',
          scope: { ...resetScope, generation_key: 'writer-generation-duplicate' },
        }),
        fence,
      ),
      'generation-exists',
      'namespace-occupied',
      beforeNamespace,
    );
    // A post-reset configure presented as `initialize` may not be written with
    // `reset_origin='none'`: prior generations exist in this budget namespace, so the
    // derived lineage is a reset and the mislabel is refused.
    await intent('writer-reset-2', 'reset', T_RESET_2, {});
    await intent('writer-config-3', 'configure', T_CONFIG_3, CONFIG);
    const raceScope = { ...resetScope, generation_config_intent_id: 'writer-config-3' };
    await refusal(
      await audited.write(
        requestOf({
          eventKey: 'writer-mislabelled',
          scope: { ...raceScope, generation_key: 'writer-generation-mislabelled' },
        }),
        fence,
      ),
      'generation',
      'lineage-kind-reset',
      beforeNamespace,
    );
    // And a reset whose barrier does not order after the claimed prior generation's
    // configure is still refused in the new namespace.
    const raceRequest = (over = {}) =>
      requestOf({
        eventKey: 'writer-race-winner',
        kind: 'reset',
        priorGenerationKey: GEN_RESET,
        resetBarrierIntentId: 'writer-reset-2',
        scope: { ...raceScope, generation_key: 'writer-generation-race' },
        ...over,
      });
    await refusal(
      await audited.write(raceRequest({ resetBarrierIntentId: 'writer-reset' }), fence),
      'reset-barrier',
      'barrier-ordering',
      beforeNamespace,
    );

    // 18c. Simultaneous writers with NO head at all, in a fresh namespace: the same
    // deterministic interleaving as the head race. Exactly one generation, event and head
    // survive and the loser leaves nothing.
    let raceInitRan = false;
    const initLoser = auditedWriter({
      afterAuthorityRead: async () => {
        if (raceInitRan) return;
        raceInitRan = true;
        const inner = auditedWriter();
        try {
          const won = await inner.write(raceRequest(), fence);
          assert.equal(won.kind, 'written', describe(won));
          assert.equal(won.receipt.revisionAfter, 0n);
          assert.equal(won.receipt.generationCreated, true);
        } finally {
          await inner.close();
        }
      },
    });
    try {
      const lost = await initLoser.write(raceRequest({ eventKey: 'writer-race-loser' }), fence);
      assert.equal(raceInitRan, true);
      assert.equal(lost.kind, 'refused', describe(lost));
      assert.equal(lost.reason, 'conflict');
      const [race] = await admin.unsafe(
        'select (select count(*)::text from engine.paper_gate_generation where generation_key=$1) as generations, (select count(*)::text from engine.paper_gate_phase_event where generation_key=$1) as events, (select count(*)::text from engine.paper_gate_head where generation_key=$1) as heads',
        ['writer-generation-race'],
      );
      assert.deepEqual(race, { events: '1', generations: '1', heads: '1' });
      // The post-reset provenance is derived from history, not from the request label.
      const [provenance] = await admin.unsafe(
        'select reset_origin,reset_barrier_intent_id from engine.paper_gate_generation where generation_key=$1',
        ['writer-generation-race'],
      );
      assert.deepEqual(provenance, {
        reset_barrier_intent_id: 'writer-reset-2',
        reset_origin: 'post-reset',
      });
      // An exact replay of the winner still succeeds and writes nothing.
      const afterRace = await stateSnapshot();
      const replayRace = await audited.write(raceRequest(), fence);
      assert.equal(replayRace.kind, 'replayed', describe(replayRace));
      assert.deepEqual(await stateSnapshot(), afterRace);
      // F3: every accepted generation field is compared on a reset replay, including the
      // settings, the reset provenance and the re-derived prior generation.
      for (const [over, field] of [
        [{ generation: { ...GENERATION_INPUTS, profileClaim: 'other-profile' } }, 'profile_claim'],
        [{ generation: { ...GENERATION_INPUTS, enabled: false } }, 'enabled'],
        [
          { generation: { ...GENERATION_INPUTS, minimumPolicyWindows: 5 } },
          'minimum_policy_windows',
        ],
        [
          { generation: { ...GENERATION_INPUTS, evidenceHalfLifeWindows: '3.5' } },
          'evidence_half_life_windows',
        ],
        [{ generation: { ...GENERATION_INPUTS, pauseConfidence: '0.98' } }, 'pause_confidence'],
        [{ generation: { ...GENERATION_INPUTS, resumeConfidence: '0.7' } }, 'resume_confidence'],
        [{ kind: 'initialize' }, 'reset_origin'],
        [{ resetBarrierIntentId: 'writer-reset' }, 'reset_barrier_intent_id'],
        [{ priorGenerationKey: 'writer-generation-duplicate' }, 'prior_generation_key'],
      ])
        await refusal(
          await audited.write(raceRequest(over), fence),
          'replay-mismatch',
          field,
          afterRace,
        );
      // An exactly equal decimal in a different spelling is the SAME numeric: the
      // comparison is PostgreSQL's, not a string compare.
      const equalDecimal = await audited.write(
        raceRequest({ generation: { ...GENERATION_INPUTS, evidenceHalfLifeWindows: '2.50' } }),
        fence,
      );
      assert.equal(equalDecimal.kind, 'replayed', describe(equalDecimal));
      assert.deepEqual(await stateSnapshot(), afterRace);
    } finally {
      await initLoser.close();
    }

    // 18e. F-B2: two writers racing a FRESH namespace with DIFFERENT generation keys,
    // with the lock OFF. Neither hits a unique constraint — the generation and head
    // primary keys are the keys themselves, which differ — so the only thing that can
    // stop two generations occupying one namespace is the namespace predicate read under
    // SERIALIZABLE. The expectation is therefore a serialization failure, not a unique
    // violation, and exactly one commit with no orphans.
    const unlocked = (effects) =>
      createTestArtifactPaperGateWriter(writerUrl, effects, AUDITED_POLICY_FIXTURE);
    // A genuinely FRESH namespace: its own configure intent, newest so the authority
    // binds it, with a reset barrier ordering after the previous generation's configure.
    await intent('writer-reset-3', 'reset', T_RESET_3, {});
    await intent('writer-config-4', 'configure', T_CONFIG_4, CONFIG);
    const freshScope = {
      ...raceScope,
      generation_config_intent_id: 'writer-config-4',
      generation_key: 'writer-generation-diffkey-a',
    };
    let diffKeyRan = false;
    const diffKeyLoser = unlocked({
      afterAuthorityRead: async () => {
        if (diffKeyRan) return;
        diffKeyRan = true;
        const inner = unlocked();
        try {
          const won = await inner.write(
            requestOf({
              eventKey: 'writer-diffkey-winner',
              kind: 'reset',
              priorGenerationKey: 'writer-generation-race',
              resetBarrierIntentId: 'writer-reset-3',
              scope: { ...freshScope, generation_key: 'writer-generation-diffkey-b' },
            }),
            fence,
          );
          assert.equal(won.kind, 'written', describe(won));
        } finally {
          await inner.close();
        }
      },
    });
    try {
      const lost = await diffKeyLoser.write(
        requestOf({
          eventKey: 'writer-diffkey-loser',
          kind: 'reset',
          priorGenerationKey: 'writer-generation-race',
          resetBarrierIntentId: 'writer-reset-3',
          scope: freshScope,
        }),
        fence,
      );
      assert.equal(diffKeyRan, true);
      assert.equal(lost.kind, 'refused', describe(lost));
      assert.equal(lost.reason, 'conflict');
      // The point of the vector: the predicate read is what stops it, so the refusal is
      // a serialization failure and NOT a unique violation.
      assert.equal(lost.detail, 'serialization-failure', describe(lost));
      // Exactly one generation occupies the namespace, with no orphan event or head.
      const [namespaceRows] = await admin.unsafe(
        'select (select count(*)::text from engine.paper_gate_generation g where g.funding_id=$1 and g.epoch=$2 and g.budget_id=$3 and g.generation_config_intent_id=$4 and g.sample_policy=$5) as generations, (select count(*)::text from engine.paper_gate_phase_event e where e.generation_config_intent_id=$4 and e.funding_id=$1 and e.epoch=$2) as events, (select count(*)::text from engine.paper_gate_head h where h.generation_config_intent_id=$4 and h.funding_id=$1 and h.epoch=$2) as heads',
        [FUNDING, EPOCH, BUDGET, 'writer-config-4', POLICY],
      );
      // Exactly one generation, event and head in the fresh namespace: the winner's.
      assert.deepEqual(namespaceRows, { events: '1', generations: '1', heads: '1' });
      assert.equal(
        (
          await admin.unsafe(
            'select count(*)::text as n from engine.paper_gate_phase_event where event_key=$1',
            ['writer-diffkey-loser'],
          )
        )[0].n,
        '0',
      );
    } finally {
      await diffKeyLoser.close();
    }

    // 19. `engine_reader` cannot write any of these tables, whatever the writer does.
    const reader = postgres('postgres://engine_reader@127.0.0.1:' + port + '/postgres', {
      max: 1,
      prepare: false,
    });
    try {
      for (const statement of [
        "insert into engine.paper_gate_head(generation_key,funding_id,epoch,budget_id,generation_config_intent_id,sample_policy,latest_event_key,revision,event_kind,projected_phase) values('reader-head','f',1,'a:paper','c','p','e',0,'genesis','warming')",
        'update engine.paper_gate_head set revision=revision',
        "insert into engine.paper_gate_generation(generation_key,funding_id,epoch,budget_id,actor,generation_config_intent_id,initialization_run_id,source_kind,sample_policy,gate_formula,bundle_id,profile_claim,settings_descriptor,enabled,minimum_policy_windows,evidence_half_life_windows,pause_confidence,resume_confidence,reset_origin,initialized_at) values('reader-generation','f',1,'a:paper','a','c','r','prospective-engine-run','p','adaptive-fee-edge-window-v1','paper-regime-historical-warm-lineage-v1','p','d',true,4,2.5,0.99,0.75,'none',now())",
      ]) {
        await assert.rejects(
          () => reader.unsafe(statement),
          (error) => {
            assert.equal(error.code, '42501');
            return true;
          },
        );
      }
      assert.equal((await reader.unsafe('select current_user as role'))[0].role, 'engine_reader');
    } finally {
      await reader.end({ timeout: 5 });
    }

    // 19a-exact. THE 0006 NUMERIC DOMAINS, DECIDED ON DIGITS, through the real writer.
    //
    // 0006 states `resume_confidence<=pause_confidence-0.01` in `numeric`, on the recorded
    // digits. The domain validator and the regime evaluator decided it in binary64, which
    // disagreed with the column in BOTH directions: it refused legal pairs, because the
    // subtraction rounds, and it admitted values whose excess digits round away. This
    // vector drives both directions through the real path, on its own namespace so no
    // earlier vector is disturbed, and it EVALUATES rather than only initializing -- the
    // evaluated transition is what reads the persisted columns back, rebuilds the
    // settings from their text and runs the qualified arithmetic.
    const BOUNDARY_EPOCH = 1100;
    const BOUNDARY_ACTOR = 'boundary-actor';
    const BOUNDARY_BUDGET = BOUNDARY_ACTOR + ':paper';
    const BOUNDARY_FUNDING = 'writer-boundary-funding';
    const BOUNDARY_CONFIG = 'writer-boundary-config';
    const BOUNDARY_GEN = 'writer-generation-boundary';
    // Legal under `numeric`; refused by the same rule in doubles. The half-life keeps the
    // long-accepted spelling `2.50`, which is the same number as `2.5`.
    const BOUNDARY_PROFILE = {
      ...GENERATION_INPUTS,
      evidenceHalfLifeWindows: '2.50',
      pauseConfidence: '0.94',
      resumeConfidence: '0.93',
    };
    assert.equal(0.93 <= 0.94 - 0.01, false);
    await intent(
      BOUNDARY_CONFIG,
      'configure',
      T_CONFIG,
      { ...CONFIG, budget_id: BOUNDARY_BUDGET, funding_id: BOUNDARY_FUNDING },
      BOUNDARY_ACTOR,
      BOUNDARY_EPOCH,
    );
    await admin.unsafe(
      'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$6,clock_timestamp())',
      [BOUNDARY_FUNDING, BOUNDARY_EPOCH, BOUNDARY_BUDGET, BOUNDARY_ACTOR, BOUNDARY_CONFIG, RUN],
    );
    await admin.unsafe(
      'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$4,1000,700,300,0,0,4,$5,clock_timestamp())',
      [BOUNDARY_FUNDING, BOUNDARY_EPOCH, BOUNDARY_BUDGET, BOUNDARY_CONFIG, RUN],
    );
    const boundaryScope = {
      budget_id: BOUNDARY_BUDGET,
      epoch: BOUNDARY_EPOCH,
      funding_id: BOUNDARY_FUNDING,
      generation_config_intent_id: BOUNDARY_CONFIG,
      generation_key: BOUNDARY_GEN,
      sample_policy: POLICY,
    };
    const boundaryRequest = (over = {}) =>
      requestOf({
        eventKey: 'writer-boundary-genesis',
        generation: BOUNDARY_PROFILE,
        scope: boundaryScope,
        ...over,
      });
    const boundaryBefore = await stateSnapshot();
    // Excess precision is OUTSIDE the 0006 domain and `Number` rounds it back inside, so
    // it must be refused before anything is written. The probe effect fires right after
    // the in-transaction authority read; it never runs, which is the proof that no
    // statement was issued for these requests at all.
    let boundarySqlReached = false;
    const probing = auditedWriter({
      afterAuthorityRead: () => {
        boundarySqlReached = true;
      },
    });
    try {
      for (const over of [
        { generation: { ...BOUNDARY_PROFILE, pauseConfidence: '0.99990000000000000001' } },
        { generation: { ...BOUNDARY_PROFILE, resumeConfidence: '0.98000000000000000001' } },
        { generation: { ...BOUNDARY_PROFILE, evidenceHalfLifeWindows: '500.00000000000000001' } },
        { generation: { ...BOUNDARY_PROFILE, resumeConfidence: '0.9301' } },
      ])
        await refusal(
          await probing.write(boundaryRequest(over), fence),
          'request',
          'request',
          boundaryBefore,
        );
      assert.equal(boundarySqlReached, false);
      // What the old rule would have done with the first of those values.
      assert.equal(Number('0.99990000000000000001'), 0.9999);
    } finally {
      await probing.close();
    }
    const boundaryGenesis = await audited.write(boundaryRequest(), fence);
    assert.equal(boundaryGenesis.kind, 'written', describe(boundaryGenesis));
    assert.equal(boundaryGenesis.receipt.revisionAfter, 0n);
    assert.equal(boundaryGenesis.receipt.generationCreated, true);
    // The columns hold the recorded digits; `numeric` keeps the scale it was handed, and
    // PostgreSQL agrees the pair satisfies 0006's own margin expression.
    const [boundaryRow] = await admin.unsafe(
      'select pause_confidence::text as pause, resume_confidence::text as resume, evidence_half_life_windows::text as half_life, minimum_policy_windows::text as windows, enabled, settings_descriptor, (resume_confidence <= pause_confidence - 0.01) as margin_ok from engine.paper_gate_generation where generation_key=$1',
      [BOUNDARY_GEN],
    );
    assert.deepEqual(boundaryRow, {
      enabled: true,
      half_life: '2.50',
      margin_ok: true,
      pause: '0.94',
      resume: '0.93',
      // The descriptor is still the NUMBER-based serialization: `2.50` and `2.5` share
      // one identity, which is the known and unchanged limit of that contract.
      settings_descriptor: 'regime-settings-v1:true:4:2.5:0.94:0.93',
      windows: '4',
    });
    // The REAL evaluated transition on that generation: it reads those columns, rebuilds
    // the settings from their text and runs the qualified arithmetic. Before this repair
    // the same row refused as a settings mismatch and no evaluation was possible.
    const boundaryEval = await audited.write(
      {
        coverageCutoffAtIso: CUTOFF_ISO,
        coverageReceiptId: 'writer-receipt',
        evidenceObservedAtIso: OBSERVED_ISO,
        eventKey: 'writer-boundary-eval',
        expectedRevision: 0n,
        kind: 'evaluate',
        runId: RUN,
        scope: boundaryScope,
      },
      fence,
    );
    assert.equal(boundaryEval.kind, 'written', describe(boundaryEval));
    assert.equal(boundaryEval.receipt.eventKind, 'evaluated');
    assert.equal(boundaryEval.receipt.revisionBefore, 0n);
    assert.equal(boundaryEval.receipt.revisionAfter, 1n);
    assert.equal(boundaryEval.receipt.projectedPhase, 'warming');
    assert.equal(boundaryEval.receipt.headMoved, true);
    assert.deepEqual(boundaryEval.receipt.inputCandidateKeys, []);

    // 19a-coherence. THE REVIEWED COUNTEREXAMPLE, persisted AND evaluated.
    //
    // `pause 0.93999999999999989` / `resume 0.92999999999999989` differ by exactly a
    // hundredth on the recorded digits, so `numeric` accepts the pair and the writer
    // persists it. Their binary64 projections are `0.9399999999999998` and
    // `0.9299999999999999`, which differ by a hundredth MINUS one ulp -- so a margin
    // decided after the conversion refused a generation that was already on disk, leaving
    // it unevaluable. Validity is now decided on the persisted text that travels with
    // those numbers, and this vector proves the whole path: initialize, read back, and a
    // real evaluated transition under the live fence.
    const PRECISE_EPOCH = 1101;
    const PRECISE_ACTOR = 'precise-actor';
    const PRECISE_BUDGET = PRECISE_ACTOR + ':paper';
    const PRECISE_FUNDING = 'writer-precise-funding';
    const PRECISE_CONFIG = 'writer-precise-config';
    const PRECISE_GEN = 'writer-generation-precise';
    const PRECISE_PAUSE = '0.93999999999999989';
    const PRECISE_RESUME = '0.92999999999999989';
    const PRECISE_PROFILE = {
      ...GENERATION_INPUTS,
      evidenceHalfLifeWindows: '2.50',
      pauseConfidence: PRECISE_PAUSE,
      resumeConfidence: PRECISE_RESUME,
    };
    assert.equal(Number(PRECISE_PAUSE), 0.9399999999999998);
    assert.equal(Number(PRECISE_RESUME), 0.9299999999999999);
    assert.equal(Number(PRECISE_RESUME) <= Number(PRECISE_PAUSE) - 0.01, false);
    await intent(
      PRECISE_CONFIG,
      'configure',
      T_CONFIG,
      { ...CONFIG, budget_id: PRECISE_BUDGET, funding_id: PRECISE_FUNDING },
      PRECISE_ACTOR,
      PRECISE_EPOCH,
    );
    await admin.unsafe(
      'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$6,clock_timestamp())',
      [PRECISE_FUNDING, PRECISE_EPOCH, PRECISE_BUDGET, PRECISE_ACTOR, PRECISE_CONFIG, RUN],
    );
    await admin.unsafe(
      'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$4,1000,700,300,0,0,4,$5,clock_timestamp())',
      [PRECISE_FUNDING, PRECISE_EPOCH, PRECISE_BUDGET, PRECISE_CONFIG, RUN],
    );
    const preciseScope = {
      budget_id: PRECISE_BUDGET,
      epoch: PRECISE_EPOCH,
      funding_id: PRECISE_FUNDING,
      generation_config_intent_id: PRECISE_CONFIG,
      generation_key: PRECISE_GEN,
      sample_policy: POLICY,
    };
    const preciseRequest = (over = {}) =>
      requestOf({
        eventKey: 'writer-precise-genesis',
        generation: PRECISE_PROFILE,
        scope: preciseScope,
        ...over,
      });
    const precisePre = await stateSnapshot();
    // One unit over the margin on the digits -- the exact invalid neighbour -- is refused
    // before any statement runs: the probe effect after the in-transaction authority read
    // never fires, and nothing is written.
    let preciseSqlReached = false;
    const precisionProbe = auditedWriter({
      afterAuthorityRead: () => {
        preciseSqlReached = true;
      },
    });
    try {
      for (const over of [
        { generation: { ...PRECISE_PROFILE, resumeConfidence: '0.92999999999999990' } },
        { generation: { ...PRECISE_PROFILE, pauseConfidence: '0.99990000000000000001' } },
      ])
        await refusal(
          await precisionProbe.write(preciseRequest(over), fence),
          'request',
          'request',
          precisePre,
        );
      assert.equal(preciseSqlReached, false);
    } finally {
      await precisionProbe.close();
    }
    const preciseGenesis = await audited.write(preciseRequest(), fence);
    assert.equal(preciseGenesis.kind, 'written', describe(preciseGenesis));
    assert.equal(preciseGenesis.receipt.revisionAfter, 0n);
    assert.equal(preciseGenesis.receipt.generationCreated, true);
    const [preciseRow] = await admin.unsafe(
      'select pause_confidence::text as pause, resume_confidence::text as resume, evidence_half_life_windows::text as half_life, settings_descriptor, (resume_confidence <= pause_confidence - 0.01) as margin_ok, (pause_confidence - resume_confidence)::text as difference from engine.paper_gate_generation where generation_key=$1',
      [PRECISE_GEN],
    );
    assert.deepEqual(preciseRow, {
      difference: '0.01000000000000000',
      half_life: '2.50',
      margin_ok: true,
      pause: PRECISE_PAUSE,
      resume: PRECISE_RESUME,
      // Still the NUMBER-based descriptor, from the projections, byte for byte unchanged.
      settings_descriptor: 'regime-settings-v1:true:4:2.5:0.9399999999999998:0.9299999999999999',
    });
    // The real evaluated transition: this is the path that refused before the repair.
    const preciseEval = await audited.write(
      {
        coverageCutoffAtIso: CUTOFF_ISO,
        coverageReceiptId: 'writer-receipt',
        evidenceObservedAtIso: OBSERVED_ISO,
        eventKey: 'writer-precise-eval',
        expectedRevision: 0n,
        kind: 'evaluate',
        runId: RUN,
        scope: preciseScope,
      },
      fence,
    );
    assert.equal(preciseEval.kind, 'written', describe(preciseEval));
    assert.equal(preciseEval.receipt.eventKind, 'evaluated');
    assert.equal(preciseEval.receipt.revisionAfter, 1n);
    assert.equal(preciseEval.receipt.projectedPhase, 'warming');
    assert.equal(preciseEval.receipt.headMoved, true);

    // 19b. F5: the FULL epoch domain, end to end. A seven-digit count parser would have
    // rejected this legitimate epoch; the canonical parser accepts it, so a genesis write
    // and its exact replay both succeed at the ceiling. Invalid epochs are refused before
    // any statement. This runs last because its configure intent becomes the newest.
    const MAX_EPOCH = 2147483647;
    const MAX_BUDGET = 'max-epoch-actor:paper';
    for (const badEpoch of [0, -1, 2147483648, 1.5, '11'])
      await refusal(
        await audited.write(requestOf({ scope: { ...scopeOf(GEN), epoch: badEpoch } }), fence),
        'scope',
        'scope',
      );
    await admin.unsafe(
      'insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters) values($1,$2,$3,$4,$5,$6::text::timestamptz,$7,$8::text::jsonb)',
      [
        'writer-max-epoch-config',
        CAPABILITY,
        'configure',
        'max-epoch-actor',
        MAX_EPOCH,
        T_CONFIG,
        RUN,
        JSON.stringify({ ...CONFIG, budget_id: MAX_BUDGET, funding_id: 'writer-max-funding' }),
      ],
    );
    await admin.unsafe(
      'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$6,clock_timestamp())',
      [
        'writer-max-funding',
        MAX_EPOCH,
        MAX_BUDGET,
        'max-epoch-actor',
        'writer-max-epoch-config',
        RUN,
      ],
    );
    await admin.unsafe(
      'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$4,1000,700,300,0,0,4,$5,clock_timestamp())',
      ['writer-max-funding', MAX_EPOCH, MAX_BUDGET, 'writer-max-epoch-config', RUN],
    );
    const maxScope = {
      budget_id: MAX_BUDGET,
      epoch: MAX_EPOCH,
      funding_id: 'writer-max-funding',
      generation_config_intent_id: 'writer-max-epoch-config',
      generation_key: 'writer-generation-max-epoch',
      sample_policy: POLICY,
    };
    const maxRequest = requestOf({ eventKey: 'writer-max-epoch-genesis', scope: maxScope });
    const maxWritten = await audited.write(maxRequest, fence);
    assert.equal(maxWritten.kind, 'written', describe(maxWritten));
    assert.equal(maxWritten.receipt.revisionAfter, 0n);
    const [maxRow] = await admin.unsafe(
      'select epoch::text as epoch from engine.paper_gate_phase_event where event_key=$1',
      ['writer-max-epoch-genesis'],
    );
    assert.equal(maxRow.epoch, String(MAX_EPOCH));
    const afterMax = await stateSnapshot();
    const maxReplay = await audited.write(maxRequest, fence);
    assert.equal(maxReplay.kind, 'replayed', describe(maxReplay));
    assert.deepEqual(await stateSnapshot(), afterMax);

    // 20. Nothing outside this contract's own fixtures and writes exists.
    const after = await counts();
    // Eleven writes always commit here: the first generation's genesis, the reset
    // generation's genesis, two evaluated transitions on it, the head race winner, the
    // namespace race winner, the exact-bounds and high-precision generations' geneses and
    // their evaluated transitions, and the max-epoch genesis. The twelfth depends on the MEASURED
    // outcome of the superseded-intent vector above, so the expectation is derived from
    // that measurement rather than assumed either way. Only the two transitions with a
    // resolved universe carry inputs; the race and max-epoch generations have none.
    const lateCommitted = lateOutcome === 'committed-under-superseded-intent' ? 1 : 0;
    assert.equal(Number(after[0].generations), Number(before[0].generations) + 7);
    assert.equal(Number(after[0].heads), Number(before[0].heads) + 7);
    assert.equal(Number(after[0].events), Number(before[0].events) + 12 + lateCommitted);
    assert.equal(Number(after[0].inputs), Number(before[0].inputs) + 10 + 5 * lateCommitted);
    assert.equal(Number(after[0].leases), 1);
    return { lateOutcome, raceDetail };
  } finally {
    await production.close();
    await audited.close();
    await coverage.close();
    // Fixture teardown, in foreign-key order.
    await admin.unsafe('delete from engine.paper_gate_phase_input where generation_key=any($1)', [
      [GEN, GEN_RESET, 'writer-generation-race'],
    ]);
    await admin.unsafe('delete from engine.paper_gate_head where generation_key=any($1)', [
      [GEN, GEN_RESET, 'writer-generation-race'],
    ]);
    await admin.unsafe('delete from engine.paper_gate_phase_event where generation_key=any($1)', [
      [GEN, GEN_RESET, 'writer-generation-race'],
    ]);
    await admin.unsafe('delete from engine.paper_gate_outcome where generation_key=any($1)', [
      [GEN, GEN_RESET],
    ]);
    await admin.unsafe('delete from engine.paper_gate_candidate where generation_key=any($1)', [
      [GEN, GEN_RESET],
    ]);
    await admin.unsafe('delete from engine.paper_gate_generation where generation_key=any($1)', [
      [GEN, GEN_RESET, 'writer-generation-race'],
    ]);
    for (const key of [
      'writer-generation-max-epoch',
      'writer-generation-boundary',
      'writer-generation-precise',
      'writer-generation-diffkey-a',
      'writer-generation-diffkey-b',
    ]) {
      await admin.unsafe('delete from engine.paper_gate_head where generation_key=$1', [key]);
      await admin.unsafe('delete from engine.paper_gate_phase_event where generation_key=$1', [
        key,
      ]);
      await admin.unsafe('delete from engine.paper_gate_generation where generation_key=$1', [key]);
    }
    for (const funding of [
      'writer-max-funding',
      'writer-boundary-funding',
      'writer-precise-funding',
    ]) {
      await admin.unsafe('delete from engine.paper_budget_root where funding_id=$1', [funding]);
      await admin.unsafe('delete from engine.paper_funding_root where funding_id=$1', [funding]);
    }
    await admin.unsafe('delete from engine.control_intent where id=$1', [
      'writer-max-epoch-config',
    ]);
    await admin.unsafe('delete from engine.paper_budget_root where funding_id=$1', [FUNDING]);
    await admin.unsafe('delete from engine.paper_funding_root where funding_id=$1', [FUNDING]);
    await clearVectorIntents();
    await admin.unsafe('delete from engine.control_intent where id=$1', [CONFIG_INTENT]);
    await admin.unsafe('delete from engine.job_run_record where run_id=any($1)', [
      ['writer-foreign-run', 'writer-alt-run'],
    ]);
    await admin.unsafe('delete from engine.job_lease where capability=$1', [CAPABILITY]);
  }
  // A committed write is a record of what the persisted control and funding state said
  // in ONE transaction under a live fence. It is not standing authority, grants no
  // capability to a later transaction, and does not activate paper mode: the compiled
  // bundle stays unavailable and the production writer refuses for exactly that reason.
}
