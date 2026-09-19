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
  artifact_version       = "release-1.2.3"
  source_commit          = "2222222222222222222222222222222222222222"
}
run "wrong_application_identity_is_rejected" {
  command = plan
  variables { service_name = "web" }
  expect_failures = [var.service_name]
}

run "the_api_consumes_the_identity_bootstrap_published" {
  command = plan

  # The identity is created by the maintainer-applied bootstrap stack and read
  # from its published contract, keyed by this stack's own pinned service name.
  # A plan that created an account would show a mocked email here instead.
  assert {
    condition     = output.contract_runtime_service_account_email == "platform-api-runtime@example-project.iam.gserviceaccount.com"
    error_message = "The API must run as the identity bootstrap published for it, not one this apply created."
  }

  # Service-level invoker bindings stay in the service stack, because they are
  # per-service and per-release. Two members: the web's runtime identity, which
  # is the least-privilege service-to-service path, and the deployer, which
  # probes this private service with an audience-bound ID token after the apply.
  assert {
    condition = output.authorised_invoker_members == tolist([
      "serviceAccount:delivery-deployer@example-project.iam.gserviceaccount.com",
      "serviceAccount:web-runtime@example-project.iam.gserviceaccount.com",
    ])
    error_message = "A private API must grant run.invoker to the web runtime identity and to the post-apply verifier, or the probe 403s for lack of a binding."
  }
}

run "a_public_principal_cannot_be_added_as_an_extra_invoker" {
  command = plan

  variables {
    authorised_invoker_members = ["allUsers"]
  }

  expect_failures = [var.authorised_invoker_members]
}
