# Published contract of the platform stack. The web and api stacks read only
# `contract_*` keys.

output "contract_project_id" {
  description = "Project id."
  value       = local.project_id
}

output "contract_region" {
  description = "Region."
  value       = local.region
}

output "contract_registry_url" {
  description = "Artifact Registry repository path images are deployed from."
  value       = module.registry.repository_url
}

output "contract_registry_host" {
  description = "Registry hostname, for `docker login` in the delivery workflow."
  value       = module.registry.registry_host
}

output "contract_telemetry_endpoint" {
  description = <<-EOT
    OTLP ingestion endpoint. Vendor-neutral OTLP means replacing this backend is a
    configuration change (ADR-0007). Metric ingestion on this endpoint is Pre-GA
    and was accepted only under the financially inert first-slice controls.
  EOT
  value       = "https://telemetry.googleapis.com"
}

output "contract_secret_ids" {
  description = "Secret container ids available to be granted to a service. Empty for the first slice."
  value       = module.secret_store.secret_ids
}

output "budget_ceiling" {
  description = "Monthly ceiling in force. Not part of the cross-stack contract."
  value       = module.budget.monthly_ceiling
}

output "budget_threshold_percents" {
  description = "Alert thresholds in force. Not part of the cross-stack contract."
  value       = module.budget.threshold_percents
}

output "telemetry_retention_policy" {
  description = "Retention actually in force per signal class, including the classes this provider does not let us configure."
  value       = module.telemetry.retention_policy
}

output "secret_custody_register" {
  description = "Owner, consumer, rotation, revocation, and recovery per declared secret. Contains no secret value."
  value       = module.secret_store.custody_register
}
