# State durability and access.
#
# ADR-0006 requires encryption, versioning from the first apply, locking, access
# restricted to the deployer, and a tested restore. These tests pin the parts
# that are properties of the configuration; locking and restore are provider
# behaviours that only a real apply can prove, and they are listed as outstanding
# in `infra/README.md` rather than claimed here.

mock_provider "google" {}

variables {
  project_id                     = "example-project"
  region                         = "us-west1"
  bucket_name                    = "example-state-platform"
  stack                          = "platform"
  deployer_service_account_email = "delivery-deployer@example-project.iam.gserviceaccount.com"
}

run "state_is_versioned_private_and_not_force_destroyable" {
  command = plan

  assert {
    condition     = one([for setting in google_storage_bucket.state.versioning : setting.enabled])
    error_message = "Object versioning must be enabled from the first apply. A retrofitted history does not contain the version you need."
  }

  assert {
    condition     = google_storage_bucket.state.public_access_prevention == "enforced"
    error_message = "State may contain values that are sensitive even when no secret was declared; public access must be impossible."
  }

  assert {
    condition     = google_storage_bucket.state.uniform_bucket_level_access
    error_message = "Uniform bucket-level access removes per-object ACLs as a way to widen access accidentally."
  }

  assert {
    condition     = google_storage_bucket.state.force_destroy == false
    error_message = "A state bucket that empties itself on destroy is not a recoverable store."
  }
}

run "only_the_deployer_can_reach_state" {
  command = plan

  assert {
    condition     = google_storage_bucket_iam_member.deployer.member == "serviceAccount:delivery-deployer@example-project.iam.gserviceaccount.com"
    error_message = "State access must be granted to the federated deployer and to nothing else. Developers hold no standing write access."
  }

  assert {
    condition     = google_storage_bucket_iam_member.deployer.role == "roles/storage.objectAdmin"
    error_message = "The deployer needs object administration on state, not project-wide storage administration."
  }
}

run "an_unknown_stack_name_is_refused" {
  command = plan

  # A new stack changes the state layout and the locking boundary. It is a
  # reviewed decision, and this makes a typo fail loudly rather than silently
  # creating a fifth state store nobody knows about.
  variables {
    stack = "experimental"
  }

  expect_failures = [var.stack]
}

run "a_history_too_short_to_restore_from_is_refused" {
  command = plan

  variables {
    state_versions_retained = 1
  }

  expect_failures = [var.state_versions_retained]
}

run "a_retention_window_shorter_than_a_month_is_refused" {
  command = plan

  variables {
    noncurrent_version_retention_days = 7
  }

  expect_failures = [var.noncurrent_version_retention_days]
}
