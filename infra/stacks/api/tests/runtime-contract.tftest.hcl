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

  # The projection binding is deliberately not overridden here. Since #219 it is the
  # stack default, so this file — the rendering the runtime-contract bridge evaluates
  # — now proves the configuration a routine deploy actually applies rather than an
  # enabled variant of it. Both gate positions are asserted in
  # `secret-binding.tftest.hcl`, which the bridge does not read.
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
    condition     = contains(keys(var.secret_environment), "PLATFORM_API_PROJECTION_DATABASE_URL")
    error_message = "The api runtime must declare the projection connection string; found: ${join(", ", keys(var.secret_environment))}"
  }

  # The allowlist of what a secret-backed variable on this runtime may be. #242
  # adds six, and this list is what stops a seventh arriving without a decision:
  # the two engine roles ADR-0013 §2 separates, this service's own schema, and the
  # three identity values. A name outside it fails here rather than in a deploy.
  assert {
    condition = alltrue([
      for name in keys(var.secret_environment) : contains([
        "PLATFORM_API_PROJECTION_DATABASE_URL",
        "PLATFORM_API_ENGINE_READER_DATABASE_URL",
        "PLATFORM_API_ENGINE_RECORDER_DATABASE_URL",
        "PLATFORM_API_ACCOUNT_DATABASE_URL",
        "PLATFORM_API_IDENTITY_AUDIENCE",
        "PLATFORM_API_IDENTITY_ISSUER",
        "PLATFORM_API_IDENTITY_ACCOUNT_ID",
      ], name)
    ])
    error_message = "A secret-backed variable outside the accepted set is declared; found: ${join(", ", keys(var.secret_environment))}"
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
