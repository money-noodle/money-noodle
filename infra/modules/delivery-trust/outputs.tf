output "attribute_condition" {
  description = "CEL conjunction applied by the workload identity pool provider before any token is exchanged."
  value       = local.attribute_condition

  precondition {
    condition = (
      sort(local.required_clause_ids) == sort(keys(local.cel_clauses))
    )
    error_message = "Every declared clause must have a CEL fragment. The emitted condition and the declared clause set have diverged."
  }

  precondition {
    condition = alltrue([
      for results in values(local.clause_results) :
      sort(local.required_clause_ids) == sort(keys(results))
    ])
    error_message = "Every declared clause must have an offline check. The enforced condition and the tested condition have diverged."
  }

  precondition {
    condition     = length(local.authorised_job_workflow_refs) > 0
    error_message = "The authorised job_workflow_ref set is empty, which would deny every subject including the intended one."
  }
}

output "attribute_mapping" {
  description = "Claim-to-attribute mapping for the workload identity pool provider."
  value       = local.attribute_mapping
}

output "repository" {
  description = "Fully qualified `owner/name` of the repository authorised for delivery."
  value       = local.repository
}

output "principal_set_attribute" {
  description = <<-EOT
    Attribute a principal-set IAM binding should be written against, as
    `attribute.repository/OWNER/NAME`. The caller prefixes the workload identity
    pool resource name. This is the second gate: `attribute_condition` decides
    whether a token is exchangeable at all, and this decides which principal the
    resulting credential may impersonate.
  EOT
  value       = "attribute.repository/${local.repository}"
}

output "authorised_job_workflow_refs" {
  description = "Whole `job_workflow_ref` values permitted to obtain delivery authority."
  value       = local.authorised_job_workflow_refs
}

output "evaluations" {
  description = "Test-only. Per-candidate policy decision and the clauses each candidate failed."
  value       = local.evaluations
}
