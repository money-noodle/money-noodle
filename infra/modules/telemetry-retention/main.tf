terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

# ADR-0007 requires retention to be explicit configuration from day one rather
# than a discovered default. Only one of the three signal classes is actually
# configurable on this backend, and this module is deliberate about saying which:
# pretending otherwise would be exactly the kind of unverified claim the
# repository's evidence standard exists to prevent.

resource "google_logging_project_bucket_config" "default" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = var.log_retention_days
  description    = "Operational logs for the Money Noodle platform. Retention set explicitly, not left at the provider default."
}

# The `_Required` bucket holds admin activity and system event audit logs. Its
# 400-day retention is fixed by the provider and cannot be shortened, which is
# appropriate: those records are closer to audit than to telemetry, and ADR-0007
# is explicit that telemetry is not audit.

# Debug-level application logs expire faster than operational logs. Routing them
# to their own bucket is what makes a shorter retention expressible at all.
resource "google_logging_project_bucket_config" "debug" {
  count = var.debug_log_retention_days == null ? 0 : 1

  project        = var.project_id
  location       = var.region
  bucket_id      = var.debug_bucket_id
  retention_days = var.debug_log_retention_days
  description    = "Debug-severity application logs, retained for a shorter window than operational logs."
}

resource "google_logging_project_sink" "debug" {
  count = var.debug_log_retention_days == null ? 0 : 1

  project     = var.project_id
  name        = "${var.debug_bucket_id}-sink"
  destination = "logging.googleapis.com/${google_logging_project_bucket_config.debug[0].id}"

  filter = join(" AND ", [
    "severity <= DEBUG",
    "resource.type = \"cloud_run_revision\"",
  ])

  # The sink writes as the logging service; no additional principal is created.
  unique_writer_identity = true
}
