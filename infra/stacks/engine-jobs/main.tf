terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }

  # The jobs family's own state. Applying it cannot lock, mutate or break the
  # web, the API or the platform stack (ADR-0006).
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

# The bootstrap stack's published contract carries the per-job identities the
# maintainer applied. ADR-0013 §1 names the restore job's as
# `engine-restore-runtime`; it is declared there by the infrastructure child,
# never here. This apply needs no identity or project-IAM authority.
data "terraform_remote_state" "bootstrap" {
  backend = "gcs"

  config = {
    bucket = var.bootstrap_state_bucket
    prefix = "stacks/bootstrap"
  }
}

locals {
  project_id   = data.terraform_remote_state.platform.outputs.contract_project_id
  region       = data.terraform_remote_state.platform.outputs.contract_region
  registry_url = data.terraform_remote_state.platform.outputs.contract_registry_url

  runtime_identities = data.terraform_remote_state.bootstrap.outputs.contract_runtime_service_account_emails

  # Keyed by this stack's pinned job name, so the restore cannot be wired to run
  # as the API's or the web's identity: `var.job_name` is validated to one value.
  runtime_service_account_email = local.runtime_identities[var.job_name]

  # The secret references this execution renders, gated exactly as #250 gated the
  # API's: Cloud Run refuses a job that references a secret which does not exist,
  # so this stays off until the maintainer has applied the platform stack with the
  # writer container, granted the restore identity access and entered the version
  # out of band. Turning it on is a reviewed one-line change. The archive is
  # staged for the execution; no archive credential is bound (#255 review).
  secret_environment = var.restore_secret_binding_enabled ? var.secret_environment : {}
}

# One Cloud Run Job for the `restore` entrypoint, manual trigger only (ADR-0013
# §1): no Cloud Scheduler resource exists in this stack, and nothing in the
# pipeline executes it. The maintainer starts an execution by hand after the
# verify-first inputs are staged; see docs/operations/restoring-the-v1-archive.md.
resource "google_cloud_run_v2_job" "restore" {
  name                = var.job_name
  location            = local.region
  deletion_protection = var.deletion_protection
  labels              = var.labels

  template {
    # One attempt. A retry of a restore is a second invocation, which the job
    # itself refuses against a non-empty schema; a platform retry would only
    # produce a second refusal in the log.
    task_count = 1

    template {
      service_account = local.runtime_service_account_email
      max_retries     = 0
      timeout         = "${var.timeout_seconds}s"

      containers {
        image   = "${local.registry_url}/${var.image_name}@${var.image_digest}"
        command = ["node"]
        args    = concat(["dist/restore/main.js"], var.restore_arguments)

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }

        env {
          name  = "ENGINE_RESTORE_SOURCE_COMMIT"
          value = var.source_commit
        }

        env {
          name  = "ENGINE_RESTORE_ARTIFACT_VERSION"
          value = var.artifact_version
        }

        # Bound by reference: the value is resolved by Cloud Run at execution start
        # and never enters a variable, a plan or state (ADR-0005, ADR-0012).
        dynamic "env" {
          for_each = local.secret_environment

          content {
            name = env.key

            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition = alltrue([
        for name, secret_id in var.secret_environment :
        contains(var.accessible_secret_ids, secret_id)
      ])
      error_message = "Every bound secret must be one this job was declared to read; a reference nobody was asked to grant fails at plan time (#217)."
    }
  }
}
