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

run "production_api" {
  command = plan
}
