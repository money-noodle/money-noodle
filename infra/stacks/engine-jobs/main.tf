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
  trigger_identities = data.terraform_remote_state.bootstrap.outputs.contract_trigger_service_account_emails

  # The fixed set of jobs this stack declares is `var.job_name` and
  # `var.cycle_job_name`, each validated to exactly one value and each resolving
  # its own identity by its own pinned name — so no job can be wired to run as
  # another unit's identity, and adding a third is a reviewed variable rather
  # than a string somebody passed at apply.
  runtime_service_account_email       = local.runtime_identities[var.job_name]
  cycle_runtime_service_account_email = local.runtime_identities[var.cycle_job_name]

  # The identity Cloud Scheduler presents to start the cycle job. A different
  # principal from the one the execution runs as (ADR-0013 §1): it holds no
  # project role, and its only grant anywhere is the job-level `run.invoker`
  # bound below.
  cycle_trigger_service_account_email = local.trigger_identities[var.cycle_job_name]

  # The staging bucket the platform stack created, read from its published
  # contract so the name is not written down here (#241). Null until the
  # maintainer has applied platform with the restore prerequisites on, which is
  # the same ordering the secret container follows.
  stage_bucket = data.terraform_remote_state.platform.outputs.contract_engine_restore_stage_bucket

  # The secret references this execution renders, gated exactly as #250 gated the
  # API's: Cloud Run refuses a job that references a secret which does not exist,
  # so this stays off until the maintainer has applied the platform stack with the
  # writer container, granted the restore identity access and entered the version
  # out of band. Turning it on is a reviewed one-line change. The archive is
  # staged for the execution; no archive credential is bound (#255 review).
  secret_environment       = var.restore_secret_binding_enabled ? var.secret_environment : {}
  cycle_secret_environment = var.cycle_secret_binding_enabled ? var.cycle_secret_environment : {}
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

      # A container reads its image and its mounts and nothing else, so without
      # this the three locations in `restore_arguments` would not exist at
      # execution time and the job could only print its usage. The staged archive
      # copy, the workstation copy and the evidence output directory are all
      # subdirectories of one mount: one bucket, one grant, one thing to retire.
      #
      # Writable, because the job writes its evidence document back under
      # `--evidence-dir`. The identity's grant carries no delete, so a writable
      # mount cannot remove a staged input (ADR-0013 §1).
      dynamic "volumes" {
        for_each = local.stage_bucket == null ? [] : [local.stage_bucket]

        content {
          name = "stage"

          gcs {
            bucket    = volumes.value
            read_only = false
          }
        }
      }

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

        dynamic "volume_mounts" {
          for_each = local.stage_bucket == null ? [] : [local.stage_bucket]

          content {
            name       = "stage"
            mount_path = var.stage_mount_path
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

    # Every argument that names a location must name one under the mount, and the
    # mount must exist. Otherwise the execution starts, finds nothing at the path,
    # and the failure looks like a bad archive rather than a missing volume.
    precondition {
      condition = (
        length(var.restore_arguments) == 0 ||
        (local.stage_bucket != null && alltrue([
          for argument in var.restore_arguments :
          !startswith(argument, "/") || startswith(argument, "${var.stage_mount_path}/")
        ]))
      )
      error_message = "A restore argument names an absolute path outside the staged mount, or the staging bucket is not declared yet. Apply the platform stack with the restore prerequisites on first (#241)."
    }
  }
}


# ---------------------------------------------------------------------------
# The scheduled cycle job (ADR-0013 §1, #243 stage 1).
#
# Short runs rather than a resident worker, which is the property the whole jobs
# family exists to keep (ADR-0013 §5: "No resident worker, in any deployment").
# One scheduled minute is one execution of `--ticks 4` at 15-second spacing, which
# is v1's cadence expressed as a trigger plus a bounded run.
#
# Stage 1 is the skeleton: the lease, the intent evaluation, the run record and
# the tick loop. A run performs no cycle and writes nothing but those. The lane
# arguments are committed in `cycle.tfvars`, and the entrypoint refuses the lanes
# later stages implement, so this apply cannot start work that does not exist yet.
resource "google_cloud_run_v2_job" "cycle" {
  name                = var.cycle_job_name
  location            = local.region
  deletion_protection = var.deletion_protection
  labels              = var.labels

  template {
    # One attempt, one task. A retry is a second execution, and the job refuses a
    # run id it has already recorded, so a platform retry re-enters a recorded run
    # and writes nothing (ADR-0013 §1).
    task_count = 1

    template {
      service_account = local.cycle_runtime_service_account_email
      max_retries     = 0
      timeout         = "${var.cycle_timeout_seconds}s"

      # No volumes. The cycle job reads the engine store and nothing from a
      # filesystem; the restore's staging mount is the one-time job's alone.
      containers {
        image   = "${local.registry_url}/${var.image_name}@${var.image_digest}"
        command = ["node"]
        args    = concat(["dist/cycle/main.js"], var.cycle_arguments)

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.cycle_memory
          }
        }

        env {
          name  = "ENGINE_CYCLE_SOURCE_COMMIT"
          value = var.source_commit
        }

        env {
          name  = "ENGINE_CYCLE_ARTIFACT_VERSION"
          value = var.artifact_version
        }

        # Not a secret and deliberately not one: the epoch is a number an
        # operator reads in a plan, and ADR-0013 §3 makes it configuration rather
        # than a stored counter so no workload can increment its own authority.
        env {
          name  = "ENGINE_CYCLE_CONTROL_EPOCH"
          value = tostring(var.cycle_control_epoch)
        }

        # Bound by reference: resolved by Cloud Run at execution start, never in a
        # variable, a plan or state (ADR-0005, ADR-0012).
        dynamic "env" {
          for_each = local.cycle_secret_environment

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
        for name, secret_id in var.cycle_secret_environment :
        contains(var.accessible_secret_ids, secret_id)
      ])
      error_message = "Every bound secret must be one this job was declared to read; a reference nobody was asked to grant fails at plan time (#217)."
    }
  }
}

# The one grant the trigger identity holds anywhere: `run.invoker` on this one
# job. Bound at job level rather than at project level, so the identity that
# starts the cycle can start nothing else — not the restore job, not a service.
#
# This is a service-level binding on a resource this stack owns, which is exactly
# what the deployer's `roles/run.admin` admits (#178). The identity itself is the
# maintainer-applied bootstrap stack's to create, because creating one needs
# authority the deployer is validated not to hold (ADR-0005).
resource "google_cloud_run_v2_job_iam_member" "cycle_invoker" {
  project  = local.project_id
  location = google_cloud_run_v2_job.cycle.location
  name     = google_cloud_run_v2_job.cycle.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.cycle_trigger_service_account_email}"
}

# The trigger. Created **paused**, so the first apply installs a schedule that
# fires nothing: the bring-up order is migration 0004, the secret version, and one
# hand-started execution read in the evidence before any cadence begins. Un-pausing
# is a reviewed one-line change to `cycle.tfvars`.
#
# The HTTP target is the Cloud Run Jobs v2 `:run` endpoint with the trigger
# identity's OAuth token. No credential value exists here: an OAuth token is
# minted by the platform for the identity named above, which is why the trigger
# needs an identity at all rather than a key.
resource "google_cloud_scheduler_job" "cycle" {
  project   = local.project_id
  region    = local.region
  name      = "${var.cycle_job_name}-schedule"
  schedule  = var.cycle_schedule
  time_zone = "Etc/UTC"
  paused    = var.cycle_schedule_paused

  description = "Starts the ${var.cycle_job_name} Cloud Run Job once a minute. One run is ${length(var.cycle_arguments) > 0 ? "the committed tick budget" : "the default tick budget"} of 15-second ticks (ADR-0013 §1). Paused until the reviewed bring-up is complete."

  # One attempt. A Scheduler retry would start a second execution, and the job's
  # own lease and run record already make that safe rather than useful; retrying
  # here would only produce refusals in the log.
  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://${local.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${local.project_id}/jobs/${var.cycle_job_name}:run"

    oauth_token {
      service_account_email = local.cycle_trigger_service_account_email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.cycle_invoker]
}
