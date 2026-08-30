mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/example-project/serviceAccounts/delivery-deployer@example-project.iam.gserviceaccount.com"
      email = "delivery-deployer@example-project.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id          = "example-project"
  state_bucket_prefix = "money-noodle-test-state"
  repository_id       = "123456789"
  repository_owner_id = "987654321"
  billing_account_id  = join("-", ["ABCDEF", "123456", "FEDCBA"])
}

run "defaults_are_valid_and_budget_authority_is_narrow" {
  command = plan

  assert {
    condition     = length(var.allowed_refs) == 1 && one(var.allowed_refs) == "refs/heads/main"
    error_message = "Bootstrap must grant delivery authority only to protected main."
  }

  assert {
    condition = (
      length(var.allowed_workflow_paths) == 1 &&
      one(var.allowed_workflow_paths) == ".github/workflows/delivery.yml"
    )
    error_message = "Bootstrap must grant delivery authority only to the delivery workflow."
  }

  assert {
    condition = (
      length(var.allowed_event_names) == 3 &&
      toset(var.allowed_event_names) == toset(["push", "workflow_dispatch", "schedule"])
    )
    error_message = "Bootstrap must permit only push, dispatch, and exact-workflow scheduled drift."
  }

  assert {
    condition = alltrue([
      for role in var.deployer_roles : !contains([
        "roles/owner",
        "roles/editor",
        "roles/iam.securityAdmin",
        "roles/resourcemanager.projectIamAdmin",
        "roles/secretmanager.admin",
        "roles/secretmanager.secretAccessor",
      ], role)
    ])
    error_message = "Bootstrap defaults must not grant broad, IAM-administrative, or secret self-escalation roles."
  }

  assert {
    condition     = google_billing_account_iam_member.deployer_budget_manager.role == "roles/billing.costsManager"
    error_message = "The deployer needs only billing cost/budget management on the billing account."
  }
}

run "secret_manager_administration_is_rejected" {
  command = plan

  variables {
    deployer_roles = ["roles/secretmanager.admin"]
  }

  expect_failures = [var.deployer_roles]
}

run "owner_is_rejected" {
  command = plan

  variables {
    deployer_roles = ["roles/owner"]
  }

  expect_failures = [var.deployer_roles]
}

run "the_deleted_v2_ref_cannot_be_bootstrapped" {
  command = plan

  variables {
    allowed_refs = ["refs/heads/v2"]
  }

  expect_failures = [var.allowed_refs]
}

run "additional_refs_cannot_be_bootstrapped" {
  command = plan

  variables {
    allowed_refs = ["refs/heads/main", "refs/heads/release"]
  }

  expect_failures = [var.allowed_refs]
}

run "another_workflow_cannot_be_bootstrapped" {
  command = plan

  variables {
    allowed_workflow_paths = [".github/workflows/ci.yml"]
  }

  expect_failures = [var.allowed_workflow_paths]
}

run "additional_workflows_cannot_be_bootstrapped" {
  command = plan

  variables {
    allowed_workflow_paths = [".github/workflows/delivery.yml", ".github/workflows/ci.yml"]
  }

  expect_failures = [var.allowed_workflow_paths]
}

run "additional_events_cannot_be_bootstrapped" {
  command = plan

  variables {
    allowed_event_names = ["push", "workflow_dispatch", "schedule", "repository_dispatch"]
  }

  expect_failures = [var.allowed_event_names]
}
