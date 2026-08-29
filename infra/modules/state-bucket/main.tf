terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

# One bucket per stack. ADR-0006 requires separate state so that applying one
# stack cannot lock, mutate, or break another; separate buckets make that a
# property of the storage layout rather than of a naming convention.

resource "google_storage_bucket" "state" {
  project  = var.project_id
  name     = var.bucket_name
  location = var.region

  # State may contain values that are sensitive even when no secret was ever
  # declared, so it is treated as sensitive by default.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Enabled from the first apply, not retrofitted. A retrofitted version history
  # does not contain the version you need.
  versioning {
    enabled = true
  }

  # Deleting a state bucket is not an ordinary operation. Removing this
  # protection requires a reviewed code change, which is the point.
  force_destroy = false

  # Provider-managed encryption at minimum, per ADR-0006. A customer-managed key
  # is a later decision and is not required for the first slice.
  dynamic "encryption" {
    for_each = var.kms_key_name == null ? [] : [var.kms_key_name]
    content {
      default_kms_key_name = encryption.value
    }
  }

  lifecycle_rule {
    condition {
      # Retain the live object plus a bounded history. `num_newer_versions`
      # counts newer versions, so this keeps the current object and the previous
      # `state_versions_retained` noncurrent ones.
      num_newer_versions = var.state_versions_retained
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = var.noncurrent_version_retention_days
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  labels = merge(var.labels, {
    "managed-by" = "opentofu"
    "purpose"    = "infrastructure-state"
    "stack"      = var.stack
  })

  lifecycle {
    prevent_destroy = true
  }
}

# Access is restricted to the deployer principal. Developers hold no standing
# write access to state; a person who needs it takes an audited, deliberate step
# rather than inheriting it.
resource "google_storage_bucket_iam_member" "deployer" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.deployer_service_account_email}"
}

# Listing is a separate grant from object access and the backend needs it to
# enumerate workspaces and lock objects.
resource "google_storage_bucket_iam_member" "deployer_list" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${var.deployer_service_account_email}"
}
