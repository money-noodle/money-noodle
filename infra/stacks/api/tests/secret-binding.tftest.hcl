# Whether this revision references the projection secret at all, in both gate
# positions.
#
# Synthetic desired configuration only; every remote-state read is overridden. No
# provider is reached and no secret value exists anywhere in this file.
#
# The binding is on by default since #219, because the container and its accessor
# grant now exist and the secret holds a version. The gate itself stays, because
# Cloud Run refuses a revision referencing a secret that does not exist and because
# taking the reference back out is how a projection incident is contained without
# reverting the port (#217, ADR-0012). Both positions are asserted here: the one a
# routine deploy renders, and the one an incident change would.
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

run "the_default_deploy_binds_the_projection_secret_by_reference" {
  command = plan

  # Default state, which is now what every routine api deploy renders.
  assert {
    condition     = var.projection_secret_binding_enabled == true
    error_message = "The projection binding is enabled by default since #219; a revision that binds nothing reads the projection as unconfigured."
  }

  assert {
    condition = (
      length(module.service.rendered_secret_environment) == 1 &&
      contains(keys(module.service.rendered_secret_environment), "PLATFORM_API_PROJECTION_DATABASE_URL")
    )
    error_message = "A routine deploy must render exactly the projection connection string, by name. Found: ${join(", ", keys(module.service.rendered_secret_environment))}"
  }

  assert {
    condition     = module.service.rendered_secret_environment["PLATFORM_API_PROJECTION_DATABASE_URL"] == "platform-api-projection-database-url"
    error_message = "The rendered reference must name the secret container the platform stack declares."
  }

  # Intent and reference agree. The platform stack grants against this list, so a
  # reference that drifted off it would be a revision that cannot start.
  assert {
    condition = alltrue([
      for name, secret_id in module.service.rendered_secret_environment :
      contains(var.accessible_secret_ids, secret_id)
    ])
    error_message = "Every rendered reference must name a secret this stack declares it may read. Found intent: ${join(", ", var.accessible_secret_ids)}"
  }
}

# The off-switch, which is the reason the gate was not replaced by an unconditional
# binding. A projection incident is contained by rendering a revision that binds no
# secret, not by reverting the port.
run "disabling_the_binding_renders_no_reference_and_keeps_the_intent" {
  command = plan

  variables {
    projection_secret_binding_enabled = false
  }

  assert {
    condition     = length(module.service.rendered_secret_environment) == 0
    error_message = "With the binding disabled the revision must reference no secret at all."
  }

  # Turning the reference off must not also withdraw what this service is declared
  # to be allowed to read, or turning it back on would need two changes.
  assert {
    condition = (
      length(var.accessible_secret_ids) == 1 &&
      contains(var.accessible_secret_ids, "platform-api-projection-database-url")
    )
    error_message = "The declared intent is unchanged by the gate; only the rendered reference is withheld. Found: ${join(", ", var.accessible_secret_ids)}"
  }
}
