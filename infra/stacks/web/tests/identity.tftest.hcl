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
  api_state_bucket       = "example-api-state"
  image_digest           = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  artifact_version       = "release-1.2.3"
  source_commit          = "1111111111111111111111111111111111111111"
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

run "the_web_consumes_the_identity_bootstrap_published" {
  command = plan

  assert {
    condition     = output.contract_runtime_service_account_email == "web-runtime@example-project.iam.gserviceaccount.com"
    error_message = "The web must run as the identity bootstrap published for it, not one this apply created."
  }

  # The web has no service-to-service caller. Its one invoker is the deployer,
  # which probes this private service with an audience-bound ID token after the
  # apply and would otherwise be refused.
  assert {
    condition = output.authorised_invoker_members == tolist([
      "serviceAccount:delivery-deployer@example-project.iam.gserviceaccount.com",
    ])
    error_message = "A private web service must grant run.invoker to the post-apply verifier, or the probe 403s for lack of a binding."
  }
}
