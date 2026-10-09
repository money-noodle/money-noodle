# Published contract of the bootstrap stack.
#
# Every output consumed by another stack is prefixed `contract_`. Downstream
# stacks read only `contract_*` keys, and `tools/verify-infra-policy.test.mjs`
# fails the repository check if one reads anything else. That is what makes
# "values cross stacks by reading a published output, never by one stack reaching
# into another's internals" (ADR-0006) enforceable rather than aspirational.

output "contract_state_buckets" {
  description = "State bucket name per stack. Consumed by each stack's backend configuration."
  value       = { for stack, module_instance in module.state : stack => module_instance.bucket_name }
}

output "contract_deployer_service_account_email" {
  description = "The federated deployer principal."
  value       = google_service_account.deployer.email
}

output "contract_workload_identity_provider" {
  description = <<-EOT
    Fully qualified workload identity provider resource name, passed to the
    delivery workflow as a repository variable. An identifier, not a credential.
  EOT
  value       = module.federation.provider_name
}

output "contract_runtime_service_account_emails" {
  description = <<-EOT
    Runtime identity email per Cloud Run service or job name. The `api`, `web` and
    `engine-jobs` stacks read this instead of creating an identity, so a service or
    job apply needs no identity or project-IAM authority (ADR-0005, 2026-09-19
    amendment; ADR-0013 §1). Each stack selects its own entry by the name it pins,
    so one unit cannot be wired to run as another's identity. An address, not a
    credential: holding it grants nothing.
  EOT
  value       = { for service, account in google_service_account.runtime : service => account.email }
}

output "contract_trigger_service_account_emails" {
  description = <<-EOT
    Trigger identity email per scheduled Cloud Run Job name. The `engine-jobs`
    stack reads this to bind `roles/run.invoker` on the one job each identity
    triggers, so a scheduled job's trigger is a separate principal from the
    identity the execution runs as (ADR-0013 §1, #243). An address, not a
    credential: holding it grants nothing.
  EOT
  value       = { for job, account in google_service_account.trigger : job => account.email }
}

output "contract_project_id" {
  description = "Project id, republished so downstream stacks take it from one place."
  value       = var.project_id
}

output "contract_region" {
  description = "Region, republished so downstream stacks cannot drift apart on it."
  value       = var.region
}

output "runtime_telemetry_roles" {
  description = "Project roles every runtime identity is declared to hold, published for review and drift reporting. Not part of the cross-stack contract."
  value       = sort(distinct([for grant in google_project_iam_member.runtime_telemetry : grant.role]))
}

output "attribute_condition" {
  description = "Trust conjunction in force, published for review and drift reporting. Not part of the cross-stack contract."
  value       = module.federation.attribute_condition
}

output "authorised_job_workflow_refs" {
  description = "Whole `job_workflow_ref` values that may obtain delivery authority. Not part of the cross-stack contract."
  value       = module.federation.authorised_job_workflow_refs
}
