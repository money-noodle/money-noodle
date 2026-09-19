# The accepted exposure order is create private, verify independently, then
# expose as a separate reviewed step. These cases assert that the apply which
# creates a service cannot be the apply that publishes it.
#
# The provider is mocked, so nothing here reaches a provider API.
mock_provider "google" {}

variables {
  project_id                    = "example-project"
  region                        = "us-west1"
  service_name                  = "example-service"
  runtime_service_account_email = "example-runtime@example-project.iam.gserviceaccount.com"
  repository_url                = "us-west1-docker.pkg.dev/example-project/platform"
  image_name                    = "example"
  image_digest                  = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  artifact_version              = "0.0.0"
  source_commit                 = "0000000000000000000000000000000000000000"
  container_port                = 3000
  cpu                           = "1"
  memory                        = "512Mi"
}

run "creating_a_service_does_not_expose_it" {
  command = plan

  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "A service must be created private. Exposing it is a separate reviewed step taken after independent verification."
  }

  assert {
    condition     = length(output.public_invoker_members) == 0
    error_message = "The published contract must report an unexposed service as having no public invoker."
  }
}

run "the_least_privilege_path_exists_while_the_service_is_private" {
  command = plan

  variables {
    authorised_invoker_members = ["serviceAccount:web-runtime@example-project.iam.gserviceaccount.com"]
  }

  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "Granting a named service-to-service invoker must not also grant public access."
  }

  assert {
    condition = one([
      for entry in google_cloud_run_v2_service_iam_member.authorised_invokers : entry.member
    ]) == "serviceAccount:web-runtime@example-project.iam.gserviceaccount.com"
    error_message = "A private service must still grant its named invoker, so a caller can verify it before exposure."
  }
}

run "exposure_is_a_separate_explicit_input" {
  command = plan

  variables {
    allow_unauthenticated = true
  }

  assert {
    condition     = one(google_cloud_run_v2_service_iam_member.public[*].member) == "allUsers"
    error_message = "The exposure step must add exactly `allUsers`, and nothing wider."
  }

  assert {
    condition     = one(google_cloud_run_v2_service_iam_member.public[*].role) == "roles/run.invoker"
    error_message = "The exposure step must grant only `roles/run.invoker`."
  }

  assert {
    condition     = one(output.public_invoker_members) == "allUsers"
    error_message = "The published contract must report the exposed member, so an unintended exposure is visible from state."
  }
}
