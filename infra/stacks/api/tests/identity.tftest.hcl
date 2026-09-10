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
variables {
  platform_state_bucket = "example-platform-state"
  image_digest          = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
  artifact_version      = "release-1.2.3"
  source_commit         = "2222222222222222222222222222222222222222"
}
run "wrong_application_identity_is_rejected" {
  command = plan
  variables { service_name = "web" }
  expect_failures = [var.service_name]
}
