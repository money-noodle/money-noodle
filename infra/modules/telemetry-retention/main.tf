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
  description    = "Debug-severity application logs. Retention is explicit and must not be shorter than the copy the _Default bucket still holds."

  lifecycle {
    # A sink routes a copy; it does not stop the `_Default` sink from keeping
    # its own. While that copy exists, configuring a shorter window here would
    # be a retention claim the routing does not deliver — exactly the
    # "second longer-lived copy" the accepted policy forbids. Making the claim
    # true needs a separately authorized `_Default` exclusion, which this module
    # deliberately does not create.
    precondition {
      condition = (
        var.debug_excluded_from_default_bucket ||
        var.debug_log_retention_days >= var.log_retention_days
      )
      error_message = "Debug retention shorter than operational retention is not delivered while _Default keeps its own copy. Either match the operational window or record a separately authorized exclusion."
    }
  }
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
