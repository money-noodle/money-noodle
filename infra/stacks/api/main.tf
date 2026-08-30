terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }

  # The API's own state. Rolling back the API leaves the web's running revision
  # and the web's state untouched, at the infrastructure layer as well as the
  # application layer (ADR-0006).
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

locals {
  project_id         = data.terraform_remote_state.platform.outputs.contract_project_id
  region             = data.terraform_remote_state.platform.outputs.contract_region
  registry_url       = data.terraform_remote_state.platform.outputs.contract_registry_url
  telemetry_endpoint = data.terraform_remote_state.platform.outputs.contract_telemetry_endpoint
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

  # Assumed allocation from the accepted cost model: a Fastify process serving one
  # in-process read. Not measured, and to be revisited against remote evidence.
  container_port = 3001
  cpu            = "1"
  memory         = "512Mi"

  # The web calls the API server-side with a bounded timeout and no retry fan-out.
  request_timeout_seconds = 15

  # Public on the interim `*.run.app` URL, matching the accepted target of a
  # public `api.noodle.money`. The least-privilege service-to-service grant below
  # exists regardless, so closing public access later does not also break the web.
  allow_unauthenticated      = var.allow_unauthenticated
  authorised_invoker_members = var.authorised_invoker_members

  # Empty. The first slice needs no operational secret.
  accessible_secret_ids = var.accessible_secret_ids

  telemetry_endpoint = local.telemetry_endpoint
  trace_sample_ratio = var.trace_sample_ratio

  labels = var.labels
}
