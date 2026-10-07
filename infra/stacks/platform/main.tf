terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }

  # Separate state from every other stack. Applying platform cannot lock, mutate,
  # or break web or api (ADR-0006).
  backend "gcs" {}
}

provider "google" {
  project = local.project_id
  region  = local.region
}

# Reads the bootstrap stack's *published contract*. Only `contract_*` outputs are
# referenced; `tools/verify-infra-policy.test.mjs` enforces that.
data "terraform_remote_state" "bootstrap" {
  backend = "gcs"

  config = {
    bucket = var.bootstrap_state_bucket
    prefix = "stacks/bootstrap"
  }
}

locals {
  project_id = data.terraform_remote_state.bootstrap.outputs.contract_project_id
  region     = data.terraform_remote_state.bootstrap.outputs.contract_region
  deployer   = data.terraform_remote_state.bootstrap.outputs.contract_deployer_service_account_email

  # Runtime identity per Cloud Run service name, as the maintainer-applied
  # bootstrap stack published it. Read here for one purpose: naming the consumer
  # of a secret by the service it belongs to, so no account address is written
  # down in this repository (#217).
  runtime_identities = data.terraform_remote_state.bootstrap.outputs.contract_runtime_service_account_emails

  # Who may read each declared secret, resolved from service name to identity. A
  # service name that bootstrap does not publish fails here rather than granting
  # access to something unintended.
  # The restore job's writer container joins the declared set only behind the
  # reviewed gate below (#241, ADR-0013 §2). Its consumer is the restore job's
  # identity, which the bootstrap contract publishes only once the infrastructure
  # child declares it; with the gate off, nothing here can reference a name the
  # contract does not carry, so a routine plan of this stack is unaffected.
  declared_secrets = merge(
    var.secrets,
    var.engine_restore_secrets_enabled ? var.engine_restore_secrets : {},
  )

  declared_secret_consumer_services = merge(
    var.secret_consumer_services,
    var.engine_restore_secrets_enabled ? var.engine_restore_secret_consumer_services : {},
  )

  secret_accessor_members = {
    for secret_id, services in local.declared_secret_consumer_services :
    secret_id => [for service in services : "serviceAccount:${local.runtime_identities[service]}"]
  }

  # Who may see that each declared secret exists, which is not who may read it.
  #
  # Every pipeline plan of this stack — the push plan and the scheduled drift plan
  # alike — refreshes each container and each IAM member on it as the deployer. With
  # no grant that refresh is refused and no plan exists at all, which is how the
  # first plan after the container was created failed and why no routine deploy
  # could run (#224). The deployer is the only member here, it is named from the
  # bootstrap contract rather than written down, and `secretmanager.viewer` bound to
  # the one secret is what it gets: enough to refresh, never a value, never a
  # mutation.
  secret_metadata_reader_members = {
    for secret_id, _secret in local.declared_secrets :
    secret_id => ["serviceAccount:${local.deployer}"]
  }

  # Cloud Run pulls images as the serverless service agent, not as a workload's
  # own runtime identity. ADR-0005 states plainly that the web workload identity
  # may not read the registry, so the pull grant goes here and nowhere near the
  # runtime identities.
  cloud_run_service_agent = "serviceAccount:service-${var.project_number}@serverless-robot-prod.iam.gserviceaccount.com"

  platform_services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "cloudtrace.googleapis.com",
    "telemetry.googleapis.com",
  ]
}

resource "google_project_service" "platform" {
  for_each = toset(local.platform_services)

  project = local.project_id
  service = each.value

  disable_on_destroy         = false
  disable_dependent_services = false
}

module "registry" {
  source = "../../modules/artifact-registry"

  project_id                     = local.project_id
  region                         = local.region
  repository_id                  = var.registry_repository_id
  deployer_service_account_email = local.deployer
  image_puller_members           = [local.cloud_run_service_agent]
  labels                         = var.labels

  depends_on = [google_project_service.platform]
}

module "secret_store" {
  source = "../../modules/secret-store"

  project_id = local.project_id
  region     = local.region
  # Empty. The first slice needs no operational secret; the store exists so the
  # first capability that does need one is not also designing custody.
  secrets = local.declared_secrets
  # The access boundary belongs with the container. Granting `secretAccessor`
  # needs Secret Manager authority the routine deploy's identity does not hold,
  # so the grant is declared in this maintainer-applied stack rather than in the
  # service stack that reads the secret (#217, ADR-0005, ADR-0012).
  accessor_members = local.secret_accessor_members
  # Read-only metadata for the identity that plans this stack. Declared here because
  # the deployer can never grant itself anything: like the accessor grant, this is
  # applied by the maintainer (#224).
  metadata_reader_members = local.secret_metadata_reader_members
  labels                  = var.labels

  depends_on = [google_project_service.platform]
}

module "telemetry" {
  source = "../../modules/telemetry-retention"

  project_id               = local.project_id
  region                   = local.region
  log_retention_days       = var.log_retention_days
  debug_log_retention_days = var.debug_log_retention_days

  depends_on = [google_project_service.platform]
}

module "budget" {
  source = "../../modules/budget-guardrail"

  project_id            = local.project_id
  project_number        = var.project_number
  billing_account_id    = var.billing_account_id
  monthly_ceiling       = var.monthly_ceiling
  threshold_percents    = var.budget_threshold_percents
  alert_email_addresses = var.budget_alert_email_addresses

  depends_on = [google_project_service.platform]
}

# ---------------------------------------------------------------------------
# The restore job's staging area (#241, ADR-0013 §1).
#
# Why it lives in this stack rather than in `infra/stacks/engine-jobs`, which is
# the stack that mounts it: the deployer that runs a dispatched apply holds
# `run.admin`, `artifactregistry.admin`, `iam.serviceAccountUser`,
# `logging.admin`, `monitoring.editor` and `serviceusage.serviceUsageAdmin` — and
# no Cloud Storage role at all. It can neither create a bucket nor set bucket
# IAM, so a bucket declared in the release path could only fail the apply that
# needed it. That is the same reason the secret container and its accessor grant
# are declared here rather than beside the service that reads them (#217, #224,
# ADR-0005).
#
# What this bucket is not: the single object store of Proposed ADR-0008. ADR-0013
# §2 is explicit that the accepted object-storage direction is the existing
# archive and that nothing may depend on ADR-0008. This holds one job's staged
# inputs and the evidence document it writes back, for the length of one
# milestone, and it is retired with the job.
resource "google_storage_bucket" "engine_restore_stage" {
  count = var.engine_restore_secrets_enabled && var.engine_restore_stage_bucket != null ? 1 : 0

  project  = local.project_id
  name     = var.engine_restore_stage_bucket
  location = local.region

  # The staged inputs are a copy of the platform's own authoritative state, so
  # the bucket is private on the same terms as state itself.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # On from the first apply. A re-upload of a staged input must not silently
  # replace the copy an execution already verified against.
  versioning {
    enabled = true
  }

  # A staging area is not an archive. The inputs are a copy of something that
  # exists elsewhere and the evidence document is collected into the repository,
  # so a bounded life keeps a 1.4 GB copy from becoming a second archive nobody
  # decided to keep.
  lifecycle_rule {
    condition {
      age        = var.engine_restore_stage_retention_days
      with_state = "ANY"
    }
    action {
      type = "Delete"
    }
  }

  # Deleting it is a reviewed code change, as for every other bucket here. The
  # evidence document is collected into `docs/validation/` before the job is
  # retired, so nothing unique is lost when it finally goes.
  force_destroy = false

  labels = merge(var.labels, {
    "managed-by" = "opentofu"
    "purpose"    = "engine-restore-staging"
  })
}

# Read and create objects on this bucket alone, for the restore job's own
# identity. `objectUser` covers the read the execution does and the evidence
# document it writes back; it carries no `storage.objects.delete`, so an
# execution cannot remove a staged input or a previous evidence document, and it
# is bound to this bucket rather than at project level.
#
# The maintainer is granted nothing here: they upload with their own account.
resource "google_storage_bucket_iam_member" "engine_restore_stage_object_user" {
  count = var.engine_restore_secrets_enabled && var.engine_restore_stage_bucket != null ? 1 : 0

  bucket = google_storage_bucket.engine_restore_stage[0].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${local.runtime_identities["engine-restore"]}"
}

# Uptime checks against both interim `*.run.app` URLs are deliberately not
# created here. They belong to the web and api stacks, which own the URLs, and
# creating them from platform would make platform a dependency of every service
# deployment — exactly the coupling separate stacks exist to avoid.

