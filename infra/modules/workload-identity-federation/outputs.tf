output "pool_name" {
  description = "Fully qualified workload identity pool resource name."
  value       = google_iam_workload_identity_pool.delivery.name
}

output "provider_name" {
  description = <<-EOT
    Fully qualified provider resource name. The delivery workflow passes this as
    `workload_identity_provider`. It is an identifier, not a credential: holding
    it grants nothing without a token that satisfies the trust conjunction.
  EOT
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "attribute_condition" {
  description = "The CEL conjunction enforced before any token exchange, published so a drift report and a review can read it."
  value       = module.trust.attribute_condition
}

output "authorised_job_workflow_refs" {
  description = "Whole `job_workflow_ref` values permitted to obtain delivery authority."
  value       = module.trust.authorised_job_workflow_refs
}
