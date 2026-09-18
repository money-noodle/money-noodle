#!/usr/bin/env node

// Behavioural policy suite for the provider-disabled delivery adapters.
//
// These run inside the existing repository gate (`pnpm verify:foundation`,
// which executes `node --test tools/*.test.mjs`) and need no OpenTofu, no
// provider, no credential and no network. Every fixture below is synthetic.
//
// The suite is deliberately adversarial about three things:
//
//   1. Every denial must name the clause that refuses, and that clause must
//      resolve to a real heading in a real owning document.
//   2. The canonical consent example in the catalog must reconstruct exactly —
//      body digest, completed-envelope digest and grant key — from this
//      implementation, so the code and the normative document cannot drift.
//   3. Nothing these adapters produce may carry a token, a provider payload or
//      a digest of a low-entropy identifier, including on the refusal path.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CanonicalEncodingError,
  canonicalDigest,
  canonicalize,
} from './delivery/canonical-json.mjs';
import {
  CATALOG_ID,
  CATALOG_VERSION,
  CONSENT_FIELDS,
  NON_INVOCABLE_OPERATIONS,
  OPERATIONS,
  PERMITTED_EVENTS,
  PERMITTED_FEDERATED_WORKFLOW,
  PERMITTED_REF,
} from './delivery/catalog-v2.mjs';
import { EXECUTION_IDENTITIES, RESOURCE_OPERATIONS } from './delivery/execution-identities.mjs';
import { deriveExplicitConsent, evaluateGrant, grantKeyFor } from './delivery/grant.mjs';
import { Journal, openJournal } from './delivery/journal.mjs';
import { CLAUSES, REFUSAL_CODES, RefusalError } from './delivery/refusals.mjs';
import {
  MINIMUM_PUBLISHABLE_ENTROPY_BITS,
  assertPublishable,
  digestForPublication,
  findForbiddenMarkers,
  isLowEntropyIdentifier,
} from './delivery/sanitize.mjs';
import { Witness, corroborateIntent, verifyConfirmedWitness } from './delivery/witness.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

const CATALOG_DOCUMENT = 'docs/operations/production-control-plane.md';

// --------------------------------------------------------------------------
// Fixtures. Synthetic throughout: no real project, service, member or URL.
// --------------------------------------------------------------------------

/** The canonical example the catalog publishes, read from the document itself. */
function publishedConsentExample() {
  const document = read(CATALOG_DOCUMENT);
  const section = document.slice(document.indexOf('#### Canonical explicit-consent example'));
  const json = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(json, 'the catalog must publish a canonical consent example');

  const digests = {};
  for (const [, label, digest] of section.matchAll(/\|\s*(\w+)\s*\|\s*`([0-9a-f]{64})`\s*\|/g)) {
    digests[label] = digest;
  }
  return { text: json.trim(), consent: JSON.parse(json), digests };
}

const EXAMPLE = publishedConsentExample();

const NOW = '2026-09-13T00:30:00Z';

const clone = (value) => JSON.parse(JSON.stringify(value));

const executorOwner = (overrides = {}) => ({
  workflowPath: PERMITTED_FEDERATED_WORKFLOW,
  workflowSHA: 'a'.repeat(40),
  runId: 'run-1',
  runAttempt: 1,
  jobId: 'job-1',
  ...overrides,
});

const execution = (overrides = {}) => ({
  event: 'workflow_dispatch',
  ref: PERMITTED_REF,
  workflowPath: PERMITTED_FEDERATED_WORKFLOW,
  actor: 'synthetic-agent',
  executorOwner: executorOwner(),
  ...overrides,
});

const ledger = (overrides = {}) => ({
  consumedSlots: {},
  activeRequestId: null,
  corroboration: { requestId: 'synthetic-request-1', witnessConfirmed: true },
  verifiedPredecessors: [],
  ...overrides,
});

const expected = (overrides = {}) => ({
  repositoryIdentity: 'synthetic-repository',
  ...overrides,
});

/**
 * Rebuilds the published consent after a change to its body, so the approval
 * identity and digests stay internally consistent. Without this, a "changed
 * principal" fixture would be rejected for the wrong reason.
 */
function rebuild(bodyChanges = {}) {
  const { originalApprovalIdentity: _identity, ...body } = clone(EXAMPLE.consent);
  return deriveExplicitConsent({ ...body, ...bodyChanges });
}

const decide = (overrides = {}) =>
  evaluateGrant({
    consent: clone(EXAMPLE.consent),
    execution: execution(),
    ledger: ledger(),
    expected: expected(),
    now: NOW,
    ...overrides,
  });

function assertRefused(decision, code, clause) {
  assert.equal(decision.allowed, false, `expected a refusal, got ${JSON.stringify(decision)}`);
  assert.equal(decision.mayExchangeMutationToken, false);
  assert.equal(decision.refusal.code, code);
  assert.equal(decision.refusal.clause, clause, `${code} must name the ${clause} clause`);
  assert.ok(
    REFUSAL_CODES.includes(decision.refusal.code),
    `${code} must be a declared refusal code`,
  );
  assert.ok(
    decision.refusal.clauseReference.includes('#'),
    'a refusal must name a document and section',
  );
  assert.ok(decision.refusal.clauseSummary.length > 0, 'a refusal must quote the clause');
  return decision.refusal;
}

// --------------------------------------------------------------------------
// Canonical encoding and consent identity
// --------------------------------------------------------------------------

test('the catalog canonical consent example reconstructs exactly', () => {
  // Round-tripping the published bytes proves the document itself is canonical,
  // not merely that this implementation agrees with itself.
  assert.equal(canonicalize(EXAMPLE.consent), EXAMPLE.text);

  const { originalApprovalIdentity, ...consentBody } = clone(EXAMPLE.consent);
  assert.equal(canonicalDigest(consentBody), EXAMPLE.digests.approvalBodyDigest);
  assert.equal(originalApprovalIdentity.approvalBodyDigest, EXAMPLE.digests.approvalBodyDigest);
  assert.equal(canonicalDigest(EXAMPLE.consent), EXAMPLE.digests.consentDigest);
  assert.equal(grantKeyFor(EXAMPLE.consent), EXAMPLE.digests.grantKey);

  // The body identity digest never hashes itself, and consentDigest is stored
  // outside the identity it completes.
  assert.ok(!('consentDigest' in EXAMPLE.consent));
  assert.ok(!('approvalBodyDigest' in EXAMPLE.consent));
  assert.ok(!('grantKey' in EXAMPLE.consent));
  assert.notEqual(EXAMPLE.digests.approvalBodyDigest, EXAMPLE.digests.consentDigest);
});

test('canonicalisation is insensitive to key order and rejects inexact values', () => {
  const reordered = Object.fromEntries(Object.entries(EXAMPLE.consent).reverse());
  assert.equal(canonicalize(reordered), EXAMPLE.text);
  assert.equal(canonicalDigest(reordered), EXAMPLE.digests.consentDigest);

  for (const inexact of [Number.NaN, Infinity, 1.5, undefined]) {
    assert.throws(() => canonicalize({ value: inexact }), CanonicalEncodingError);
  }
  // `-0` and `0` must not produce different preimages.
  assert.equal(canonicalize({ value: -0 }), canonicalize({ value: 0 }));
});

test('changed principal, approval or expiry produces a different grant identity', () => {
  const base = rebuild();
  assert.equal(base.grantKey, EXAMPLE.digests.grantKey);

  for (const change of [
    { principal: 'other-principal' },
    { approvalRef: { commentId: 3, issueNumber: 1 } },
    { expiresAt: '2026-09-13T02:00:00Z' },
  ]) {
    const changed = rebuild(change);
    assert.notEqual(
      changed.approvalBodyDigest,
      base.approvalBodyDigest,
      `${Object.keys(change)[0]} must change the approval body identity`,
    );
    assert.notEqual(changed.consentDigest, base.consentDigest);
  }

  // The approval reference is part of the key, so a changed comment is a
  // different grant; a changed expiry is the same key under a new body digest,
  // which the digest check catches rather than the key.
  assert.notEqual(
    rebuild({ approvalRef: { commentId: 3, issueNumber: 1 } }).grantKey,
    base.grantKey,
  );
});

// --------------------------------------------------------------------------
// The grant check: what it allows, and what it refuses and why
// --------------------------------------------------------------------------

test('a complete, corroborated, in-window grant is allowed and stays provider-disabled', () => {
  const decision = decide();
  assert.equal(decision.allowed, true, JSON.stringify(decision.refusal ?? {}));
  assert.equal(decision.grantKey, EXAMPLE.digests.grantKey);
  assert.equal(decision.consentDigest, EXAMPLE.digests.consentDigest);
  assert.equal(decision.operation, 'configuration.change');
  assert.equal(decision.approvalClass, 'H1');
  assert.equal(decision.permissionSlot, 'configuration-change');
  // An allowed decision is a verdict about policy. Nothing here is enabled.
  assert.equal(decision.providerEnabled, false);
});

test('an expired or not-yet-valid grant is refused, and retrying does not renew it', () => {
  // `now` equal to `expiresAt` denies: expiry prohibits new submissions.
  const atExpiry = assertRefused(
    decide({ now: EXAMPLE.consent.expiresAt }),
    'validity-window-expired',
    'catalog.expiry',
  );
  assert.match(
    atExpiry.reason,
    /never refreshed by retry, epoch, configuration change or recovery/,
  );

  assertRefused(
    decide({ now: '2026-09-14T00:00:00Z' }),
    'validity-window-expired',
    'catalog.expiry',
  );

  // A retry under a new run identity is still the same original window.
  assertRefused(
    decide({
      now: '2026-09-14T00:00:00Z',
      execution: execution({ executorOwner: executorOwner({ runId: 'run-2', runAttempt: 2 }) }),
    }),
    'validity-window-expired',
    'catalog.expiry',
  );

  assertRefused(
    decide({ now: '2026-09-12T23:00:00Z' }),
    'validity-window-not-started',
    'catalog.expiry',
  );
});

test('a replayed grant is refused: a new epoch, run or configuration does not restore a spent slot', () => {
  const spent = ledger({
    consumedSlots: {
      'configuration-change': {
        grantKey: EXAMPLE.digests.grantKey,
        admissionEventId: 'intent-1',
      },
    },
  });

  const refusal = assertRefused(
    decide({ ledger: spent }),
    'slot-already-spent',
    'catalog.slot-spent',
  );
  assert.match(refusal.reason, /a new epoch or run does not restore it/);

  // The slot-epoch fixture: same consent, new epoch and run, same grant key.
  const newRun = decide({
    ledger: spent,
    execution: execution({ executorOwner: executorOwner({ runId: 'run-9', runAttempt: 3 }) }),
  });
  assertRefused(newRun, 'slot-already-spent', 'catalog.slot-spent');
  assert.equal(grantKeyFor(EXAMPLE.consent), EXAMPLE.digests.grantKey);

  // A different grant holding the same slot is also refused, with a reason that
  // distinguishes the two cases for whoever reads the evidence.
  const otherHolder = assertRefused(
    decide({
      ledger: ledger({
        consumedSlots: {
          'configuration-change': { grantKey: 'b'.repeat(64), admissionEventId: 'intent-2' },
        },
      }),
    }),
    'slot-already-spent',
    'catalog.slot-spent',
  );
  assert.match(otherHolder.reason, /held by a different grant/);
});

test('a grant presented on the wrong ref is refused by the federation conjunction', () => {
  for (const ref of ['refs/heads/claim-v1/issue-70', 'refs/tags/v1', 'refs/pull/1/merge', 'main']) {
    const refusal = assertRefused(
      decide({ execution: execution({ ref }) }),
      'ref-not-permitted',
      'trust.federation-conjunction',
    );
    assert.equal(refusal.detail, PERMITTED_REF);
  }
});

test('a grant presented from the wrong workflow is refused by the federation conjunction', () => {
  for (const workflowPath of [
    '.github/workflows/ci.yml',
    '.github/workflows/source-publication.yml',
    '.github/workflows/delivery-copy.yml',
  ]) {
    const refusal = assertRefused(
      decide({
        execution: execution({ workflowPath, executorOwner: executorOwner({ workflowPath }) }),
      }),
      'workflow-not-permitted',
      'trust.federation-conjunction',
    );
    assert.equal(refusal.detail, PERMITTED_FEDERATED_WORKFLOW);
  }
});

test('a grant presented on the wrong event is refused, and schedule never reaches a mutation', () => {
  for (const event of ['pull_request', 'pull_request_target', 'release', 'issue_comment']) {
    const refusal = assertRefused(
      decide({ execution: execution({ event }) }),
      'event-not-permitted',
      'trust.federation-conjunction',
    );
    assert.equal(refusal.detail, PERMITTED_EVENTS.join(','));
  }

  // `schedule` is inside the closed set, and still cannot reach a mutating row:
  // the scheduled exception exists only for the read-only drift path.
  const scheduled = assertRefused(
    decide({ execution: execution({ event: 'schedule' }) }),
    'scheduled-event-mutation',
    'trust.scheduled-read-only',
  );
  assert.equal(scheduled.detail, 'configuration.change');
});

test('a self-issued grant is refused', () => {
  // The requester supplying its own consent.
  const selfSupplied = rebuild({ principal: 'synthetic-agent' });
  assertRefused(
    decide({
      consent: selfSupplied.consent,
      expected: expected(),
    }),
    'self-issued-consent',
    'catalog.no-self-grant',
  );

  // The run acting as the approving principal.
  assertRefused(
    decide({ execution: execution({ actor: 'synthetic-principal' }) }),
    'self-issued-consent',
    'catalog.no-self-grant',
  );

  // A run that is neither the requester nor a bound delegate.
  assertRefused(
    decide({ execution: execution({ actor: 'unrelated-agent' }) }),
    'actor-not-requester',
    'catalog.consent-binding',
  );
});

test('the human bootstrap row is approver and executor by design, and stays exempt', () => {
  // `bootstrap.initialize` reads "HB; principal -> independent readers": the
  // principal executes it personally. Separation comes from the independent
  // verifiers and the enumerated manifest, not from a second actor, so the
  // self-issue rule must not deny the one row defined to have that property.
  const genesis = rebuild({
    operation: 'bootstrap.initialize',
    permissionSlot: 'bootstrap-initialize',
    executorClass: 'principal',
    verifierClass: 'independent-readers',
    principal: 'synthetic-principal',
    requester: 'synthetic-principal',
    effectBounds: { 'initialize-journal': 1 },
    targetVector: [
      {
        actionCounts: { 'initialize-journal': 1 },
        configurationVersion: 'genesis-1',
        expectedSafeVersions: { journal: 'none' },
        intendedSafeVersions: { journal: 'genesis' },
        logicalIncarnation: 'synthetic-journal-1',
      },
    ],
    transportPhases: [
      {
        actionId: 'initialize-journal',
        maxSubmissions: 1,
        phaseId: 'genesis',
        targetIds: ['synthetic-journal-1'],
      },
    ],
  });

  const humanOwner = {
    principal: 'synthetic-principal',
    bootstrapInvocationId: 'hb-1',
    controlSourceSHA: 'd'.repeat(40),
  };

  const decision = decide({
    consent: genesis.consent,
    execution: execution({ actor: 'synthetic-principal', executorOwner: humanOwner }),
    ledger: ledger({ corroboration: null }),
  });
  assert.equal(decision.allowed, true, JSON.stringify(decision.refusal ?? {}));
  // Human-executed: there is no token of any kind to exchange.
  assert.equal(decision.tokenClass, 'none');
  assert.equal(decision.mayExchangeMutationToken, false);

  // The workflow owner form cannot be substituted for the human one.
  assertRefused(
    decide({
      consent: genesis.consent,
      execution: execution({ actor: 'synthetic-principal' }),
      ledger: ledger({ corroboration: null }),
    }),
    'executor-owner-stale',
    'catalog.executor-owner',
  );

  // And the exemption is narrow: an ordinary row with the same actor is refused.
  assertRefused(
    decide({ execution: execution({ actor: 'synthetic-principal' }) }),
    'self-issued-consent',
    'catalog.no-self-grant',
  );
});

test('a missing or unknown consent field denies rather than defaulting', () => {
  for (const field of CONSENT_FIELDS) {
    const consent = clone(EXAMPLE.consent);
    delete consent[field];
    const refusal = assertRefused(
      decide({ consent, expected: expected({ consentDigest: undefined }) }),
      'consent-field-missing',
      'catalog.supported-effects',
    );
    assert.equal(refusal.detail, field);
    assert.match(refusal.reason, /field omission is not null substitution/);
  }

  const extended = { ...clone(EXAMPLE.consent), escalate: true };
  const unknown = assertRefused(
    decide({ consent: extended }),
    'consent-field-unknown',
    'catalog.supported-effects',
  );
  assert.equal(unknown.detail, 'escalate');
});

test('an unknown or deliberately non-invocable operation denies, and they are distinguishable', () => {
  assertRefused(
    decide({ consent: { ...clone(EXAMPLE.consent), operation: 'service.delete' } }),
    'operation-unknown',
    'catalog.supported-effects',
  );

  for (const operation of ['secret.rotate', 'restore.execute', 'repair.execute']) {
    const refusal = assertRefused(
      decide({ consent: { ...clone(EXAMPLE.consent), operation } }),
      'operation-non-invocable',
      'catalog.supported-effects',
    );
    assert.equal(refusal.detail, operation);
  }

  assertRefused(
    decide({ consent: { ...clone(EXAMPLE.consent), catalog: 'other.catalog' } }),
    'catalog-unknown',
    'catalog.supported-effects',
  );
  assertRefused(
    decide({ consent: { ...clone(EXAMPLE.consent), version: 1 } }),
    'catalog-version-unknown',
    'catalog.supported-effects',
  );
});

test('wrong scope denies: class, slot, repository, bounds and vectors', () => {
  assertRefused(
    decide({ consent: { ...clone(EXAMPLE.consent), executorClass: 'stack-executor' } }),
    'executor-class-mismatch',
    'catalog.supported-effects',
  );
  assertRefused(
    decide({ consent: { ...clone(EXAMPLE.consent), verifierClass: 'gcp-probe-reader' } }),
    'verifier-class-mismatch',
    'catalog.supported-effects',
  );
  assertRefused(
    decide({ consent: { ...clone(EXAMPLE.consent), permissionSlot: 'release-forward' } }),
    'permission-slot-mismatch',
    'catalog.supported-effects',
  );
  assertRefused(
    decide({ expected: expected({ repositoryIdentity: 'other-repository' }) }),
    'repository-identity-mismatch',
    'catalog.consent-binding',
  );

  // Each scope fixture below is a *consistently rebuilt* envelope: an envelope
  // whose body was edited without recomputing its identity is refused earlier,
  // as `approval-identity-mismatch`, which would hide the check under test.
  const target = (changes) => [{ ...clone(EXAMPLE.consent.targetVector[0]), ...changes }];

  // A missing finite bound denies the operation.
  assertRefused(
    decide({ consent: rebuild({ effectBounds: {} }).consent }),
    'bound-missing',
    'catalog.supported-effects',
  );

  // An action outside effectBounds denies the whole request, not just the action.
  assertRefused(
    decide({
      consent: rebuild({
        targetVector: target({ actionCounts: { 'set-display-mode': 1, 'delete-service': 1 } }),
      }).consent,
    }),
    'effect-bound-exceeded',
    'catalog.supported-effects',
  );

  // Intended counts above the approved bound deny.
  assertRefused(
    decide({
      consent: rebuild({ targetVector: target({ actionCounts: { 'set-display-mode': 2 } }) })
        .consent,
    }),
    'effect-bound-exceeded',
    'catalog.supported-effects',
  );

  // A third service is refused: targets and transport calls never multiply consent.
  assertRefused(
    decide({
      consent: rebuild({
        targetVector: ['a', 'b', 'c'].map((suffix) => ({
          ...clone(EXAMPLE.consent.targetVector[0]),
          logicalIncarnation: `synthetic-api-${suffix}`,
        })),
      }).consent,
    }),
    'target-vector-exceeded',
    'catalog.supported-effects',
  );

  // A repeated target does not multiply consent either.
  assertRefused(
    decide({
      consent: rebuild({
        targetVector: [
          clone(EXAMPLE.consent.targetVector[0]),
          clone(EXAMPLE.consent.targetVector[0]),
        ],
      }).consent,
    }),
    'target-vector-exceeded',
    'catalog.supported-effects',
  );

  // A transport phase naming a target outside the approved vector denies.
  assertRefused(
    decide({
      consent: rebuild({
        transportPhases: [
          { ...clone(EXAMPLE.consent.transportPhases[0]), targetIds: ['synthetic-web-1'] },
        ],
      }).consent,
    }),
    'effect-bound-exceeded',
    'catalog.supported-effects',
  );
});

test('a tampered consent envelope is refused before anything else is trusted', () => {
  // Body changed without recomputing the approval identity.
  const tampered = clone(EXAMPLE.consent);
  tampered.principal = 'other-principal';
  assertRefused(
    decide({ consent: tampered }),
    'approval-identity-mismatch',
    'catalog.consent-binding',
  );

  // Internally consistent body, but not the envelope the journal recorded.
  const rebuilt = rebuild({ reasonRef: 'synthetic-change-2' });
  assertRefused(
    decide({
      consent: rebuilt.consent,
      expected: expected({ consentDigest: EXAMPLE.digests.consentDigest }),
    }),
    'consent-digest-mismatch',
    'catalog.consent-binding',
  );

  assertRefused(
    decide({ expected: expected({ grantKey: 'c'.repeat(64) }) }),
    'grant-key-mismatch',
    'catalog.consent-binding',
  );
});

test('a stale or wrongly shaped executor owner is refused', () => {
  assertRefused(
    decide({
      execution: execution({
        executorOwner: executorOwner({ workflowPath: '.github/workflows/ci.yml' }),
      }),
    }),
    'executor-owner-stale',
    'catalog.executor-owner',
  );

  // The human bootstrap owner form is disjoint and cannot be used here.
  assertRefused(
    decide({
      execution: execution({
        executorOwner: {
          principal: 'synthetic-principal',
          bootstrapInvocationId: 'hb-1',
          controlSourceSHA: 'd'.repeat(40),
        },
      }),
    }),
    'executor-owner-stale',
    'catalog.executor-owner',
  );
});

test('a mutation without journal and witness corroboration is refused', () => {
  assertRefused(
    decide({ ledger: ledger({ corroboration: null }) }),
    'journal-not-corroborated',
    'catalog.witness-corroboration',
  );

  assertRefused(
    decide({
      ledger: ledger({
        corroboration: { requestId: 'synthetic-request-1', witnessConfirmed: false },
      }),
    }),
    'witness-missing',
    'catalog.witness-corroboration',
  );

  assertRefused(
    decide({
      ledger: ledger({ corroboration: { requestId: 'other-request', witnessConfirmed: true } }),
    }),
    'witness-inconsistent',
    'catalog.witness-corroboration',
  );
});

test('one global active provider request is permitted', () => {
  assertRefused(
    decide({ ledger: ledger({ activeRequestId: 'another-request' }) }),
    'global-request-active',
    'catalog.journal-transition',
  );
  assert.equal(
    decide({ ledger: ledger({ activeRequestId: 'synthetic-request-1' }) }).allowed,
    true,
  );
});

test('rollback without a verified predecessor is refused rather than given a fallback', () => {
  const rollback = rebuild({
    operation: 'service.rollback',
    permissionSlot: 'release-rollback',
    executorClass: 'service-executor',
    verifierClass: 'gcp-probe-reader',
    effectBounds: { 'assign-traffic': 1 },
    targetVector: [
      {
        actionCounts: { 'assign-traffic': 1 },
        configurationVersion: 'config-1',
        expectedSafeVersions: { revision: 'synthetic-revision-2' },
        intendedSafeVersions: { revision: 'synthetic-revision-1' },
        logicalIncarnation: 'synthetic-api-1',
      },
    ],
    transportPhases: [
      {
        actionId: 'assign-traffic',
        maxSubmissions: 1,
        phaseId: 'rollback',
        targetIds: ['synthetic-api-1'],
      },
    ],
    artifactVector: [
      {
        artifactDigest: 'e'.repeat(64),
        tuple: { deployableProject: 'platform-api', outputPlatform: 'linux/amd64' },
      },
    ],
  });

  const refusal = assertRefused(
    decide({ consent: rollback.consent }),
    'predecessor-unverified',
    'catalog.supported-effects',
  );
  assert.equal(refusal.detail, 'synthetic-api-1');

  assert.equal(
    decide({
      consent: rollback.consent,
      ledger: ledger({ verifiedPredecessors: ['synthetic-api-1'] }),
    }).allowed,
    true,
  );
});

test('a release without an exact artifact digest is refused', () => {
  const deploy = rebuild({
    operation: 'service.deploy',
    permissionSlot: 'release-forward',
    executorClass: 'service-executor',
    verifierClass: 'gcp-probe-reader',
    effectBounds: { 'create-revision': 1 },
    targetVector: [
      {
        actionCounts: { 'create-revision': 1 },
        configurationVersion: 'config-1',
        expectedSafeVersions: { revision: 'none' },
        intendedSafeVersions: { revision: 'synthetic-revision-1' },
        logicalIncarnation: 'synthetic-api-1',
      },
    ],
    transportPhases: [
      {
        actionId: 'create-revision',
        maxSubmissions: 1,
        phaseId: 'deploy',
        targetIds: ['synthetic-api-1'],
      },
    ],
    artifactVector: [],
  });

  const refusal = assertRefused(
    decide({ consent: deploy.consent }),
    'artifact-binding-missing',
    'catalog.supported-effects',
  );
  assert.match(refusal.reason, /a mutable tag is not a digest/);
});

test('every refusal is reachable through a declared code and clause', () => {
  for (const clause of Object.values(CLAUSES)) {
    const document = read(clause.document);
    const anchors = [...document.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) =>
      heading
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s/g, '-'),
    );
    assert.ok(
      anchors.includes(clause.anchor),
      `${clause.document} must still contain the #${clause.anchor} heading a refusal points at`,
    );
  }
  assert.equal(new Set(REFUSAL_CODES).size, REFUSAL_CODES.length, 'refusal codes must be unique');
});

// --------------------------------------------------------------------------
// The journal: append-only, idempotent, owner-exclusive
// --------------------------------------------------------------------------

const GRANT_KEY = EXAMPLE.digests.grantKey;

function admitted({ owner = executorOwner() } = {}) {
  const journal = openJournal({ epoch: 1 });
  const intent = journal.appendIntent({
    requestId: 'synthetic-request-1',
    grantKey: GRANT_KEY,
    consentDigest: EXAMPLE.digests.consentDigest,
    permissionSlot: 'configuration-change',
    executorOwner: owner,
    targetVector: clone(EXAMPLE.consent.targetVector),
    intendedCounts: { 'set-display-mode': 1 },
    occurredAt: NOW,
  });
  assert.equal(intent.allowed, true, JSON.stringify(intent.refusal ?? {}));
  return { journal, intent };
}

test('journal append is idempotent under a repeated request id', () => {
  const { journal, intent } = admitted();
  const before = journal.events.length;

  const repeat = journal.appendIntent({
    requestId: 'synthetic-request-1',
    grantKey: GRANT_KEY,
    consentDigest: EXAMPLE.digests.consentDigest,
    permissionSlot: 'configuration-change',
    executorOwner: executorOwner(),
    targetVector: clone(EXAMPLE.consent.targetVector),
    intendedCounts: { 'set-display-mode': 1 },
    occurredAt: NOW,
  });

  assert.equal(repeat.allowed, true);
  assert.equal(repeat.idempotent, true, 'a retried admission observes the effect it already had');
  assert.equal(repeat.event.eventId, intent.event.eventId);
  assert.equal(journal.events.length, before, 'no second event is appended');
  assert.equal(journal.control.sequence, intent.sequence);

  // And the slot is spent exactly once.
  const request = journal.request(GRANT_KEY);
  assert.deepEqual(Object.keys(request.consumedSlots), ['configuration-change']);
  assert.equal(
    request.consumedSlots['configuration-change'].admissionEventId,
    intent.event.eventId,
  );
});

test('journal append refuses a stale owner', () => {
  const { journal } = admitted();
  const stale = executorOwner({ runId: 'run-2', runAttempt: 2, jobId: 'job-2' });

  const rerunIntent = journal.appendIntent({
    requestId: 'synthetic-request-1',
    grantKey: GRANT_KEY,
    consentDigest: EXAMPLE.digests.consentDigest,
    permissionSlot: 'configuration-change',
    executorOwner: stale,
    targetVector: clone(EXAMPLE.consent.targetVector),
    intendedCounts: { 'set-display-mode': 1 },
    occurredAt: NOW,
  });
  assert.equal(rerunIntent.allowed, false);
  assert.equal(rerunIntent.refusal.code, 'executor-owner-stale');
  assert.equal(rerunIntent.refusal.clause, 'catalog.executor-owner');
  assert.match(rerunIntent.refusal.reason, /cannot adopt it/);

  const rerunEvidence = journal.appendEvidence({
    grantKey: GRANT_KEY,
    eventType: 'submission',
    phase: 'submitted',
    executorOwner: stale,
    occurredAt: NOW,
  });
  assert.equal(rerunEvidence.allowed, false);
  assert.equal(rerunEvidence.refusal.code, 'executor-owner-stale');
});

test('a different intent cannot replace the outstanding one, and events are immutable', () => {
  const { journal } = admitted();
  const conflicting = journal.appendIntent({
    requestId: 'synthetic-request-1',
    grantKey: GRANT_KEY,
    consentDigest: EXAMPLE.digests.consentDigest,
    permissionSlot: 'configuration-change',
    executorOwner: executorOwner(),
    targetVector: clone(EXAMPLE.consent.targetVector),
    intendedCounts: { 'set-display-mode': 2 },
    occurredAt: NOW,
  });
  assert.equal(conflicting.allowed, false);
  assert.equal(conflicting.refusal.code, 'journal-event-immutable');

  // Every recorded event is frozen.
  for (const event of journal.events) {
    assert.ok(Object.isFrozen(event));
  }
});

test('concurrent siblings cannot both fast-forward; the loser re-evaluates', () => {
  // Both siblings read the same head `H` and build an admission on it. The
  // first wins the fast-forward; the second must be refused rather than
  // reparented onto the new head, because reparenting an admission is how a
  // spent slot silently becomes two.
  const journal = openJournal({ epoch: 1 });
  const observedHead = journal.head;

  const sibling = (suffix) => ({
    requestId: `synthetic-request-${suffix}`,
    grantKey: suffix === 'a' ? GRANT_KEY : 'b'.repeat(64),
    consentDigest: EXAMPLE.digests.consentDigest,
    permissionSlot: 'configuration-change',
    executorOwner: executorOwner({ runId: `run-${suffix}` }),
    targetVector: clone(EXAMPLE.consent.targetVector),
    intendedCounts: { 'set-display-mode': 1 },
    occurredAt: NOW,
    expectedParent: observedHead,
  });

  const winner = journal.appendIntent(sibling('a'));
  assert.equal(winner.allowed, true, JSON.stringify(winner.refusal ?? {}));
  assert.notEqual(journal.head, observedHead, 'the winner advanced the head');

  const loser = journal.appendIntent(sibling('b'));
  assert.equal(loser.allowed, false, 'the sibling must not also fast-forward');
  assert.equal(loser.refusal.code, 'global-request-active');

  // Even with the global slot free, an append against a stale parent is refused
  // on the parent alone.
  const staleParent = journal.appendEvidence({
    grantKey: GRANT_KEY,
    eventType: 'submission',
    phase: 'submitted',
    executorOwner: executorOwner({ runId: 'run-a' }),
    occurredAt: NOW,
    eventId: 'submission-stale',
    expectedParent: observedHead,
  });
  assert.equal(staleParent.allowed, false);
  assert.equal(staleParent.refusal.code, 'journal-parent-stale');
  assert.equal(staleParent.refusal.clause, 'catalog.journal-transition');
  assert.match(staleParent.refusal.reason, /reread and re-evaluate rather than reparenting/);
  assert.equal(journal.event('submission-stale'), null, 'the refused append recorded nothing');

  // The same append against the observed head succeeds, so the refusal above is
  // about the parent and not about the content.
  const retried = journal.appendEvidence({
    grantKey: GRANT_KEY,
    eventType: 'submission',
    phase: 'submitted',
    executorOwner: executorOwner({ runId: 'run-a' }),
    occurredAt: NOW,
    eventId: 'submission-stale',
    expectedParent: journal.head,
  });
  assert.equal(retried.allowed, true, JSON.stringify(retried.refusal ?? {}));
});

test('the evidence-preserving sequence keeps the acknowledgment index while the head advances', () => {
  const { journal, intent } = admitted();
  const witness = new Witness();

  const corroborated = corroborateIntent(journal, witness, {
    grantKey: GRANT_KEY,
    intent: {
      epoch: journal.epoch,
      sequence: intent.sequence,
      eventId: intent.event.eventId,
      journalCommit: journal.head,
      executorOwner: executorOwner(),
    },
    occurredAt: NOW,
  });
  assert.equal(corroborated.allowed, true, JSON.stringify(corroborated.refusal ?? {}));
  assert.equal(
    corroborated.witnessedAcknowledgment,
    false,
    'the acknowledgment is never witnessed',
  );

  const acknowledgmentId = journal.control.lastAcknowledgment.eventId;
  // The pointer names the intent, not the acknowledgment commit.
  assert.equal(witness.pointer.eventId, intent.event.eventId);
  assert.notEqual(witness.pointer.eventId, acknowledgmentId);

  // Submission, observation and verification advance the head and are retained.
  for (const [eventType, phase] of [
    ['submission', 'submitted'],
    ['observation', 'observed'],
    ['verification', 'verified'],
  ]) {
    const appended = journal.appendEvidence({
      grantKey: GRANT_KEY,
      eventType,
      phase,
      executorOwner: executorOwner(),
      occurredAt: NOW,
      eventId: `${eventType}-1`,
    });
    assert.equal(appended.allowed, true, JSON.stringify(appended.refusal ?? {}));
    assert.equal(
      journal.control.lastAcknowledgment.eventId,
      acknowledgmentId,
      'evidence preserves the acknowledgment index',
    );
    assert.deepEqual(journal.control.witness, witness.pointer, 'evidence preserves the witness');
  }

  assert.equal(journal.control.latestEventId, 'verification-1');
  // Sequence is strictly increasing across every event, acknowledgment included.
  const sequences = journal.events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
  );
  assert.equal(new Set(sequences).size, sequences.length);

  // Each event's sole parent is the commit produced by the previous append, and
  // no event contains the commit that contains it. That is what keeps the chain
  // acyclic: an event that recorded its own containing commit could not be
  // hashed into that commit.
  for (const event of journal.events) {
    const serialised = canonicalize(event);
    assert.ok(
      !serialised.includes(journal.commitOf(event.eventId)),
      `${event.eventId} must not record its own containing commit`,
    );
    if (event.eventType === 'genesis') {
      assert.equal(event.parentCommit, null);
      continue;
    }
    assert.equal(
      event.parentCommit,
      journal.commitOf(event.previousEventId),
      `${event.eventId} must have the previous event's commit as sole parent`,
    );
  }
});

test('a journal ledger projection feeds the grant check without granting anything', () => {
  const { journal, intent } = admitted();
  const witness = new Witness();

  // Before corroboration a mutation is refused.
  assertRefused(
    decide({ ledger: journal.ledgerFor(GRANT_KEY) }),
    'slot-already-spent',
    'catalog.slot-spent',
  );

  corroborateIntent(journal, witness, {
    grantKey: GRANT_KEY,
    intent: {
      epoch: journal.epoch,
      sequence: intent.sequence,
      eventId: intent.event.eventId,
      journalCommit: journal.head,
      executorOwner: executorOwner(),
    },
    occurredAt: NOW,
  });

  const projection = journal.ledgerFor(GRANT_KEY);
  assert.equal(projection.corroboration.witnessConfirmed, true);
  assert.equal(projection.corroboration.requestId, 'synthetic-request-1');
  // The slot is spent, so the same grant cannot be admitted twice even once
  // corroborated. Corroboration authorises the admitted request, not a new one.
  assertRefused(decide({ ledger: projection }), 'slot-already-spent', 'catalog.slot-spent');
});

// --------------------------------------------------------------------------
// The witness: corroboration, not authority
// --------------------------------------------------------------------------

test('a witness holds no journal and cannot append an event', () => {
  const witness = new Witness();
  for (const method of ['appendIntent', 'appendEvidence', 'appendAcknowledgment']) {
    assert.equal(
      typeof witness[method],
      'undefined',
      `the witness writer must not expose ${method}: its ceiling is issues:write with contents:read`,
    );
  }
  assert.ok(!(witness instanceof Journal));
});

test('an intent without a confirmed witness is pending, never authority', () => {
  const witness = new Witness();
  const refusal = verifyConfirmedWitness(witness, null);
  assert.equal(refusal.allowed, false);
  assert.equal(refusal.refusal.code, 'witness-missing');
  assert.equal(refusal.refusal.clause, 'catalog.witness-corroboration');
});

test('a previously confirmed witness that disappears blocks, and recreating it restores nothing', () => {
  const { journal, intent } = admitted();
  const witness = new Witness();
  const corroborated = corroborateIntent(journal, witness, {
    grantKey: GRANT_KEY,
    intent: {
      epoch: journal.epoch,
      sequence: intent.sequence,
      eventId: intent.event.eventId,
      journalCommit: journal.head,
      executorOwner: executorOwner(),
    },
    occurredAt: NOW,
  });
  const confirmed = corroborated.pointer;
  assert.equal(verifyConfirmedWitness(witness, confirmed).allowed, true);

  witness.dropComment(confirmed.commentId);
  const blocked = verifyConfirmedWitness(witness, confirmed);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.refusal.code, 'witness-inconsistent');
  assert.equal(blocked.refusal.clause, 'catalog.faults');
  assert.match(blocked.refusal.reason, /recreated comment cannot restore authority/);

  // Re-appending identical content produces a new comment ID; the confirmed
  // pointer still does not resolve, so authority is not restored.
  const recreated = witness.appendComment({
    epoch: journal.epoch,
    sequence: intent.sequence,
    eventId: intent.event.eventId,
    journalCommit: confirmed.journalCommit,
    grantKey: GRANT_KEY,
    executorOwner: executorOwner(),
  });
  assert.equal(recreated.allowed, true);
  assert.notEqual(recreated.commentId, confirmed.commentId);
  assert.equal(verifyConfirmedWitness(witness, confirmed).allowed, false);
});

test('the issue pointer is guarded, not compare-and-set', () => {
  const witness = new Witness();
  const appended = witness.appendComment({
    epoch: 1,
    sequence: 2,
    eventId: 'intent-1',
    journalCommit: 'f'.repeat(64),
    grantKey: GRANT_KEY,
    executorOwner: executorOwner(),
  });
  const pointer = {
    commentId: appended.commentId,
    epoch: 1,
    eventId: 'intent-1',
    journalCommit: 'f'.repeat(64),
    sequence: 2,
  };
  assert.equal(witness.updatePointer(pointer, { expectedPrevious: null }).allowed, true);

  // Somebody else moved it: block rather than overwrite.
  const surprised = witness.updatePointer(pointer, { expectedPrevious: null });
  assert.equal(surprised.allowed, false);
  assert.equal(surprised.refusal.code, 'witness-inconsistent');
  assert.match(surprised.refusal.reason, /not compare-and-set/);

  // A pointer whose comment cannot be read by ID is refused.
  const dangling = witness.updatePointer(
    { ...pointer, commentId: 99 },
    { expectedPrevious: pointer },
  );
  assert.equal(dangling.allowed, false);
  assert.equal(dangling.refusal.code, 'witness-missing');
});

test('duplicate matching witness comments add no authority', () => {
  const witness = new Witness();
  const record = {
    epoch: 1,
    sequence: 2,
    eventId: 'intent-1',
    journalCommit: 'a'.repeat(64),
    grantKey: GRANT_KEY,
    executorOwner: executorOwner(),
  };
  const first = witness.appendComment(record);
  const second = witness.appendComment({ ...record });
  assert.equal(second.allowed, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.commentId, first.commentId);
});

// --------------------------------------------------------------------------
// Custody: nothing leaks, on any path
// --------------------------------------------------------------------------

const SYNTHETIC_MARKER = 'MN-SYNTHETIC-LEAK-CANARY-8f2c41d6';

test('the output-leak fixture produces a safe error and no marker anywhere', () => {
  const hostile = clone(EXAMPLE.consent);
  hostile.reasonRef = `ghp_${'A'.repeat(36)}`;

  const decision = decide({ consent: hostile });
  const serialised = JSON.stringify(decision);
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal.code, 'evidence-unsanitised');
  assert.ok(!serialised.includes('ghp_'), 'a refusal must not quote what it refused');
  assert.ok(serialised.includes('github-token'), 'the refusal names the kind that was found');

  for (const [kind, value] of [
    ['google-oauth-token', 'ya29.AbCdEfGhIjKlMnOpQrSt'],
    ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----'],
    ['service-account-member', 'serviceAccount:deployer@example-project.iam.gserviceaccount.com'],
    ['cloud-run-url', 'https://platform-api-abc123-uc.a.run.app'],
    ['native-project-path', 'projects/123456789012/locations/us-central1/services/platform-api'],
    ['raw-plan-payload', '{"resource_changes": [] }'],
  ]) {
    const markers = findForbiddenMarkers({ observations: [{ note: value }] });
    assert.ok(
      markers.some((marker) => marker.kind === kind),
      `${kind} must be recognised as unpublishable`,
    );
    // The report says what and where, never the value.
    assert.ok(!JSON.stringify(markers).includes(value));
  }
});

test('an unsanitised journal event is refused rather than recorded', () => {
  const { journal } = admitted();
  const leaked = journal.appendEvidence({
    grantKey: GRANT_KEY,
    eventType: 'observation',
    phase: 'observed',
    executorOwner: executorOwner(),
    occurredAt: NOW,
    eventId: 'observation-leak',
    observations: [{ detail: 'https://platform-api-abc123-uc.a.run.app' }],
  });
  assert.equal(leaked.allowed, false);
  assert.equal(leaked.refusal.code, 'evidence-unsanitised');
  assert.equal(journal.event('observation-leak'), null, 'nothing unsanitised is recorded');
});

test('a digest of a low-entropy identifier is refused, because hashing is not sanitisation', () => {
  for (const value of [
    '123456789012',
    'platform-api',
    'synthetic-api-1',
    'deployer@example-project.iam.gserviceaccount.com',
    'https://platform-api-abc123-uc.a.run.app',
    '2026-09-13T00:00:00Z',
    'production',
  ]) {
    assert.ok(isLowEntropyIdentifier(value), `${value} must be treated as low entropy`);
    assert.throws(
      () => digestForPublication(value, { declaredEntropyBits: 256 }),
      RefusalError,
      `a digest of ${value} must be refused even when the caller claims entropy`,
    );
  }

  // A genuinely high-entropy value digests normally.
  const random = 'a3f9c2e7b481d05629fe3a7c8d1b4e60a3f9c2e7b481d05629fe3a7c8d1b4e60';
  assert.equal(isLowEntropyIdentifier(random), false);
  assert.equal(digestForPublication(random, { declaredEntropyBits: 256 }).length, 64);
  assert.ok(MINIMUM_PUBLISHABLE_ENTROPY_BITS >= 128);
});

test('the adapters never print, so no log can carry a payload', () => {
  const directory = join(repoRoot, 'tools', 'delivery');
  const sources = readdirSync(directory).filter((name) => name.endsWith('.mjs'));
  assert.ok(sources.length >= 6, 'expected the delivery adapters to be present');
  for (const name of sources) {
    const source = readFileSync(join(directory, name), 'utf8');
    assert.doesNotMatch(
      source,
      /\bconsole\.(log|info|warn|error|debug)\b/,
      `${name} must not print: evidence is returned to a caller that sanitises it, never written to a public log`,
    );
    assert.doesNotMatch(
      source,
      /\bprocess\.(stdout|stderr)\.write\b/,
      `${name} must not write to a public stream`,
    );
  }
});

test('the adapters import no transport, so nothing can reach a provider', () => {
  const directory = join(repoRoot, 'tools', 'delivery');
  const forbidden = /from\s+'(?:node:)?(?:http|https|net|tls|dgram|child_process|dns)'/;
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.mjs'))) {
    const source = readFileSync(join(directory, name), 'utf8');
    assert.doesNotMatch(
      source,
      forbidden,
      `${name} must import no transport: "denies before any token exchange" is structural, not an ordering convention`,
    );
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${name} must not call fetch`);
  }
});

test('the suite itself prints no token or provider payload', () => {
  // The canary is asserted against this file's own text. A future fixture that
  // pastes a real-looking credential into an assertion message fails here.
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const withoutCanary = source.split(SYNTHETIC_MARKER).join('');
  const markers = findForbiddenMarkers({ source: withoutCanary });
  const allowed = new Set([
    // Fixture literals that exist precisely to be recognised and refused.
    'github-token',
    'google-oauth-token',
    'private-key-block',
    'service-account-member',
    'cloud-run-url',
    'native-project-path',
    'raw-plan-payload',
  ]);
  for (const marker of markers) {
    assert.ok(allowed.has(marker.kind), `unexpected ${marker.kind} in the suite source`);
  }
});

// --------------------------------------------------------------------------
// Catalog and identity map agreement with the owning documents
// --------------------------------------------------------------------------

test('the transcribed catalog rows match the owning document', () => {
  const document = read(CATALOG_DOCUMENT);
  const section = document.slice(
    document.indexOf('### Supported effects and stable slots'),
    document.indexOf('### Consent, artifact and owner binding'),
  );

  const documented = new Set(
    [...section.matchAll(/^\| `([a-z.]+)` \|/gm)].map(([, operation]) => operation),
  );
  assert.deepEqual(
    [...documented].sort(),
    Object.keys(OPERATIONS).sort(),
    'every documented row must be transcribed, and no row invented',
  );

  for (const [operation, row] of Object.entries(OPERATIONS)) {
    const line = section.match(
      new RegExp(`^\\| \`${operation.replace(/\./g, '\\.')}\` \\|.*$`, 'm'),
    )[0];
    for (const slot of row.permissionSlots) {
      assert.ok(
        line.includes(`\`${slot}\``),
        `${operation} must declare its documented slot ${slot}`,
      );
    }
    if (row.permissionSlots.length === 0) {
      assert.ok(
        line.trimEnd().endsWith('| none |'),
        `${operation} consumes no slot in the document`,
      );
    }
  }

  // Non-invocable rows are listed, not merely absent.
  for (const operation of NON_INVOCABLE_OPERATIONS) {
    assert.ok(
      !(operation in OPERATIONS),
      `${operation} must not be invocable while it is listed as non-invocable`,
    );
  }
  assert.ok(document.includes('`incident.mitigation.execute`'));
  assert.equal(CATALOG_ID, 'money-noodle.production-operations');
  assert.equal(CATALOG_VERSION, 2);
});

test('every catalog operation has exactly one named execution identity', () => {
  const executors = new Set(Object.values(OPERATIONS).map((row) => row.executorClass));
  for (const [name, identity] of Object.entries(EXECUTION_IDENTITIES)) {
    assert.ok(identity.summary.length > 0, `${name} must describe what it is`);
    assert.ok(identity.mustNot.length > 0, `${name} must record its least-privilege boundary`);
    for (const operation of identity.catalogOperations) {
      assert.ok(operation in OPERATIONS, `${name} names ${operation}, which is not a catalog row`);
    }
  }

  // Every identity that owns an infra resource is a declared identity, and the
  // operation it claims is one that identity can actually execute.
  for (const [key, row] of Object.entries(RESOURCE_OPERATIONS)) {
    const identity = EXECUTION_IDENTITIES[row.identity];
    assert.ok(identity, `${key} names undeclared identity ${row.identity}`);
    assert.ok(
      identity.catalogOperations.includes(row.catalogOperation),
      `${key} claims ${row.catalogOperation}, which ${row.identity} cannot execute`,
    );
  }

  assert.ok(executors.size >= 10, 'the catalog separates operation-specific executors');
});
