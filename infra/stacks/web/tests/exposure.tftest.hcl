# The first apply of this stack must create a private web service. The web is
# the intended public entry point for the first remote validation, but exposing
# it is a separate reviewed step taken once the private service has been
# independently verified.
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
  target = data.terraform_remote_state.api
  values = {
    outputs = {
      contract_service_uri = "https://api.example.test"
    }
  }
}

variables {
  platform_state_bucket = "example-platform-state"
  api_state_bucket      = "example-api-state"
  image_digest          = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  artifact_version      = "release-1.2.3+web"
  source_commit         = "1111111111111111111111111111111111111111"
}

run "the_creating_apply_leaves_the_web_private" {
  command = plan

  assert {
    condition     = length(output.contract_public_invoker_members) == 0
    error_message = "Applying this stack with its declared defaults must create a web service with no `allUsers` binding."
  }
}

run "exposing_the_web_requires_the_explicit_input" {
  command = plan

  variables {
    allow_unauthenticated = true
  }

  assert {
    condition     = one(output.contract_public_invoker_members) == "allUsers"
    error_message = "Exposure must come from the explicit input and add exactly `allUsers`."
  }
}
