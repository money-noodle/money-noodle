terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }

  # The one stack that cannot start with remote state, because it creates the
  # buckets remote state lives in. It is applied once with local state and then
  # migrated into the bucket it just made, so that even the bootstrap ends up
  # reconciled into code and remote state rather than living on a laptop.
  #
  # `infra/stacks/bootstrap/backend.gcs.tfbackend.example` holds the migration
  # configuration; `infra/bootstrap.md` holds the procedure and the exact list of
  # values the maintainer supplies.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  state_buckets = {
    bootstrap = "${var.state_bucket_prefix}-bootstrap"
    platform  = "${var.state_bucket_prefix}-platform"
    web       = "${var.state_bucket_prefix}-web"
    api       = "${var.state_bucket_prefix}-api"
    # The engine-jobs stack (#255, ADR-0013 §1) keeps its state here like every
    # other stack; the first dispatched apply failed at backend init without it.
    engine-jobs = "${var.state_bucket_prefix}-engine-jobs"
  }

  # Only the services bootstrap itself needs. Everything else is enabled by the
  # platform stack, so that the smallest possible surface is turned on by the one
  # apply a human runs by hand.
  required_services = [
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
  ]
}

resource "google_project_service" "bootstrap" {
  for_each = toset(local.required_services)

  project = var.project_id
  service = each.value

  # Disabling an API is a destructive act with effects far outside this stack.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# The single federated deployer principal from ADR-0005. It exists before the
# state buckets so it can be granted access to them as they are created.
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = var.deployer_service_account_id
  display_name = "Delivery deployer"
  description  = "Federated CI principal. Holds no key: it is reachable only by OIDC token exchange from the reviewed delivery workflow."

  depends_on = [google_project_service.bootstrap]
}

module "state" {
  source   = "../../modules/state-bucket"
  for_each = local.state_buckets

  project_id                     = var.project_id
  region                         = var.region
  bucket_name                    = each.value
  stack                          = each.key
  deployer_service_account_email = google_service_account.deployer.email
  labels                         = var.labels

  depends_on = [google_project_service.bootstrap]
}

module "federation" {
  source = "../../modules/workload-identity-federation"

  project_id                  = var.project_id
  deployer_service_account_id = google_service_account.deployer.name
  allowed_audiences           = var.allowed_audiences

  repository_owner       = var.repository_owner
  repository_name        = var.repository_name
  repository_id          = var.repository_id
  repository_owner_id    = var.repository_owner_id
  allowed_refs           = var.allowed_refs
  allowed_workflow_paths = var.allowed_workflow_paths
  allowed_event_names    = var.allowed_event_names

  depends_on = [google_project_service.bootstrap]
}

# Project-level authority for the deployer, granted as named roles rather than a
# broad administrative role. ADR-0005 rejects granting the deployer broad rights
# for convenience: it would make the CI principal the most powerful identity in
# the platform, reachable from any workflow change.
#
# Notably absent: `roles/owner`, `roles/editor`, every Secret Manager
# administrative/access role, and IAM-administration roles. The first slice has
# no secret, so secret-policy authority is deferred rather than granting CI a
# role that could let it give itself secretAccessor.
resource "google_project_iam_member" "deployer" {
  for_each = toset(var.deployer_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"

  depends_on = [google_project_service.bootstrap]
}

# Each deployable unit's own runtime identity, created here rather than by the
# delivery pipeline. One per Cloud Run service, and since #241 one per Cloud Run
# Job as well: a job runs as an identity on exactly the same terms, so it is the
# same resource with the same default-deny shape (ADR-0013 §1).
#
# ADR-0005's 2026-09-19 amendment: creating a service account needs
# `iam.serviceAccounts.create`, and granting it a project role needs
# `resourcemanager.projects.setIamPolicy`. The deployer role validation above
# refuses both, so asking the pipeline to create these identities would have
# meant granting CI identity and project-IAM administration — exactly the broad
# authority this stack exists to withhold. Identities and their project-level
# grants are a maintainer-applied bootstrap concern; the pipeline consumes them
# and manages only Cloud Run resources and service-level bindings.
resource "google_service_account" "runtime" {
  for_each = var.runtime_service_accounts

  project      = var.project_id
  account_id   = each.value
  display_name = "${each.key} runtime"
  # Says which kind of unit the identity runs, so a job is not described as a
  # service. The service renderings are unchanged by the conditional, so adding a
  # job identity plans no update to the identities that already exist.
  description = "Runtime identity for the ${each.key} Cloud Run ${contains(var.runtime_job_names, each.key) ? "job" : "service"}. Default-deny: it holds no project role beyond the telemetry write roles granted here."

  depends_on = [google_project_service.bootstrap]
}

# The identity Cloud Scheduler presents when it starts a scheduled job, and
# nothing else (#243, supervisor decision 2026-10-09).
#
# It is deliberately not in `google_service_account.runtime`: a runtime identity
# is what an execution runs as and holds `roles/run.invoker` nowhere, so a
# workload cannot start another workload. This one exists only to start one job.
# It receives **no project role here** — it is absent from
# `google_project_iam_member.runtime_telemetry` below, because a trigger writes no
# telemetry — and its only grant anywhere is `roles/run.invoker` on the single
# Cloud Run Job it triggers, bound beside that job in the engine-jobs stack.
resource "google_service_account" "trigger" {
  for_each = var.trigger_service_accounts

  project      = var.project_id
  account_id   = each.value
  display_name = "${each.key} trigger"
  description  = "Trigger identity for the ${each.key} Cloud Run job. It holds no project role at all; its only grant is run.invoker on that one job, declared beside it."

  depends_on = [google_project_service.bootstrap]
}

# Telemetry export is the only project-level authority a runtime identity holds
# in the first slice. Writing telemetry is not reading anything and not deploying
# anything, and `var.runtime_telemetry_roles` is validated to keep it that way.
#
# Every identity in the map receives every declared role, so a job identity gets
# the same telemetry grants and nothing else: no Secret Manager role, no
# `run.invoker`, no registry access. The engine store connections a job needs are
# Secret Manager containers granted beside the container in the platform stack,
# never a project role here (ADR-0005, ADR-0013 §2).
resource "google_project_iam_member" "runtime_telemetry" {
  for_each = {
    for pair in setproduct(keys(var.runtime_service_accounts), var.runtime_telemetry_roles) :
    "${pair[0]}:${pair[1]}" => { service = pair[0], role = pair[1] }
  }

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.runtime[each.value.service].email}"

  depends_on = [google_project_service.bootstrap]
}

# Project IAM cannot authorize a billing-account budget. This separate binding
# is the narrow billing scope the platform stack needs for the accepted USD 25
# alert budget; it grants no billing-account administration or payment authority.
resource "google_billing_account_iam_member" "deployer_budget_manager" {
  billing_account_id = var.billing_account_id
  role               = "roles/billing.costsManager"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# ---------------------------------------------------------------------------
# Bucket-level IAM on the restore job's staging area (#241 follow-up).
#
# The bucket itself is declared by `infra/stacks/platform`, which owns it. Its
# two grants are declared here for the same reason the state buckets' deployer
# grants are: setting bucket IAM needs `storage.buckets.setIamPolicy`, which the
# deployer does not hold and must never hold, so a grant on a bucket is the
# bootstrap principal's to make and never the pipeline's.
#
# The second reason is the one that brought this here rather than leaving it in
# the platform stack. The deployer plans that stack on every push, and a plan
# refreshes every resource its state holds. Refreshing a
# `google_storage_bucket_iam_member` needs `storage.buckets.getIamPolicy`, and no
# Cloud Storage predefined role carries that permission without also carrying
# `storage.buckets.setIamPolicy`: `roles/storage.bucketViewer` has
# `storage.buckets.get` and `storage.buckets.list` and no IAM permission at all,
# `roles/storage.legacyBucketReader` adds `storage.objects.list` but still no
# `getIamPolicy`, and `roles/storage.legacyBucketOwner` has `getIamPolicy` only
# together with `setIamPolicy`, `storage.objects.create` and
# `storage.objects.delete`. Granting the deployer that last one to make a plan
# work would let the pipeline grant itself read on a copy of the platform's own
# records, which is precisely the self-grant ADR-0005 exists to withhold. Keeping
# every bucket IAM resource out of the stacks the pipeline plans removes the need
# for the permission instead of widening the identity that lacked it.
#
# This stack is never planned or applied by the pipeline — `.github/workflows/
# delivery.yml` offers `platform`, `api`, `web` and `engine-jobs` and nothing
# else — so nothing here is refreshed by the deployer and no grant is needed to
# make these two resources plannable.
locals {
  # The same convention the state buckets use, derived in the one place the
  # prefix already lives rather than passed in again. A bucket name is account
  # data, so only the suffix is written down (SECURITY.md).
  engine_restore_stage_bucket = "${var.state_bucket_prefix}-engine-restore-stage"

  engine_restore_stage_grants = var.engine_restore_stage_grants_enabled ? 1 : 0
}

# Read and create objects on this bucket alone, for the restore job's own
# identity. `objectUser` covers the read the execution does and the evidence
# document it writes back; it carries no `storage.objects.delete`, so an
# execution cannot remove a staged input or a previous evidence document, and it
# is bound to this bucket rather than at project level.
#
# The maintainer is granted nothing here: they upload with their own account.
resource "google_storage_bucket_iam_member" "engine_restore_stage_object_user" {
  count = local.engine_restore_stage_grants

  bucket = local.engine_restore_stage_bucket
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime["engine-restore"].email}"
}

# Enough for the deployer to refresh the bucket the platform stack declares, and
# nothing else. `roles/storage.bucketViewer` carries `storage.buckets.get` and
# `storage.buckets.list`; bound to one bucket, only the first means anything, and
# the role carries no `storage.objects.*` at all — not `get`, not `list` — and no
# IAM permission. So the pipeline can see that the bucket exists and still cannot
# learn what is staged in it, cannot change it, and cannot change who may read
# it.
#
# `bucketViewer` is published as a beta role. If it is ever withdrawn, the
# narrowest replacement that still carries `storage.buckets.get` is
# `roles/storage.legacyBucketReader`, which the deployer already holds on each
# state bucket; it additionally carries `storage.objects.list`, so the staged
# object names would become visible to the pipeline. Prefer the beta role while
# it exists.
resource "google_storage_bucket_iam_member" "engine_restore_stage_plan_reader" {
  count = local.engine_restore_stage_grants

  bucket = local.engine_restore_stage_bucket
  role   = "roles/storage.bucketViewer"
  member = "serviceAccount:${google_service_account.deployer.email}"
}
