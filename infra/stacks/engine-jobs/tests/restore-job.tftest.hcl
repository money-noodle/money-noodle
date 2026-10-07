# The restore job is created with a manual trigger only, under its own identity,
# and binds no secret until the reviewed gate is turned on. Synthetic desired
# configuration only; every remote-state read is overridden.
mock_provider "google" {}

override_data {
  target = data.terraform_remote_state.platform
  values = {
    outputs = {
      contract_project_id   = "example-project"
      contract_region       = "us-west1"
      contract_registry_url = "us-west1-docker.pkg.dev/example-project/platform"
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

run "binds_exactly_the_declared_references_when_enabled" {
  command = plan

  variables {
    restore_secret_binding_enabled = true
  }

  assert {
    condition     = toset(keys(local.secret_environment)) == toset(["ENGINE_RESTORE_WRITER_DATABASE_URL", "ENGINE_RESTORE_ARCHIVE_READ_CREDENTIAL"])
    error_message = "Enabling the gate binds the two declared references and nothing else."
  }
}
