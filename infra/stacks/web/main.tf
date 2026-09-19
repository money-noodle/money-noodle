terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }

  # The web's own state, separate from the API's.
  backend "gcs" {}
}

provider "google" {
  project = local.project_id
  region  = local.region
}

data "terraform_remote_state" "platform" {
  backend = "gcs"

  config = {
    bucket = var.platform_state_bucket
    prefix = "stacks/platform"
  }
}

# The web reads the API stack's published contract to learn the API origin. This
# is a read of a published output, not a write: deploying the web cannot lock or
# modify the API stack's state, and the API can be applied while this is running.
data "terraform_remote_state" "api" {
  backend = "gcs"

  config = {
    bucket = var.api_state_bucket
    prefix = "stacks/api"
  }
}

# The bootstrap stack's published contract carries the identities the maintainer
# applied: this service's own runtime identity and the federated deployer.
# Reading them here is what lets this apply need no identity or project-IAM
# authority (ADR-0005, 2026-09-19 amendment).
data "terraform_remote_state" "bootstrap" {
  backend = "gcs"

  config = {
    bucket = var.bootstrap_state_bucket
    prefix = "stacks/bootstrap"
  }
}

locals {
  project_id         = data.terraform_remote_state.platform.outputs.contract_project_id
  region             = data.terraform_remote_state.platform.outputs.contract_region
  registry_url       = data.terraform_remote_state.platform.outputs.contract_registry_url
  telemetry_endpoint = data.terraform_remote_state.platform.outputs.contract_telemetry_endpoint

  deployer = data.terraform_remote_state.bootstrap.outputs.contract_deployer_service_account_email

  # Keyed by this stack's own pinned service name, so the web cannot be wired to
  # run as the API's identity: `var.service_name` is validated to one value.
  runtime_service_account_email = (
    data.terraform_remote_state.bootstrap.outputs.contract_runtime_service_account_emails[var.service_name]
  )

  # Service-level `roles/run.invoker`, never a project role. The web is created
  # private and has no service-to-service caller; the one member is the post-apply
  # verifier. `delivery.yml` mints an ID token for the deployer with this service
  # as its audience, and a private service refuses it without this binding.
  authorised_invoker_members = ["serviceAccount:${local.deployer}"]

  # A non-secret typed configuration value, not a secret. Putting it in the
  # secret store would obscure which values actually matter (ADR-0005).
  api_base_url = coalesce(
    var.api_base_url_override,
    data.terraform_remote_state.api.outputs.contract_service_uri,
  )
}

module "service" {
  source = "../../modules/cloud-run-service"

  project_id                    = local.project_id
  region                        = local.region
  service_name                  = var.service_name
  runtime_service_account_email = local.runtime_service_account_email

  repository_url   = local.registry_url
  image_name       = var.image_name
  image_digest     = var.image_digest
  artifact_version = var.artifact_version
  source_commit    = var.source_commit

  revision_suffix   = var.revision_suffix
  rollback_revision = var.rollback_revision

  # Assumed allocation from the accepted cost model: a Next.js standalone server
  # rendering one bounded upstream call. Not measured.
  container_port = 3000
  cpu            = "1"
  memory         = "1Gi"

  request_timeout_seconds = 30

  # Created private. The web is the intended public entry point for the first
  # remote validation, but exposing it is a separate reviewed step taken after
  # the private service has been independently verified, never part of the apply
  # that creates it.
  allow_unauthenticated      = var.allow_unauthenticated
  authorised_invoker_members = local.authorised_invoker_members

  # The web reads no secret. ADR-0005: the web workload identity may not read the
  # registry, infrastructure state, or any secret.
  accessible_secret_ids = []

  telemetry_endpoint = local.telemetry_endpoint
  trace_sample_ratio = var.trace_sample_ratio

  platform_api_origin = local.api_base_url
  extra_env           = var.extra_env

  labels = var.labels
}
