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
  secret_accessor_members = {
    for secret_id, services in var.secret_consumer_services :
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
    for secret_id, _secret in var.secrets :
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
  secrets = var.secrets
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

# Uptime checks against both interim `*.run.app` URLs are deliberately not
# created here. They belong to the web and api stacks, which own the URLs, and
# creating them from platform would make platform a dependency of every service
# deployment — exactly the coupling separate stacks exist to avoid.

