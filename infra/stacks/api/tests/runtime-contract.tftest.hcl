# Synthetic desired configuration only; every remote-state read is overridden.
mock_provider "google" {}

override_data {
  target = data.terraform_remote_state.platform
  values = {
    outputs = {
      contract_project_id         = "example-project"
      contract_region             = "us-west1"
      contract_registry_url       = "us-west1-docker.pkg.dev/example-project/platform"
      contract_telemetry_endpoint = "https://telemetry.example.test"
    }
  }
}

override_data {
  target = data.terraform_remote_state.bootstrap
  values = {
    outputs = {
      contract_deployer_service_account_email = "delivery-deployer@example-project.iam.gserviceaccount.com"
      contract_runtime_service_account_emails = {
        "platform-api" = "platform-api-runtime@example-project.iam.gserviceaccount.com"
        "web"          = "web-runtime@example-project.iam.gserviceaccount.com"
      }
    }
  }
}

variables {
  platform_state_bucket  = "example-platform-state"
  bootstrap_state_bucket = "example-bootstrap-state"
  image_digest           = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
  artifact_version       = "release-1.2.3+api"
  source_commit          = "2222222222222222222222222222222222222222"

  # Enabled here on purpose, where the stack default is off (#217). This file is
  # the rendering the runtime-contract bridge evaluates, and the contract worth
  # proving is the one that will serve production once the maintainer has applied
  # the container and its accessor grant: a reference, never a value. The
  # default-off rendering is proved separately, in `secret-binding.tftest.hcl`,
  # which the bridge does not read.
  projection_secret_binding_enabled = true
}

run "production_api" {
  command = plan

  # The projection connection reaches the runtime by reference, under the one
  # name the runtime contract allowlists, and only because the same secret is
  # granted to this service's runtime identity (#209, ADR-0012). The bridge
  # proves the rendered reference; these assert the declared intent it is
  # checked against, so a binding renamed here fails in HCL rather than only in
  # the bridge's JSON.
  assert {
    condition = (
      length(var.secret_environment) == 1 &&
      contains(keys(var.secret_environment), "PLATFORM_API_PROJECTION_DATABASE_URL")
    )
    error_message = "The api runtime may hold exactly one secret-backed variable, the projection connection string; found: ${join(", ", keys(var.secret_environment))}"
  }

  assert {
    condition = alltrue([
      for name, secret_id in var.secret_environment :
      contains(var.accessible_secret_ids, secret_id)
    ])
    error_message = "A secret bound by reference must also be granted to this service's runtime identity, or the instance cannot start."
  }

  # No value is supplied anywhere in this configuration. The container is
  # declared empty by the platform stack and the maintainer adds the version out
  # of band, so there is nothing here a plan or state file could carry.
  assert {
    condition     = length(var.secret_environment) == length(distinct(values(var.secret_environment)))
    error_message = "Two variables must not reference the same secret under different names."
  }
}
