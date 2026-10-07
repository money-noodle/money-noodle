# The restore job is created with a manual trigger only, under its own identity,
# and binds no secret until the reviewed gate is turned on. Synthetic desired
# configuration only; every remote-state read is overridden.
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
      }
    }
  }
}

variables {
  platform_state_bucket  = "example-platform-state"
  bootstrap_state_bucket = "example-bootstrap-state"
  image_digest           = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
  artifact_version       = "release-1.2.3+engine-jobs"
  source_commit          = "3333333333333333333333333333333333333333"
}

run "runs_as_its_own_identity_with_no_secret_bound_by_default" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_job.restore.template[0].template[0].service_account == "engine-restore-runtime@example-project.iam.gserviceaccount.com"
    error_message = "The restore job must run as the engine-restore-runtime identity from the bootstrap contract."
  }

  assert {
    condition     = length(local.secret_environment) == 0
    error_message = "No secret may be bound until the reviewed gate is enabled."
  }

  assert {
    condition     = google_cloud_run_v2_job.restore.template[0].template[0].max_retries == 0
    error_message = "A restore is never retried by the platform; a second invocation is the job's own refusal."
  }
}

# The gap #241 closed: a container reads its image and its mounts and nothing
# else, so a job told to read `/mnt/stage/archive` without a volume there is a job
# that cannot run as declared.
run "mounts_the_staged_bucket_read_write_at_the_declared_path" {
  command = plan

  assert {
    condition = (
      length(google_cloud_run_v2_job.restore.template[0].template[0].volumes) == 1 &&
      google_cloud_run_v2_job.restore.template[0].template[0].volumes[0].name == "stage"
    )
    error_message = "The execution must carry exactly one volume, the staging bucket."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.restore.template[0].template[0].volumes[0].gcs[0].bucket ==
      "example-engine-restore-stage"
    )
    error_message = "The volume must name the bucket the platform stack published, never one written down in this stack."
  }

  # Writable, because the job writes its evidence document back under
  # `--evidence-dir`. The identity's grant carries no delete, so this cannot
  # remove a staged input.
  assert {
    condition     = google_cloud_run_v2_job.restore.template[0].template[0].volumes[0].gcs[0].read_only == false
    error_message = "The staged mount must be writable; the job writes its evidence document back."
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.restore.template[0].template[0].containers[0].volume_mounts) == 1 &&
      google_cloud_run_v2_job.restore.template[0].template[0].containers[0].volume_mounts[0].name == "stage" &&
      google_cloud_run_v2_job.restore.template[0].template[0].containers[0].volume_mounts[0].mount_path == "/mnt/stage"
    )
    error_message = "The staged volume must be mounted at the path the reviewed restore arguments name."
  }
}

# The content of the committed `restore.tfvars`, applied. `tofu test` cannot load
# a var-file, so the values are restated here; `tools/infra-policy.test.mjs` pins
# that the committed file says exactly this.
run "applies_the_reviewed_restore_inputs" {
  command = plan

  variables {
    restore_secret_binding_enabled = true
    restore_arguments = [
      "--archive",
      "/mnt/stage/archive",
      "--workstation",
      "/mnt/stage/workstation",
      "--evidence-dir",
      "/mnt/stage/evidence",
    ]
  }

  assert {
    # `tolist`: the rendered `args` is a list(string) and a bare literal is a
    # tuple, which `==` never considers equal even with identical elements.
    condition = google_cloud_run_v2_job.restore.template[0].template[0].containers[0].args == tolist([
      "dist/restore/main.js",
      "--archive",
      "/mnt/stage/archive",
      "--workstation",
      "/mnt/stage/workstation",
      "--evidence-dir",
      "/mnt/stage/evidence",
    ])
    error_message = "The entrypoint must receive the three locations the reviewed inputs name, after its own script path."
  }

  # Every location is under the mount, so the execution can actually read them.
  assert {
    condition = alltrue([
      for argument in var.restore_arguments :
      !startswith(argument, "/") || startswith(argument, "/mnt/stage/")
    ])
    error_message = "A location outside the staged mount is a path the execution cannot read."
  }

  assert {
    condition     = toset(keys(local.secret_environment)) == toset(["ENGINE_RESTORE_WRITER_DATABASE_URL"])
    error_message = "The reviewed inputs turn the declared reference on, and nothing else."
  }
}

run "an_absolute_location_outside_the_staged_mount_is_refused" {
  command = plan

  variables {
    restore_arguments = ["--archive", "/srv/archive", "--evidence-dir", "/mnt/stage/evidence"]
  }

  # A plan that accepted this would produce an execution that starts, finds
  # nothing at the path, and fails as though the archive were bad.
  expect_failures = [google_cloud_run_v2_job.restore]
}

run "no_volume_is_declared_before_the_platform_stack_creates_the_bucket" {
  command = plan

  override_data {
    target = data.terraform_remote_state.platform
    values = {
      outputs = {
        contract_project_id                  = "example-project"
        contract_region                      = "us-west1"
        contract_registry_url                = "us-west1-docker.pkg.dev/example-project/platform"
        contract_engine_restore_stage_bucket = null
      }
    }
  }

  assert {
    condition     = length(google_cloud_run_v2_job.restore.template[0].template[0].volumes) == 0
    error_message = "With no bucket published there is nothing to mount; a job referencing a bucket that does not exist would not start."
  }

  assert {
    condition     = length(google_cloud_run_v2_job.restore.template[0].template[0].containers[0].volume_mounts) == 0
    error_message = "A mount without its volume is a mount of nothing."
  }
}

run "restore_arguments_are_refused_before_the_bucket_exists" {
  command = plan

  override_data {
    target = data.terraform_remote_state.platform
    values = {
      outputs = {
        contract_project_id                  = "example-project"
        contract_region                      = "us-west1"
        contract_registry_url                = "us-west1-docker.pkg.dev/example-project/platform"
        contract_engine_restore_stage_bucket = null
      }
    }
  }

  variables {
    restore_arguments = ["--archive", "/mnt/stage/archive", "--evidence-dir", "/mnt/stage/evidence"]
  }

  # Applying the reviewed inputs before the platform prerequisites fails at plan
  # time rather than producing an execution with nowhere to read from.
  expect_failures = [google_cloud_run_v2_job.restore]
}

run "binds_exactly_the_declared_reference_when_enabled" {
  command = plan

  variables {
    restore_secret_binding_enabled = true
  }

  assert {
    condition     = toset(keys(local.secret_environment)) == toset(["ENGINE_RESTORE_WRITER_DATABASE_URL"])
    error_message = "Enabling the gate binds the engine_writer reference and nothing else; the job reads a staged archive copy and holds no archive credential."
  }

  assert {
    condition     = !contains(var.accessible_secret_ids, "engine-restore-archive-read-credential")
    error_message = "No archive credential may be declared for a job that never opens the bucket (#255 review)."
  }
}
