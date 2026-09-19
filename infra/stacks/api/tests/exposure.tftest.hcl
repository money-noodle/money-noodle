# The first apply of this stack must create a private API. Public invocation on
# the interim `*.run.app` URL is the accepted end state, applied as a separate
# reviewed step once the private service has been independently verified.
#
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
}

run "the_creating_apply_leaves_the_api_private" {
  command = plan

  assert {
    condition     = length(output.contract_public_invoker_members) == 0
    error_message = "Applying this stack with its declared defaults must create an API with no `allUsers` binding."
  }
}

run "the_web_can_reach_a_private_api" {
  command = plan

  variables {
    authorised_invoker_members = ["serviceAccount:web-runtime@example-project.iam.gserviceaccount.com"]
  }

  assert {
    condition     = length(output.contract_public_invoker_members) == 0
    error_message = "Granting the web runtime identity must not expose the API publicly."
  }
}

run "exposing_the_api_requires_the_explicit_input" {
  command = plan

  variables {
    allow_unauthenticated = true
  }

  assert {
    condition     = one(output.contract_public_invoker_members) == "allUsers"
    error_message = "Exposure must come from the explicit input and add exactly `allUsers`."
  }
}
