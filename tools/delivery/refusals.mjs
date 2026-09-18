// Stable refusal codes, each naming the clause that refuses.
//
// A denial that only says "denied" is not reviewable: the operator cannot tell
// whether the adapter enforced policy or simply failed. Every refusal these
// adapters produce therefore carries a stable machine code plus the exact
// owning document and section, so a refusal can be argued with by reading the
// clause it names.
//
// Refusal detail is public evidence. It carries safe labels only — never a
// token, a provider payload, a private identifier or a digest of one. See
// `sanitize.mjs`, which every refusal passes through.

/**
 * The normative clauses these adapters enforce.
 *
 * `document` is repository-relative; `anchor` is the GitHub heading anchor
 * inside it. Both are asserted to resolve by the policy suite, so a documentary
 * reorganisation that orphans a clause fails a test rather than degrading a
 * refusal into an unverifiable string.
 */
export const CLAUSES = {
  'catalog.supported-effects': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'supported-effects-and-stable-slots',
    summary:
      'Unknown fields, versions, operations, targets or unbounded effects deny; a missing bound denies the operation.',
  },
  'catalog.consent-binding': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'consent-artifact-and-owner-binding',
    summary:
      'Consent is an exact field set under the canonical encoding; grantKey binds repository, original approval and permission slot.',
  },
  'catalog.slot-spent': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'consent-artifact-and-owner-binding',
    summary:
      'Epoch and workflow/run/attempt identity are excluded from the key; a spent slot is never cleared and cannot be re-consumed.',
  },
  'catalog.expiry': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'consent-artifact-and-owner-binding',
    summary:
      'Original expiry is never refreshed by retry, epoch, configuration change or recovery; expiry prohibits new submissions.',
  },
  'catalog.executor-owner': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'consent-artifact-and-owner-binding',
    summary:
      'executorOwner is immutable from admission; reruns and new runs cannot adopt it and can only record facts.',
  },
  'catalog.no-self-grant': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'supported-effects-and-stable-slots',
    summary:
      'Consent comes from the principal, not the requester; access change requires a fresh etag and no self-grant.',
  },
  'catalog.journal-transition': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'indexed-journal-schema-and-nonrecursive-witness',
    summary:
      'Events are immutable and never replaced; every transition appends at a strictly increasing sequence onto the current coherent head.',
  },
  'catalog.witness-corroboration': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'indexed-journal-schema-and-nonrecursive-witness',
    summary:
      'Journal plus witness confirmation precedes any mutation token; the acknowledgment is never itself witnessed.',
  },
  'catalog.faults': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'faults-and-interrupted-calls',
    summary:
      'Missing or inconsistent evidence blocks; an ambiguous mutation is never automatically repeated.',
  },
  'catalog.custody': {
    document: 'docs/operations/production-control-plane.md',
    anchor: 'field-level-custody-and-bounded-reconstruction',
    summary:
      'Public records carry safe logical labels and allowlisted results only; a digest of a secret or low-entropy private identifier is not sanitisation.',
  },
  'trust.federation-conjunction': {
    document: 'docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md',
    anchor: 'ci-authenticates-by-federation-never-by-a-stored-cloud-key',
    summary:
      'The workload-identity conjunction accepts only the immutable repository identity, protected refs/heads/main, exact .github/workflows/delivery.yml and the closed push/workflow_dispatch/schedule event set.',
  },
  'trust.scheduled-read-only': {
    document: 'docs/operations/delivery.md',
    anchor: 'public-automation-boundary',
    summary: 'The scheduled exception reaches only the declared read-only drift path.',
  },
  'trust.no-provider-authority': {
    document: 'docs/operations/delivery.md',
    anchor: 'current-to-target-activation',
    summary:
      'Current provider paths stay disabled; policy acceptance, a green check or a plan is not production consent.',
  },
};

export class RefusalError extends Error {
  constructor(refusal) {
    super(`${refusal.code}: ${refusal.reason}`);
    this.name = 'RefusalError';
    this.refusal = refusal;
  }
}

const SAFE_DETAIL = /^[A-Za-z0-9 ._:/@+,()[\]=<>-]{0,200}$/;

/**
 * Builds a refusal naming the clause that refuses.
 *
 * `detail` is an optional bounded safe label (an operation name, a slot, a
 * field name). It is rejected outright rather than truncated or escaped if it
 * is not obviously safe, because a refusal path is exactly where an unsanitised
 * value would otherwise reach a public log.
 */
export function refuse(clauseId, code, reason, detail = '') {
  const clause = CLAUSES[clauseId];
  if (!clause) throw new Error(`unknown refusal clause "${clauseId}"`);
  if (typeof detail !== 'string' || !SAFE_DETAIL.test(detail)) {
    throw new Error(`refusal detail for ${code} is not a bounded safe label`);
  }
  return {
    allowed: false,
    // `mayExchangeMutationToken` is stated on every decision, refusal or not, so
    // a caller that reads only this field can never read it as absent-is-fine.
    mayExchangeMutationToken: false,
    refusal: {
      code,
      reason,
      detail,
      clause: clauseId,
      clauseReference: `${clause.document}#${clause.anchor}`,
      clauseSummary: clause.summary,
    },
  };
}

/** The refusal codes the adapters can produce, for exhaustiveness assertions. */
export const REFUSAL_CODES = Object.freeze([
  'consent-field-unknown',
  'consent-field-missing',
  'consent-encoding-invalid',
  'consent-digest-mismatch',
  'approval-identity-mismatch',
  'grant-key-mismatch',
  'catalog-unknown',
  'catalog-version-unknown',
  'operation-unknown',
  'operation-non-invocable',
  'permission-slot-mismatch',
  'executor-class-mismatch',
  'verifier-class-mismatch',
  'repository-identity-mismatch',
  'validity-window-not-started',
  'validity-window-expired',
  'bound-missing',
  'effect-bound-exceeded',
  'target-vector-exceeded',
  'artifact-binding-missing',
  'slot-already-spent',
  'global-request-active',
  'self-issued-consent',
  'actor-not-requester',
  'predecessor-unverified',
  'ref-not-permitted',
  'workflow-not-permitted',
  'event-not-permitted',
  'scheduled-event-mutation',
  'executor-owner-stale',
  'journal-not-corroborated',
  'journal-parent-stale',
  'journal-sequence-invalid',
  'journal-event-immutable',
  'witness-missing',
  'witness-inconsistent',
  'witness-recursive',
  'evidence-unsanitised',
]);
