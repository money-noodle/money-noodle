# Whether this revision references the projection secret at all, and what that
# costs when it does.
#
# Synthetic desired configuration only; every remote-state read is overridden. No
# provider is reached and no secret value exists anywhere in this file.
#
# The gate exists because Cloud Run refuses a revision whose referenced secret does
# not exist, and the container plus its accessor grant are created by a
# maintainer-applied platform stack rather than by a routine deploy (#217). A
# default that referenced a secret nobody had created yet would make every routine
# api deploy fail until the maintainer acted, which is a knowingly red `main`.
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
}

run "the_default_deploy_references_no_secret" {
  command = plan

  # Default state: the intent is declared, and nothing is bound. This is what a
  # routine deploy renders before the maintainer has applied the container.
  assert {
    condition     = var.projection_secret_binding_enabled == false
    error_message = "The projection binding must default to off, or a routine deploy references a secret that may not exist yet."
  }

  assert {
    condition     = length(module.service.rendered_secret_environment) == 0
    error_message = "With the binding disabled the revision must reference no secret at all."
  }

  # Intent survives the gate. The platform stack grants against this list, and
  # turning the binding on must not also have to re-declare what it may read.
  assert {
    condition = (
      length(var.accessible_secret_ids) == 1 &&
      contains(var.accessible_secret_ids, "platform-api-projection-database-url")
    )
    error_message = "The declared intent is unchanged by the gate; only the rendered reference is withheld. Found: ${join(", ", var.accessible_secret_ids)}"
  }
}

run "enabling_the_binding_renders_one_reference_and_no_value" {
  command = plan

  variables {
    projection_secret_binding_enabled = true
  }

  assert {
    condition = (
      length(module.service.rendered_secret_environment) == 1 &&
      contains(keys(module.service.rendered_secret_environment), "PLATFORM_API_PROJECTION_DATABASE_URL")
    )
    error_message = "Enabling the binding must render exactly the projection connection string, by name. Found: ${join(", ", keys(module.service.rendered_secret_environment))}"
  }

  assert {
    condition     = module.service.rendered_secret_environment["PLATFORM_API_PROJECTION_DATABASE_URL"] == "platform-api-projection-database-url"
    error_message = "The rendered reference must name the secret container the platform stack declares."
  }
}
