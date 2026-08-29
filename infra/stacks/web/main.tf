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

locals {
  project_id         = data.terraform_remote_state.platform.outputs.contract_project_id
  region             = data.terraform_remote_state.platform.outputs.contract_region
  registry_url       = data.terraform_remote_state.platform.outputs.contract_registry_url
  telemetry_endpoint = data.terraform_remote_state.platform.outputs.contract_telemetry_endpoint

  # A non-secret typed configuration value, not a secret. Putting it in the
  # secret store would obscure which values actually matter (ADR-0005).
  api_base_url = coalesce(
    var.api_base_url_override,
    data.terraform_remote_state.api.outputs.contract_service_uri,
  )
}

module "service" {
  source = "../../modules/cloud-run-service"

  project_id                 = local.project_id
  region                     = local.region
  service_name               = var.service_name
  runtime_service_account_id = var.runtime_service_account_id

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

  # The public entry point for the first remote validation.
  allow_unauthenticated = true

  # The web reads no secret. ADR-0005: the web workload identity may not read the
  # registry, infrastructure state, or any secret.
  accessible_secret_ids = []

  telemetry_endpoint = local.telemetry_endpoint
  trace_sample_ratio = var.trace_sample_ratio

  extra_env = merge(
    {
      MONEY_NOODLE_API_BASE_URL = local.api_base_url
    },
    var.extra_env,
  )

  labels = var.labels
}
