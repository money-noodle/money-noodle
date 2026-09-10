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
  values = { outputs = { contract_service_uri = "https://api.example.test" } }
}
variables {
  platform_state_bucket = "example-platform-state"
  api_state_bucket      = "example-api-state"
  image_digest          = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  artifact_version      = "release-1.2.3"
  source_commit         = "1111111111111111111111111111111111111111"
}
run "wrong_application_identity_is_rejected" {
  command = plan
  variables { service_name = "platform-api" }
  expect_failures = [var.service_name]
}
run "empty_origin_override_is_rejected" {
  command = plan
  variables { api_base_url_override = "" }
  expect_failures = [var.api_base_url_override]
}
run "credential_bearing_origin_override_is_rejected" {
  command = plan
  variables { api_base_url_override = "https://user:private-marker@api.example.test" }
  expect_failures = [var.api_base_url_override]
}
