terraform {
  required_version = "1.12.6"
}

# This module declares no provider and no resource. It is pure policy, so its
# assertions run offline in `tofu test` without a project, a billing account, or
# any credential.

locals {
  repository = "${var.repository_owner}/${var.repository_name}"

  # `job_workflow_ref` has the form OWNER/REPO/.github/workflows/FILE@REF.
  # Enumerating the exact product of authorised workflow paths and authorised refs
  # makes this an allowlist of whole values rather than a prefix match, so a
  # workflow file on an unauthorised ref is not merely improbable, it is absent
  # from the permitted set.
  authorised_job_workflow_refs = sort(flatten([
    for path in var.allowed_workflow_paths : [
      for ref in var.allowed_refs : "${local.repository}/${path}@${ref}"
    ]
  ]))

  allowed_refs_sorted   = sort(var.allowed_refs)
  allowed_events_sorted = sort(var.allowed_event_names)

  # The clause set is declared once. `cel_clauses` and the per-candidate
  # `clause_results` below are both keyed by it, and an output precondition
  # asserts the three key sets are identical. Adding an enforcement clause to the
  # CEL without adding the matching offline check — or the reverse — fails the
  # plan instead of silently weakening one of the two.
  required_clause_ids = [
    "repository_owner_id",
    "repository_id",
    "repository",
    "ref_type",
    "ref",
    "event_name",
    "job_workflow_ref",
  ]

  cel_clauses = {
    repository_owner_id = "assertion.repository_owner_id == ${jsonencode(var.repository_owner_id)}"
    repository_id       = "assertion.repository_id == ${jsonencode(var.repository_id)}"
    repository          = "assertion.repository == ${jsonencode(local.repository)}"
    ref_type            = "assertion.ref_type == \"branch\""
    ref                 = "assertion.ref in ${jsonencode(local.allowed_refs_sorted)}"
    event_name          = "assertion.event_name in ${jsonencode(local.allowed_events_sorted)}"
    job_workflow_ref    = "assertion.job_workflow_ref in ${jsonencode(local.authorised_job_workflow_refs)}"
  }

  # Rendered in the declared clause order and joined with `&&`, so the emitted
  # condition is a conjunction: every clause must hold. A reviewer can read the
  # rendered string in the plan and see exactly what the provider will enforce.
  attribute_condition = join(" &&\n", [
    for id in local.required_clause_ids : local.cel_clauses[id]
  ])

  # Claims mapped out of the GitHub token. `google.subject` is required. Every
  # other mapped attribute exists because the condition above or a principal-set
  # binding refers to it; nothing is mapped speculatively, because each mapped
  # attribute is an additional value a future binding could be written against.
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner"    = "assertion.repository_owner"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
    "attribute.ref_type"            = "assertion.ref_type"
    "attribute.event_name"          = "assertion.event_name"
    "attribute.job_workflow_ref"    = "assertion.job_workflow_ref"
  }

  # Offline evaluation of the same conjunction over supplied candidate claim sets.
  clause_results = {
    for candidate in var.candidate_subjects : candidate.name => {
      repository_owner_id = candidate.repository_owner_id == var.repository_owner_id
      repository_id       = candidate.repository_id == var.repository_id
      repository          = candidate.repository == local.repository
      ref_type            = candidate.ref_type == "branch"
      ref                 = contains(local.allowed_refs_sorted, candidate.ref)
      event_name          = contains(local.allowed_events_sorted, candidate.event_name)
      job_workflow_ref    = contains(local.authorised_job_workflow_refs, candidate.job_workflow_ref)
    }
  }

  evaluations = {
    for name, results in local.clause_results : name => {
      allowed = alltrue(values(results))
      # Sorted so a denial reason list is stable and diffable across runs.
      failed_clauses = sort([for id, ok in results : id if !ok])
    }
  }
}
