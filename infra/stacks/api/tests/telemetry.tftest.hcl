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

variables {
  platform_state_bucket = "example-platform-state"
  image_digest          = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
  artifact_version      = "release-1.2.3+api"
  source_commit         = "3333333333333333333333333333333333333333"
}

run "telemetry_configuration_is_explicit_and_credential_free" {
  command = plan

  # OTLP over HTTP/protobuf keeps the exporter replaceable (ADR-0007).
  assert {
    condition     = module.service.telemetry_env["OTEL_EXPORTER_OTLP_PROTOCOL"] == "http/protobuf"
    error_message = "Telemetry must be exported as OTLP over HTTP/protobuf."
  }

  assert {
    condition     = module.service.telemetry_env["OTEL_SERVICE_NAME"] == "platform-api"
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
        "service.name=platform-api",
        "service.version=release-1.2.3+api",
        "money_noodle.image_digest=sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "money_noodle.source_commit=3333333333333333333333333333333333333333",
      ] : strcontains(module.service.telemetry_env["OTEL_RESOURCE_ATTRIBUTES"], fragment)
    ])
    error_message = "Every signal must be attributable to service, release, image digest and source commit."
  }
}

run "the_runtime_identity_holds_only_telemetry_write_authority" {
  command = plan

  assert {
    condition = alltrue([
      for role in [
        "roles/cloudtrace.agent",
        "roles/logging.logWriter",
        "roles/monitoring.metricWriter",
        "roles/serviceusage.serviceUsageConsumer",
        "roles/telemetry.writer",
      ] : contains(module.service.telemetry_roles, role)
    ])
    error_message = "The runtime identity must declare exactly the telemetry write roles the Telemetry API documents."
  }

  # Writing telemetry is not reading anything and not deploying anything.
  assert {
    condition = length([
      for role in module.service.telemetry_roles : role
      if !startswith(role, "roles/cloudtrace.") && !startswith(role, "roles/logging.") && !startswith(role, "roles/monitoring.") && !startswith(role, "roles/serviceusage.") && !startswith(role, "roles/telemetry.")
    ]) == 0
    error_message = "The runtime identity must hold no authority beyond telemetry write and its quota consumer role."
  }
}
