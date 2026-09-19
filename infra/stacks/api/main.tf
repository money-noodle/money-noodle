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

# The bootstrap stack's published contract carries the identities the maintainer
# applied: this service's own runtime identity, the web's, and the federated
# deployer. Reading them here is what lets this apply need no identity or
# project-IAM authority (ADR-0005, 2026-09-19 amendment). It is a read of a
# published output; applying this stack cannot lock or modify bootstrap state.
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

  runtime_identities = data.terraform_remote_state.bootstrap.outputs.contract_runtime_service_account_emails
  deployer           = data.terraform_remote_state.bootstrap.outputs.contract_deployer_service_account_email

  # Keyed by this stack's own pinned service name, so the API cannot be wired to
  # run as the web's identity: `var.service_name` is validated to one value.
  runtime_service_account_email = local.runtime_identities[var.service_name]

  # Service-level `roles/run.invoker`, never a project role. Two members, for two
  # reasons that outlive each other:
  #
  #   * the web reaches the API as its own runtime identity, which is the
  #     least-privilege service-to-service path and exists while the API is still
  #     private;
  #   * the deployer reaches it as the post-apply verifier. `delivery.yml` mints
  #     an ID token for the deployer with this service as its audience, and a
  #     private service refuses it without this binding.
  authorised_invoker_members = distinct(concat([
    "serviceAccount:${local.runtime_identities["web"]}",
    "serviceAccount:${local.deployer}",
  ], var.authorised_invoker_members))
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

  # Assumed allocation from the accepted cost model: a Fastify process serving one
  # in-process read. Not measured, and to be revisited against remote evidence.
  container_port = 3001
  cpu            = "1"
  memory         = "512Mi"

  # The web calls the API server-side with a bounded timeout and no retry fan-out.
  request_timeout_seconds = 15

  # Created private. Public invocation on the interim `*.run.app` URL is the
  # accepted end state, but it is applied as a separate reviewed step after the
  # private service has been independently verified. The least-privilege
  # service-to-service grant below exists regardless, so the web can reach the
  # API while the API is still private, and closing public access later does not
  # break the web.
  allow_unauthenticated      = var.allow_unauthenticated
  authorised_invoker_members = local.authorised_invoker_members

  # Empty. The first slice needs no operational secret.
  accessible_secret_ids = var.accessible_secret_ids

  telemetry_endpoint = local.telemetry_endpoint
  trace_sample_ratio = var.trace_sample_ratio

  labels = var.labels
}
