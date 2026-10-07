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

run "bootstrap_creates_one_runtime_identity_per_deployable_unit" {
  command = plan

  # The exact set, by name: two services and, since #241, the one-time restore
  # job (ADR-0013 §1). Asserted as an exact set rather than a count, because an
  # identity appearing here is authority nobody asked for unless this line
  # changed with it.
  assert {
    condition = toset(keys(google_service_account.runtime)) == toset([
      "engine-restore",
      "platform-api",
      "web",
    ])
    error_message = "Bootstrap must create a runtime identity for each deployable service and each declared job, keyed by the name that unit's stack pins."
  }

  assert {
    condition = (
      google_service_account.runtime["platform-api"].account_id == "platform-api-runtime" &&
      google_service_account.runtime["web"].account_id == "web-runtime" &&
      google_service_account.runtime["engine-restore"].account_id == "engine-restore-runtime"
    )
    error_message = "The runtime account ids must stay the ones the stacks already use, so bootstrap adopts rather than renames them. ADR-0013 §1 names engine-restore-runtime."
  }

  # Distinct across every identity, not just the two services: a shared one makes
  # blast radius conventional rather than mechanical (ADR-0005).
  assert {
    condition = (
      length(distinct([for account in google_service_account.runtime : account.account_id])) ==
      length(google_service_account.runtime)
    )
    error_message = "Every runtime identity must be mechanically distinct from every other."
  }

  # The job identity is a job identity. Wording, but wording a maintainer reads in
  # the plan before approving it.
  assert {
    condition = (
      strcontains(google_service_account.runtime["engine-restore"].description, "Cloud Run job") &&
      strcontains(google_service_account.runtime["web"].description, "Cloud Run service")
    )
    error_message = "Each identity's description must name the kind of unit it runs."
  }
}

run "a_declared_job_name_must_name_an_identity_this_stack_creates" {
  command = plan

  variables {
    runtime_job_names = ["engine-cycle"]
  }

  expect_failures = [var.runtime_job_names]
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

run "a_job_cannot_share_a_service_runtime_identity" {
  command = plan

  variables {
    runtime_service_accounts = {
      "platform-api"   = "platform-api-runtime"
      "web"            = "web-runtime"
      "engine-restore" = "platform-api-runtime"
    }
  }

  expect_failures = [var.runtime_service_accounts]
}

run "two_services_cannot_share_one_runtime_identity" {
  command = plan

  variables {
    runtime_service_accounts = {
      "platform-api" = "shared-runtime"
      "web"          = "shared-runtime"
    }
    # Emptied with the map, because the default names a job this override removes
    # and that validation would otherwise fail alongside the one under test.
    runtime_job_names = []
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
