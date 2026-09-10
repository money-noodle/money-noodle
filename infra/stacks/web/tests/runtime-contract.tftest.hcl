# Synthetic desired configuration only; no provider or remote backend is read.
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

run "published_origin" {
  command = plan
}

run "explicit_origin" {
  command = plan
  variables {
    api_base_url_override = "https://explicit-api.example.test"
  }
}
