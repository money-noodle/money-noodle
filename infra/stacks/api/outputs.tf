# Published contract of the API stack. The web stack reads only `contract_*` keys.

output "contract_service_uri" {
  description = "Interim public `*.run.app` URI. The origin the web is configured with until the reviewed domain cutover."
  value       = module.service.uri
}

output "contract_runtime_service_account_email" {
  description = "The API's own runtime identity."
  value       = module.service.runtime_service_account_email
}

output "deployed_digest" {
  description = "Digest currently deployed, so `what is running` is answerable from state."
  value       = module.service.deployed_digest
}

output "artifact_version" {
  description = "Attributable version of the configured artifact, preserved during traffic-only rollback."
  value       = module.service.artifact_version
}

output "source_commit" {
  description = "Reviewed commit the running artifact was built from."
  value       = module.service.source_commit
}

output "latest_ready_revision" {
  description = "Most recent revision that passed its startup probe. A later rollback names this value."
  value       = module.service.latest_ready_revision
}

output "configured_revision_suffix" {
  description = "Revision suffix in desired state, preserved during traffic-only rollback."
  value       = module.service.configured_revision_suffix
}
