terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

locals {
  # Deployment is by digest, never by a mutable tag (ADR-0005). The validation on
  # `image_digest` makes a tag unrepresentable rather than merely discouraged.
  image = "${var.repository_url}/${var.image_name}@${var.image_digest}"

  revision_name = var.revision_suffix == null ? null : "${var.service_name}-${var.revision_suffix}"

  # Rollback is a traffic reassignment to an existing prior revision. It requires
  # no rebuild and touches only this service, which is the accepted quality
  # attribute from ADR-0004.
  rolling_back = var.rollback_revision != null

  telemetry_env = var.telemetry_endpoint == null ? {} : {
    OTEL_EXPORTER_OTLP_ENDPOINT = var.telemetry_endpoint
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_SERVICE_NAME           = var.service_name
    # Every signal carries the artifact version and deployment identity so a
    # trace can be attributed to a specific image digest (ADR-0007).
    OTEL_RESOURCE_ATTRIBUTES = join(",", [
      "service.name=${var.service_name}",
      "service.version=${var.artifact_version}",
      "deployment.environment.name=${var.environment}",
      "money_noodle.image_digest=${var.image_digest}",
      "money_noodle.source_commit=${var.source_commit}",
    ])
    # Configured explicitly and effectively unity at first-slice volume, so it can
    # be lowered later without re-instrumenting (ADR-0007).
    OTEL_TRACES_SAMPLER     = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG = tostring(var.trace_sample_ratio)
  }

  base_env = {
    NODE_ENV                 = "production"
    MONEY_NOODLE_SERVICE     = var.service_name
    MONEY_NOODLE_VERSION     = var.artifact_version
    MONEY_NOODLE_COMMIT      = var.source_commit
    MONEY_NOODLE_ENVIRONMENT = var.environment
  }

  env = merge(local.base_env, local.telemetry_env, var.extra_env)
}

# Each service holds its own identity. ADR-0005 makes the blast radius explicit:
# the web identity cannot read the registry or infrastructure state, and the API
# identity cannot deploy anything.
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = var.runtime_service_account_id
  display_name = "${var.service_name} runtime"
  description  = "Runtime identity for the ${var.service_name} Cloud Run service. Default-deny: it holds no project role beyond those granted explicitly here."
}

# Telemetry export is the only project-level authority a runtime identity holds
# in the first slice. Writing telemetry is not reading anything.
resource "google_project_iam_member" "runtime_telemetry" {
  for_each = var.telemetry_endpoint == null ? toset([]) : toset([
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Secret access is granted per secret, never at project level, and only to the
# service explicitly declared as its consumer.
resource "google_secret_manager_secret_iam_member" "runtime_secret_access" {
  for_each = toset(var.accessible_secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "service" {
  project  = var.project_id
  location = var.region
  name     = var.service_name

  # Removing a running service requires a reviewed code change that flips this
  # first. Destroy is not available to ordinary automation (ADR-0006).
  deletion_protection = var.deletion_protection

  ingress = var.ingress

  template {
    revision        = local.revision_name
    service_account = google_service_account.runtime.email
    timeout         = "${var.request_timeout_seconds}s"

    scaling {
      # Scale to zero. There is no resident multipurpose service here, and idle
      # cost is therefore bounded at zero (`principles.md`, R3).
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    max_instance_request_concurrency = var.max_concurrency

    containers {
      image = local.image

      ports {
        name           = "http1"
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # Request-based billing: CPU is allocated only while a request is being
        # handled. This is the billing model priced in the accepted cost model.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Cloud Run has no separate readiness probe; the startup probe is what
      # gates a revision from receiving traffic, so `/health/ready` belongs here.
      # A revision that never reports ready never serves, which is the behaviour
      # the accepted architecture asks for.
      startup_probe {
        http_get {
          path = var.readiness_path
          port = var.container_port
        }
        initial_delay_seconds = 0
        period_seconds        = 3
        timeout_seconds       = 3
        failure_threshold     = var.startup_failure_threshold
      }

      # `/health/live` says only that the process can answer.
      liveness_probe {
        http_get {
          path = var.liveness_path
          port = var.container_port
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        timeout_seconds       = 3
        failure_threshold     = 3
      }
    }
  }

  dynamic "traffic" {
    for_each = local.rolling_back ? [] : [1]
    content {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = 100
    }
  }

  dynamic "traffic" {
    for_each = local.rolling_back ? [var.rollback_revision] : []
    content {
      type     = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
      revision = traffic.value
      percent  = 100
    }
  }

  labels = merge(var.labels, {
    "managed-by" = "opentofu"
    "service"    = var.service_name
  })

  lifecycle {
    precondition {
      condition     = startswith(var.image_digest, "sha256:")
      error_message = "Cloud Run services deploy by digest. A mutable tag breaks attribution and makes rollback ambiguous (ADR-0005)."
    }

    precondition {
      condition     = !(var.rollback_revision != null && var.revision_suffix != null)
      error_message = "A rollback reassigns traffic to an existing revision. Naming a new revision at the same time would rebuild rather than roll back."
    }
  }
}

# Public invocation for the interim `*.run.app` entry point. Held in a variable
# so that making a service private later is a reviewed change to one value.
resource "google_cloud_run_v2_service_iam_member" "public" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = google_cloud_run_v2_service.service.project
  location = google_cloud_run_v2_service.service.location
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The least-privilege service-to-service path exists whether or not the service
# is also publicly invocable, so that removing public access does not also remove
# the web's ability to reach the API.
resource "google_cloud_run_v2_service_iam_member" "authorised_invokers" {
  for_each = toset(var.authorised_invoker_members)

  project  = google_cloud_run_v2_service.service.project
  location = google_cloud_run_v2_service.service.location
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = each.value
}
