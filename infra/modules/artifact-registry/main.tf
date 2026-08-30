terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

# Regional and colocated with the Cloud Run services so image pulls stay on the
# free intra-location path (ADR-0004).

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  description   = "Attributable OCI artifacts for the Money Noodle platform. Deployed by digest only."
  format        = "DOCKER"

  docker_config {
    # A published tag cannot be moved to a different digest. Deployment is by
    # digest regardless, so this is defence in depth against a mutable tag ever
    # becoming load-bearing.
    immutable_tags = true
  }

  # Untagged images accumulate from every provenance and SBOM attestation push.
  # Deleting them on a delay keeps storage inside the free allotment without
  # removing anything a rollback might still need.
  cleanup_policy_dry_run = var.cleanup_dry_run

  cleanup_policies {
    id     = "keep-recent-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.keep_recent_versions
    }
  }

  cleanup_policies {
    id     = "delete-stale-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "${var.untagged_retention_days * 24}h"
    }
  }

  labels = merge(var.labels, {
    "managed-by" = "opentofu"
  })
}

# The deployer writes; nothing else does.
resource "google_artifact_registry_repository_iam_member" "deployer_write" {
  project    = google_artifact_registry_repository.images.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.deployer_service_account_email}"
}

# Cloud Run pulls images as the per-project Cloud Run service agent, not as the
# workload's own runtime identity. Granting the reader role to the runtime
# identities instead would be both insufficient and a violation of ADR-0005,
# which states plainly that the web workload identity may not read the registry.
resource "google_artifact_registry_repository_iam_member" "runtime_pull" {
  for_each = toset(var.image_puller_members)

  project    = google_artifact_registry_repository.images.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = each.value
}
