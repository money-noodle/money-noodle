# Which secrets this revision references, in every gate position.
#
# Two gates since #242: the projection's, which is on, and the signed-in surface's,
# which is off until the maintainer has created those containers and entered their
# first versions. Both positions of both are asserted here.
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
    condition     = contains(var.accessible_secret_ids, "platform-api-projection-database-url")
    error_message = "The declared intent is unchanged by the gate; only the rendered reference is withheld. Found: ${join(", ", var.accessible_secret_ids)}"
  }
}

# The signed-in surface (#242, ADR-0013). Declared, granted, and rendered by
# nothing: Cloud Run refuses a revision referencing a container that does not
# exist, so the references wait for the maintainer exactly as the projection's did
# between #217 and #219.
run "the_signed_in_references_are_declared_and_not_yet_rendered" {
  command = plan

  assert {
    condition     = var.identity_secret_binding_enabled == false
    error_message = "The signed-in binding stays off until its containers exist and hold versions."
  }

  assert {
    condition = (
      length(module.service.rendered_secret_environment) == 1 &&
      contains(keys(module.service.rendered_secret_environment), "PLATFORM_API_PROJECTION_DATABASE_URL")
    )
    error_message = "A routine deploy still renders exactly the projection reference. Found: ${join(", ", keys(module.service.rendered_secret_environment))}"
  }

  # The intent is declared now, because the grant is applied from the platform
  # stack and a grant that arrived after the reference would be a revision that
  # cannot start.
  assert {
    condition = alltrue([
      for secret_id in [
        "platform-api-engine-reader-database-url",
        "platform-api-engine-recorder-database-url",
        "platform-api-account-database-url",
        "platform-api-identity-audience",
        "platform-api-identity-issuer",
        "platform-api-identity-account-id",
      ] : contains(var.accessible_secret_ids, secret_id)
    ])
    error_message = "Every signed-in container must be declared readable before its reference is rendered. Found: ${join(", ", var.accessible_secret_ids)}"
  }

  # No venue, broker or exchange credential is declared anywhere. ADR-0013 §4
  # gives the live budget no execution path in M4.
  assert {
    condition = alltrue([
      for secret_id in var.accessible_secret_ids :
      length(regexall("(venue|broker|exchange|kalshi|polymarket|kraken)", secret_id)) == 0
    ])
    error_message = "A venue credential is declared. ADR-0013 §4: the live budget has no execution path in M4."
  }
}

run "enabling_the_signed_in_binding_renders_every_reference_by_name" {
  command = plan

  variables {
    identity_secret_binding_enabled = true
  }

  assert {
    condition = (
      length(module.service.rendered_secret_environment) == 7 &&
      module.service.rendered_secret_environment["PLATFORM_API_ENGINE_READER_DATABASE_URL"] == "platform-api-engine-reader-database-url" &&
      module.service.rendered_secret_environment["PLATFORM_API_ENGINE_RECORDER_DATABASE_URL"] == "platform-api-engine-recorder-database-url" &&
      module.service.rendered_secret_environment["PLATFORM_API_ACCOUNT_DATABASE_URL"] == "platform-api-account-database-url"
    )
    error_message = "With the gate on, every declared reference renders by name. Found: ${join(", ", keys(module.service.rendered_secret_environment))}"
  }

  # The two engine roles stay two references, because they are two authorities
  # (ADR-0013 §2). One variable carrying both would be one merge away from a role
  # that both reads and records.
  assert {
    condition = (
      module.service.rendered_secret_environment["PLATFORM_API_ENGINE_READER_DATABASE_URL"] !=
      module.service.rendered_secret_environment["PLATFORM_API_ENGINE_RECORDER_DATABASE_URL"]
    )
    error_message = "The engine read path and the control path must reference different containers."
  }

  assert {
    condition = alltrue([
      for name, secret_id in module.service.rendered_secret_environment :
      contains(var.accessible_secret_ids, secret_id)
    ])
    error_message = "Every rendered reference must name a secret this stack declares it may read."
  }
}

run "disabling_both_gates_renders_nothing_at_all" {
  command = plan

  variables {
    projection_secret_binding_enabled = false
    identity_secret_binding_enabled   = false
  }

  assert {
    condition     = length(module.service.rendered_secret_environment) == 0
    error_message = "With both gates off the revision must reference no secret at all."
  }
}
