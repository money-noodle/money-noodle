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
