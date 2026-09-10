mock_provider "google" {}

variables {
  project_id                 = "example-project"
  region                     = "us-west1"
  service_name               = "web"
  runtime_service_account_id = "example-runtime"
  repository_url             = "us-west1-docker.pkg.dev/example-project/platform"
  image_name                 = "web"
  image_digest               = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  artifact_version           = "release-1.2.3"
  source_commit              = "1111111111111111111111111111111111111111"
  container_port             = 3000
  cpu                        = "1"
  memory                     = "512Mi"
}

run "production_mode_cannot_be_downgraded" {
  command = plan
  variables { environment = "development" }
  expect_failures = [var.environment]
}

run "empty_version_is_rejected" {
  command = plan
  variables { artifact_version = "" }
  expect_failures = [var.artifact_version]
}

run "development_version_is_rejected" {
  command = plan
  variables { artifact_version = "development" }
  expect_failures = [var.artifact_version]
}

run "unsafe_version_is_rejected" {
  command = plan
  variables { artifact_version = "../private-marker" }
  expect_failures = [var.artifact_version]
}

run "overlong_version_is_rejected" {
  command = plan
  variables { artifact_version = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  expect_failures = [var.artifact_version]
}

run "node_env_override_is_rejected" {
  command = plan
  variables { extra_env = { NODE_ENV = "development" } }
  expect_failures = [var.extra_env]
}

run "identical_node_env_override_is_rejected" {
  command = plan
  variables { extra_env = { NODE_ENV = "production" } }
  expect_failures = [var.extra_env]
}

run "origin_override_is_rejected" {
  command = plan
  variables { extra_env = { PLATFORM_API_ORIGIN = "https://api.example.test" } }
  expect_failures = [var.extra_env]
}

run "artifact_override_is_rejected" {
  command = plan
  variables { extra_env = { ARTIFACT_VERSION = "release-1.2.3" } }
  expect_failures = [var.extra_env]
}

run "source_override_is_rejected" {
  command = plan
  variables { extra_env = { MONEY_NOODLE_COMMIT = "1111111111111111111111111111111111111111" } }
  expect_failures = [var.extra_env]
}

run "service_override_is_rejected" {
  command = plan
  variables { extra_env = { MONEY_NOODLE_SERVICE = "web" } }
  expect_failures = [var.extra_env]
}

run "environment_override_is_rejected" {
  command = plan
  variables { extra_env = { MONEY_NOODLE_ENVIRONMENT = "production" } }
  expect_failures = [var.extra_env]
}

run "old_origin_alias_is_rejected" {
  command = plan
  variables { extra_env = { MONEY_NOODLE_API_BASE_URL = "https://api.example.test" } }
  expect_failures = [var.extra_env]
}

run "old_version_alias_is_rejected" {
  command = plan
  variables { extra_env = { MONEY_NOODLE_VERSION = "release-1.2.3" } }
  expect_failures = [var.extra_env]
}

run "cloud_run_port_override_is_rejected" {
  command = plan
  variables { extra_env = { PORT = "3000" } }
  expect_failures = [var.extra_env]
}

run "packaged_contract_override_is_rejected" {
  command = plan
  variables { extra_env = { PLATFORM_API_CONTRACT_PATH = "alternate.yaml" } }
  expect_failures = [var.extra_env]
}

run "telemetry_override_is_rejected" {
  command = plan
  variables { extra_env = { OTEL_SERVICE_NAME = "web" } }
  expect_failures = [var.extra_env]
}

run "browser_public_override_is_rejected" {
  command = plan
  variables { extra_env = { NEXT_PUBLIC_ORIGIN = "https://api.example.test" } }
  expect_failures = [var.extra_env]
}

run "nonreserved_configuration_is_preserved" {
  command = plan
  variables {
    extra_env           = { EXAMPLE_FEATURE = "enabled" }
    platform_api_origin = "https://api.example.test"
  }
  assert {
    condition     = one([for entry in google_cloud_run_v2_service.service.template[0].containers[0].env : entry.value if entry.name == "EXAMPLE_FEATURE"]) == "enabled"
    error_message = "Nonreserved additional configuration must remain supported."
  }
  assert {
    condition     = length([for entry in google_cloud_run_v2_service.service.template[0].containers[0].env : entry if entry.name == "PORT"]) == 0
    error_message = "Cloud Run, not extra_env, injects PORT."
  }
}
