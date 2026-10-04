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
