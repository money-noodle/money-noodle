# Offline negative tests for the delivery trust condition.
#
# ADR-0005: "A token minted for a fork, a pull request from an untrusted source,
# another workflow, or another repository must not be exchangeable for deployment
# authority." A test proving the pipeline *can* deploy proves nothing about who
# else can, so every case below except the first is a denial.
#
# These values are deliberately fictional. Real identifiers are supplied at
# bootstrap and are never committed.

variables {
  repository_owner       = "example-owner"
  repository_name        = "example-repo"
  repository_id          = "111111111"
  repository_owner_id    = "222222222"
  allowed_refs           = ["refs/heads/v2"]
  allowed_workflow_paths = [".github/workflows/delivery.yml"]
  allowed_event_names    = ["push", "workflow_dispatch"]

  candidate_subjects = [
    {
      name                = "authorised-delivery-run"
      repository          = "example-owner/example-repo"
      repository_id       = "111111111"
      repository_owner_id = "222222222"
      ref                 = "refs/heads/v2"
      ref_type            = "branch"
      job_workflow_ref    = "example-owner/example-repo/.github/workflows/delivery.yml@refs/heads/v2"
      event_name          = "push"
    },
    {
      # A different repository under the same owner. Sharing an organisation is
      # not sharing delivery authority.
      name                = "sibling-repository"
      repository          = "example-owner/other-repo"
      repository_id       = "999999999"
      repository_owner_id = "222222222"
      ref                 = "refs/heads/v2"
      ref_type            = "branch"
      job_workflow_ref    = "example-owner/other-repo/.github/workflows/delivery.yml@refs/heads/v2"
      event_name          = "push"
    },
    {
      # A fork. The claim set is internally consistent and completely valid — it
      # is simply somebody else's.
      name                = "fork-under-another-owner"
      repository          = "attacker/example-repo"
      repository_id       = "888888888"
      repository_owner_id = "777777777"
      ref                 = "refs/heads/v2"
      ref_type            = "branch"
      job_workflow_ref    = "attacker/example-repo/.github/workflows/delivery.yml@refs/heads/v2"
      event_name          = "push"
    },
    {
      # The repository is deleted and the `owner/name` path is re-registered by
      # someone else. Every string claim matches; only the immutable numeric id
      # betrays it. This is why the numeric ids are in the conjunction.
      name                = "reclaimed-repository-name"
      repository          = "example-owner/example-repo"
      repository_id       = "555555555"
      repository_owner_id = "222222222"
      ref                 = "refs/heads/v2"
      ref_type            = "branch"
      job_workflow_ref    = "example-owner/example-repo/.github/workflows/delivery.yml@refs/heads/v2"
      event_name          = "push"
    },
    {
      # An unauthorised branch in the authorised repository.
      name                = "unauthorised-branch"
      repository          = "example-owner/example-repo"
      repository_id       = "111111111"
      repository_owner_id = "222222222"
      ref                 = "refs/heads/feature-branch"
      ref_type            = "branch"
      job_workflow_ref    = "example-owner/example-repo/.github/workflows/delivery.yml@refs/heads/feature-branch"
      event_name          = "push"
    },
    {
      # A tag. Tags are not deployable refs, and anyone able to push a tag would
      # otherwise inherit whatever the branch allowlist grants.
      name                = "tag-ref"
      repository          = "example-owner/example-repo"
      repository_id       = "111111111"
      repository_owner_id = "222222222"
      ref                 = "refs/tags/v1.0.0"
      ref_type            = "tag"
      job_workflow_ref    = "example-owner/example-repo/.github/workflows/delivery.yml@refs/tags/v1.0.0"
      event_name          = "push"
    },
    {
      # A pull request run. The merge ref and the event name are both refused,
      # which is what keeps an untrusted contributor's workflow change inert.
      name                = "pull-request-run"
      repository          = "example-owner/example-repo"
      repository_id       = "111111111"
      repository_owner_id = "222222222"
      ref                 = "refs/pull/42/merge"
      ref_type            = "branch"
      job_workflow_ref    = "example-owner/example-repo/.github/workflows/delivery.yml@refs/pull/42/merge"
      event_name          = "pull_request"
    },
    {
      # The right repository and the right branch, but a workflow that was never
      # granted delivery authority. Editing or adding a workflow must not be a
      # route to a deployment credential.
      name                = "unauthorised-workflow"
      repository          = "example-owner/example-repo"
      repository_id       = "111111111"
      repository_owner_id = "222222222"
      ref                 = "refs/heads/v2"
      ref_type            = "branch"
      job_workflow_ref    = "example-owner/example-repo/.github/workflows/ci.yml@refs/heads/v2"
      event_name          = "push"
    },
    {
      # A reusable workflow called from the authorised repository but defined
      # elsewhere. `job_workflow_ref` names where the job is *defined*, so this is
      # refused even though the caller is authorised.
      name                = "external-reusable-workflow"
      repository          = "example-owner/example-repo"
      repository_id       = "111111111"
      repository_owner_id = "222222222"
      ref                 = "refs/heads/v2"
      ref_type            = "branch"
      job_workflow_ref    = "third-party/actions/.github/workflows/deploy.yml@refs/heads/main"
      event_name          = "push"
    },
    {
      # A scheduled run. Drift detection reads; it does not deploy.
      name                = "scheduled-run"
      repository          = "example-owner/example-repo"
      repository_id       = "111111111"
      repository_owner_id = "222222222"
      ref                 = "refs/heads/v2"
      ref_type            = "branch"
      job_workflow_ref    = "example-owner/example-repo/.github/workflows/delivery.yml@refs/heads/v2"
      event_name          = "schedule"
    },
  ]
}

run "authorised_subject_is_accepted" {
  command = plan

  assert {
    condition     = output.evaluations["authorised-delivery-run"].allowed
    error_message = "The intended delivery subject must be able to obtain authority, otherwise the policy is merely broken rather than strict."
  }
}

run "every_other_subject_is_rejected" {
  command = plan

  assert {
    condition = alltrue([
      for name, evaluation in output.evaluations :
      !evaluation.allowed if name != "authorised-delivery-run"
    ])
    error_message = "An unauthorised subject was accepted by the delivery trust condition."
  }
}

run "rejections_name_the_clause_that_refused_them" {
  command = plan

  # Asserting *why* each subject was refused, not merely that it was. A denial
  # for an accidental reason is a denial that disappears with the next edit.
  assert {
    condition     = contains(output.evaluations["sibling-repository"].failed_clauses, "repository")
    error_message = "A sibling repository must be refused on the repository clause."
  }

  assert {
    condition     = contains(output.evaluations["fork-under-another-owner"].failed_clauses, "repository_owner_id")
    error_message = "A fork under another owner must be refused on the immutable owner id."
  }

  assert {
    condition = (
      contains(output.evaluations["reclaimed-repository-name"].failed_clauses, "repository_id") &&
      !contains(output.evaluations["reclaimed-repository-name"].failed_clauses, "repository")
    )
    error_message = "A reclaimed repository name must be refused specifically by the immutable numeric id, which is the only claim that differs."
  }

  assert {
    condition     = contains(output.evaluations["unauthorised-branch"].failed_clauses, "ref")
    error_message = "An unauthorised branch must be refused on the ref clause."
  }

  assert {
    condition     = contains(output.evaluations["tag-ref"].failed_clauses, "ref_type")
    error_message = "A tag must be refused on the ref_type clause."
  }

  assert {
    condition     = contains(output.evaluations["pull-request-run"].failed_clauses, "event_name")
    error_message = "A pull request run must be refused on the event_name clause."
  }

  assert {
    condition     = contains(output.evaluations["unauthorised-workflow"].failed_clauses, "job_workflow_ref")
    error_message = "An unauthorised workflow must be refused on the job_workflow_ref clause."
  }

  assert {
    condition     = contains(output.evaluations["external-reusable-workflow"].failed_clauses, "job_workflow_ref")
    error_message = "A job defined in another repository must be refused on the job_workflow_ref clause."
  }

  assert {
    condition     = contains(output.evaluations["scheduled-run"].failed_clauses, "event_name")
    error_message = "A scheduled run must be refused on the event_name clause; drift detection reads, it does not deploy."
  }
}

run "emitted_condition_matches_the_reviewed_text" {
  command = plan

  # A golden assertion. The offline evaluator above models the policy; this pins
  # the string Google actually evaluates. Both must move together, and a reviewer
  # can read this expected value without running anything.
  assert {
    condition = output.attribute_condition == join(" &&\n", [
      "assertion.repository_owner_id == \"222222222\"",
      "assertion.repository_id == \"111111111\"",
      "assertion.repository == \"example-owner/example-repo\"",
      "assertion.ref_type == \"branch\"",
      "assertion.ref in [\"refs/heads/v2\"]",
      "assertion.event_name in [\"push\",\"workflow_dispatch\"]",
      "assertion.job_workflow_ref in [\"example-owner/example-repo/.github/workflows/delivery.yml@refs/heads/v2\"]",
    ])
    error_message = "The emitted CEL condition no longer matches the reviewed text."
  }
}

run "principal_set_binding_is_repository_scoped" {
  command = plan

  assert {
    condition     = output.principal_set_attribute == "attribute.repository/example-owner/example-repo"
    error_message = "The principal-set binding must name the exact repository, never a wildcard or an owner-wide attribute."
  }
}

# Input refusals. These guard the shape of the policy itself: a wildcard, a tag,
# or a pull-request event must be unrepresentable rather than merely unusual, so
# that a later edit cannot widen the trust boundary by accident.

run "a_wildcard_ref_is_refused" {
  command = plan

  variables {
    allowed_refs = ["refs/heads/*"]
  }

  expect_failures = [var.allowed_refs]
}

run "a_tag_ref_is_refused" {
  command = plan

  variables {
    allowed_refs = ["refs/tags/v1.0.0"]
  }

  expect_failures = [var.allowed_refs]
}

run "an_empty_ref_allowlist_is_refused" {
  command = plan

  variables {
    allowed_refs = []
  }

  expect_failures = [var.allowed_refs]
}

run "a_pull_request_event_cannot_be_authorised" {
  command = plan

  variables {
    allowed_event_names = ["push", "pull_request"]
  }

  expect_failures = [var.allowed_event_names]
}

run "a_pull_request_target_event_cannot_be_authorised" {
  command = plan

  variables {
    allowed_event_names = ["pull_request_target"]
  }

  expect_failures = [var.allowed_event_names]
}

run "a_workflow_outside_the_workflows_directory_is_refused" {
  command = plan

  variables {
    allowed_workflow_paths = ["scripts/deploy.yml"]
  }

  expect_failures = [var.allowed_workflow_paths]
}

run "a_wildcard_workflow_path_is_refused" {
  command = plan

  variables {
    allowed_workflow_paths = [".github/workflows/*.yml"]
  }

  expect_failures = [var.allowed_workflow_paths]
}

run "an_owner_wide_repository_glob_is_refused" {
  command = plan

  variables {
    repository_name = "*"
  }

  expect_failures = [var.repository_name]
}

run "a_non_numeric_repository_id_is_refused" {
  command = plan

  variables {
    repository_id = "not-an-id"
  }

  expect_failures = [var.repository_id]
}
