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
  description = <<-EOT
    Secret container ids a service stack may be granted. Declared containers only;
    this output carries no value and cannot, because the module never creates a
    version. Currently the projection reader's connection string (ADR-0012).
  EOT
  value       = module.secret_store.secret_ids
}

output "contract_engine_restore_stage_bucket" {
  description = <<-EOT
    Name of the restore job's staging bucket, or null until it is declared. The
    `engine-jobs` stack reads this to mount it, so the bucket name is not written
    down in this repository (#241). A bucket name is an address, not a credential:
    holding it grants nothing, and the bucket enforces public-access prevention.
  EOT
  value       = one(google_storage_bucket.engine_restore_stage[*].name)
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

output "secret_accessor_register" {
  description = <<-EOT
    Members holding `secretAccessor` per declared secret, as this stack applied
    them. Published for review and drift reporting; not part of the cross-stack
    contract, because a service stack needs the grant to exist rather than to read
    who holds it. Contains no secret value.
  EOT
  value       = module.secret_store.accessor_register
}

output "secret_metadata_reader_register" {
  description = <<-EOT
    Members holding secret-level metadata read per declared secret, and the role they
    hold. The deployer is here so that a pipeline plan of this stack can refresh the
    containers and their IAM members; it is deliberately absent from
    `secret_accessor_register`, because seeing that a secret exists is not reading it
    (#224). Contains no secret value.
  EOT
  value       = module.secret_store.metadata_reader_register
}
