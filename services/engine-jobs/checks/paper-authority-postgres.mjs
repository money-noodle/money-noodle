// Drives the ACTUAL persisted paper-authority reader against disposable fixtures.
// Reads only through `createPostgresPaperAuthorityStore`; no hand-written equivalent
// SQL stands in for it. Synthetic rows in existing approved tables only: no migration,
// no new grant, no production write, no account or money truth. Every cent value below
// is a disposable fixture number, never selected funding or a principal's balance.
//
// Timing: the fence vectors need real elapsed time, because the thing under test is the
// DATABASE clock passing a lease expiry. They use the shared `lease-fence-harness.mjs`
// barrier rather than a second copy of fragile timing logic, and never a sleep as a
// race oracle. Every other interleaving uses an explicit barrier with no timing at all.
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BLOCKED_SPAN_CEILING_MS,
  LEASE_BUDGET_MS,
  createLeaseFenceHarness,
} from './lease-fence-harness.mjs';
import { createPostgresPaperAuthorityStore } from '../dist/adapters/engine-store/postgres-paper-authority-store.js';
import { PAPER_AUTHORITY_EVIDENCE_PROTOCOL } from '../dist/domain/paper-authority-evidence.js';
import { evaluatePaperAuthority } from '../dist/domain/paper-authority.js';
import { MAX_INTENT_CLOCK_SKEW_MS } from '../dist/domain/intent.js';

const CAPABILITY = 'budget:paper';
// A capability with a live lease and no control rows at all, so "no intents" is proved
// against the real adapter rather than asserted.
const EMPTY_CAPABILITY = 'budget:paper-authority-synthetic-empty';
// Epoch 9 dominates the pre-existing epoch-1 fixture rows under `epoch desc`, so these
// vectors never depend on another contract's ordering.
const EPOCH = 9;
const ACTOR = 'authority-actor';
const BUDGET = ACTOR + ':paper';
const FUNDING = 'authority-funding';
const OWNER = 'authority-owner';
const TOKEN = 11n;
const RUN = 'root-paper-run';
const BIRTH = 'auth-birth';
// Explicit microsecond literals: the ordering under test is PostgreSQL's, at database
// precision, so no value here is derived from a JS Date.
// Strictly before the birth row, so a fixture intent that only needs to EXIST can
// never become the standing intent and change the reason under test.
const T_EARLIER = '2026-10-12 01:59:00.000000+00';
const T_BIRTH = '2026-10-12 02:00:00.000000+00';
const T_BIRTH_PLUS_1US = '2026-10-12 02:00:00.000001+00';
const T_RESET = '2026-10-12 02:00:00.500000+00';
const T_LATER = '2026-10-12 02:00:01.000000+00';
const T_LATEST = '2026-10-12 02:00:02.000000+00';
// Twelve scalar fields exactly as the DESIGN PROPOSAL decoder recognises them.
// Recognising this shape is not adopting it: it is not an approved operator API and no
// default is chosen here.
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
const RESUME_REF = { paper_config_version: 2, config_intent_id: BIRTH };

export async function paperAuthorityPostgresContract(admin, port) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(/^\d+$/.test(String(port)));
  const scope = { capability: CAPABILITY, epoch: EPOCH };
  const fence = { capability: CAPABILITY, owner: OWNER, fencingToken: TOKEN };
  const writerUrl = 'postgres://engine_writer@127.0.0.1:' + port + '/postgres';

  const counts = () =>
    admin.unsafe(
      'select (select count(*) from engine.control_intent) as intents, (select count(*) from engine.paper_funding_root) as funding, (select count(*) from engine.paper_budget_root) as budget, (select count(*) from engine.job_lease) as leases',
    );
  const before = await counts();
  // No other lease may be in play, so these fences are unambiguous.
  assert.equal(Number(before[0].leases), 0);
  // No reset exists in this contract's own epoch band, so the reset-barrier vectors
  // cannot pass for a reason another contract introduced.
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
  /** `recorded_at` from a server expression, for the clock-skew vectors only. */
  const intentAt = (id, action, expression, parameters) =>
    admin.unsafe(
      'insert into engine.control_intent(id,capability,action,actor,epoch,recorded_at,run_id,parameters) values($1,$2,$3,$4,$5,' +
        expression +
        ',$6,$7::text::jsonb)',
      [id, CAPABILITY, action, ACTOR, EPOCH, RUN, JSON.stringify(parameters)],
    );
  /** Removes this contract's own per-vector rows, never the retained birth row and
   * never another contract's rows. */
  const clearVectorIntents = () =>
    admin.unsafe('delete from engine.control_intent where capability=$1 and epoch>=$2 and id<>$3', [
      CAPABILITY,
      EPOCH,
      BIRTH,
    ]);

  await intent(BIRTH, 'configure', T_BIRTH, CONFIG);
  await admin.unsafe(
    'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$6,clock_timestamp())',
    [FUNDING, EPOCH, BUDGET, ACTOR, BIRTH, RUN],
  );
  // 700 + 300 = 1000 + 0 + 0: the conservation identity holds by construction, and the
  // adapter recomputes it in exact arbitrary-precision numeric regardless.
  await admin.unsafe(
    'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$4,1000,700,300,0,0,4,$5,clock_timestamp())',
    [FUNDING, EPOCH, BUDGET, BIRTH, RUN],
  );
  await admin.unsafe(
    "insert into engine.job_lease(capability,owner,fencing_token,acquired_at,expires_at,heartbeat_at) values($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp())",
    [CAPABILITY, OWNER, TOKEN.toString()],
  );
  await admin.unsafe(
    "insert into engine.job_lease(capability,owner,fencing_token,acquired_at,expires_at,heartbeat_at) values($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp())",
    [EMPTY_CAPABILITY, OWNER, TOKEN.toString()],
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

  const store = createPostgresPaperAuthorityStore(writerUrl);
  /** Every refusal must carry no evidence at all, not a partial snapshot. */
  const refusal = (result, reason, detail) => {
    assert.deepEqual(result, { detail, kind: 'refused', reason });
    assert.equal(Object.hasOwn(result, 'evidence'), false);
  };
  const readOf = async (overrideScope = scope, overrideFence = fence) => {
    const result = await store.readAuthority(overrideScope, overrideFence);
    assert.equal(
      result.kind,
      'read',
      // A bigint fencing token is in the refusal-free path's own fence, so the message
      // is composed from the refusal fields rather than serialized wholesale.
      'expected a read, got ' + String(result.reason) + '/' + String(result.detail),
    );
    return result.evidence;
  };

  try {
    // 1. Malformed scope, epoch and fence are refused BEFORE any statement runs, and
    // a capability that does not match the fence is refused too.
    for (const bad of [
      { capability: '', epoch: EPOCH },
      { capability: CAPABILITY, epoch: 0 },
      { capability: CAPABILITY, epoch: 1.5 },
      { capability: ' ' + CAPABILITY, epoch: EPOCH },
    ])
      refusal(await store.readAuthority(bad, fence), 'scope', 'scope');
    for (const bad of [
      { capability: CAPABILITY, owner: '', fencingToken: TOKEN },
      { capability: CAPABILITY, owner: OWNER, fencingToken: 0n },
      { capability: CAPABILITY, owner: OWNER, fencingToken: 11 },
    ])
      refusal(await store.readAuthority(scope, bad), 'scope', 'fence');
    refusal(
      await store.readAuthority({ capability: EMPTY_CAPABILITY, epoch: EPOCH }, fence),
      'scope',
      'capability-mismatch',
    );

    // 2. The start fence: a wrong owner, a wrong token and an expired lease all refuse
    // with no evidence.
    for (const wrong of [
      { ...fence, owner: 'not-the-owner' },
      { ...fence, fencingToken: TOKEN + 1n },
    ])
      refusal(await store.readAuthority(scope, wrong), 'lease-not-held', 'start-boundary');

    // 2b. N1: an EXPIRED lease refuses at the start boundary too, not only a wrong
    // owner or token. `job_lease` checks `expires_at >= acquired_at`, so both columns
    // move back.
    await admin.unsafe(
      "update engine.job_lease set acquired_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' where capability=$1",
      [CAPABILITY],
    );
    refusal(await store.readAuthority(scope, fence), 'lease-not-held', 'start-boundary');
    await restoreLease();

    // 3. A valid snapshot. The production decision refuses `bundle-unavailable` because
    // the adapter uses the reducer's own default availability and accepts no override.
    const valid = await readOf();
    assert.equal(valid.protocol, PAPER_AUTHORITY_EVIDENCE_PROTOCOL);
    assert.equal(valid.validity, 'single-transaction-snapshot-only');
    assert.equal(valid.lifetime, 'historical-read-evidence-after-commit');
    assert.equal(valid.admission, 'none');
    assert.equal(valid.clockSkewAllowanceMs, MAX_INTENT_CLOCK_SKEW_MS);
    assert.equal(valid.snapshot.complete, true);
    assert.equal(valid.snapshot.latest.id, BIRTH);
    assert.equal(valid.snapshot.configure.id, BIRTH);
    assert.equal(valid.snapshot.configureAtOrBeforeLatest, true);
    assert.equal(valid.snapshot.configureAfterReset, true);
    assert.equal(valid.newestResetIntentId, undefined);
    assert.equal(valid.snapshot.funding.conserved, true);
    assert.deepEqual(valid.snapshot.funding, {
      budgetId: BUDGET,
      conserved: true,
      epoch: EPOCH,
      id: FUNDING,
    });
    assert.deepEqual(valid.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'bundle-unavailable',
    });
    // The timestamp really crossed at database microsecond precision.
    assert.equal(valid.latestRecordedAtMicroseconds, 1791770400000000n);
    assert.equal(valid.configureRecordedAtMicroseconds, 1791770400000000n);
    assert.ok(valid.observedAtMicroseconds > 1791770400000000n);
    // Every funding sub-fact held, including the two that no schema constraint
    // enforces.
    assert.equal(valid.fundingFacts.identityHolds, true);
    assert.equal(valid.fundingFacts.birthIntentBound, true);
    assert.equal(valid.fundingFacts.otherEpochRootExists, false);
    assert.equal(valid.fundingFacts.availableCents, '700');
    assert.equal(valid.fundingFacts.reservedCents, '300');
    // The POSITIVE reducer path, reached only by a caller that supplies a known-audited
    // bundle itself. The adapter exposes the snapshot, never this flag.
    assert.deepEqual(evaluatePaperAuthority(valid.snapshot, true), {
      allowed: true,
      config: CONFIG,
      configIntentId: BIRTH,
      latestIntentId: BIRTH,
    });
    // And the explicit production-unavailable assertion on the same snapshot.
    assert.deepEqual(evaluatePaperAuthority(valid.snapshot), {
      allowed: false,
      reason: 'bundle-unavailable',
    });

    // 4. No intents at all for a capability that holds a live lease: refused for the
    // missing standing intent, with nothing invented.
    const emptyStore = createPostgresPaperAuthorityStore(writerUrl);
    try {
      const empty = await emptyStore.readAuthority(
        { capability: EMPTY_CAPABILITY, epoch: EPOCH },
        { capability: EMPTY_CAPABILITY, owner: OWNER, fencingToken: TOKEN },
      );
      assert.equal(empty.kind, 'read');
      assert.equal(empty.evidence.snapshot.complete, true);
      assert.equal(empty.evidence.snapshot.latest, undefined);
      assert.equal(empty.evidence.snapshot.configure, undefined);
      assert.equal(empty.evidence.snapshot.funding, undefined);
      assert.deepEqual(empty.evidence.decisionUnderProductionBundle, {
        allowed: false,
        reason: 'latest-authority-invalid',
      });
    } finally {
      await emptyStore.close();
    }

    // 5. A malformed NEWEST configure is never skipped in favour of the older valid
    // one. The retained birth row is still there and still valid, and is still not
    // used.
    for (const [id, parameters] of [
      ['auth-extra', { ...CONFIG, extra_field: 1 }],
      ['auth-scalar', 5],
      ['auth-string', 'not-an-object'],
      ['auth-array', [CONFIG]],
      ['auth-missing', { ...CONFIG, policy_bundle: undefined }],
      ['auth-overcap', { ...CONFIG, entry_cap_cents: CONFIG.total_cap_cents + 1 }],
      ['auth-wrong-budget', { ...CONFIG, budget_id: 'someone-else:paper' }],
    ]) {
      await intent(id, 'configure', T_LATER, parameters);
      const poisoned = await readOf();
      assert.equal(poisoned.snapshot.configure.id, id, 'newest configure must win');
      assert.equal(poisoned.snapshot.complete, true);
      assert.deepEqual(poisoned.decisionUnderProductionBundle, {
        allowed: false,
        reason: 'configuration-invalid',
      });
      await clearVectorIntents();
    }
    // The older valid configure is still present and is chosen once the poison is gone.
    assert.equal((await readOf()).snapshot.configure.id, BIRTH);

    // 6. Exact tie behaviour and the database microsecond boundary. Two configure rows
    // at the SAME instant are ordered by `id desc`; two rows one microsecond apart are
    // ordered by time, which a millisecond JS Date could not distinguish.
    await intent('auth-tie-a', 'configure', T_LATER, CONFIG);
    await intent('auth-tie-b', 'configure', T_LATER, { ...CONFIG, extra_field: 1 });
    assert.equal((await readOf()).snapshot.configure.id, 'auth-tie-b');
    await clearVectorIntents();
    await intent('auth-us-low', 'configure', T_BIRTH_PLUS_1US, CONFIG);
    const [gap] = await admin.unsafe(
      'select (extract(epoch from c2.recorded_at)*1000000)::numeric(30,0)::text as hi, (extract(epoch from c1.recorded_at)*1000000)::numeric(30,0)::text as lo from engine.control_intent c1 cross join engine.control_intent c2 where c1.id=$1 and c2.id=$2',
      [BIRTH, 'auth-us-low'],
    );
    assert.equal(BigInt(gap.hi) - BigInt(gap.lo), 1n);
    const microWinner = await readOf();
    assert.equal(microWinner.snapshot.configure.id, 'auth-us-low');
    assert.equal(microWinner.configureRecordedAtMicroseconds - 1791770400000000n, 1n);
    await clearVectorIntents();

    // 7. The standing intent is GLOBAL for the capability, not filtered to the
    // requested epoch: a newer-epoch row is visible and refuses rather than vanishing.
    await intent('auth-newer-epoch', 'configure', T_LATEST, CONFIG, ACTOR, EPOCH + 1);
    const newerEpoch = await readOf();
    assert.equal(newerEpoch.snapshot.latest.id, 'auth-newer-epoch');
    assert.equal(newerEpoch.snapshot.latest.epoch, EPOCH + 1);
    // The configure read is epoch-scoped because the reducer requires an equal epoch,
    // so the retained birth row is still the configure candidate.
    assert.equal(newerEpoch.snapshot.configure.id, BIRTH);
    assert.deepEqual(newerEpoch.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'latest-authority-invalid',
    });
    await admin.unsafe('delete from engine.control_intent where id=$1', ['auth-newer-epoch']);

    // 8. pause, reset and provider-enable as the standing action all leave paper
    // paused; a resume naming the configure row is admitted to the funding stage.
    for (const action of ['pause', 'reset', 'provider-enable']) {
      await intent('auth-' + action, action, T_LATEST, {});
      assert.deepEqual((await readOf()).decisionUnderProductionBundle, {
        allowed: false,
        reason: 'paused',
      });
      await clearVectorIntents();
    }
    await intent('auth-resume', 'resume', T_LATEST, RESUME_REF);
    const resumed = await readOf();
    assert.equal(resumed.snapshot.latest.id, 'auth-resume');
    assert.deepEqual(resumed.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'bundle-unavailable',
    });
    await clearVectorIntents();

    // 9. A resume whose reference does not name the chosen configure row, and a resume
    // whose reference is not the two-field shape at all.
    for (const parameters of [
      { paper_config_version: 2, config_intent_id: 'not-the-birth-row' },
      { paper_config_version: 2 },
      { paper_config_version: 2, config_intent_id: BIRTH, extra_field: 1 },
    ]) {
      await intent('auth-bad-resume', 'resume', T_LATEST, parameters);
      assert.deepEqual((await readOf()).decisionUnderProductionBundle, {
        allowed: false,
        reason: 'resume-reference-invalid',
      });
      await clearVectorIntents();
    }

    // 10. A configure recorded by a DIFFERENT actor than the standing resume is not
    // the configure this resume may bind.
    await intent('auth-other-actor', 'configure', T_LATER, CONFIG, 'someone-else');
    await intent('auth-resume-2', 'resume', T_LATEST, {
      paper_config_version: 2,
      config_intent_id: 'auth-other-actor',
    });
    const otherActor = await readOf();
    assert.equal(otherActor.snapshot.configure.id, 'auth-other-actor');
    assert.equal(otherActor.snapshot.configure.actor, 'someone-else');
    assert.deepEqual(otherActor.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'configure-authority-invalid',
    });
    await clearVectorIntents();

    // 11. The reset barrier, both ways, under the SERVER's ordering. A reset recorded
    // between the configure and the standing resume poisons that configure; a configure
    // recorded after the reset clears it. A reset under a NEWER epoch orders after an
    // older configure even though its wall-clock time is earlier.
    await intent('auth-reset-mid', 'reset', T_RESET, {});
    await intent('auth-resume-3', 'resume', T_LATEST, RESUME_REF);
    const afterReset = await readOf();
    assert.equal(afterReset.newestResetIntentId, 'auth-reset-mid');
    assert.equal(afterReset.snapshot.configureAfterReset, false);
    assert.deepEqual(afterReset.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'configure-authority-invalid',
    });
    // A configure recorded after that reset clears the barrier.
    await intent('auth-c-after-reset', 'configure', T_LATER, CONFIG);
    await admin.unsafe('delete from engine.control_intent where id=$1', ['auth-resume-3']);
    await intent('auth-resume-4', 'resume', T_LATEST, {
      paper_config_version: 2,
      config_intent_id: 'auth-c-after-reset',
    });
    const cleared = await readOf();
    assert.equal(cleared.snapshot.configure.id, 'auth-c-after-reset');
    assert.equal(cleared.snapshot.configureAfterReset, true);
    assert.deepEqual(cleared.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'bundle-unavailable',
    });
    await clearVectorIntents();
    // Newer epoch, EARLIER wall clock: the authoritative ordering is (epoch,
    // recorded_at, id), so this reset still orders after the configure.
    await intent('auth-reset-newer-epoch', 'reset', T_BIRTH, {}, ACTOR, EPOCH + 1);
    await intent('auth-resume-5', 'resume', T_LATEST, RESUME_REF);
    const newerReset = await readOf();
    assert.equal(newerReset.newestResetIntentId, 'auth-reset-newer-epoch');
    assert.equal(newerReset.snapshot.configureAfterReset, false);
    await clearVectorIntents();

    // 12. A configure recorded AFTER the standing intent is not at-or-before it. The
    // ordering is the server's row comparison, not a JS comparison of two Dates.
    await intent('auth-late-configure', 'configure', T_LATEST, CONFIG);
    await intent('auth-resume-6', 'resume', T_LATER, RESUME_REF);
    const notBefore = await readOf();
    assert.equal(notBefore.snapshot.latest.id, 'auth-late-configure');
    assert.equal(notBefore.snapshot.configure.id, 'auth-late-configure');
    assert.equal(notBefore.snapshot.configureAtOrBeforeLatest, true);
    await clearVectorIntents();

    // 13. Clock skew uses the EXISTING approved allowance, applied by PostgreSQL
    // against its own clock. A row inside the allowance is valid; one beyond it is
    // not; a non-finite timestamp is neither valid nor silently dropped.
    await intentAt(
      'auth-near-future',
      'configure',
      "clock_timestamp()+interval '60 seconds'",
      CONFIG,
    );
    const nearFuture = await readOf();
    assert.equal(nearFuture.snapshot.latest.id, 'auth-near-future');
    assert.equal(nearFuture.snapshot.latestTimeValid, true);
    assert.deepEqual(nearFuture.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'bundle-unavailable',
    });
    await clearVectorIntents();
    await intentAt(
      'auth-far-future',
      'configure',
      "clock_timestamp()+interval '" + (MAX_INTENT_CLOCK_SKEW_MS / 1000 + 60) + " seconds'",
      CONFIG,
    );
    const farFuture = await readOf();
    assert.equal(farFuture.snapshot.latest.id, 'auth-far-future');
    assert.equal(farFuture.snapshot.latestTimeValid, false);
    assert.deepEqual(farFuture.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'latest-authority-invalid',
    });
    await clearVectorIntents();
    // `control_intent.recorded_at` carries no `isfinite` check, so this row is
    // genuinely reachable. It sorts FIRST under `recorded_at desc`, so it IS the
    // newest row, and the adapter must report it as unrecognisable rather than let the
    // numeric cast raise or skip to an older row.
    await intentAt('auth-infinite', 'configure', "'infinity'::timestamptz", CONFIG);
    const infinite = await readOf();
    assert.equal(infinite.snapshot.complete, false);
    assert.equal(infinite.snapshot.latest, undefined);
    assert.equal(infinite.snapshot.latestTimeValid, false);
    assert.equal(infinite.latestRecordedAtMicroseconds, undefined);
    assert.deepEqual(infinite.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'latest-authority-invalid',
    });
    await clearVectorIntents();

    // 14. Funding and budget roots. A missing budget-root half, a funding identity the
    // configuration does not name, a budget id that is not the actor's, and a
    // birth-config intent that is not a matching configure all refuse. The conservation
    // identity is also a schema CHECK, so the discriminating facts here are the pair
    // join and the birth-intent binding, which no constraint enforces.
    await admin.unsafe('update engine.control_intent set parameters=$2::text::jsonb where id=$1', [
      BIRTH,
      JSON.stringify({ ...CONFIG, funding_id: 'no-such-funding' }),
    ]);
    const noFunding = await readOf();
    assert.equal(noFunding.snapshot.funding, undefined);
    assert.equal(noFunding.fundingFacts, undefined);
    assert.equal(noFunding.snapshot.complete, true);
    assert.deepEqual(noFunding.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'funding-invalid',
    });
    await admin.unsafe('update engine.control_intent set parameters=$2::text::jsonb where id=$1', [
      BIRTH,
      JSON.stringify(CONFIG),
    ]);
    // A second funding root at another epoch is audit information only.
    await admin.unsafe(
      'insert into engine.paper_funding_root(funding_id,epoch,budget_id,actor,birth_config_intent_id,origin_run_id,materialized_run_id,recorded_at) values($1,$2,$3,$4,$5,$6,$6,clock_timestamp())',
      [FUNDING, EPOCH + 1, BUDGET, ACTOR, BIRTH, RUN],
    );
    const otherEpoch = await readOf();
    assert.equal(otherEpoch.fundingFacts.otherEpochRootExists, true);
    assert.equal(otherEpoch.snapshot.funding.conserved, true);
    assert.equal(otherEpoch.snapshot.funding.epoch, EPOCH);
    await admin.unsafe(
      'delete from engine.paper_funding_root where funding_id=$1 and epoch=$2 and budget_id=$3',
      [FUNDING, EPOCH + 1, BUDGET],
    );
    // The birth-config intent is repointed at a PAUSE row that satisfies every foreign
    // key, so ONLY the adapter's own check can catch it — the fact 0006's own comments
    // assign to the adapter. Both roots are repointed together, because the budget
    // root's composite foreign key names the funding root's birth id, which keeps
    // `birthBound` true and leaves `birthIntentBound` the single failing fact.
    await intent('auth-birth-pause', 'pause', T_EARLIER, {});
    const rebindRoots = async (birthId) => {
      await admin.unsafe(
        'delete from engine.paper_budget_root where funding_id=$1 and epoch=$2 and budget_id=$3',
        [FUNDING, EPOCH, BUDGET],
      );
      await admin.unsafe(
        'update engine.paper_funding_root set birth_config_intent_id=$4 where funding_id=$1 and epoch=$2 and budget_id=$3',
        [FUNDING, EPOCH, BUDGET, birthId],
      );
      await admin.unsafe(
        'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$5,1000,700,300,0,0,4,$6,clock_timestamp())',
        [FUNDING, EPOCH, BUDGET, birthId, BIRTH, RUN],
      );
    };
    await rebindRoots('auth-birth-pause');
    const unboundBirth = await readOf();
    assert.equal(unboundBirth.fundingFacts.birthBound, true);
    assert.equal(unboundBirth.fundingFacts.identityHolds, true);
    assert.equal(unboundBirth.fundingFacts.birthIntentBound, false);
    assert.equal(unboundBirth.snapshot.funding.conserved, false);
    assert.deepEqual(unboundBirth.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'funding-invalid',
    });
    await rebindRoots(BIRTH);
    await clearVectorIntents();
    assert.equal((await readOf()).snapshot.funding.conserved, true);
    // A configured budget id that is not the actor's paper budget. The root lookup is
    // ACTOR-derived, not configuration-derived, so the real root is still found and
    // still conserved; it is the reducer that rejects the configuration for naming a
    // budget the actor does not own. A root whose own budget id were not
    // `actor || ':paper'` cannot exist: 0006 checks that on the row itself.
    await admin.unsafe('update engine.control_intent set parameters=$2::text::jsonb where id=$1', [
      BIRTH,
      JSON.stringify({ ...CONFIG, budget_id: 'someone-else:paper' }),
    ]);
    const wrongBudget = await readOf();
    assert.equal(wrongBudget.snapshot.funding.budgetId, BUDGET);
    assert.equal(wrongBudget.snapshot.funding.conserved, true);
    assert.deepEqual(wrongBudget.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'configuration-invalid',
    });
    await admin.unsafe('update engine.control_intent set parameters=$2::text::jsonb where id=$1', [
      BIRTH,
      JSON.stringify(CONFIG),
    ]);

    // 14b. N2: a funding root with NO budget root half. The pair is joined on the full
    // primary key, so half a pair is not a pair and no funding evidence is invented.
    await admin.unsafe(
      'delete from engine.paper_budget_root where funding_id=$1 and epoch=$2 and budget_id=$3',
      [FUNDING, EPOCH, BUDGET],
    );
    const fundingOnly = await readOf();
    assert.equal(fundingOnly.snapshot.funding, undefined);
    assert.equal(fundingOnly.fundingFacts, undefined);
    assert.equal(fundingOnly.snapshot.complete, true);
    assert.deepEqual(fundingOnly.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'funding-invalid',
    });
    await admin.unsafe(
      'insert into engine.paper_budget_root(funding_id,epoch,budget_id,birth_config_intent_id,latest_intent_id,starting_cents,available_cents,reserved_cents,realized_cents,correction_cents,revision,last_run_id,recorded_at) values($1,$2,$3,$4,$4,1000,700,300,0,0,4,$5,clock_timestamp())',
      [FUNDING, EPOCH, BUDGET, BIRTH, RUN],
    );
    assert.equal((await readOf()).snapshot.funding.conserved, true);

    // 14c. N3: a current resume that references a configure recorded under an OLDER
    // epoch. The configure read is epoch-scoped because the reducer requires an equal
    // epoch, so the older row is never the candidate: the current-epoch row is, and the
    // resume is refused for naming something else.
    await intent('auth-old-epoch-configure', 'configure', T_LATEST, CONFIG, ACTOR, EPOCH - 1);
    await intent('auth-current-resume', 'resume', T_LATEST, {
      paper_config_version: 2,
      config_intent_id: 'auth-old-epoch-configure',
    });
    const oldEpoch = await readOf();
    assert.equal(oldEpoch.snapshot.latest.id, 'auth-current-resume');
    // The older-epoch row was NOT selected, even though it is the one referenced.
    assert.equal(oldEpoch.snapshot.configure.id, BIRTH);
    assert.equal(oldEpoch.snapshot.configure.epoch, EPOCH);
    assert.deepEqual(oldEpoch.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'resume-reference-invalid',
    });
    await admin.unsafe('delete from engine.control_intent where id=$1', [
      'auth-old-epoch-configure',
    ]);
    await clearVectorIntents();
    assert.equal((await readOf()).snapshot.configure.id, BIRTH);

    // 15. ONE coherent snapshot, with genuinely different pre and post states. The
    // barrier commits a NEWER malformed configure between the standing-intent read and
    // the configure read, so a READ COMMITTED adapter would pick the malformed row and
    // refuse `configuration-invalid`. This one still sees the birth row and refuses
    // only for the unavailable bundle.
    let midRan = false;
    const midStore = createPostgresPaperAuthorityStore(writerUrl, {
      afterLatestRead: async () => {
        if (midRan) return;
        midRan = true;
        await intent('auth-midread', 'configure', T_LATER, { ...CONFIG, extra_field: 1 });
      },
    });
    try {
      const mid = await midStore.readAuthority(scope, fence);
      assert.equal(midRan, true);
      assert.equal(mid.kind, 'read');
      assert.equal(mid.evidence.snapshot.configure.id, BIRTH);
      assert.deepEqual(mid.evidence.decisionUnderProductionBundle, {
        allowed: false,
        reason: 'bundle-unavailable',
      });
    } finally {
      await midStore.close();
    }
    // Pre and post genuinely differ: a FRESH transaction sees the commit and refuses,
    // so the verified read above was not a coincidence of identical state.
    const after = await readOf();
    assert.equal(after.snapshot.configure.id, 'auth-midread');
    assert.deepEqual(after.decisionUnderProductionBundle, {
      allowed: false,
      reason: 'configuration-invalid',
    });
    await clearVectorIntents();

    // 16. Strict serialization failure 40001 on a lease takeover, and on a heartbeat by
    // the SAME owner and token. A committed UPDATE of the locked row aborts the whole
    // transaction; the refusal is exactly `serialization-failure`, never the weaker
    // final-boundary alternative, and no evidence is returned.
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
      const fenceStore = createPostgresPaperAuthorityStore(writerUrl, {
        beforeFinalFence: async () => {
          if (ran) return;
          ran = true;
          await admin.unsafe(update, values);
        },
      });
      try {
        refusal(
          await fenceStore.readAuthority(scope, fence),
          'lease-lost',
          'serialization-failure',
        );
        assert.equal(ran, true, label);
      } finally {
        await fenceStore.close();
      }
      await restoreLease();
    }

    // 17. NATURAL expiry between the reads and the final fence, with no UPDATE at all,
    // so this is the expiry path and not the 40001 path.
    const expiryEvidence = {};
    let expiryRan = false;
    const expiryStore = createPostgresPaperAuthorityStore(writerUrl, {
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
      refusal(await expiryStore.readAuthority(scope, fence), 'lease-lost', 'final-boundary');
      assert.equal(expiryRan, true);
      assert.equal(expiryEvidence.liveBeforeWait, true);
      assert.equal(expiryEvidence.liveAfterWait, false);
    } finally {
      await expiryStore.close();
    }
    await restoreLease();

    // 18. Expiry WHILE the final `for update` genuinely WAITS for the lock on an
    // UNCHANGED row, proved by direct observation through the SHARED barrier: a
    // separate observer must see this adapter's own backend blocked BY the holder's
    // backend, on the final locking statement, while the lease is still live on the
    // database clock. Only then does the holder wait for the natural expiry and release
    // the row unchanged. Without the adapter's fresh post-lock clock check this read
    // would admit an expired lease.
    const lockWaitBarrier = createLeaseFenceHarness({ capability: CAPABILITY, leaseLive, port });
    const lockWait = lockWaitBarrier();
    const lockEvidence = lockWait.evidence;
    const lockStore = createPostgresPaperAuthorityStore(writerUrl, {
      beforeFinalFence: lockWait.barrier,
    });
    try {
      await admin.unsafe(
        "update engine.job_lease set expires_at=clock_timestamp()+($2||' milliseconds')::interval where capability=$1",
        [CAPABILITY, String(LEASE_BUDGET_MS)],
      );
      assert.equal(await leaseLive(), true);
      const blockedStartedAt = Date.now();
      const blocked = await lockStore.readAuthority(scope, fence);
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
      assert.notEqual(atResolution.readerPid, lockEvidence.holderPid);
      assert.ok(
        atResolution.blockedWhileLive !== undefined,
        'adapter was never observed blocked by the holder while the lease was live ' +
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
        blockedSpanMs < BLOCKED_SPAN_CEILING_MS,
        'blocked span ' + String(blockedSpanMs) + 'ms ' + lockEvidence.diagnostics(),
      );
      // The lock was released UNCHANGED, so this is the fresh-clock refusal and not the
      // 40001 path, and no evidence leaked out of a failed fence.
      refusal(blocked, 'lease-lost', 'final-boundary');
    } finally {
      await lockStore.close();
      await lockWait.dispose();
    }
    await restoreLease();

    // 19. Nothing in this contract's reads wrote anything. Every row counted below was
    // inserted by the fixtures above, never by the adapter.
    const afterCounts = await counts();
    assert.equal(Number(afterCounts[0].intents), Number(before[0].intents) + 1);
    assert.equal(Number(afterCounts[0].funding), Number(before[0].funding) + 1);
    assert.equal(Number(afterCounts[0].budget), Number(before[0].budget) + 1);
    assert.equal(Number(afterCounts[0].leases), 2);
    const [lease] = await admin.unsafe(
      'select owner,fencing_token::text as token from engine.job_lease where capability=$1',
      [CAPABILITY],
    );
    assert.equal(lease.owner, OWNER);
    assert.equal(lease.token, TOKEN.toString());
  } finally {
    await store.close();
  }
  // Fixture teardown, in foreign-key order. The retained birth row goes last.
  await admin.unsafe('delete from engine.paper_budget_root where funding_id=$1', [FUNDING]);
  await admin.unsafe('delete from engine.paper_funding_root where funding_id=$1', [FUNDING]);
  await clearVectorIntents();
  await admin.unsafe('delete from engine.control_intent where id=$1', [BIRTH]);
  await admin.unsafe('delete from engine.job_lease where capability=any($1)', [
    [CAPABILITY, EMPTY_CAPABILITY],
  ]);
  // A verified snapshot attests the persisted control and funding record in ONE
  // transaction under a live fence, re-validated after the lock was held. It is
  // HISTORICAL read evidence handed back after that transaction ended: it does not
  // assert the lease is still live when the caller reads it, grants no write
  // capability, is not current write-admission, and proves nothing about whether any
  // future write will replay or compare-and-set correctly. Paper admission itself
  // remains refused because the compiled bundle is unavailable.
}
