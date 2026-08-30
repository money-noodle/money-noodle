terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

# ADR-0005: the managed secret store is declared and reachable from the first
# apply even though the first slice stores nothing in it, so that the first
# capability needing a credential does not also have to invent custody under
# delivery pressure.
#
# This module creates secret *containers* and their access boundary. It never
# creates a secret *version*: a value would have to pass through OpenTofu
# variables, plans, and state to get here, and secret values never enter Git,
# images, build logs, telemetry, or handoffs. Versions are added out of band by
# the maintainer and the container is then already waiting for them.

resource "google_secret_manager_secret" "secret" {
  for_each = var.secrets

  project   = var.project_id
  secret_id = each.key

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  labels = merge(var.labels, {
    "managed-by" = "opentofu"
    "owner"      = each.value.owner
    "consumer"   = each.value.consuming_principal
  })

  annotations = {
    # Every secret records owner, consuming principal, rotation interval,
    # revocation procedure, and recovery path (ADR-0005). Recording them beside
    # the secret is what keeps them true; a wiki page drifts.
    "rotation-interval-days" = tostring(each.value.rotation_interval_days)
    "revocation-procedure"   = each.value.revocation_procedure
    "recovery-path"          = each.value.recovery_path
  }

  # Provider-scheduled rotation is deliberately not configured here. Secret
  # Manager's rotation schedule publishes to a Pub/Sub topic, which means a
  # topic, a subscription, and a responder — infrastructure that would exist to
  # serve zero secrets. The interval is recorded as an annotation now so the
  # obligation is written down, and the scheduling mechanism is built with the
  # first real secret, which is also the first time it can be tested end to end.

  lifecycle {
    prevent_destroy = true
  }
}
