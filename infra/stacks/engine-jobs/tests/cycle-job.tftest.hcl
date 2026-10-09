# The scheduled cycle job is created under its own runtime identity, triggered by
# a *different* identity that holds one job-level invoker binding and nothing
# else, on a schedule that is paused at creation and in the one lane stage 1
# implements (#243, ADR-0013 §1, §3, §5).
#
# Synthetic desired configuration only; every remote-state read is overridden and
# no provider is reached.
mock_provider "google" {}

override_data {
  target = data.terraform_remote_state.platform
  values = {
    outputs = {
      contract_project_id                  = "example-project"
      contract_region                      = "us-west1"
      contract_registry_url                = "us-west1-docker.pkg.dev/example-project/platform"
      contract_engine_restore_stage_bucket = "example-engine-restore-stage"
    }
  }
}

override_data {
  target = data.terraform_remote_state.bootstrap
  values = {
    outputs = {
      contract_deployer_service_account_email = "delivery-deployer@example-project.iam.gserviceaccount.com"
      contract_runtime_service_account_emails = {
        "platform-api"   = "platform-api-runtime@example-project.iam.gserviceaccount.com"
        "web"            = "web-runtime@example-project.iam.gserviceaccount.com"
        "engine-restore" = "engine-restore-runtime@example-project.iam.gserviceaccount.com"
        "engine-cycle"   = "engine-cycle-runtime@example-project.iam.gserviceaccount.com"
      }
      contract_trigger_service_account_emails = {
        "engine-cycle" = "engine-cycle-scheduler@example-project.iam.gserviceaccount.com"
      }
    }
  }
}

variables {
  platform_state_bucket  = "example-platform-state"
  bootstrap_state_bucket = "example-bootstrap-state"
  image_digest           = "sha256:4444444444444444444444444444444444444444444444444444444444444444"
  artifact_version       = "release-1.2.3+engine-jobs"
  source_commit          = "4444444444444444444444444444444444444444"
}

run "the_execution_and_its_trigger_are_different_principals" {
  command = plan

  assert {
    condition = (
      google_cloud_run_v2_job.cycle.template[0].template[0].service_account ==
      "engine-cycle-runtime@example-project.iam.gserviceaccount.com"
    )
    error_message = "The cycle job must run as its own runtime identity from the bootstrap contract."
  }

  # The identity that starts an execution is not the identity it runs as. A
  # runtime identity holds `run.invoker` nowhere, which is what stops a workload
  # from starting a workload (ADR-0013 §1).
  assert {
    condition = (
      google_cloud_run_v2_job_iam_member.cycle_invoker.member ==
      "serviceAccount:engine-cycle-scheduler@example-project.iam.gserviceaccount.com"
    )
    error_message = "The invoker binding must name the trigger identity, never the runtime one."
  }

  assert {
    condition     = google_cloud_run_v2_job_iam_member.cycle_invoker.role == "roles/run.invoker"
    error_message = "The trigger's one grant is run.invoker."
  }

  # Bound on this one job, so the trigger can start nothing else.
  assert {
    condition = (
      google_cloud_run_v2_job_iam_member.cycle_invoker.name ==
      google_cloud_run_v2_job.cycle.name
    )
    error_message = "The binding must be on the job it starts, not at project level."
  }

  assert {
    condition = (
      google_cloud_scheduler_job.cycle.http_target[0].oauth_token[0].service_account_email ==
      "engine-cycle-scheduler@example-project.iam.gserviceaccount.com"
    )
    error_message = "The trigger must present its own identity's OAuth token; no key exists anywhere."
  }
}

run "the_cadence_is_declared_and_paused_at_creation" {
  command = plan

  assert {
    condition     = google_cloud_scheduler_job.cycle.paused == true
    error_message = "The schedule must be created paused: the bring-up is read before a cadence starts."
  }

  assert {
    condition = (
      google_cloud_scheduler_job.cycle.schedule == "* * * * *" &&
      google_cloud_scheduler_job.cycle.time_zone == "Etc/UTC"
    )
    error_message = "One scheduled minute is one run of ticks, in UTC so the cadence reads the same everywhere."
  }

  assert {
    condition     = one(google_cloud_scheduler_job.cycle.retry_config).retry_count == 0
    error_message = "A Scheduler retry would only start an execution the job refuses; the lease and the run record are the safety, not the retry."
  }

  assert {
    condition     = google_cloud_scheduler_job.cycle.http_target[0].http_method == "POST"
    error_message = "The trigger posts to the Cloud Run Jobs run endpoint."
  }
}

run "the_committed_lane_is_dry_with_the_v1_tick_budget" {
  command = plan

  # `tolist`: a list(string) never compares equal to a tuple literal (#261).
  assert {
    condition = (
      google_cloud_run_v2_job.cycle.template[0].template[0].containers[0].args ==
      tolist(["dist/cycle/main.js", "--mode", "dry", "--ticks", "4"])
    )
    error_message = "The cycle entrypoint must run the committed lane and tick budget."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.cycle.template[0].template[0].containers[0].command ==
      tolist(["node"])
    )
    error_message = "One image, one entrypoint per job: the command is node and the entrypoint is an argument."
  }

  # The control epoch travels as plain configuration, never as a secret: it is a
  # number an operator reads in a plan (ADR-0013 §3).
  assert {
    condition = anytrue([
      for environment in google_cloud_run_v2_job.cycle.template[0].template[0].containers[0].env :
      environment.name == "ENGINE_CYCLE_CONTROL_EPOCH" && environment.value == "1"
    ])
    error_message = "The job must carry the control epoch it evaluates intent against."
  }
}

run "no_secret_is_bound_and_no_volume_exists_by_default" {
  command = plan

  assert {
    condition     = length(local.cycle_secret_environment) == 0
    error_message = "No secret may be bound until the reviewed gate is enabled; Cloud Run refuses a reference to a container that does not exist."
  }

  # The cycle job reads the engine store and nothing from a filesystem. The
  # restore's staging mount belongs to the one-time job alone.
  assert {
    condition     = length(google_cloud_run_v2_job.cycle.template[0].template[0].volumes) == 0
    error_message = "The cycle job declares no volume."
  }

  assert {
    condition     = google_cloud_run_v2_job.cycle.template[0].template[0].max_retries == 0
    error_message = "One attempt: a retry is a second execution the job itself refuses by run id."
  }
}

run "binds_exactly_the_declared_reference_when_enabled" {
  command = plan

  variables {
    cycle_secret_binding_enabled = true
  }

  assert {
    condition = (
      length(local.cycle_secret_environment) == 1 &&
      local.cycle_secret_environment["ENGINE_CYCLE_WRITER_DATABASE_URL"] ==
      "engine-cycle-writer-database-url"
    )
    error_message = "The cycle job binds its own engine_writer connection string and nothing else."
  }
}

run "a_lane_this_stage_cannot_run_is_still_only_an_argument" {
  command = plan

  variables {
    cycle_arguments = ["--mode", "forecast", "--ticks", "4"]
  }

  # The stack will happily pass it; the entrypoint refuses it at run start with
  # the outcome `mode-not-implemented`. The gate is in the job, not in the plan,
  # so a premature tfvars change changes what is refused rather than what runs.
  assert {
    condition = contains(
      google_cloud_run_v2_job.cycle.template[0].template[0].containers[0].args,
      "forecast",
    )
    error_message = "The lane is an argument; refusing it is the entrypoint's job."
  }
}

run "an_argument_that_is_not_a_flag_a_lane_or_a_number_is_refused" {
  command = plan

  variables {
    cycle_arguments = ["--mode", "dry", "--endpoint", "https://example.test"]
  }

  expect_failures = [var.cycle_arguments]
}

run "there_is_no_live_lane" {
  command = plan

  variables {
    cycle_arguments = ["--mode", "live"]
  }

  expect_failures = [var.cycle_arguments]
}

run "the_cycle_job_name_is_the_identity_key_and_stays_pinned" {
  command = plan

  variables {
    cycle_job_name = "engine-anything"
  }

  expect_failures = [var.cycle_job_name]
}
