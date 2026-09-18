// The provider-disabled catalog v2 grant check.
//
// This module decides whether a run may exchange a token. It cannot perform an
// exchange, and it holds no transport of any kind: there is no network import
// anywhere in `tools/delivery/`, which is what makes "denies before any token
// exchange" a structural property rather than an ordering convention.
//
// The order below is deliberate. Structural and custody checks run first, so a
// hostile envelope is refused before its fields are trusted for anything;
// binding, validity, trust conjunction, self-issue, scope and replay follow;
// corroboration is last, because it is the only check whose answer can change
// without the request changing.
//
// Owning clauses:
//   docs/operations/production-control-plane.md#supported-effects-and-stable-slots
//   docs/operations/production-control-plane.md#consent-artifact-and-owner-binding
//   docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md

import {
  canonicalDigest,
  isGitObjectId,
  isSha256Hex,
  missingKeys,
  unknownKeys,
} from './canonical-json.mjs';
import {
  CATALOG_ID,
  CATALOG_VERSION,
  CONSENT_BODY_FIELDS,
  CONSENT_FIELDS,
  PERMITTED_EVENTS,
  PERMITTED_FEDERATED_WORKFLOW,
  PERMITTED_PUBLICATION_WORKFLOW,
  PERMITTED_REF,
  READ_BOUND_FIELDS,
  SCHEDULED_EVENT,
  TARGET_FIELDS,
  TRANSPORT_PHASE_FIELDS,
  isNonInvocable,
  operationRow,
} from './catalog-v2.mjs';
import { RefusalError, refuse } from './refusals.mjs';
import { assertPublishable } from './sanitize.mjs';

const WORKFLOW_OWNER_FIELDS = ['jobId', 'runAttempt', 'runId', 'workflowPath', 'workflowSHA'];
const HUMAN_OWNER_FIELDS = ['bootstrapInvocationId', 'controlSourceSHA', 'principal'];

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function instant(value) {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * Derives the explicit-consent identities in the order the catalog fixes.
 *
 * `consentBody` is the completed field set minus only `originalApprovalIdentity`,
 * so the body digest never hashes itself and `consentDigest` is stored outside
 * the identity it completes.
 */
export function deriveExplicitConsent(consentBody) {
  const unknown = unknownKeys(consentBody, CONSENT_BODY_FIELDS);
  if (unknown.length > 0)
    throw new Error(`consent body carries unknown fields: ${unknown.join(',')}`);
  const missing = missingKeys(consentBody, CONSENT_BODY_FIELDS);
  if (missing.length > 0) throw new Error(`consent body is missing fields: ${missing.join(',')}`);

  const approvalBodyDigest = canonicalDigest(consentBody);
  const originalApprovalIdentity = {
    approvalBodyDigest,
    approvalRef: consentBody.approvalRef,
    kind: 'explicit',
  };
  const consent = { ...consentBody, originalApprovalIdentity };
  return {
    consent,
    approvalBodyDigest,
    consentDigest: canonicalDigest(consent),
    grantKey: grantKeyFor(consent),
  };
}

/** `grantKey = SHA256(JCS([repositoryIdentity, originalApprovalIdentity, permissionSlot]))`. */
export function grantKeyFor(consent) {
  return canonicalDigest([
    consent.repositoryIdentity,
    consent.originalApprovalIdentity,
    consent.permissionSlot,
  ]);
}

function checkStructure(consent) {
  if (!isPlainObject(consent)) {
    return refuse(
      'catalog.consent-binding',
      'consent-encoding-invalid',
      'consent is not an object',
    );
  }

  const unknown = unknownKeys(consent, CONSENT_FIELDS);
  if (unknown.length > 0) {
    return refuse(
      'catalog.supported-effects',
      'consent-field-unknown',
      'unknown consent fields deny',
      unknown.sort().join(','),
    );
  }

  const missing = missingKeys(consent, CONSENT_FIELDS);
  if (missing.length > 0) {
    return refuse(
      'catalog.supported-effects',
      'consent-field-missing',
      'field omission is not null substitution',
      missing.sort().join(','),
    );
  }

  for (const [field, predicate] of [
    ['policyDigest', isSha256Hex],
    ['controlDependencyDigest', isSha256Hex],
    ['inputDigest', isSha256Hex],
    ['verificationContractDigest', isSha256Hex],
    ['recoveryContractDigest', isSha256Hex],
    ['controlSourceSHA', isGitObjectId],
    ['sourceSHA', isGitObjectId],
  ]) {
    if (!predicate(consent[field])) {
      return refuse(
        'catalog.consent-binding',
        'consent-encoding-invalid',
        'digest and object-id fields must be exact lowercase hex',
        field,
      );
    }
  }

  if (consent.planDigest !== null && !isSha256Hex(consent.planDigest)) {
    return refuse(
      'catalog.consent-binding',
      'consent-encoding-invalid',
      'planDigest is a digest or explicitly null',
      'planDigest',
    );
  }

  if (!isPlainObject(consent.approvalRef)) {
    return refuse(
      'catalog.consent-binding',
      'consent-encoding-invalid',
      'approvalRef is exactly {issueNumber, commentId}',
      'approvalRef',
    );
  }
  if (
    unknownKeys(consent.approvalRef, ['commentId', 'issueNumber']).length > 0 ||
    !isFiniteCount(consent.approvalRef.commentId) ||
    !isFiniteCount(consent.approvalRef.issueNumber)
  ) {
    return refuse(
      'catalog.consent-binding',
      'consent-encoding-invalid',
      'approvalRef is exactly {issueNumber, commentId}',
      'approvalRef',
    );
  }

  return null;
}

function checkCatalogRow(consent) {
  if (consent.catalog !== CATALOG_ID) {
    return refuse('catalog.supported-effects', 'catalog-unknown', 'unknown catalog denies');
  }
  if (consent.version !== CATALOG_VERSION) {
    return refuse(
      'catalog.supported-effects',
      'catalog-version-unknown',
      'unknown catalog version denies',
    );
  }
  if (isNonInvocable(consent.operation)) {
    return refuse(
      'catalog.supported-effects',
      'operation-non-invocable',
      'this operation is deliberately not invocable in the M1 surface',
      String(consent.operation),
    );
  }

  const row = operationRow(consent.operation);
  if (!row) {
    return refuse(
      'catalog.supported-effects',
      'operation-unknown',
      'unknown operation denies',
      typeof consent.operation === 'string' ? consent.operation : '',
    );
  }
  if (row.executorClass !== consent.executorClass) {
    return refuse(
      'catalog.supported-effects',
      'executor-class-mismatch',
      'the executor identity class must equal the catalog row',
      row.executorClass,
    );
  }
  if (row.verifierClass !== consent.verifierClass) {
    return refuse(
      'catalog.supported-effects',
      'verifier-class-mismatch',
      'the verifier class must equal the catalog row',
      row.verifierClass,
    );
  }

  const permitted = [...row.permissionSlots, ...row.optionalPermissionSlots];
  const declared = consent.permissionSlot;
  if (row.mutating) {
    if (!permitted.includes(declared)) {
      return refuse(
        'catalog.supported-effects',
        'permission-slot-mismatch',
        'the permission slot must be one this row can consume',
        permitted.join(','),
      );
    }
  } else if (declared !== null && declared !== 'none') {
    return refuse(
      'catalog.supported-effects',
      'permission-slot-mismatch',
      'a read row consumes no permission slot',
      'none',
    );
  }

  return null;
}

function checkBinding(consent, expected) {
  if (consent.repositoryIdentity !== expected.repositoryIdentity) {
    return refuse(
      'catalog.consent-binding',
      'repository-identity-mismatch',
      'consent is bound to the fixed repository identity established at bootstrap',
    );
  }

  const identity = consent.originalApprovalIdentity;
  if (!isPlainObject(identity)) {
    return refuse(
      'catalog.consent-binding',
      'approval-identity-mismatch',
      'originalApprovalIdentity is required',
    );
  }

  if (identity.kind === 'explicit') {
    if (
      unknownKeys(identity, ['approvalBodyDigest', 'approvalRef', 'kind']).length > 0 ||
      !isSha256Hex(identity.approvalBodyDigest)
    ) {
      return refuse(
        'catalog.consent-binding',
        'approval-identity-mismatch',
        'explicit approval identity is exactly {kind, approvalRef, approvalBodyDigest}',
      );
    }
    const { originalApprovalIdentity: _omitted, ...consentBody } = consent;
    if (canonicalDigest(consentBody) !== identity.approvalBodyDigest) {
      return refuse(
        'catalog.consent-binding',
        'approval-identity-mismatch',
        'the approval body digest does not reconstruct from the consent body',
      );
    }
    if (
      identity.approvalRef.issueNumber !== consent.approvalRef.issueNumber ||
      identity.approvalRef.commentId !== consent.approvalRef.commentId
    ) {
      return refuse(
        'catalog.consent-binding',
        'approval-identity-mismatch',
        'the approval identity names a different issue comment than the consent',
      );
    }
  } else if (identity.kind === 'merge') {
    if (
      unknownKeys(identity, [
        'approvedHeadSHA',
        'kind',
        'mergeSHA',
        'pullRequestNumber',
        'repositoryIdentity',
      ]).length > 0 ||
      !isGitObjectId(identity.approvedHeadSHA) ||
      !isGitObjectId(identity.mergeSHA) ||
      !isFiniteCount(identity.pullRequestNumber) ||
      identity.repositoryIdentity !== consent.repositoryIdentity
    ) {
      return refuse(
        'catalog.consent-binding',
        'approval-identity-mismatch',
        'merge approval identity binds the exact reviewed head and resulting protected-main commit',
      );
    }
  } else {
    return refuse(
      'catalog.consent-binding',
      'approval-identity-mismatch',
      'approval identity kind must be explicit or merge',
    );
  }

  if (expected.consentDigest && canonicalDigest(consent) !== expected.consentDigest) {
    return refuse(
      'catalog.consent-binding',
      'consent-digest-mismatch',
      'the completed consent envelope does not match its recorded digest',
    );
  }

  return null;
}

function checkValidity(consent, now) {
  const issued = instant(consent.issuedAt);
  const notBefore = instant(consent.notBefore);
  const expires = instant(consent.expiresAt);

  if (issued === null || notBefore === null || expires === null) {
    return refuse(
      'catalog.expiry',
      'consent-encoding-invalid',
      'validity timestamps must be UTC RFC 3339',
    );
  }
  if (!(notBefore < expires)) {
    return refuse('catalog.expiry', 'bound-missing', 'consent must carry a finite forward window');
  }
  if (now < notBefore) {
    return refuse(
      'catalog.expiry',
      'validity-window-not-started',
      'notBefore is in the future; a retry does not start the window early',
    );
  }
  // `now equals expiresAt` denies: expiry prohibits new submissions.
  if (now >= expires) {
    return refuse(
      'catalog.expiry',
      'validity-window-expired',
      'original expiry is never refreshed by retry, epoch, configuration change or recovery',
    );
  }
  return null;
}

function checkTrustConjunction(row, execution) {
  if (row.tokenClass === 'none') return null;

  if (row.tokenClass === 'github-token') {
    // The publisher route is a different fixed workflow that holds no OIDC. It
    // is never reachable through the federated conjunction.
    if (execution.workflowPath !== PERMITTED_PUBLICATION_WORKFLOW) {
      return refuse(
        'trust.federation-conjunction',
        'workflow-not-permitted',
        'source publication runs only in its own fixed workflow',
        PERMITTED_PUBLICATION_WORKFLOW,
      );
    }
    return null;
  }

  if (execution.ref !== PERMITTED_REF) {
    return refuse(
      'trust.federation-conjunction',
      'ref-not-permitted',
      'the conjunction accepts exactly protected refs/heads/main',
      PERMITTED_REF,
    );
  }
  if (execution.workflowPath !== PERMITTED_FEDERATED_WORKFLOW) {
    return refuse(
      'trust.federation-conjunction',
      'workflow-not-permitted',
      'the conjunction accepts exactly the delivery workflow',
      PERMITTED_FEDERATED_WORKFLOW,
    );
  }
  if (!PERMITTED_EVENTS.includes(execution.event)) {
    return refuse(
      'trust.federation-conjunction',
      'event-not-permitted',
      'the conjunction accepts only the closed push, workflow_dispatch and schedule event set',
      PERMITTED_EVENTS.join(','),
    );
  }
  if (execution.event === SCHEDULED_EVENT && row.mutating) {
    return refuse(
      'trust.scheduled-read-only',
      'scheduled-event-mutation',
      'the scheduled exception reaches only the declared read-only drift path',
      row.operation,
    );
  }
  return null;
}

function checkOwner(row, consent, execution) {
  const owner = execution.executorOwner;
  if (!isPlainObject(owner)) {
    return refuse(
      'catalog.executor-owner',
      'executor-owner-stale',
      'an immutable executor owner is required',
    );
  }

  const human = row.approvalClass === 'HB';
  const fields = human ? HUMAN_OWNER_FIELDS : WORKFLOW_OWNER_FIELDS;
  if (
    unknownKeys(owner, fields).length > 0 ||
    missingKeys(owner, fields).length > 0 ||
    // The two owner forms are disjoint: a human genesis owner can never be
    // converted into a workflow owner, or the reverse.
    (human && 'runId' in owner) ||
    (!human && 'bootstrapInvocationId' in owner)
  ) {
    return refuse(
      'catalog.executor-owner',
      'executor-owner-stale',
      human
        ? 'human bootstrap owner is exactly {principal, bootstrapInvocationId, controlSourceSHA}'
        : 'workflow owner is exactly {workflowPath, workflowSHA, runId, runAttempt, jobId}',
    );
  }

  if (!human && owner.workflowPath !== execution.workflowPath) {
    return refuse(
      'catalog.executor-owner',
      'executor-owner-stale',
      'the executor owner must name the workflow actually running',
    );
  }
  if (human && owner.principal !== consent.principal) {
    return refuse(
      'catalog.executor-owner',
      'executor-owner-stale',
      'the bootstrap owner must be the authorising principal',
    );
  }
  return null;
}

function checkSelfIssue(consent, execution) {
  if (consent.principal === consent.requester) {
    return refuse(
      'catalog.no-self-grant',
      'self-issued-consent',
      'the requester cannot supply its own consent',
    );
  }
  if (execution.actor && execution.actor === consent.principal) {
    return refuse(
      'catalog.no-self-grant',
      'self-issued-consent',
      'the run acting as the approving principal is a self-issued grant',
    );
  }
  if (execution.actor && execution.actor !== consent.requester) {
    return refuse(
      'catalog.consent-binding',
      'actor-not-requester',
      'the acting run is neither the named requester nor a bound delegate',
    );
  }
  return null;
}

function checkScope(row, consent) {
  if (!Array.isArray(consent.targetVector) || consent.targetVector.length === 0) {
    return refuse(
      'catalog.supported-effects',
      'bound-missing',
      'a finite target vector is required; a missing bound denies',
      'targetVector',
    );
  }
  if (consent.targetVector.length > row.maxTargets) {
    return refuse(
      'catalog.supported-effects',
      'target-vector-exceeded',
      'the target vector exceeds the row bound',
      `max=${row.maxTargets}`,
    );
  }

  const incarnations = new Set();
  for (const target of consent.targetVector) {
    if (
      !isPlainObject(target) ||
      unknownKeys(target, TARGET_FIELDS).length > 0 ||
      missingKeys(target, TARGET_FIELDS).length > 0
    ) {
      return refuse(
        'catalog.supported-effects',
        'bound-missing',
        'each target is an exact object of the declared fields',
        'targetVector',
      );
    }
    if (incarnations.has(target.logicalIncarnation)) {
      return refuse(
        'catalog.supported-effects',
        'target-vector-exceeded',
        'a target may appear once; repeated targets do not multiply consent',
        'targetVector',
      );
    }
    incarnations.add(target.logicalIncarnation);
    for (const count of Object.values(target.actionCounts ?? {})) {
      if (!isFiniteCount(count)) {
        return refuse(
          'catalog.supported-effects',
          'bound-missing',
          'action counts must be finite integers',
          'targetVector.actionCounts',
        );
      }
    }
  }

  if (!isPlainObject(consent.effectBounds)) {
    return refuse(
      'catalog.supported-effects',
      'bound-missing',
      'effectBounds is required; a missing bound denies',
      'effectBounds',
    );
  }
  if (row.mutating && Object.keys(consent.effectBounds).length === 0) {
    return refuse(
      'catalog.supported-effects',
      'bound-missing',
      'a mutating row requires at least one bounded action',
      'effectBounds',
    );
  }
  for (const [action, bound] of Object.entries(consent.effectBounds)) {
    if (!isFiniteCount(bound)) {
      return refuse(
        'catalog.supported-effects',
        'bound-missing',
        'every allowlisted action maps to a finite maximum count',
        action,
      );
    }
  }

  // Intended counts may never exceed the approved bound for the same action.
  for (const target of consent.targetVector) {
    for (const [action, count] of Object.entries(target.actionCounts ?? {})) {
      if (!(action in consent.effectBounds)) {
        return refuse(
          'catalog.supported-effects',
          'effect-bound-exceeded',
          'an action outside effectBounds denies the whole request',
          action,
        );
      }
      if (count > consent.effectBounds[action]) {
        return refuse(
          'catalog.supported-effects',
          'effect-bound-exceeded',
          'intended counts exceed the approved finite bound',
          action,
        );
      }
    }
  }

  if (!Array.isArray(consent.transportPhases) || consent.transportPhases.length === 0) {
    return refuse(
      'catalog.supported-effects',
      'bound-missing',
      'transportPhases is an ordered finite list',
      'transportPhases',
    );
  }
  for (const phase of consent.transportPhases) {
    if (
      !isPlainObject(phase) ||
      unknownKeys(phase, TRANSPORT_PHASE_FIELDS).length > 0 ||
      missingKeys(phase, TRANSPORT_PHASE_FIELDS).length > 0 ||
      !isFiniteCount(phase.maxSubmissions) ||
      !Array.isArray(phase.targetIds)
    ) {
      return refuse(
        'catalog.supported-effects',
        'bound-missing',
        'each transport phase is an exact bounded object',
        'transportPhases',
      );
    }
    for (const targetId of phase.targetIds) {
      if (!incarnations.has(targetId)) {
        return refuse(
          'catalog.supported-effects',
          'effect-bound-exceeded',
          'a transport phase names a target outside the approved vector',
          'transportPhases',
        );
      }
    }
  }

  if (row.requiresReadBounds) {
    if (
      !isPlainObject(consent.readBounds) ||
      unknownKeys(consent.readBounds, READ_BOUND_FIELDS).length > 0 ||
      missingKeys(consent.readBounds, READ_BOUND_FIELDS).length > 0 ||
      !isFiniteCount(consent.readBounds.maxBytes) ||
      !isFiniteCount(consent.readBounds.maxPages) ||
      !isFiniteCount(consent.readBounds.timeoutSeconds) ||
      instant(consent.readBounds.validUntil) === null
    ) {
      return refuse(
        'catalog.supported-effects',
        'bound-missing',
        'a read row requires finite pages, bytes, timeout and validity',
        'readBounds',
      );
    }
  }

  if (row.requiresPlanDigest && consent.planDigest === null) {
    return refuse(
      'catalog.supported-effects',
      'bound-missing',
      'an apply binds exactly one saved plan digest',
      'planDigest',
    );
  }

  if (row.requiresArtifactVector) {
    if (!Array.isArray(consent.artifactVector) || consent.artifactVector.length === 0) {
      return refuse(
        'catalog.supported-effects',
        'artifact-binding-missing',
        'the exact artifact tuple and digest are required; a mutable tag is not a digest',
        'artifactVector',
      );
    }
    for (const entry of consent.artifactVector) {
      if (
        !isPlainObject(entry) ||
        unknownKeys(entry, ['artifactDigest', 'tuple']).length > 0 ||
        !isSha256Hex(entry.artifactDigest) ||
        !isPlainObject(entry.tuple)
      ) {
        return refuse(
          'catalog.supported-effects',
          'artifact-binding-missing',
          'each artifact entry is exactly {tuple, artifactDigest}',
          'artifactVector',
        );
      }
    }
  }

  if (consent.recovery !== null) {
    if (!isPlainObject(consent.recovery)) {
      return refuse(
        'catalog.supported-effects',
        'bound-missing',
        'recovery is null or an exact conditional grant',
        'recovery',
      );
    }
    if (consent.recovery.permissionSlot === consent.permissionSlot) {
      return refuse(
        'catalog.supported-effects',
        'permission-slot-mismatch',
        'a recovery slot is separately approved, never the forward slot itself',
        'recovery',
      );
    }
  }

  return null;
}

function checkReplay(consent, grantKey, ledger, row) {
  const consumed = ledger.consumedSlots ?? {};
  const held = consumed[consent.permissionSlot];
  if (held) {
    // Epoch, run and configuration are excluded from the grant key precisely so
    // that a new epoch cannot present the same consent as a fresh request.
    return refuse(
      'catalog.slot-spent',
      'slot-already-spent',
      held.grantKey === grantKey
        ? 'this slot is already spent under the same grant key; a new epoch or run does not restore it'
        : 'this slot is held by a different grant',
      consent.permissionSlot,
    );
  }

  if (row.consumesGlobalRequest) {
    const active = ledger.activeRequestId ?? null;
    if (active !== null && active !== consent.requestId) {
      return refuse(
        'catalog.journal-transition',
        'global-request-active',
        'one global active M1 provider request is permitted',
      );
    }
  }

  if (row.requiresVerifiedPredecessor) {
    const verified = new Set(ledger.verifiedPredecessors ?? []);
    const missing = consent.targetVector
      .map((target) => target.logicalIncarnation)
      .filter((incarnation) => !verified.has(incarnation));
    if (missing.length > 0) {
      return refuse(
        'catalog.supported-effects',
        'predecessor-unverified',
        'no verified predecessor means no rollback slot; a fallback is never invented',
        missing.sort().join(','),
      );
    }
  }

  return null;
}

function checkCorroboration(row, consent, ledger) {
  if (!row.mutating) return null;
  const corroboration = ledger.corroboration ?? null;
  if (!corroboration) {
    return refuse(
      'catalog.witness-corroboration',
      'journal-not-corroborated',
      'journal plus witness confirmation precedes any mutation token',
    );
  }
  if (!corroboration.witnessConfirmed) {
    return refuse(
      'catalog.witness-corroboration',
      'witness-missing',
      'intent without a confirmed witness is pending or unknown, never authority',
    );
  }
  if (corroboration.requestId !== consent.requestId) {
    return refuse(
      'catalog.witness-corroboration',
      'witness-inconsistent',
      'the corroborated intent belongs to a different request',
    );
  }
  return null;
}

/**
 * Evaluates one grant.
 *
 * Returns a decision object. `allowed: false` always carries a refusal naming
 * the clause that refused; `allowed: true` carries the derived grant key and an
 * explicit statement of what may be exchanged. `mayExchangeMutationToken` is
 * present on every decision so a caller cannot read its absence as permission.
 *
 * No provider is reachable from here under any decision: this returns a verdict,
 * never a credential.
 */
export function evaluateGrant({ consent, execution, ledger = {}, expected = {}, now }) {
  const evaluatedAt = typeof now === 'number' ? now : Date.parse(now ?? new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) {
    return refuse(
      'catalog.expiry',
      'consent-encoding-invalid',
      'evaluation time is not a valid instant',
    );
  }

  // Custody first. A hostile envelope must not reach a code path that echoes it.
  try {
    assertPublishable(consent, 'consent');
    assertPublishable(execution ?? {}, 'execution context');
  } catch (error) {
    if (error instanceof RefusalError) {
      return { allowed: false, mayExchangeMutationToken: false, refusal: error.refusal };
    }
    throw error;
  }

  let decision = checkStructure(consent);
  if (decision) return decision;

  decision = checkCatalogRow(consent);
  if (decision) return decision;

  const row = operationRow(consent.operation);

  if (!isPlainObject(execution)) {
    return refuse(
      'catalog.executor-owner',
      'executor-owner-stale',
      'an execution context is required',
    );
  }

  decision =
    checkBinding(consent, expected) ??
    checkValidity(consent, evaluatedAt) ??
    checkTrustConjunction(row, execution) ??
    checkOwner(row, consent, execution) ??
    checkSelfIssue(consent, execution) ??
    checkScope(row, consent);
  if (decision) return decision;

  const grantKey = grantKeyFor(consent);
  if (expected.grantKey && expected.grantKey !== grantKey) {
    return refuse(
      'catalog.consent-binding',
      'grant-key-mismatch',
      'the derived grant key does not match the recorded key',
    );
  }

  decision =
    checkReplay(consent, grantKey, ledger, row) ?? checkCorroboration(row, consent, ledger);
  if (decision) return decision;

  const mayExchangeMutationToken = row.mutating && row.tokenClass === 'federated-mutation';

  return assertPublishable(
    {
      allowed: true,
      grantKey,
      consentDigest: canonicalDigest(consent),
      operation: row.operation,
      approvalClass: row.approvalClass,
      permissionSlot: row.mutating ? consent.permissionSlot : 'none',
      executorClass: row.executorClass,
      verifierClass: row.verifierClass,
      tokenClass: row.tokenClass,
      mayExchangeMutationToken,
      // Stated on every allowed decision. The adapters are provider-disabled by
      // construction; an allowed grant is a verdict about policy, never an
      // enabled path.
      providerEnabled: false,
      consumesGlobalRequest: row.consumesGlobalRequest,
      evaluatedAt: new Date(evaluatedAt).toISOString(),
    },
    'grant decision',
  );
}
