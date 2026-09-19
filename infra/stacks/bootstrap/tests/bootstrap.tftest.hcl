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
    condition     = var.repository_owner == "money-noodle" && var.repository_name == "money-noodle"
    error_message = "Bootstrap must target the current organization-owned source repository."
  }

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
    condition     = contains(var.deployer_roles, "roles/artifactregistry.admin")
    error_message = "The deployer must be able to create the platform image repository and set its IAM; writer alone fails the first platform apply."
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

# ---------------------------------------------------------------------------
# Runtime identities (#178).
#
# These moved here from `modules/cloud-run-service` so that a service apply
# needs no identity administration and no project IAM. The mocked provider gives
# every service account the same email, so distinctness is asserted on the
# declared account id, which is the value that actually decides the identity.
# ---------------------------------------------------------------------------

run "bootstrap_creates_one_runtime_identity_per_service" {
  command = plan

  assert {
    condition     = toset(keys(google_service_account.runtime)) == toset(["platform-api", "web"])
    error_message = "Bootstrap must create a runtime identity for each deployable service, keyed by its Cloud Run service name."
  }

  assert {
    condition = (
      google_service_account.runtime["platform-api"].account_id == "platform-api-runtime" &&
      google_service_account.runtime["web"].account_id == "web-runtime"
    )
    error_message = "The runtime account ids must stay the ones the service stacks already use, so bootstrap adopts rather than renames them."
  }

  assert {
    condition = (
      google_service_account.runtime["platform-api"].account_id !=
      google_service_account.runtime["web"].account_id
    )
    error_message = "The web and API runtime identities must be mechanically distinct; a shared one makes blast radius conventional (ADR-0005)."
  }
}

run "each_runtime_identity_holds_only_telemetry_write_authority" {
  command = plan

  assert {
    condition = alltrue([
      for role in [
        "roles/cloudtrace.agent",
        "roles/logging.logWriter",
        "roles/monitoring.metricWriter",
        "roles/serviceusage.serviceUsageConsumer",
        "roles/telemetry.writer",
      ] : contains(var.runtime_telemetry_roles, role)
    ])
    error_message = "Each runtime identity must hold exactly the telemetry write roles the Telemetry API documents."
  }

  # One grant per service per role, and nothing else at project level.
  assert {
    condition = (
      length(google_project_iam_member.runtime_telemetry) ==
      length(var.runtime_service_accounts) * length(var.runtime_telemetry_roles)
    )
    error_message = "Every runtime identity must receive every declared telemetry role, and no other project grant."
  }

  # Writing telemetry is not reading anything and not deploying anything.
  assert {
    condition = length([
      for grant in google_project_iam_member.runtime_telemetry : grant.role
      if !startswith(grant.role, "roles/cloudtrace.") && !startswith(grant.role, "roles/logging.") && !startswith(grant.role, "roles/monitoring.") && !startswith(grant.role, "roles/serviceusage.") && !startswith(grant.role, "roles/telemetry.")
    ]) == 0
    error_message = "A runtime identity must hold no project authority beyond telemetry write and its quota consumer role."
  }
}

run "a_runtime_identity_cannot_be_granted_an_administrative_role" {
  command = plan

  variables {
    runtime_telemetry_roles = ["roles/logging.admin"]
  }

  expect_failures = [var.runtime_telemetry_roles]
}

run "a_runtime_identity_cannot_be_granted_deployment_authority" {
  command = plan

  variables {
    runtime_telemetry_roles = ["roles/run.admin"]
  }

  expect_failures = [var.runtime_telemetry_roles]
}

run "two_services_cannot_share_one_runtime_identity" {
  command = plan

  variables {
    runtime_service_accounts = {
      "platform-api" = "shared-runtime"
      "web"          = "shared-runtime"
    }
  }

  expect_failures = [var.runtime_service_accounts]
}

run "the_deployer_needs_cloud_run_administration_and_no_identity_authority" {
  command = plan

  # `run.developer` cannot set a service-level invoker binding, and a private
  # service needs one for the web and for the post-apply verifier. `run.admin` is
  # confined to Cloud Run: it grants no project IAM and no identity
  # administration (#178).
  assert {
    condition     = contains(var.deployer_roles, "roles/run.admin")
    error_message = "The deployer must be able to set service-level run.invoker bindings on the services it deploys."
  }

  assert {
    condition     = !contains(var.deployer_roles, "roles/run.developer")
    error_message = "run.developer cannot set a service-level invoker binding; the first private apply fails on it."
  }

  # It still acts as the runtime identities rather than administering them.
  assert {
    condition     = contains(var.deployer_roles, "roles/iam.serviceAccountUser")
    error_message = "The deployer must keep the authority to act as the runtime identities it deploys."
  }

  assert {
    condition = alltrue([
      for role in var.deployer_roles : !contains([
        "roles/owner",
        "roles/editor",
        "roles/resourcemanager.projectIamAdmin",
        "roles/iam.securityAdmin",
        "roles/iam.serviceAccountAdmin",
        "roles/iam.serviceAccountCreator",
        "roles/iam.serviceAccountKeyAdmin",
        "roles/secretmanager.admin",
        "roles/secretmanager.secretAccessor",
        "roles/secretmanager.viewer",
      ], role)
    ])
    error_message = "The deployer must hold no owner, editor, project-IAM, service-account-administration or Secret Manager role (ADR-0005)."
  }
}
