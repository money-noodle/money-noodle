// A COMPOSED end-to-end paper run, assembled from ports that are already on this branch
// and already approved for code and tests. It is a TEST ARTIFACT ONLY: no production
// module, no `main.ts`, no `cycle.ts`, no schema, grant, role, config or infrastructure
// change accompanies it, nothing is activated or deployed, and the production runtime
// still refuses paper mode — which this contract proves rather than asserts.
//
// What it composes, each through its REAL port and never through hand-written SQL
// standing in for the thing being qualified:
//
//   * the platform API's parameter validator and control recorder, as
//     `engine_control_recorder`, writing the twelve-field configuration the engine's own
//     decoder recognises and the two-field resume reference;
//   * the engine's lease port, as `engine_writer`, for acquisition, heartbeat and release;
//   * the engine's persisted authority reader, for the decision under the production
//     bundle and the same decision re-run by the pure reducer with an audited fixture;
//   * the gate writer — production first, refusing, then the test artifact — for a genesis
//     and a real evaluated advance under the real lease;
//   * `runCycleJob` in paper mode, which must still refuse.
//
// What it is NOT: the live engine. Nothing here is HTTP, nothing is scheduled, no secret
// is bound, and the twelve-field document is NOT adopted as the operator API — it is what
// the decoder, the authority SQL and the existing authority contract already bind. Admin
// SQL is used ONLY for synthetic root/FK fixtures, for verification and for teardown;
// every control row and every lease this contract reasons about goes through a port.
import assert from 'node:assert/strict';
import process from 'node:process';
import { createPostgresCycleStore } from '../dist/adapters/engine-store/postgres-cycle-store.js';
import { createPostgresPaperAuthorityStore } from '../dist/adapters/engine-store/postgres-paper-authority-store.js';
import { createPostgresPaperGateWriter as createProductionPaperGateWriter } from '../dist/adapters/engine-store/postgres-paper-gate-writer.js';
import {
  evaluatePaperAuthority,
  generationInputsFromConfiguration,
} from '../dist/domain/paper-authority.js';
import { runCycleJob } from '../dist/application/cycle.js';
import { createPostgresPaperGateWriter } from '../dist-test-support/adapters/engine-store/postgres-paper-gate-writer.js';
import { AUDITED_POLICY_FIXTURE } from '../dist-test-support/test-support/paper-gate-audited-policy-fixture.js';
import { createPostgresControlRecorder } from '../../platform-api/dist/adapters/engine-store/postgres-engine-store.js';
import { createEngineRecorderClient } from '../../platform-api/dist/adapters/engine-store/engine-query-client.js';
import { validateParameters } from '../../platform-api/dist/application/manage-budget-control.js';

const CAPABILITY = 'budget:paper';
// Its own epoch band, so this composition cannot disturb or be disturbed by another.
const EPOCH = 17;
const ACTOR = 'e2e-actor';
// The decoder requires exactly this: the budget identity is the actor plus ':paper'.
const BUDGET = ACTOR + ':paper';
const FUNDING = 'e2e-funding';
const OWNER = 'e2e-owner';
const RUN = 'root-paper-run';
const GEN = 'e2e-generation';
const POLICY = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
const OBSERVED_ISO = '2026-10-14T00:00:00.000Z';
const JOB_RUN_CAPABILITY = 'budget:paper-e2e-synthetic';
const CYCLE_RUN_ID = 'e2e-cycle-run';
const CYCLE_RUN_ID_WIRED = 'e2e-cycle-run-wired';
// Twelve scalar fields, exactly as the engine's decoder recognises them. Recognising this
// shape is NOT adopting it as the operator contract: that is a human decision this test
// does not make, and no default, cap or funding value here is a selected one.
const CONFIG = Object.freeze({
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
});
// What the pure mapping must produce from CONFIG's seven profile fields: a rename, with
// the recorded spellings carried through untouched.
const GENERATION_INPUTS = Object.freeze({
  bundleId: 'paper-regime-historical-warm-lineage-v1',
  enabled: true,
  evidenceHalfLifeWindows: '2.50',
  minimumPolicyWindows: 4,
  pauseConfidence: '0.970',
  profileClaim: 'synthetic-profile-claim',
  resumeConfidence: '0.9',
});

export async function paperRunEndToEndPostgresContract(admin, port) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(/^\d+$/.test(String(port)));
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';
  const recorderUrl = 'postgres://engine_control_recorder@127.0.0.1:' + port + '/postgres';
  const describe = (value) =>
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  // Preconditions: this band is empty and no lease exists for the capability, so every
  // control row and the lease below are ones this contract takes through a port.
  const [band] = await admin.unsafe(
    'select count(*)::text as n from engine.control_intent where capability=$1 and epoch>=$2',
    [CAPABILITY, EPOCH],
  );
  assert.equal(band.n, '0');
  const [leases] = await admin.unsafe(
    'select count(*)::text as n from engine.job_lease where capability=$1',
    [CAPABILITY],
  );
  assert.equal(leases.n, '0');

  const gateCounts = async () => {
    const [row] = await admin.unsafe(
      'select (select count(*) from engine.paper_gate_generation where generation_key=$1)::text as generations, (select count(*) from engine.paper_gate_phase_event where generation_key=$1)::text as events, (select count(*) from engine.paper_gate_head where generation_key=$1)::text as heads',
      [GEN],
    );
    return row;
  };
  const advisoryLocks = async () => {
    const [row] = await admin.unsafe(
      "select count(*)::text as n from pg_locks where locktype='advisory'",
    );
    return row.n;
  };

  const recorderClient = createEngineRecorderClient(recorderUrl);
  const recorder = createPostgresControlRecorder({ client: recorderClient, schema: 'engine' });
  const cycleStore = createPostgresCycleStore(writerUrl);
  const authority = createPostgresPaperAuthorityStore(writerUrl);
  const facts = {};
  let primary;
  let primaryPresent = false;
  let grant;

  try {
    // 1. THE CONTROL FACTS, through the API's own validator and recorder.
    //
    // The validator is the real one the signed-in route applies, so the twelve-field
    // document is proved to fit the API's parameter domain before anything is written.
    assert.equal(Object.keys(CONFIG).length, 19);
    assert.equal(validateParameters(CONFIG), true);
    assert.equal(
      validateParameters({ ...CONFIG, nested: { not: 'allowed' } }),
      false,
      'the parameter domain must still refuse a nested member',
    );
    // The cap is twenty: a twenty-first field is refused by the API before any row
    // exists, which is the boundary the published contract now states.
    assert.equal(
      validateParameters(
        Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`synthetic_${index}`, index])),
      ),
      false,
      'the parameter domain must refuse a twenty-first field',
    );
    const configureRecorded = await recorder.record({
      action: 'configure',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: CONFIG,
      recordedAt: new Date('2026-10-12T05:00:00.000Z'),
      runId: RUN,
    });
    const CONFIG_INTENT = configureRecorded.id;
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(CONFIG_INTENT),
      'the recorder returned something that is not a v4 UUID: ' + describe(configureRecorded),
    );
    // The synthetic funding and budget roots the authority reader requires. ADMIN, because
    // these are FK fixtures no port on this branch writes — and they are bound to the
    // configure row the REAL recorder just created, not to a hand-made id.
    await admin.unsafe(
      'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$6,clock_timestamp())',
      [FUNDING, EPOCH, BUDGET, ACTOR, CONFIG_INTENT, RUN],
    );
    await admin.unsafe(
      'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$4,1000,700,300,0,0,4,$5,clock_timestamp())',
      [FUNDING, EPOCH, BUDGET, CONFIG_INTENT, RUN],
    );
    const resumeRecorded = await recorder.record({
      action: 'resume',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: { paper_config_version: 2, config_intent_id: CONFIG_INTENT },
      recordedAt: new Date('2026-10-12T05:01:00.000Z'),
      runId: RUN,
    });
    // Both documents are stored as jsonb OBJECTS — verified by admin, because the role
    // that wrote them cannot read them, which one assertion here re-proves.
    const stored = await admin.unsafe(
      "select id, jsonb_typeof(parameters) as type, parameters->>'funding_id' as funding_id, parameters->>'config_intent_id' as config_intent_id from engine.control_intent where id = any($1::text[]) order by recorded_at asc",
      [[CONFIG_INTENT, resumeRecorded.id]],
    );
    assert.deepEqual(
      stored.map((row) => ({
        config_intent_id: row.config_intent_id,
        funding_id: row.funding_id,
        type: row.type,
      })),
      [
        { config_intent_id: null, funding_id: FUNDING, type: 'object' },
        { config_intent_id: CONFIG_INTENT, funding_id: null, type: 'object' },
      ],
      describe(stored),
    );
    const readDenial = await recorderClient
      .query('select id from "engine"."control_intent" limit 1', [])
      .then(
        () => 'READ-WHICH-IS-WRONG',
        (error) => String(error && error.code),
      );
    assert.equal(readDenial, '42501');

    // 2. THE LEASE, through the real port. Nothing below is fenced by a token this
    //    contract made up.
    const now = new Date();
    const acquisition = await cycleStore.acquireLease({
      capability: CAPABILITY,
      expiresAt: new Date(now.getTime() + 600000),
      now,
      owner: OWNER,
    });
    assert.equal(acquisition.acquired, true, describe(acquisition));
    grant = acquisition.grant;
    assert.equal(grant.owner, OWNER);
    assert.ok(Number.isSafeInteger(grant.fencingToken) && grant.fencingToken >= 1);
    const contended = await cycleStore.acquireLease({
      capability: CAPABILITY,
      expiresAt: new Date(now.getTime() + 600000),
      now,
      owner: 'e2e-other-owner',
    });
    assert.equal(contended.acquired, false, describe(contended));
    assert.equal(contended.holder.owner, OWNER);
    const fence = {
      capability: CAPABILITY,
      owner: grant.owner,
      fencingToken: BigInt(grant.fencingToken),
    };
    const scope = { capability: CAPABILITY, epoch: EPOCH };

    // 3. AUTHORITY, through the real persisted reader, under that real fence.
    const readEvidence = async () => {
      const result = await authority.readAuthority(scope, fence);
      assert.equal(result.kind, 'read', 'authority read refused: ' + describe(result));
      return result.evidence;
    };
    const evidence = await readEvidence();
    // The production default: the compiled bundle is unavailable, so admission refuses
    // even though every other condition holds.
    assert.deepEqual(evidence.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'bundle-unavailable',
    });
    // The same snapshot, re-run by the pure reducer with an audited-bundle fixture, is
    // allowed — and the configuration it returns is the document the recorder wrote,
    // field for field, with the intent ids the ports generated.
    const overridden = evaluatePaperAuthority(evidence.snapshot, true);
    assert.equal(overridden.allowed, true, describe(overridden));
    assert.deepEqual({ ...overridden.config }, { ...CONFIG });
    assert.deepEqual(
      { configIntentId: overridden.configIntentId, latestIntentId: overridden.latestIntentId },
      { configIntentId: CONFIG_INTENT, latestIntentId: resumeRecorded.id },
    );
    // The clock-skew allowance is the existing constant, carried by the evidence; no new
    // tolerance and no evidence-age rule is introduced anywhere in this contract.
    assert.equal(evidence.clockSkewAllowanceMs, 300000);

    // A real `pause` through the real recorder makes the next read refuse, and a correct
    // `resume` restores it. Semantics, not strings: the ids are the ones the recorder
    // returned.
    const pausedRecorded = await recorder.record({
      action: 'pause',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: null,
      recordedAt: new Date('2026-10-12T05:02:00.000Z'),
      runId: RUN,
    });
    const pausedEvidence = await readEvidence();
    assert.deepEqual(pausedEvidence.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'paused',
    });
    assert.equal(evaluatePaperAuthority(pausedEvidence.snapshot, true).reason, 'paused');
    assert.equal(pausedEvidence.snapshot.latest.id, pausedRecorded.id);
    // A resume whose reference does not name the configure row is refused on its own
    // terms, even with an audited bundle.
    const wrongResume = await recorder.record({
      action: 'resume',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: { paper_config_version: 2, config_intent_id: pausedRecorded.id },
      recordedAt: new Date('2026-10-12T05:03:00.000Z'),
      runId: RUN,
    });
    const wrongEvidence = await readEvidence();
    assert.equal(wrongEvidence.snapshot.latest.id, wrongResume.id);
    assert.equal(
      evaluatePaperAuthority(wrongEvidence.snapshot, true).reason,
      'resume-reference-invalid',
    );
    const goodResume = await recorder.record({
      action: 'resume',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: { paper_config_version: 2, config_intent_id: CONFIG_INTENT },
      recordedAt: new Date('2026-10-12T05:04:00.000Z'),
      runId: RUN,
    });
    const restored = await readEvidence();
    assert.deepEqual(restored.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'bundle-unavailable',
    });
    assert.equal(evaluatePaperAuthority(restored.snapshot, true).allowed, true);
    assert.equal(restored.snapshot.latest.id, goodResume.id);

    // 4. THE GATE WRITE. The PRODUCTION writer goes FIRST, on a namespace where nothing
    //    has been written yet, so its refusal cannot be mistaken for a replay of work the
    //    test artifact had already done.
    //
    //    The generation it is handed is DERIVED from the decoded configure document by the
    //    pure mapping, not hand-written here: the operator-recorded profile is what a
    //    write would persist.
    const mappedGeneration = generationInputsFromConfiguration(overridden.config);
    assert.deepEqual({ ...mappedGeneration }, { ...GENERATION_INPUTS });
    const genesisRequest = {
      coverageCutoffAtIso: OBSERVED_ISO,
      coverageReceiptId: 'e2e-receipt',
      evidenceObservedAtIso: OBSERVED_ISO,
      eventKey: 'e2e-genesis',
      generation: mappedGeneration,
      kind: 'initialize',
      runId: RUN,
      scope: {
        budget_id: BUDGET,
        epoch: EPOCH,
        funding_id: FUNDING,
        generation_config_intent_id: CONFIG_INTENT,
        generation_key: GEN,
        sample_policy: POLICY,
      },
    };
    const emptyGate = await gateCounts();
    assert.deepEqual(emptyGate, { events: '0', generations: '0', heads: '0' });
    const productionWriter = createProductionPaperGateWriter(writerUrl);
    let productionRefusal;
    try {
      productionRefusal = await productionWriter.write(genesisRequest, fence);
    } finally {
      await productionWriter.close().catch(() => undefined);
    }
    assert.deepEqual(
      {
        detail: productionRefusal.detail,
        kind: productionRefusal.kind,
        reason: productionRefusal.reason,
      },
      { detail: 'bundle-unavailable', kind: 'refused', reason: 'authority' },
    );
    // Nothing at all was written by the production writer.
    assert.deepEqual(await gateCounts(), { events: '0', generations: '0', heads: '0' });

    // The TEST ARTIFACT writer, which holds the identity-bound audited-policy fixture,
    // then writes the genesis at revision 0 and a real EVALUATED advance to revision 1 —
    // two different writes, not one write replayed twice.
    const artifactWriter = (effects) =>
      createPostgresPaperGateWriter(writerUrl, effects, AUDITED_POLICY_FIXTURE);
    const evaluateAt = (eventKey, expectedRevision) => ({
      coverageCutoffAtIso: OBSERVED_ISO,
      coverageReceiptId: 'e2e-receipt',
      evidenceObservedAtIso: OBSERVED_ISO,
      eventKey,
      expectedRevision,
      kind: 'evaluate',
      runId: RUN,
      scope: genesisRequest.scope,
    });
    const genesisWriter = artifactWriter();
    try {
      const genesis = await genesisWriter.write(genesisRequest, fence);
      assert.equal(genesis.kind, 'written', describe(genesis));
      assert.equal(genesis.receipt.revisionAfter, 0n);
    } finally {
      await genesisWriter.close().catch(() => undefined);
    }
    const advanceWriter = artifactWriter();
    try {
      const advanced = await advanceWriter.write(evaluateAt('e2e-advance', 0n), fence);
      assert.equal(advanced.kind, 'written', describe(advanced));
      assert.equal(advanced.receipt.revisionAfter, 1n);
    } finally {
      await advanceWriter.close().catch(() => undefined);
    }
    assert.deepEqual(await gateCounts(), { events: '2', generations: '1', heads: '1' });

    // 4b. THE PERSISTED PROFILE IS THE RECORDED ONE. Read back by admin SQL, with the
    //     numeric columns as text so no driver conversion sits in the comparison.
    const [persistedProfile] = await admin.unsafe(
      'select bundle_id, profile_claim, enabled, minimum_policy_windows::text as minimum_policy_windows, evidence_half_life_windows::text as evidence_half_life_windows, pause_confidence::text as pause_confidence, resume_confidence::text as resume_confidence from engine.paper_gate_generation where generation_key=$1',
      [GEN],
    );
    assert.deepEqual(persistedProfile, {
      bundle_id: CONFIG.regime_bundle_id,
      enabled: CONFIG.regime_enabled,
      // `numeric` keeps the scale it was given, so the recorded spelling survives.
      evidence_half_life_windows: CONFIG.regime_evidence_half_life_windows,
      minimum_policy_windows: String(CONFIG.regime_minimum_policy_windows),
      pause_confidence: CONFIG.regime_pause_confidence,
      profile_claim: CONFIG.regime_profile_claim,
      resume_confidence: CONFIG.regime_resume_confidence,
    });

    // 4c. NEGATIVE VECTORS for the document itself, through the real recorder and the
    //     real authority read. Each one is recorded in this contract's own epoch band,
    //     read, and then REMOVED, so the authority the steps below read is exactly the
    //     authority they read before: the generation on disk is bound to this scope's
    //     configure intent, and leaving a different configure as the newest row would
    //     move the namespace rather than test the document.
    for (const [label, parameters, expected] of [
      // A version-1 twelve-field document is refused, not upgraded or defaulted.
      [
        'version-1',
        Object.fromEntries(
          Object.entries(CONFIG)
            .filter(([key]) => !key.startsWith('regime_'))
            .concat([['paper_config_version', 1]]),
        ),
        'configuration-invalid',
      ],
      // A profile whose resume confidence does not clear the margin on the digits.
      [
        'margin-violated',
        { ...CONFIG, regime_pause_confidence: '0.97', regime_resume_confidence: '0.9601' },
        'configuration-invalid',
      ],
      // A profile field outside the 0006 domain.
      [
        'windows-out-of-domain',
        { ...CONFIG, regime_minimum_policy_windows: 501 },
        'configuration-invalid',
      ],
    ]) {
      // The API's domain accepts all three: these are SEMANTIC refusals by the engine's
      // decoder, not structural ones by the parameter validator.
      assert.equal(validateParameters(parameters), true, label);
      const badConfigure = await recorder.record({
        action: 'configure',
        actor: ACTOR,
        capability: CAPABILITY,
        epoch: EPOCH,
        parameters,
        recordedAt: new Date('2026-10-12T05:04:10.000Z'),
        runId: RUN,
      });
      const badResume = await recorder.record({
        action: 'resume',
        actor: ACTOR,
        capability: CAPABILITY,
        epoch: EPOCH,
        parameters: { paper_config_version: 2, config_intent_id: badConfigure.id },
        recordedAt: new Date('2026-10-12T05:04:20.000Z'),
        runId: RUN,
      });
      const badEvidence = await readEvidence();
      assert.deepEqual(
        badEvidence.decisionUnderProductionBundle,
        { allowed: false, reason: expected },
        label,
      );
      // And with the audited fixture, so the refusal is the DOCUMENT's rather than the
      // compiled bundle's unavailability.
      assert.equal(evaluatePaperAuthority(badEvidence.snapshot, true).reason, expected, label);
      await admin.unsafe('delete from engine.control_intent where id=any($1)', [
        [badResume.id, badConfigure.id],
      ]);
    }
    // A fresh resume naming THIS scope's original configure row, so the newest authority
    // is again the one the persisted generation is bound to.
    const restoredResume = await recorder.record({
      action: 'resume',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: { paper_config_version: 2, config_intent_id: CONFIG_INTENT },
      recordedAt: new Date('2026-10-12T05:04:30.000Z'),
      runId: RUN,
    });
    const restoredAfterVectors = await readEvidence();
    assert.deepEqual(restoredAfterVectors.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'bundle-unavailable',
    });
    const restoredDecision = evaluatePaperAuthority(restoredAfterVectors.snapshot, true);
    assert.equal(restoredDecision.allowed, true, describe(restoredDecision));
    assert.deepEqual(
      {
        configIntentId: restoredDecision.configIntentId,
        latestIntentId: restoredDecision.latestIntentId,
      },
      { configIntentId: CONFIG_INTENT, latestIntentId: restoredResume.id },
    );

    // 5. INTERLEAVINGS, measured against the real ports rather than asserted as policy.
    //
    // (a) A real heartbeat committed INSIDE a mutating, non-replay write transaction,
    //     after its mutations and before its final row lock. The heartbeat succeeds on
    //     its own connection — the writer holds no lock on `job_lease` yet, so nothing
    //     deadlocks — and the writer's final fence then finds the row changed since its
    //     snapshot and refuses, with nothing written. That is a MEASUREMENT of the
    //     existing isolation, not a new no-retry rule.
    let heartbeatRan = false;
    const conflicted = artifactWriter({
      beforeFinalFence: async () => {
        if (heartbeatRan) return;
        heartbeatRan = true;
        await cycleStore.heartbeat(grant, new Date(), new Date(Date.now() + 600000));
      },
    });
    let conflictOutcome;
    try {
      conflictOutcome = await conflicted.write(evaluateAt('e2e-heartbeat-conflict', 1n), fence);
    } finally {
      await conflicted.close().catch(() => undefined);
    }
    assert.equal(heartbeatRan, true);
    assert.deepEqual(
      {
        detail: conflictOutcome.detail,
        kind: conflictOutcome.kind,
        reason: conflictOutcome.reason,
      },
      { detail: 'serialization-failure', kind: 'refused', reason: 'conflict' },
    );
    // Nothing was written, and the lease this run holds is still this run's.
    assert.deepEqual(await gateCounts(), { events: '2', generations: '1', heads: '1' });
    const [heldAfter] = await admin.unsafe(
      'select owner, fencing_token::text as token, (expires_at > clock_timestamp()) as live from engine.job_lease where capability=$1',
      [CAPABILITY],
    );
    assert.deepEqual(
      { live: heldAfter.live, owner: heldAfter.owner, token: heldAfter.token },
      { live: true, owner: OWNER, token: String(grant.fencingToken) },
    );

    // (b) The cycle loop's own order — heartbeat BETWEEN transactions — and both writes
    //     apply.
    await cycleStore.heartbeat(grant, new Date(), new Date(Date.now() + 600000));
    const betweenWriter = artifactWriter();
    try {
      const applied = await betweenWriter.write(evaluateAt('e2e-after-heartbeat', 1n), fence);
      assert.equal(applied.kind, 'written', describe(applied));
      assert.equal(applied.receipt.revisionAfter, 2n);
    } finally {
      await betweenWriter.close().catch(() => undefined);
    }
    assert.deepEqual(await gateCounts(), { events: '3', generations: '1', heads: '1' });

    // (c) A real `pause` recorded AFTER a write is what the next authority read sees.
    const lateP = await recorder.record({
      action: 'pause',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: null,
      recordedAt: new Date('2026-10-12T05:05:00.000Z'),
      runId: RUN,
    });
    const afterWritePause = await readEvidence();
    assert.equal(afterWritePause.snapshot.latest.id, lateP.id);
    assert.deepEqual(afterWritePause.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'paused',
    });
    const pausedWrite = artifactWriter();
    try {
      const refused = await pausedWrite.write(evaluateAt('e2e-while-paused', 2n), fence);
      assert.deepEqual(
        { detail: refused.detail, kind: refused.kind, reason: refused.reason },
        { detail: 'paused', kind: 'refused', reason: 'authority' },
      );
    } finally {
      await pausedWrite.close().catch(() => undefined);
    }
    assert.deepEqual(await gateCounts(), { events: '3', generations: '1', heads: '1' });

    // (d) The real release, then a write: refused at the START boundary, nothing written.
    await cycleStore.releaseLease(grant, new Date());
    const unleashed = artifactWriter();
    try {
      const refused = await unleashed.write(evaluateAt('e2e-after-release', 2n), fence);
      assert.deepEqual(
        { detail: refused.detail, kind: refused.kind, reason: refused.reason },
        { detail: 'start-boundary', kind: 'refused', reason: 'lease-not-held' },
      );
    } finally {
      await unleashed.close().catch(() => undefined);
    }
    // And the authority reader refuses on the same fence, for the same reason.
    const afterRelease = await authority.readAuthority(scope, fence);
    assert.deepEqual(afterRelease, {
      detail: 'start-boundary',
      kind: 'refused',
      reason: 'lease-not-held',
    });
    assert.deepEqual(await gateCounts(), { events: '3', generations: '1', heads: '1' });

    // 6. THE RUNTIME IS STILL FAIL-CLOSED, composed rather than argued, in BOTH shapes:
    //    unwired, where the paper lane answers exactly what it always answered; and
    //    WIRED (new, 2026-10-19), where it reads the real persisted authority under its
    //    own lease fence and records what that read said. Either way it takes its own
    //    lease, opens and closes its own run record, performs no tick and writes no gate
    //    row. A standing resume is deliberately in place first, so a refusal is the paper
    //    lane's and not a paused control.
    await recorder.record({
      action: 'resume',
      actor: ACTOR,
      capability: CAPABILITY,
      epoch: EPOCH,
      parameters: { paper_config_version: 2, config_intent_id: CONFIG_INTENT },
      recordedAt: new Date('2026-10-12T05:06:00.000Z'),
      runId: RUN,
    });
    const cycleResult = await runCycleJob({
      capability: CAPABILITY,
      controlEpoch: EPOCH,
      jobRunCapability: JOB_RUN_CAPABILITY,
      mode: 'paper',
      now: () => new Date(),
      runId: CYCLE_RUN_ID,
      sleep: async () => undefined,
      store: cycleStore,
      ticks: 1,
    });
    assert.deepEqual(
      {
        mode: cycleResult.mode,
        outcome: cycleResult.outcome,
        reason: cycleResult.reason,
        ticksCompleted: cycleResult.ticksCompleted,
      },
      { mode: 'paper', outcome: 'refused', reason: 'mode-not-implemented', ticksCompleted: 0 },
    );
    // It released the lease it took, and wrote no gate row at all.
    const [afterCycle] = await admin.unsafe(
      'select count(*)::text as n from engine.job_lease where capability=$1 and expires_at > clock_timestamp()',
      [CAPABILITY],
    );
    assert.equal(afterCycle.n, '0');
    assert.deepEqual(await gateCounts(), { events: '3', generations: '1', heads: '1' });
    assert.equal(await advisoryLocks(), '0');

    // 6b. THE WIRED LANE. The same real cycle store, the same real control rows, plus the
    //     REAL persisted authority reader as its `paper` dependency. The production
    //     decision is what it records — `bundle-unavailable` for an otherwise valid
    //     configure and resume — and it is no longer a blanket mode refusal.
    const paperWriteCounts = async () => {
      const [row] = await admin.unsafe(
        'select (select count(*) from engine.paper_order)::text as orders, (select count(*) from engine.paper_reservation)::text as reservations, (select count(*) from engine.paper_entry_effect)::text as entry_effects, (select count(*) from engine.paper_sale_event)::text as sales, (select count(*) from engine.paper_gate_candidate)::text as candidates, (select count(*) from engine.paper_gate_outcome)::text as outcomes from engine.control_intent limit 1',
      );
      return row;
    };
    const paperWritesBefore = await paperWriteCounts();
    const bookkeeping = async (runId) => {
      const [row] = await admin.unsafe(
        'select (select count(*) from engine.control_outcome where applied_run_id=$1)::text as outcomes, (select count(*) from engine.job_run_record where run_id=$1)::text as records, (select last_outcome from engine.job_run where capability=$2) as job_run_outcome from engine.control_intent limit 1',
        [runId, JOB_RUN_CAPABILITY],
      );
      return row;
    };
    const wired = await runCycleJob({
      capability: CAPABILITY,
      controlEpoch: EPOCH,
      jobRunCapability: JOB_RUN_CAPABILITY,
      mode: 'paper',
      now: () => new Date(),
      paper: { authority },
      runId: CYCLE_RUN_ID_WIRED,
      sleep: async () => undefined,
      store: cycleStore,
      ticks: 1,
    });
    assert.deepEqual(
      {
        mode: wired.mode,
        outcome: wired.outcome,
        reason: wired.reason,
        ticksCompleted: wired.ticksCompleted,
      },
      { mode: 'paper', outcome: 'refused', reason: 'paper-bundle-unavailable', ticksCompleted: 0 },
    );
    // Control-plane bookkeeping happened — one outcome row, one run record, the job-health
    // row — and the paper side wrote exactly nothing.
    const wiredBooks = await bookkeeping(CYCLE_RUN_ID_WIRED);
    assert.deepEqual(wiredBooks, {
      job_run_outcome: 'refused',
      outcomes: '1',
      records: '1',
    });
    const [wiredOutcome] = await admin.unsafe(
      'select outcome, reason, intent_id from engine.control_outcome where applied_run_id=$1',
      [CYCLE_RUN_ID_WIRED],
    );
    assert.deepEqual(
      {
        intent_id: wiredOutcome.intent_id,
        outcome: wiredOutcome.outcome,
        reason: wiredOutcome.reason,
      },
      { intent_id: wired.intentId, outcome: 'refused', reason: 'paper-bundle-unavailable' },
    );
    assert.deepEqual(await gateCounts(), { events: '3', generations: '1', heads: '1' });
    // Zero PAPER-SIDE writes by this job, measured as "unchanged across the run" rather
    // than as an absolute count: other contracts in this chain leave their own synthetic
    // order, reservation, entry-effect and sale rows behind, and the claim here is about
    // what the cycle job emitted, not about the whole database.
    assert.deepEqual(await paperWriteCounts(), paperWritesBefore, 'the paper lane wrote rows');

    // 6c. IDEMPOTENCY, unchanged by the wiring: the same run id again writes no second
    //     outcome and runs nothing.
    const replayed = await runCycleJob({
      capability: CAPABILITY,
      controlEpoch: EPOCH,
      jobRunCapability: JOB_RUN_CAPABILITY,
      mode: 'paper',
      now: () => new Date(),
      paper: { authority },
      runId: CYCLE_RUN_ID_WIRED,
      sleep: async () => undefined,
      store: cycleStore,
      ticks: 1,
    });
    assert.deepEqual(
      {
        outcome: replayed.outcome,
        reason: replayed.reason,
        ticksCompleted: replayed.ticksCompleted,
      },
      { outcome: 'refused', reason: 'run-already-recorded', ticksCompleted: 0 },
    );
    assert.deepEqual(await bookkeeping(CYCLE_RUN_ID_WIRED), {
      job_run_outcome: 'refused',
      outcomes: '1',
      records: '1',
    });

    // 6d. LEASE CONTENTION, through the real job: another owner holding the lease makes
    //     the wired lane refuse `lease-held` before it reads anything.
    const contention = await cycleStore.acquireLease({
      capability: CAPABILITY,
      expiresAt: new Date(Date.now() + 600000),
      now: new Date(),
      owner: 'e2e-lease-holder',
    });
    assert.equal(contention.acquired, true, describe(contention));
    try {
      const blocked = await runCycleJob({
        capability: CAPABILITY,
        controlEpoch: EPOCH,
        jobRunCapability: JOB_RUN_CAPABILITY,
        mode: 'paper',
        now: () => new Date(),
        paper: { authority },
        runId: 'e2e-cycle-run-blocked',
        sleep: async () => undefined,
        store: cycleStore,
        ticks: 1,
      });
      assert.deepEqual(
        {
          outcome: blocked.outcome,
          reason: blocked.reason,
          ticksCompleted: blocked.ticksCompleted,
        },
        { outcome: 'refused', reason: 'lease-held', ticksCompleted: 0 },
      );
      const [blockedBooks] = await admin.unsafe(
        'select count(*)::text as n from engine.job_run_record where run_id=$1',
        ['e2e-cycle-run-blocked'],
      );
      assert.equal(blockedBooks.n, '0');
    } finally {
      await cycleStore.releaseLease(contention.grant, new Date());
    }

    // 6e. THE PRODUCTION WRITER STILL CANNOT WRITE, even handed this artifact's own
    //     audited-policy fixture: the production gate holds no token, so the fixture is
    //     not its token and the answer is the same refusal.
    //     A live lease is taken for it through the real port, because a released fence
    //     would refuse at the start boundary before the availability gate is even
    //     reached, which would prove nothing about the token.
    const tokenLease = await cycleStore.acquireLease({
      capability: CAPABILITY,
      expiresAt: new Date(Date.now() + 600000),
      now: new Date(),
      owner: OWNER,
    });
    assert.equal(tokenLease.acquired, true, describe(tokenLease));
    const tokenFence = {
      capability: CAPABILITY,
      owner: tokenLease.grant.owner,
      fencingToken: BigInt(tokenLease.grant.fencingToken),
    };
    const tokenedProduction = createProductionPaperGateWriter(
      writerUrl,
      undefined,
      AUDITED_POLICY_FIXTURE,
    );
    try {
      const refused = await tokenedProduction.write(
        evaluateAt('e2e-production-token', 2n),
        tokenFence,
      );
      assert.deepEqual(
        { detail: refused.detail, kind: refused.kind, reason: refused.reason },
        { detail: 'bundle-unavailable', kind: 'refused', reason: 'authority' },
      );
    } finally {
      await tokenedProduction.close().catch(() => undefined);
      await cycleStore.releaseLease(tokenLease.grant, new Date()).catch(() => undefined);
    }
    assert.deepEqual(await gateCounts(), { events: '3', generations: '1', heads: '1' });
    assert.equal(await advisoryLocks(), '0');

    // 6f. LEASE RELEASE ACROSS TWO CLOCK RESOLUTIONS, deterministic rather than timed.
    //
    //     `acquired_at` is written by the DATABASE clock at microsecond precision;
    //     `releaseLease` is handed a JavaScript `Date`, which carries milliseconds. A run
    //     that acquires and releases inside the same millisecond therefore offers an
    //     instant a few hundred microseconds BEFORE its own acquisition, and 0004's
    //     `check (expires_at >= acquired_at)` rejected that update with `23514`, leaving
    //     the lease held until its natural expiry. CI run 39531285790 attempt 1 failed
    //     exactly this way on `budget:paper` / `e2e-cycle-run-wired`.
    //
    //     This vector reproduces the ordering exactly, with no sleeping and no reliance on
    //     being fast: the row is seeded with an explicit historical `acquired_at` whose
    //     microsecond part is non-zero, and the release is handed the SAME instant
    //     truncated to its millisecond, which is 500us earlier.
    const CLAMP_CAPABILITY = 'budget:lease-clamp-probe';
    const CLAMP_OWNER = 'lease-clamp-owner';
    const CLAMP_ACQUIRED_AT = '2026-10-21T00:00:00.000500Z';
    const CLAMP_RELEASE_AT = new Date('2026-10-21T00:00:00.000Z');
    await admin.unsafe(
      "insert into engine.job_lease(capability,owner,fencing_token,acquired_at,expires_at,heartbeat_at) values($1,$2,1,$3::text::timestamptz,clock_timestamp()+interval '10 minutes',$3::text::timestamptz)",
      [CLAMP_CAPABILITY, CLAMP_OWNER, CLAMP_ACQUIRED_AT],
    );
    const clampGrant = {
      acquiredAt: new Date(CLAMP_ACQUIRED_AT),
      capability: CLAMP_CAPABILITY,
      expiresAt: new Date(Date.now() + 600000),
      fencingToken: 1,
      owner: CLAMP_OWNER,
    };
    assert.ok(CLAMP_RELEASE_AT.getTime() < Date.parse(CLAMP_ACQUIRED_AT) + 1);
    // The real adapter, under the intended role: the release commits instead of raising
    // `23514`, and the clamped instant is `acquired_at` itself, to the microsecond.
    await cycleStore.releaseLease(clampGrant, CLAMP_RELEASE_AT);
    const [clamped] = await admin.unsafe(
      'select expires_at::text as expires_at, heartbeat_at::text as heartbeat_at, acquired_at::text as acquired_at, (expires_at > clock_timestamp()) as live from engine.job_lease where capability=$1',
      [CLAMP_CAPABILITY],
    );
    assert.deepEqual(clamped, {
      acquired_at: '2026-10-21 00:00:00.0005+00',
      expires_at: '2026-10-21 00:00:00.0005+00',
      heartbeat_at: '2026-10-21 00:00:00.0005+00',
      // Clamping up to `acquired_at` cannot extend a lease: that instant is already past.
      live: false,
    });
    // The capability is free again, which is the whole point of a release.
    const afterClamp = await cycleStore.acquireLease({
      capability: CLAMP_CAPABILITY,
      expiresAt: new Date(Date.now() + 600000),
      now: new Date(),
      owner: 'lease-clamp-next-owner',
    });
    assert.equal(afterClamp.acquired, true, describe(afterClamp));
    assert.equal(afterClamp.grant.fencingToken, 2);
    // The fences are untouched by every refusal below, and each is checked against the
    // FULL row — capability, owner, token and all three timestamps — because a subset of
    // owner, token and expiry cannot tell a refusal apart from a write that moved a
    // heartbeat or an acquisition stamp. Exactly one row must exist throughout.
    const CLAMP_ROW_SQL =
      'select capability, owner, fencing_token::text as token, acquired_at::text as acquired_at, expires_at::text as expires_at, heartbeat_at::text as heartbeat_at from engine.job_lease where capability=$1';
    const clampRow = async () => {
      const rows = await admin.unsafe(CLAMP_ROW_SQL, [CLAMP_CAPABILITY]);
      assert.equal(rows.length, 1, describe(rows));
      return rows[0];
    };
    const clampLive = async () => {
      const [row] = await admin.unsafe(
        'select (expires_at > clock_timestamp()) as live from engine.job_lease where capability=$1',
        [CLAMP_CAPABILITY],
      );
      return row.live;
    };
    const heldRow = await clampRow();
    // The lease really is LIVE while the token negatives run, so none of them can be a
    // vacuous refusal against a lease that had already expired.
    assert.equal(await clampLive(), true);
    for (const [label, refusedGrant] of [
      // The case the first version of this vector could not distinguish: the CURRENT
      // owner presenting a SUPERSEDED token. Owner equality holds, so only the token
      // fence can refuse it, and removing that predicate must make this case fail.
      ['current-owner-stale-token', { ...afterClamp.grant, fencingToken: 1 }],
      ['current-owner-bogus-token', { ...afterClamp.grant, fencingToken: 99 }],
      ['wrong-owner-current-token', { ...afterClamp.grant, owner: 'not-the-owner' }],
      ['stale-owner-and-stale-token', { ...clampGrant, fencingToken: 1 }],
    ]) {
      await assert.rejects(
        () => cycleStore.releaseLease(refusedGrant, new Date()),
        (error) => /no longer holds the lease/.test(String(error && error.message)),
        label,
      );
      assert.deepEqual(await clampRow(), heldRow, label);
      assert.equal(await clampLive(), true, label);
    }
    // For the owner's own release, the acquisition stamp is re-dated by admin SQL to a
    // fixed historical instant while the expiry stays live. That is a fixture re-stamp,
    // not a stand-in for a port: owner and token are untouched, the release below is
    // still the real adapter's, and it makes the released expiry a DETERMINISTIC past
    // instant rather than something that has to elapse.
    const OWNER_ACQUIRED_AT = '2026-10-21T00:05:00.000500Z';
    const OWNER_RELEASE_AT = new Date('2026-10-21T00:06:00.000Z');
    await admin.unsafe(
      "update engine.job_lease set acquired_at=$2::text::timestamptz, heartbeat_at=$2::text::timestamptz, expires_at=clock_timestamp()+interval '10 minutes' where capability=$1",
      [CLAMP_CAPABILITY, OWNER_ACQUIRED_AT],
    );
    assert.equal(await clampLive(), true);
    await cycleStore.releaseLease(afterClamp.grant, OWNER_RELEASE_AT);
    const releasedRow = await clampRow();
    assert.deepEqual(releasedRow, {
      acquired_at: '2026-10-21 00:05:00.0005+00',
      capability: CLAMP_CAPABILITY,
      // A release instant AFTER the acquisition is recorded as given: the clamp is a
      // floor, not a rewrite.
      expires_at: '2026-10-21 00:06:00+00',
      heartbeat_at: '2026-10-21 00:06:00+00',
      owner: 'lease-clamp-next-owner',
      token: '2',
    });
    assert.equal(await clampLive(), false);
    // Repeating that release — SAME owner, SAME token, same instant — is refused by the
    // live-expiry predicate alone, because the lease it names is now expired. Nothing
    // moves, and removing that predicate must make this case fail.
    await assert.rejects(
      () => cycleStore.releaseLease(afterClamp.grant, OWNER_RELEASE_AT),
      (error) => /no longer holds the lease/.test(String(error && error.message)),
      'repeated-release-after-expiry',
    );
    assert.deepEqual(await clampRow(), releasedRow);
    facts.leaseReleaseClamp = 'released-at-acquired_at-microseconds';

    facts.configureDocumentVersion = 2;
    facts.profileRoundTrip = 'recorder-authority-persisted-equal';
    facts.generationInputsSource = 'decoded-configure';
    facts.authorityDecisionDefault = 'bundle-unavailable';
    facts.authorityDecisionOverride = 'allowed';
    facts.heartbeatDuringWrite = 'conflict/serialization-failure';
    facts.heartbeatBetweenWrites = 'both-applied';
    facts.productionGateWrite = 'refused/bundle-unavailable';
    facts.recorderRole = 'engine_control_recorder';
    facts.runtimePaperModeUnwired = 'refused/mode-not-implemented';
    facts.runtimePaperModeWired = 'refused/paper-bundle-unavailable';
    facts.runtimePaperWriteRows = 'zero';
    facts.runtimeIdempotentRerun = 'refused/run-already-recorded';
    facts.runtimeLeaseHeld = 'refused/lease-held';
    facts.productionWriterWithFixtureToken = 'refused/bundle-unavailable';
    facts.storedTypeof = 'object';
  } catch (error) {
    primary = error;
    primaryPresent = true;
  }

  // Teardown, every step collected so a cleanup failure cannot replace the real one.
  const teardownErrors = [];
  const teardown = async (step) => {
    await step().catch((error) => teardownErrors.push(String((error && error.message) || error)));
  };
  await teardown(() => recorderClient.close());
  await teardown(() => authority.close());
  await teardown(() => cycleStore.close());
  for (const [statement, values] of [
    ['delete from engine.paper_gate_head where generation_key=$1', [GEN]],
    ['delete from engine.paper_gate_phase_input where generation_key=$1', [GEN]],
    ['delete from engine.paper_gate_phase_event where generation_key=$1', [GEN]],
    ['delete from engine.paper_gate_generation where generation_key=$1', [GEN]],
    ['delete from engine.paper_budget_root where funding_id=$1', [FUNDING]],
    ['delete from engine.paper_funding_root where funding_id=$1', [FUNDING]],
    ['delete from engine.control_outcome where applied_run_id=$1', [CYCLE_RUN_ID]],
    ['delete from engine.control_outcome where applied_run_id=$1', [CYCLE_RUN_ID_WIRED]],
    ['delete from engine.job_run where capability=$1', [JOB_RUN_CAPABILITY]],
    ['delete from engine.job_run_record where run_id=$1', [CYCLE_RUN_ID]],
    ['delete from engine.job_run_record where run_id=$1', [CYCLE_RUN_ID_WIRED]],
    ['delete from engine.job_run_record where run_id=$1', ['e2e-cycle-run-blocked']],
    ['delete from engine.control_intent where capability=$1 and epoch>=$2', [CAPABILITY, EPOCH]],
    ['delete from engine.job_lease where capability=$1', [CAPABILITY]],
    ['delete from engine.job_lease where capability=$1', ['budget:lease-clamp-probe']],
  ])
    await teardown(() => admin.unsafe(statement, values));
  if (primaryPresent) throw primary;
  if (teardownErrors.length > 0) assert.fail('teardown failed: ' + describe(teardownErrors));
  return { ...facts, teardownErrors: teardownErrors.length };
  // What this proves: these ports COMPOSE, under the real roles and the real lease, with
  // the production writer and the production runtime still refusing. What it does not
  // prove: that the live engine runs paper, that the twelve-field document is the
  // operator contract, that any endpoint is direct, or that this issue is review-ready.
  // Those remain separate human decisions.
}
