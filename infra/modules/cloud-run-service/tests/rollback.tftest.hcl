# Rollback behaviour.
#
# ADR-0004 accepts "roll back by pointing 100% of traffic at the prior revision",
# requiring no rebuild and no change to the other service. These tests pin that
# the planned configuration actually does that, rather than quietly creating a
# new revision from an older digest — which would look like a rollback in a
# changelog and behave like a deployment in production.

mock_provider "google" {}

variables {
  project_id                 = "example-project"
  region                     = "us-west1"
  service_name               = "example-service"
  runtime_service_account_id = "example-runtime"
  repository_url             = "us-west1-docker.pkg.dev/example-project/platform"
  image_name                 = "example"
  image_digest               = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  artifact_version           = "1.2.3"
  source_commit              = "1111111111111111111111111111111111111111"
  container_port             = 3000
  cpu                        = "1"
  memory                     = "512Mi"
}

run "a_normal_deployment_serves_the_newest_revision" {
  command = plan

  variables {
    revision_suffix = "build-42"
  }

  assert {
    condition = one([
      for entry in google_cloud_run_v2_service.service.traffic : entry.type
    ]) == "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    error_message = "A normal deployment must send traffic to the latest revision."
  }

  assert {
    condition     = google_cloud_run_v2_service.service.template[0].revision == "example-service-build-42"
    error_message = "A normal deployment must name its revision so that a later rollback can target it."
  }
}

run "a_rollback_reassigns_traffic_without_creating_a_revision" {
  command = plan

  variables {
    rollback_revision = "example-service-build-41"
  }

  assert {
    condition = one([
      for entry in google_cloud_run_v2_service.service.traffic : entry.type
    ]) == "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
    error_message = "A rollback must target a named revision, not the latest one."
  }

  assert {
    condition = one([
      for entry in google_cloud_run_v2_service.service.traffic : entry.revision
    ]) == "example-service-build-41"
    error_message = "A rollback must send traffic to the named prior revision."
  }

  assert {
    condition = one([
      for entry in google_cloud_run_v2_service.service.traffic : entry.percent
    ]) == 100
    error_message = "A rollback must move all traffic, not a fraction of it."
  }

  assert {
    condition     = google_cloud_run_v2_service.service.template[0].revision == null
    error_message = "A rollback must not name a new revision; naming one would rebuild rather than reassign."
  }
}

run "the_running_image_is_referenced_by_digest" {
  command = plan

  assert {
    condition = google_cloud_run_v2_service.service.template[0].containers[0].image == join("", [
      "us-west1-docker.pkg.dev/example-project/platform/example",
      "@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    ])
    error_message = "The service must run an image addressed by digest."
  }
}

run "cpu_is_billed_per_request_and_the_service_scales_to_zero" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.service.template[0].containers[0].resources[0].cpu_idle
    error_message = "CPU must be allocated only while handling a request; the accepted cost model prices request-based billing."
  }

  assert {
    condition     = google_cloud_run_v2_service.service.template[0].scaling[0].min_instance_count == 0
    error_message = "The service must scale to zero, so idle cost is bounded at zero."
  }
}

run "readiness_gates_traffic_and_liveness_is_separate" {
  command = plan

  assert {
    condition = one([
      for probe in google_cloud_run_v2_service.service.template[0].containers[0].startup_probe :
      one([for get in probe.http_get : get.path])
    ]) == "/health/ready"
    error_message = "The startup probe must check readiness: it is what gates a revision from receiving traffic."
  }

  assert {
    condition = one([
      for probe in google_cloud_run_v2_service.service.template[0].containers[0].liveness_probe :
      one([for get in probe.http_get : get.path])
    ]) == "/health/live"
    error_message = "The liveness probe must check only that the process can answer."
  }
}

run "telemetry_is_absent_until_an_endpoint_is_configured" {
  command = plan

  # Telemetry is opt-in per deployment. With no endpoint the container carries no
  # OTEL variables at all, rather than half-configured ones that would fail at
  # runtime — and the telemetry IAM grants are skipped with them.
  assert {
    condition = length([
      for entry in google_cloud_run_v2_service.service.template[0].containers[0].env :
      entry if startswith(entry.name, "OTEL_")
    ]) == 0
    error_message = "No OTEL configuration should be injected when no telemetry endpoint is set."
  }
}

run "telemetry_attributes_the_signal_to_a_specific_artifact" {
  command = plan

  variables {
    telemetry_endpoint = "https://telemetry.googleapis.com"
  }

  # ADR-0007: every signal carries the artifact version and deployment identity
  # so a trace can be attributed to a specific image digest.
  assert {
    condition = anytrue([
      for entry in google_cloud_run_v2_service.service.template[0].containers[0].env :
      entry.name == "OTEL_RESOURCE_ATTRIBUTES" && strcontains(entry.value, "sha256:1111")
      if entry.name == "OTEL_RESOURCE_ATTRIBUTES"
    ])
    error_message = "Telemetry resource attributes must carry the image digest."
  }

  assert {
    condition = anytrue([
      for entry in google_cloud_run_v2_service.service.template[0].containers[0].env :
      strcontains(entry.value, "service.version=1.2.3")
      if entry.name == "OTEL_RESOURCE_ATTRIBUTES"
    ])
    error_message = "Telemetry resource attributes must carry the artifact version."
  }
}
