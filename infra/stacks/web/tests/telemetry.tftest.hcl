# Synthetic evaluated telemetry configuration. The provider is mocked and every
# remote-state read is overridden: nothing here reaches a provider, and no
# identifier below is real.
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
  image_digest           = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
  artifact_version       = "release-1.2.3+web"
  source_commit          = "3333333333333333333333333333333333333333"
}

run "telemetry_configuration_is_explicit_and_credential_free" {
  command = plan

  # OTLP over HTTP/protobuf keeps the exporter replaceable (ADR-0007).
  assert {
    condition     = module.service.telemetry_env["OTEL_EXPORTER_OTLP_PROTOCOL"] == "http/protobuf"
    error_message = "Telemetry must be exported as OTLP over HTTP/protobuf."
  }

  assert {
    condition     = module.service.telemetry_env["OTEL_SERVICE_NAME"] == "web"
    error_message = "Each service must carry its own telemetry service name."
  }

  # Head sampling is configured explicitly and is unity at the first slice, so
  # it can be lowered later without re-instrumenting.
  assert {
    condition     = module.service.telemetry_env["OTEL_TRACES_SAMPLER"] == "parentbased_traceidratio"
    error_message = "Sampling must be parent-based so a propagated decision is honoured."
  }
  assert {
    condition     = module.service.telemetry_env["OTEL_TRACES_SAMPLER_ARG"] == "1"
    error_message = "First-slice head sampling is unity."
  }

  # The quota project the Telemetry API requires is a project identifier, not a
  # credential, and no credential may appear in any environment variable.
  assert {
    condition     = module.service.telemetry_env["GOOGLE_CLOUD_QUOTA_PROJECT"] == "example-project"
    error_message = "The Telemetry API quota project must be configured."
  }
  assert {
    condition     = !contains(keys(module.service.telemetry_env), "OTEL_EXPORTER_OTLP_HEADERS")
    error_message = "No credential may be carried in an OTEL header variable."
  }

  # Attribution keeps the upstream contract's three distinct facts.
  assert {
    condition = alltrue([
      for fragment in [
        "service.name=web",
        "service.version=release-1.2.3+web",
        "money_noodle.image_digest=sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "money_noodle.source_commit=3333333333333333333333333333333333333333",
      ] : strcontains(module.service.telemetry_env["OTEL_RESOURCE_ATTRIBUTES"], fragment)
    ])
    error_message = "Every signal must be attributable to service, release, image digest and source commit."
  }
}

# The runtime identity's project-level telemetry roles are no longer granted
# here. They are granted by the maintainer-applied bootstrap stack, and asserted
# in `infra/stacks/bootstrap/tests/bootstrap.tftest.hcl`, because a service apply
# must need no project-IAM authority at all (ADR-0005, 2026-09-19 amendment).
