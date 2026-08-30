# Federation wiring.
#
# `delivery-trust` owns and tests the policy itself. These tests prove the policy
# actually reaches the provider resource, and that the two gates are configured
# the way ADR-0005 describes: the condition decides whether a token is
# exchangeable at all, and the principal set decides what it may then impersonate.

mock_provider "google" {}

variables {
  project_id                  = "example-project"
  deployer_service_account_id = "projects/example-project/serviceAccounts/delivery-deployer@example-project.iam.gserviceaccount.com"
  allowed_audiences           = ["money-noodle-delivery"]
  repository_owner            = "example-owner"
  repository_name             = "example-repo"
  repository_id               = "111111111"
  repository_owner_id         = "222222222"
  allowed_refs                = ["refs/heads/v2"]
  allowed_workflow_paths      = [".github/workflows/delivery.yml"]
}

run "the_trust_conjunction_reaches_the_provider" {
  command = plan

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == output.attribute_condition
    error_message = "The provider must enforce the reviewed condition, not a separately maintained copy of it."
  }

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.repository_id == \"111111111\"")
    error_message = "The immutable repository id must be part of the enforced condition."
  }

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.job_workflow_ref in")
    error_message = "The authorised workflow set must be part of the enforced condition."
  }
}

run "only_github_may_issue_tokens_and_only_for_our_audience" {
  command = plan

  assert {
    condition = one([
      for config in google_iam_workload_identity_pool_provider.github.oidc : config.issuer_uri
    ]) == "https://token.actions.githubusercontent.com"
    error_message = "The issuer must be GitHub's OIDC issuer."
  }

  assert {
    condition = one([
      for config in google_iam_workload_identity_pool_provider.github.oidc :
      one(config.allowed_audiences)
    ]) == "money-noodle-delivery"
    error_message = "An unconstrained audience would accept a token minted for an unrelated purpose."
  }
}

run "impersonation_is_bound_to_the_exact_repository" {
  command = plan

  assert {
    condition     = google_service_account_iam_member.deployer_impersonation.role == "roles/iam.workloadIdentityUser"
    error_message = "Federation grants impersonation of the deployer, and nothing broader."
  }

  assert {
    condition     = strcontains(google_service_account_iam_member.deployer_impersonation.member, "attribute.repository/example-owner/example-repo")
    error_message = "The principal set must name the exact repository."
  }

  assert {
    condition     = !strcontains(google_service_account_iam_member.deployer_impersonation.member, "*")
    error_message = "A wildcard principal set would let any repository in the pool impersonate the deployer."
  }
}
