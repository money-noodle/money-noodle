// Named execution identities, and the one that owns each declared resource.
//
// "Every declared delivery operation has a named execution identity" is only
// checkable if the mapping is written down somewhere a test can read. This is
// that place. It is a declaration of ownership, not a grant: nothing here
// authorises an apply, and the identities it names do not exist yet — ADR-0005's
// federation is unconfigured and `infra/` is unapplied.
//
// Two rules the policy suite enforces against `infra/**`:
//
//   * Exactly one identity per resource. A resource claimed by two identities,
//     or by none, fails. "Whoever runs the apply" is not an identity.
//   * A justification per resource. The permission has to be argued for in one
//     sentence that names why that identity needs that resource, so a widened
//     permission has to be defended in the diff that widens it.
//
// Clauses:
//   docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md#runtime-separation-and-purpose-specific-operation-identities
//   docs/operations/production-control-plane.md#supported-effects-and-stable-slots

/**
 * The identities that may execute a declared delivery operation.
 *
 * `catalogOperations` names the catalog v2 rows this identity can execute;
 * `mustNot` records the boundary that makes it least-privilege, in the same
 * spirit as ADR-0005's May/May-not table.
 */
export const EXECUTION_IDENTITIES = Object.freeze({
  'bootstrap-principal': {
    approvalClass: 'HB',
    catalogOperations: ['bootstrap.initialize'],
    tokenClass: 'none',
    summary:
      'The human principal executing the enumerated once-only bootstrap. Holds no workflow owner and cannot be adopted by a run.',
    mustNot: 'Become a workflow identity, or execute an ordinary release, apply or access change.',
  },
  'stack-executor': {
    approvalClass: 'H1',
    catalogOperations: ['infrastructure.apply'],
    tokenClass: 'federated-mutation',
    summary:
      'The federated deployer applying one saved plan to one stack under an explicit apply authorisation.',
    mustNot: 'Read tenant data or runtime secret values, or grant itself access.',
  },
  'service-executor': {
    approvalClass: 'H1',
    catalogOperations: ['service.deploy', 'service.rollback'],
    tokenClass: 'federated-mutation',
    summary:
      'The federated release executor creating or updating a Cloud Run service by digest within one forward or conditional rollback vector.',
    mustNot: 'Change IAM, expose a service, or deploy an artifact without verified provenance.',
  },
  'iam-executor': {
    approvalClass: 'H2',
    catalogOperations: ['workload.access.change'],
    tokenClass: 'federated-mutation',
    summary:
      'The separately approved access executor applying one exact IAM delta against a fresh expected etag.',
    mustNot:
      'Grant itself access, overwrite a policy on a stale etag, or expose a service that has not been independently verified in private.',
  },
  'telemetry-configurator': {
    approvalClass: 'H1',
    catalogOperations: ['telemetry.configuration.change'],
    tokenClass: 'federated-mutation',
    summary:
      'Applies finite exporter, retention and sink settings after redaction and cost checks.',
    mustNot: 'Export telemetry content, or treat degraded observability as healthy.',
  },
  'cost-configurator': {
    approvalClass: 'H2',
    catalogOperations: ['cost.control.change'],
    tokenClass: 'federated-mutation',
    summary:
      'Applies finite budget policies and notification tests. A budget alert is not a spending cap.',
    mustNot: 'Hold payment authority, detach billing, or shut a workload down implicitly.',
  },
  'runtime-workload': {
    approvalClass: 'H1',
    catalogOperations: ['service.deploy'],
    tokenClass: 'none',
    summary:
      'The per-service runtime identity a deployed revision runs as. It is declared by a release, never an executor itself.',
    mustNot:
      'Deploy anything, write infrastructure state, write the registry, or read another service’s secrets.',
  },
});

const RESOURCE_KEY = /^(modules|stacks)\/[a-z0-9-]+:[a-z0-9_]+\.[a-z0-9_]+$/;

const own = (identity, catalogOperation, justification) => ({
  identity,
  catalogOperation,
  justification,
});

/**
 * Every resource declared under `infra/**`, and the single identity that owns
 * its create/update/delete operations.
 *
 * Keyed `<modules|stacks>/<directory>:<resource_type>.<resource_name>`, which
 * is exactly what the static test derives from the committed HCL. A resource
 * added without a row here fails that test rather than silently inheriting
 * whatever identity happens to run the apply.
 */
export const RESOURCE_OPERATIONS = Object.freeze({
  // --- Bootstrap: once-only, human-executed, before any federation exists. ---
  'stacks/bootstrap:google_project_service.bootstrap': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'Enabling provider APIs precedes every other operation and cannot be performed by an identity that those APIs have not yet made possible.',
  ),
  'stacks/bootstrap:google_service_account.deployer': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'The deployer identity cannot create itself; a human must establish the first principal in the chain.',
  ),
  'stacks/bootstrap:google_project_iam_member.deployer': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'Granting the deployer its project roles is the self-grant the deployer must never be able to perform.',
  ),
  'stacks/bootstrap:google_billing_account_iam_member.deployer_budget_manager': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'Billing-account access is owned by the account holder; no workload identity may extend its own billing authority.',
  ),
  'stacks/bootstrap:google_service_account.runtime': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'Each service’s runtime identity is maintainer-applied so web and API hold separate least-privilege identities the pipeline cannot create or replace.',
  ),
  'stacks/bootstrap:google_project_iam_member.runtime_telemetry': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'Telemetry export is the runtime identity’s only project-level permission, and project-level grants are never the deployer’s to make.',
  ),
  'modules/state-bucket:google_storage_bucket.state': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'Remote state must exist before any apply can record state, so its bucket cannot be created by a state-backed apply.',
  ),
  'modules/state-bucket:google_storage_bucket_iam_member.deployer': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'State object access is granted to the deployer by the bootstrap principal, never by the deployer to itself.',
  ),
  'modules/state-bucket:google_storage_bucket_iam_member.deployer_list': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'Bucket listing is part of the same bootstrap-granted state access and is scoped with it.',
  ),
  'modules/workload-identity-federation:google_iam_workload_identity_pool.delivery': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'The federation pool is what lets CI authenticate at all; creating it from CI would be circular.',
  ),
  'modules/workload-identity-federation:google_iam_workload_identity_pool_provider.github': own(
    'bootstrap-principal',
    'bootstrap.initialize',
    'The provider carries the ref, workflow and repository trust condition, so only a human may set or widen it.',
  ),
  'modules/workload-identity-federation:google_service_account_iam_member.deployer_impersonation':
    own(
      'bootstrap-principal',
      'bootstrap.initialize',
      'Impersonation binds the federated principal to the deployer; an identity must never be able to extend who may become it.',
    ),

  // --- Platform stack: ordinary infrastructure applies. ---
  'modules/artifact-registry:google_artifact_registry_repository.images': own(
    'stack-executor',
    'infrastructure.apply',
    'The registry is declared platform infrastructure applied from one saved plan under explicit apply authorisation.',
  ),
  'modules/artifact-registry:google_artifact_registry_repository_iam_member.deployer_write': own(
    'stack-executor',
    'infrastructure.apply',
    'Publishing artifacts requires registry write, declared in reviewed source rather than granted ad hoc at publish time.',
  ),
  'modules/artifact-registry:google_artifact_registry_repository_iam_member.runtime_pull': own(
    'stack-executor',
    'infrastructure.apply',
    'Runtime identities need pull access to start a revision; the binding is least-privilege and separate from the deployer’s write access.',
  ),
  'modules/secret-store:google_secret_manager_secret.secret': own(
    'stack-executor',
    'infrastructure.apply',
    'The declared secret container is infrastructure; ADR-0005 requires custody to exist before the first secret, and no value-bearing version is managed here.',
  ),
  'modules/telemetry-retention:google_logging_project_bucket_config.default': own(
    'telemetry-configurator',
    'telemetry.configuration.change',
    'Retention on the default log bucket is a telemetry setting with its own cost and redaction verification, separate from ordinary stack shape.',
  ),
  'modules/telemetry-retention:google_logging_project_bucket_config.debug': own(
    'telemetry-configurator',
    'telemetry.configuration.change',
    'The debug bucket has its own shorter retention and is approved as a telemetry setting, not as incidental infrastructure.',
  ),
  'modules/telemetry-retention:google_logging_project_sink.debug': own(
    'telemetry-configurator',
    'telemetry.configuration.change',
    'A sink decides what telemetry is routed where, so it is a redaction-relevant telemetry change rather than a neutral resource.',
  ),
  'modules/budget-guardrail:google_monitoring_notification_channel.budget': own(
    'cost-configurator',
    'cost.control.change',
    'The notification channel must be verified by an actual notification test, which is a cost-control operation with its own approval.',
  ),
  'modules/budget-guardrail:google_billing_budget.monthly_ceiling': own(
    'cost-configurator',
    'cost.control.change',
    'Budget thresholds are cost policy under separate approval; an alert is not a spending cap and never implies shutdown authority.',
  ),

  // --- Per-service stacks: release and the separate exposure seam. ---
  'modules/cloud-run-service:google_secret_manager_secret_iam_member.runtime_secret_access': own(
    'stack-executor',
    'infrastructure.apply',
    'Per-secret access is granted only for the secrets a service is explicitly declared to consume, never project-wide.',
  ),
  'modules/cloud-run-service:google_cloud_run_v2_service.service': own(
    'service-executor',
    'service.deploy',
    'The service revision is the release effect itself: bound to one artifact digest, one forward vector and, with a verified predecessor, one conditional rollback.',
  ),
  'modules/cloud-run-service:google_cloud_run_v2_service_iam_member.public': own(
    'iam-executor',
    'workload.access.change',
    'Public invocation is the first-exposure effect and is deliberately not reachable by the apply that creates the service; it requires its own H2 approval after independent private verification.',
  ),
  'modules/cloud-run-service:google_cloud_run_v2_service_iam_member.authorised_invokers': own(
    'iam-executor',
    'workload.access.change',
    'Service-to-service invocation is an access binding with its own approval, so removing public access cannot silently remove the web’s path to the API.',
  ),
  'stacks/platform:google_project_service.platform': own(
    'stack-executor',
    'infrastructure.apply',
    'Platform API enablement is ordinary declared infrastructure once bootstrap has established the deployer.',
  ),
});

/** The identity that owns `key`, or null when the resource is unmapped. */
export const ownerOf = (key) => RESOURCE_OPERATIONS[key] ?? null;

/** Validates a resource key's shape, so a malformed key fails loudly. */
export const isResourceKey = (key) => RESOURCE_KEY.test(key);
