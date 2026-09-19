# Desired retention configuration only. The provider is mocked: nothing here
# observes real aging, and the accepted policy is explicit that desired
# configuration is not observed retention.
mock_provider "google" {}

variables {
  project_id = "example-project"
  region     = "us-west1"
}

run "accepted_first_slice_policy" {
  command = plan

  assert {
    condition     = google_logging_project_bucket_config.default.retention_days == 14
    error_message = "Operational logs must carry the accepted 14-day window explicitly."
  }

  # The accepted policy puts application and debug logs at the same 14 days, so
  # the `_Default` copy that still exists cannot outlive what the debug bucket
  # claims.
  assert {
    condition     = google_logging_project_bucket_config.debug[0].retention_days == 14
    error_message = "Debug logs must match the operational window while _Default keeps its own copy."
  }

  assert {
    condition     = output.retention_policy.debug_logs.effective_days == 14
    error_message = "The effective debug window must be reported as the longer of the two copies."
  }

  assert {
    condition     = output.retention_policy.traces.configured == false && output.retention_policy.traces.days == 30
    error_message = "Trace retention is Google's documented 30 days, recorded as provider behaviour rather than a configured TTL."
  }

  assert {
    condition     = output.retention_policy.metrics.configured == false && output.retention_policy.metrics.days == 730
    error_message = "OTLP metric retention is Google's documented 24 months with downsampling, recorded as provider behaviour."
  }

  # Audit retention is separate and unchanged by this module.
  assert {
    condition     = output.retention_policy.audit_logs.days == 400 && output.retention_policy.audit_logs.configured == false
    error_message = "Audit retention must remain separate, provider-fixed and untouched by telemetry policy."
  }
}

run "debug_routing_is_a_real_path" {
  command = plan

  assert {
    condition     = google_logging_project_sink.debug[0].destination == "logging.googleapis.com/${google_logging_project_bucket_config.debug[0].id}"
    error_message = "The debug sink must route to the debug bucket it claims to."
  }

  assert {
    condition     = strcontains(google_logging_project_sink.debug[0].filter, "severity <= DEBUG")
    error_message = "The debug sink must select debug severity, or the shorter window applies to nothing."
  }

  assert {
    condition     = google_logging_project_sink.debug[0].unique_writer_identity == true
    error_message = "The sink writes as its own service identity; no additional principal is created."
  }
}

run "a_shorter_debug_window_is_refused_without_an_exclusion" {
  command = plan

  variables {
    debug_log_retention_days = 7
  }

  # A shorter debug window is not delivered while `_Default` holds its own copy,
  # so the module refuses to configure the claim rather than quietly making it.
  expect_failures = [
    google_logging_project_bucket_config.debug,
  ]
}

run "a_shorter_debug_window_is_permitted_once_the_exclusion_is_recorded" {
  command = plan

  variables {
    debug_log_retention_days           = 7
    debug_excluded_from_default_bucket = true
  }

  assert {
    condition     = output.retention_policy.debug_logs.effective_days == 7
    error_message = "With the exclusion recorded, the debug window is the only copy."
  }
}
