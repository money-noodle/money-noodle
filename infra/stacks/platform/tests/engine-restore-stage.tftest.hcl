# The restore job's staging area: private, bounded, and readable by exactly one
# identity (#241, ADR-0013 §1).
#
# Synthetic desired configuration only; the bootstrap remote-state read is
# overridden and no provider is reached. The bucket name here is a placeholder:
# the real one is supplied at apply and never committed.
#
# Why these assertions live in the platform stack's tests at all: the bucket is
# declared here because the deployer that runs a dispatched apply holds no Cloud
# Storage role, so it could neither create the bucket nor set its IAM. That is the
# same reason the secret container and its grant are declared here (#217, #224).
mock_provider "google" {}

override_data {
  target = data.terraform_remote_state.bootstrap
  values = {
    outputs = {
      contract_project_id                     = "example-project"
      contract_region                         = "us-west1"
      contract_deployer_service_account_email = "delivery-deployer@example-project.iam.gserviceaccount.com"
      contract_runtime_service_account_emails = {
        "platform-api"   = "platform-api-runtime@example-project.iam.gserviceaccount.com"
        "web"            = "web-runtime@example-project.iam.gserviceaccount.com"
        "engine-restore" = "engine-restore-runtime@example-project.iam.gserviceaccount.com"
      }
    }
  }
}

variables {
  bootstrap_state_bucket = "example-bootstrap-state"
  project_number         = "123456789012"
  # Deliberately not billing-account-shaped: `tools/infra-policy.test.mjs` refuses
  # a committed literal that looks like a real billing account id.
  billing_account_id           = "example-billing-account"
  budget_alert_email_addresses = ["alerts@example.test"]
}

run "no_staging_bucket_exists_until_the_reviewed_gate_is_on" {
  command = plan

  # Default state. A routine plan of this stack is unaffected by #241 until the
  # maintainer turns the restore prerequisites on.
  assert {
    condition     = length(google_storage_bucket.engine_restore_stage) == 0
    error_message = "The staging bucket must not exist by default; it is one milestone's staging area, declared when that milestone needs it."
  }

  assert {
    condition     = length(google_storage_bucket_iam_member.engine_restore_stage_object_user) == 0
    error_message = "No object grant may exist without the bucket it is bound to."
  }
}

run "the_gate_alone_creates_nothing_without_a_bucket_name" {
  command = plan

  variables {
    engine_restore_secrets_enabled = true
    engine_restore_stage_bucket    = null
  }

  # The name is account data supplied at apply. Turning the gate on without one
  # declares no bucket rather than inventing a name.
  assert {
    condition     = length(google_storage_bucket.engine_restore_stage) == 0
    error_message = "A bucket name is supplied at apply; with none, nothing is declared."
  }
}

run "the_staging_bucket_is_private_versioned_and_bounded" {
  command = plan

  variables {
    engine_restore_secrets_enabled = true
    engine_restore_stage_bucket    = "example-engine-restore-stage"
  }

  assert {
    condition = (
      google_storage_bucket.engine_restore_stage[0].name == "example-engine-restore-stage" &&
      google_storage_bucket.engine_restore_stage[0].location == "us-west1"
    )
    error_message = "The bucket must be the one named at apply, in the stack's own region."
  }

  # Private on the same terms as state: the staged inputs are a copy of the
  # platform's own authoritative records.
  assert {
    condition = (
      google_storage_bucket.engine_restore_stage[0].uniform_bucket_level_access == true &&
      google_storage_bucket.engine_restore_stage[0].public_access_prevention == "enforced"
    )
    error_message = "The staging bucket must enforce uniform access and public-access prevention."
  }

  assert {
    condition     = google_storage_bucket.engine_restore_stage[0].versioning[0].enabled == true
    error_message = "Versioning must be on from the first apply: a re-upload must not silently replace a copy an execution verified against."
  }

  # A staging area is not an archive. Without a deletion age a 1.4 GB copy becomes
  # a second archive nobody decided to keep, which ADR-0013 §2 does not admit.
  assert {
    condition = (
      length(google_storage_bucket.engine_restore_stage[0].lifecycle_rule) == 1 &&
      google_storage_bucket.engine_restore_stage[0].lifecycle_rule[0].action[0].type == "Delete" &&
      google_storage_bucket.engine_restore_stage[0].lifecycle_rule[0].condition[0].age ==
      var.engine_restore_stage_retention_days
    )
    error_message = "The staging bucket must delete staged objects at the declared age."
  }

  assert {
    condition     = google_storage_bucket.engine_restore_stage[0].force_destroy == false
    error_message = "Removing the bucket must stay a reviewed code change."
  }
}

run "exactly_the_restore_identity_may_read_and_append" {
  command = plan

  variables {
    engine_restore_secrets_enabled = true
    engine_restore_stage_bucket    = "example-engine-restore-stage"
  }

  # Bound to this bucket, not at project level, and to the job's own identity
  # resolved through the bootstrap contract rather than an address written here.
  assert {
    condition = (
      length(google_storage_bucket_iam_member.engine_restore_stage_object_user) == 1 &&
      google_storage_bucket_iam_member.engine_restore_stage_object_user[0].bucket ==
      "example-engine-restore-stage" &&
      google_storage_bucket_iam_member.engine_restore_stage_object_user[0].member ==
      "serviceAccount:engine-restore-runtime@example-project.iam.gserviceaccount.com"
    )
    error_message = "The grant must bind the restore job's own identity to this bucket alone."
  }

  # `objectUser` reads and creates. It carries no `storage.objects.delete`, so an
  # execution cannot remove a staged input or a previous evidence document, and it
  # is not an admin role.
  assert {
    condition = (
      google_storage_bucket_iam_member.engine_restore_stage_object_user[0].role ==
      "roles/storage.objectUser"
    )
    error_message = "The grant must be objectUser: read and create, never delete and never admin."
  }

  # The web, the API and the deployer have no business here. The maintainer is
  # granted nothing either: they upload with their own account.
  assert {
    condition = !contains([
      "serviceAccount:web-runtime@example-project.iam.gserviceaccount.com",
      "serviceAccount:platform-api-runtime@example-project.iam.gserviceaccount.com",
      "serviceAccount:delivery-deployer@example-project.iam.gserviceaccount.com",
    ], google_storage_bucket_iam_member.engine_restore_stage_object_user[0].member)
    error_message = "Only the restore job's identity may read the staged inputs."
  }
}

run "a_bucket_name_that_is_not_a_bucket_name_is_refused" {
  command = plan

  variables {
    engine_restore_secrets_enabled = true
    engine_restore_stage_bucket    = "Not A Bucket Name"
  }

  expect_failures = [var.engine_restore_stage_bucket]
}

run "a_staging_bucket_with_no_deletion_age_is_refused" {
  command = plan

  variables {
    engine_restore_secrets_enabled      = true
    engine_restore_stage_bucket         = "example-engine-restore-stage"
    engine_restore_stage_retention_days = 0
  }

  expect_failures = [var.engine_restore_stage_retention_days]
}
