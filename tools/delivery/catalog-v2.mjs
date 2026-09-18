// The typed M1 catalog v2 surface these adapters enforce.
//
// This is a transcription of the accepted table in
// `docs/operations/production-control-plane.md#supported-effects-and-stable-slots`
// into a shape code can check against. It selects nothing and enables nothing:
// every row here is provider-disabled, and no adapter in this directory can
// reach a provider. The catalog is the allowlist, so an operation, class, slot
// or field that is absent from it denies.
//
// The policy suite asserts this table against the owning document, so the two
// cannot drift apart silently.

export const CATALOG_ID = 'money-noodle.production-operations';
export const CATALOG_VERSION = 2;

/**
 * Approval classes.
 *
 * `R0` reads, `H1` ordinary human-approved effects, `H2` separately approved
 * access/cost effects, `HB` the once-only human bootstrap, `source-permit` the
 * restricted source publication permit, which is explicitly not production
 * consent.
 */
export const APPROVAL_CLASSES = Object.freeze(['R0', 'H1', 'H2', 'HB', 'source-permit']);

/**
 * How a row authenticates, which decides what a confirmed grant may ever be
 * exchanged for.
 *
 * `none` never exchanges anything. `github-token` is the restricted publisher
 * route, which carries no OIDC at all. `federated-read` and `federated-mutation`
 * are the short-lived exchanged provider identities; no durable provider
 * credential exists in any row (ADR-0005).
 */
export const TOKEN_CLASSES = Object.freeze([
  'none',
  'github-token',
  'federated-read',
  'federated-mutation',
]);

const row = (operation, fields) => [operation, Object.freeze({ operation, ...fields })];

/**
 * The invocable M1 surface. `permissionSlots` is exhaustive: a slot outside a
 * row's list is not consumable by that row, and an empty list means the row
 * spends nothing because it mutates nothing.
 */
export const OPERATIONS = Object.freeze(
  Object.fromEntries([
    row('status.read', {
      approvalClass: 'R0',
      executorClass: 'status-reader',
      verifierClass: 'authoritative-response',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'federated-read',
      maxTargets: 2,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('deployment.read', {
      approvalClass: 'R0',
      executorClass: 'provider-reader',
      verifierClass: 'service-revision-state',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'federated-read',
      maxTargets: 2,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('drift.read', {
      approvalClass: 'R0',
      executorClass: 'drift-reader',
      verifierClass: 'desired-provider-comparison',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'federated-read',
      maxTargets: 4,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('telemetry.diagnose', {
      approvalClass: 'R0',
      executorClass: 'telemetry-reader',
      verifierClass: 'correlated-signals',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'federated-read',
      maxTargets: 2,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('cost.read', {
      approvalClass: 'R0',
      executorClass: 'cost-reader',
      verifierClass: 'billing-observation',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'federated-read',
      maxTargets: 2,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('workload.access.read', {
      approvalClass: 'R0',
      executorClass: 'iam-reader',
      verifierClass: 'effective-policy',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'federated-read',
      maxTargets: 2,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('operation.evidence.read', {
      approvalClass: 'R0',
      executorClass: 'git-reader',
      verifierClass: 'journal-witness',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'none',
      maxTargets: 2,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('source.publish', {
      approvalClass: 'source-permit',
      executorClass: 'fixed-publisher',
      verifierClass: 'git-pr-reader',
      permissionSlots: ['source-publication'],
      optionalPermissionSlots: [],
      mutating: true,
      // The publisher route carries no OIDC, so a confirmed source permit can
      // never become provider authority however the run is arranged.
      tokenClass: 'github-token',
      maxTargets: 1,
      consumesGlobalRequest: false,
      requiresReadBounds: false,
    }),
    row('artifact.publish', {
      approvalClass: 'H1',
      executorClass: 'registry-writer',
      verifierClass: 'registry-provenance-reader',
      permissionSlots: ['artifact-publication'],
      optionalPermissionSlots: [],
      mutating: true,
      tokenClass: 'federated-mutation',
      maxTargets: 2,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
      requiresArtifactVector: true,
    }),
    row('service.deploy', {
      approvalClass: 'H1',
      executorClass: 'service-executor',
      verifierClass: 'gcp-probe-reader',
      permissionSlots: ['release-forward'],
      optionalPermissionSlots: [],
      mutating: true,
      tokenClass: 'federated-mutation',
      // "One forward vector, at most 2 services".
      maxTargets: 2,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
      requiresArtifactVector: true,
    }),
    row('service.rollback', {
      approvalClass: 'H1',
      executorClass: 'service-executor',
      verifierClass: 'gcp-probe-reader',
      permissionSlots: ['release-rollback'],
      optionalPermissionSlots: [],
      mutating: true,
      tokenClass: 'federated-mutation',
      maxTargets: 2,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
      requiresArtifactVector: true,
      // No verified predecessor means no rollback slot; the caller must supply
      // the predecessor evidence, never invent a fallback.
      requiresVerifiedPredecessor: true,
    }),
    row('infrastructure.plan', {
      approvalClass: 'R0',
      executorClass: 'non-apply-planner',
      verifierClass: 'plan-state-comparator',
      permissionSlots: [],
      optionalPermissionSlots: [],
      mutating: false,
      tokenClass: 'federated-read',
      maxTargets: 1,
      consumesGlobalRequest: false,
      requiresReadBounds: true,
    }),
    row('infrastructure.apply', {
      approvalClass: 'H1',
      executorClass: 'stack-executor',
      verifierClass: 'provider-state-reader',
      permissionSlots: ['infrastructure-apply'],
      optionalPermissionSlots: [],
      mutating: true,
      tokenClass: 'federated-mutation',
      maxTargets: 1,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
      requiresPlanDigest: true,
    }),
    row('configuration.change', {
      approvalClass: 'H1',
      executorClass: 'configurator',
      verifierClass: 'config-behavior-reader',
      permissionSlots: ['configuration-change'],
      optionalPermissionSlots: [],
      mutating: true,
      tokenClass: 'federated-mutation',
      maxTargets: 2,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
    }),
    row('workload.access.change', {
      approvalClass: 'H2',
      executorClass: 'iam-executor',
      verifierClass: 'iam-probe-reader',
      permissionSlots: ['access-change'],
      // The inverse is a separately approved conditional slot, never implied.
      optionalPermissionSlots: ['access-inverse'],
      mutating: true,
      tokenClass: 'federated-mutation',
      maxTargets: 2,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
    }),
    row('telemetry.configuration.change', {
      approvalClass: 'H1',
      executorClass: 'telemetry-configurator',
      verifierClass: 'telemetry-reader',
      permissionSlots: ['telemetry-change'],
      optionalPermissionSlots: [],
      mutating: true,
      tokenClass: 'federated-mutation',
      maxTargets: 2,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
    }),
    row('cost.control.change', {
      approvalClass: 'H2',
      executorClass: 'cost-configurator',
      verifierClass: 'cost-reader',
      permissionSlots: ['cost-control-change'],
      optionalPermissionSlots: [],
      mutating: true,
      tokenClass: 'federated-mutation',
      maxTargets: 2,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
    }),
    row('bootstrap.initialize', {
      approvalClass: 'HB',
      executorClass: 'principal',
      verifierClass: 'independent-readers',
      permissionSlots: ['bootstrap-initialize'],
      optionalPermissionSlots: [],
      mutating: true,
      // Human-executed. No workflow owner can hold this row.
      tokenClass: 'none',
      maxTargets: 4,
      consumesGlobalRequest: true,
      requiresReadBounds: false,
    }),
  ]),
);

/**
 * v1 operations that the M1 surface explicitly does not make invocable.
 *
 * Listed rather than merely omitted so that asking for one produces "this is
 * deliberately non-invocable in M1" instead of "unknown operation", which are
 * different facts for a reviewer.
 */
export const NON_INVOCABLE_OPERATIONS = Object.freeze([
  'backup.create',
  'backup.read',
  'data.quality.read',
  'dns.certificate.cutover',
  'drift.reconcile',
  'incident.mitigation.execute',
  'incident.state.read',
  'job.state.read',
  'operation.evidence.export',
  'reconciliation.run',
  'repair.execute',
  'restore.execute',
  'schedule.change',
  'schedule.run',
  'schema.migrate',
  'secret.metadata.read',
  'secret.create',
  'secret.destroy',
  'secret.grant',
  'secret.revoke',
  'secret.rotate',
]);

/** The exact consent field set. Unknown denies; omission is not null. */
export const CONSENT_FIELDS = Object.freeze([
  'approvalRef',
  'artifactVector',
  'catalog',
  'controlDependencyDigest',
  'controlSourceSHA',
  'effectBounds',
  'environment',
  'executorClass',
  'expiresAt',
  'inputDigest',
  'issuedAt',
  'notBefore',
  'operation',
  'originalApprovalIdentity',
  'permissionSlot',
  'planDigest',
  'policyDigest',
  'principal',
  'readBounds',
  'reasonRef',
  'recovery',
  'recoveryContractDigest',
  'repositoryIdentity',
  'requestId',
  'requester',
  'sourceSHA',
  'targetVector',
  'transportPhases',
  'verificationContractDigest',
  'verifierClass',
  'version',
]);

/** `consentBody` is the completed envelope minus only the approval identity. */
export const CONSENT_BODY_FIELDS = Object.freeze(
  CONSENT_FIELDS.filter((field) => field !== 'originalApprovalIdentity'),
);

export const TARGET_FIELDS = Object.freeze([
  'actionCounts',
  'configurationVersion',
  'expectedSafeVersions',
  'intendedSafeVersions',
  'logicalIncarnation',
]);

export const READ_BOUND_FIELDS = Object.freeze([
  'maxBytes',
  'maxPages',
  'timeoutSeconds',
  'validUntil',
]);

export const TRANSPORT_PHASE_FIELDS = Object.freeze([
  'actionId',
  'maxSubmissions',
  'phaseId',
  'targetIds',
]);

export const RECOVERY_FIELDS = Object.freeze([
  'condition',
  'expiresAt',
  'permissionSlot',
  'targetVector',
]);

/**
 * The federation conjunction from ADR-0005. Every element is exact: a ref
 * allowlist other than exactly `refs/heads/main`, a workflow allowlist other
 * than exactly the delivery workflow, or an event outside the closed set is
 * rejected rather than widened.
 */
export const PERMITTED_REF = 'refs/heads/main';
export const PERMITTED_FEDERATED_WORKFLOW = '.github/workflows/delivery.yml';
export const PERMITTED_EVENTS = Object.freeze(['push', 'schedule', 'workflow_dispatch']);

/**
 * The scheduled event exists only so the declared read-only drift job can
 * authenticate. It never reaches a mutating row.
 */
export const SCHEDULED_EVENT = 'schedule';

/** The restricted publisher's own fixed workflow. It holds no OIDC. */
export const PERMITTED_PUBLICATION_WORKFLOW = '.github/workflows/source-publication.yml';

export const EVENT_TYPES = Object.freeze([
  'genesis',
  'intent',
  'witness-ack',
  'submission',
  'observation',
  'verification',
  'abandonment',
  'restoration',
]);

export const PHASES = Object.freeze([
  'requested',
  'admitted',
  'intent-corroborated',
  'submitted',
  'observed',
  'verified',
  'blocked',
  'unverified',
  'failed',
  'rolled-back-and-verified',
  'recovered-and-verified',
]);

export const OUTCOMES = Object.freeze([
  'pending',
  'unknown',
  'verified',
  'blocked',
  'unverified',
  'failed',
  'rolled-back-and-verified',
  'recovered-and-verified',
]);

/** Stable error classes. Raw provider text is never an error class. */
export const ERROR_CLASSES = Object.freeze([
  'none',
  'denied-by-policy',
  'precondition-failed',
  'bound-exceeded',
  'evidence-missing',
  'evidence-inconsistent',
  'ambiguous-effect',
  'transport-failed',
  'budget-exhausted',
]);

/** Per-transition budgets. Exhausting one aborts rather than degrading. */
export const TRANSITION_BUDGET = Object.freeze({
  maxDocuments: 8,
  maxDocumentBytes: 16 * 1024,
  maxWitnessBytes: 4 * 1024,
  maxRequests: 40,
  maxTransferBytes: 512 * 1024,
  deadlineSeconds: 120,
  maxContentionReevaluations: 2,
});

/** Source publication envelope, from the accepted 16-file/32-KiB limit. */
export const SOURCE_PUBLICATION_BOUNDS = Object.freeze({
  maxFiles: 16,
  maxReplacementBytes: 32768,
  maxCommentBytes: 49152,
  maxMetadataBytes: 4096,
});

export const operationRow = (operation) => OPERATIONS[operation] ?? null;
export const isNonInvocable = (operation) => NON_INVOCABLE_OPERATIONS.includes(operation);
