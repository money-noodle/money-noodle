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
      "engine-cycle",
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
      google_service_account.runtime["engine-restore"].account_id == "engine-restore-runtime" &&
      google_service_account.runtime["engine-cycle"].account_id == "engine-cycle-runtime"
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
    # A later child's job (#245), which this stack does not create an identity
    # for. It used to be `engine-cycle`; #243 made that one real, which is
    # exactly the drift this run exists to catch.
    runtime_job_names = ["engine-observer"]
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

run "the_staging_bucket_grants_are_bound_here_and_stay_narrow" {
  command = plan

  # Both grants on the restore job's staging area are declared in this stack:
  # setting bucket IAM needs `storage.buckets.setIamPolicy`, which the deployer
  # does not hold, and a bucket IAM resource in a stack the pipeline plans would
  # need `storage.buckets.getIamPolicy` to refresh (#241 follow-up, ADR-0005).
  assert {
    condition = (
      length(google_storage_bucket_iam_member.engine_restore_stage_object_user) == 1 &&
      length(google_storage_bucket_iam_member.engine_restore_stage_plan_reader) == 1
    )
    error_message = "Both staging-bucket grants must be declared here while the one-time restore job exists."
  }

  # One bucket, named by the same convention as the state buckets and derived
  # from the prefix rather than written down. Neither grant may land on state.
  assert {
    condition = (
      google_storage_bucket_iam_member.engine_restore_stage_object_user[0].bucket ==
      "${var.state_bucket_prefix}-engine-restore-stage" &&
      google_storage_bucket_iam_member.engine_restore_stage_plan_reader[0].bucket ==
      "${var.state_bucket_prefix}-engine-restore-stage"
    )
    error_message = "Both grants must bind the staging bucket alone, by the published naming convention."
  }

  assert {
    condition = !contains([
      "${var.state_bucket_prefix}-bootstrap",
      "${var.state_bucket_prefix}-platform",
      "${var.state_bucket_prefix}-api",
      "${var.state_bucket_prefix}-web",
      "${var.state_bucket_prefix}-engine-jobs",
    ], google_storage_bucket_iam_member.engine_restore_stage_plan_reader[0].bucket)
    error_message = "The staging bucket is not a state bucket; a grant that landed on one would widen state access."
  }

  # `objectUser` reads and creates. It carries no `storage.objects.delete`, so an
  # execution cannot remove a staged input or a previous evidence document.
  assert {
    condition = (
      google_storage_bucket_iam_member.engine_restore_stage_object_user[0].role ==
      "roles/storage.objectUser"
    )
    error_message = "The job's grant must be objectUser: read and create, never delete and never admin."
  }

  # The narrowest predefined role that lets OpenTofu refresh the bucket the
  # platform stack declares: `storage.buckets.get` and `storage.buckets.list`,
  # no `storage.objects.*` of any kind, and no IAM permission.
  assert {
    condition = (
      google_storage_bucket_iam_member.engine_restore_stage_plan_reader[0].role ==
      "roles/storage.bucketViewer"
    )
    error_message = "The deployer's grant must be bucketViewer: enough to refresh the bucket, never enough to read what is staged in it."
  }

  # The pipeline may see that the bucket exists. It may not read, write or list
  # the staged copy of the platform's own records, and it may not change who can.
  assert {
    condition = !contains([
      "roles/storage.objectUser",
      "roles/storage.objectViewer",
      "roles/storage.objectCreator",
      "roles/storage.objectAdmin",
      "roles/storage.legacyBucketOwner",
      "roles/storage.legacyObjectReader",
      "roles/storage.admin",
    ], google_storage_bucket_iam_member.engine_restore_stage_plan_reader[0].role)
    error_message = "The deployer must hold no object access and no bucket-IAM authority on the staging bucket."
  }

  assert {
    condition = !contains([
      "roles/storage.objectAdmin",
      "roles/storage.legacyBucketOwner",
      "roles/storage.admin",
    ], google_storage_bucket_iam_member.engine_restore_stage_object_user[0].role)
    error_message = "The restore identity must hold no administrative or bucket-IAM role on the staging bucket."
  }
}

run "the_staging_bucket_grants_come_back_out_with_the_job" {
  command = plan

  variables {
    engine_restore_stage_grants_enabled = false
  }

  # Retiring the one-time job retires its access, in one reviewed change.
  assert {
    condition = (
      length(google_storage_bucket_iam_member.engine_restore_stage_object_user) == 0 &&
      length(google_storage_bucket_iam_member.engine_restore_stage_plan_reader) == 0
    )
    error_message = "With the gate off this stack must declare no grant on the staging bucket."
  }
}

run "a_trigger_identity_starts_one_job_and_runs_nothing" {
  command = plan

  # The identity Cloud Scheduler presents to start a scheduled job. A different
  # principal from the one the execution runs as: a runtime identity holds
  # `run.invoker` nowhere, which is what stops a workload from starting a
  # workload, and that stays true because this is not one (ADR-0013 §1, #243).
  assert {
    condition     = toset(keys(google_service_account.trigger)) == toset(["engine-cycle"])
    error_message = "Bootstrap must create a trigger identity for each scheduled job and no others."
  }

  assert {
    condition     = google_service_account.trigger["engine-cycle"].account_id == "engine-cycle-scheduler"
    error_message = "The cycle job's trigger identity is engine-cycle-scheduler."
  }

  # Distinct from every runtime identity, mechanically, not by convention.
  assert {
    condition = length(setintersection(
      toset([for account in google_service_account.trigger : account.account_id]),
      toset([for account in google_service_account.runtime : account.account_id]),
    )) == 0
    error_message = "A trigger identity must not also be a runtime identity."
  }

  # It receives no project role at all: the telemetry grants are keyed by runtime
  # identity, and a trigger writes no telemetry.
  assert {
    condition = alltrue([
      for grant in google_project_iam_member.runtime_telemetry :
      !strcontains(grant.member, "engine-cycle-scheduler")
    ])
    error_message = "A trigger identity must hold no project role, including a telemetry one."
  }

  assert {
    condition     = strcontains(google_service_account.trigger["engine-cycle"].description, "no project role")
    error_message = "The identity's own description must say what it does not hold."
  }
}

run "a_trigger_for_a_job_this_stack_does_not_create_is_refused" {
  command = plan

  variables {
    trigger_service_accounts = {
      "engine-observer" = "engine-observer-scheduler"
    }
  }

  expect_failures = [var.trigger_service_accounts]
}

run "a_trigger_identity_cannot_be_a_runtime_identity" {
  command = plan

  variables {
    trigger_service_accounts = {
      "engine-cycle" = "engine-cycle-runtime"
    }
  }

  expect_failures = [var.trigger_service_accounts]
}
