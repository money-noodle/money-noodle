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
  labels  = var.labels

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

