# The access boundary this module declares around the containers it creates.
#
# Synthetic desired configuration only; no provider is reached and no secret value
# exists anywhere in this file, because the module cannot accept one (ADR-0005).
mock_provider "google" {}

variables {
  project_id = "example-project"
  region     = "us-west1"

  secrets = {
    "example-secret" = {
      owner                  = "maintainer"
      consuming_principal    = "example runtime service account"
      rotation_interval_days = 90
      revocation_procedure   = "Revoke at the provider, then add a new version."
      recovery_path          = "Recreate at the provider and add a new version."
    }
  }
}

run "a_container_with_no_declared_consumer_is_readable_by_nobody" {
  command = plan

  assert {
    condition     = length(google_secret_manager_secret_iam_member.accessor) == 0
    error_message = "A store asked for no accessor must create no access binding at all."
  }
}

# A provider label accepts only lower-case letters, digits, hyphen and underscore,
# which a mocked provider never checks: the first real apply was refused for the
# space in a custody phrase (#221). The consuming principal above is prose with
# spaces on purpose, so this fails if custody text ever returns to a label.
run "custody_prose_is_an_annotation_and_every_label_is_label_safe" {
  command = plan

  assert {
    condition = alltrue([
      for value in values(google_secret_manager_secret.secret["example-secret"].labels) :
      can(regex("^[a-z0-9_-]{0,63}$", value))
    ])
    error_message = "Every label value must satisfy the provider's label character rule; free-text custody facts belong in annotations."
  }

  assert {
    condition     = google_secret_manager_secret.secret["example-secret"].annotations["consuming-principal"] == "example runtime service account"
    error_message = "The consuming principal is recorded beside the secret as an annotation (ADR-0005)."
  }

  assert {
    condition     = google_secret_manager_secret.secret["example-secret"].annotations["owner"] == "maintainer"
    error_message = "The owner is recorded beside the secret as an annotation (ADR-0005)."
  }
}

run "a_declared_consumer_is_granted_accessor_on_exactly_that_secret" {
  command = plan

  variables {
    accessor_members = {
      "example-secret" = ["serviceAccount:example-runtime@example-project.iam.gserviceaccount.com"]
    }
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.accessor) == 1
    error_message = "One consumer on one secret is one binding."
  }

  # Per secret, never project-level, and the accessor role rather than a role that
  # could also add a version or change the policy.
  assert {
    condition = alltrue([
      for grant in values(google_secret_manager_secret_iam_member.accessor) :
      grant.role == "roles/secretmanager.secretAccessor" && grant.secret_id == "example-secret"
    ])
    error_message = "The grant is `secretAccessor` on the named secret; anything broader would let a workload manage custody rather than read a value."
  }
}

run "two_consumers_on_one_secret_are_two_addressable_bindings" {
  command = plan

  variables {
    accessor_members = {
      "example-secret" = [
        "serviceAccount:example-runtime@example-project.iam.gserviceaccount.com",
        "serviceAccount:other-runtime@example-project.iam.gserviceaccount.com",
      ]
    }
  }

  # Flattened per member, so removing one consumer removes one resource rather than
  # rewriting a list in place.
  assert {
    condition     = length(google_secret_manager_secret_iam_member.accessor) == 2
    error_message = "Each consumer is its own binding."
  }
}

run "an_accessor_on_a_secret_this_store_does_not_declare_is_refused" {
  command = plan

  variables {
    accessor_members = {
      "a-secret-nobody-declared" = ["serviceAccount:example-runtime@example-project.iam.gserviceaccount.com"]
    }
  }

  expect_failures = [var.accessor_members]
}

# A runtime credential must not become readable by something that is not a
# workload. These are refused by shape rather than reviewed case by case.
run "a_human_group_domain_or_public_member_is_refused" {
  command = plan

  variables {
    accessor_members = {
      "example-secret" = ["user:someone@example.test"]
    }
  }

  expect_failures = [var.accessor_members]
}

run "a_public_wildcard_member_is_refused" {
  command = plan

  variables {
    accessor_members = {
      "example-secret" = ["allAuthenticatedUsers"]
    }
  }

  expect_failures = [var.accessor_members]
}

run "a_repeated_consumer_is_refused" {
  command = plan

  variables {
    accessor_members = {
      "example-secret" = [
        "serviceAccount:example-runtime@example-project.iam.gserviceaccount.com",
        "serviceAccount:example-runtime@example-project.iam.gserviceaccount.com",
      ]
    }
  }

  expect_failures = [var.accessor_members]
}

# Metadata read: the grant that lets an identity plan these resources without being
# able to read what they hold (#224).
run "a_store_asked_for_no_metadata_reader_creates_no_reader_binding" {
  command = plan

  assert {
    condition     = length(google_secret_manager_secret_iam_member.metadata_reader) == 0
    error_message = "A store with no declared plan-only identity must create no reader binding."
  }
}

run "a_metadata_reader_receives_viewer_on_exactly_that_secret" {
  command = plan

  variables {
    metadata_reader_members = {
      "example-secret" = ["serviceAccount:example-deployer@example-project.iam.gserviceaccount.com"]
    }
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.metadata_reader) == 1
    error_message = "One reader on one secret is one binding."
  }

  # The role is the narrowest predefined one that can refresh both the container and
  # an IAM member on it. Asserted literally: this is the line that decides what a
  # plan-only identity can do, and it must never drift to a role that reads values.
  assert {
    condition = alltrue([
      for grant in values(google_secret_manager_secret_iam_member.metadata_reader) :
      grant.role == "roles/secretmanager.viewer" && grant.secret_id == "example-secret"
    ])
    error_message = "A metadata reader holds `roles/secretmanager.viewer` on the named secret and nothing else."
  }

  # Stated as a refusal as well, because these are the two roles a convenience edit
  # would reach for, and either would turn a plan-only identity into a reader of the
  # value or an owner of the custody boundary.
  assert {
    condition = alltrue([
      for grant in values(google_secret_manager_secret_iam_member.metadata_reader) :
      grant.role != "roles/secretmanager.secretAccessor" && grant.role != "roles/secretmanager.admin"
    ])
    error_message = "A metadata reader must never receive secretAccessor or admin; metadata read is the whole point of the separate list."
  }
}

run "metadata_readers_and_accessors_are_separate_bindings" {
  command = plan

  variables {
    accessor_members = {
      "example-secret" = ["serviceAccount:example-runtime@example-project.iam.gserviceaccount.com"]
    }
    metadata_reader_members = {
      "example-secret" = ["serviceAccount:example-deployer@example-project.iam.gserviceaccount.com"]
    }
  }

  # Two members, two roles, two addresses. The consumer of the value and the
  # identity that merely plans it are never the same binding.
  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.accessor) == 1 &&
      length(google_secret_manager_secret_iam_member.metadata_reader) == 1
    )
    error_message = "An accessor and a metadata reader are distinct bindings on the same container."
  }

  assert {
    condition = alltrue([
      for grant in values(google_secret_manager_secret_iam_member.metadata_reader) :
      !contains(
        [for accessor in values(google_secret_manager_secret_iam_member.accessor) : accessor.member],
        grant.member
      )
    ])
    error_message = "An identity granted metadata read must not also appear as an accessor; that would make the separation cosmetic."
  }
}

run "a_metadata_reader_on_an_undeclared_secret_is_refused" {
  command = plan

  variables {
    metadata_reader_members = {
      "a-secret-nobody-declared" = ["serviceAccount:example-deployer@example-project.iam.gserviceaccount.com"]
    }
  }

  expect_failures = [var.metadata_reader_members]
}

run "a_human_or_public_metadata_reader_is_refused" {
  command = plan

  variables {
    metadata_reader_members = {
      "example-secret" = ["user:someone@example.test"]
    }
  }

  expect_failures = [var.metadata_reader_members]
}

run "a_repeated_metadata_reader_is_refused" {
  command = plan

  variables {
    metadata_reader_members = {
      "example-secret" = [
        "serviceAccount:example-deployer@example-project.iam.gserviceaccount.com",
        "serviceAccount:example-deployer@example-project.iam.gserviceaccount.com",
      ]
    }
  }

  expect_failures = [var.metadata_reader_members]
}
