# Published contract of the web stack.

output "contract_service_uri" {
  description = "Interim public `*.run.app` URI. The first remote entry point; `noodle.money` remains on Vercel until a separately reviewed cutover."
  value       = module.service.uri
}

output "contract_runtime_service_account_email" {
  description = "The web's own runtime identity. It is granted `run.invoker` on the API service and nothing else."
  value       = module.service.runtime_service_account_email
}

output "configured_api_base_url" {
  description = "API origin this deployment was configured with, so a wrong origin is visible without reading the running container."
  value       = local.api_base_url
}

output "deployed_digest" {
  description = "Digest currently deployed."
  value       = module.service.deployed_digest
}

output "source_commit" {
  description = "Reviewed commit the running artifact was built from."
  value       = module.service.source_commit
}

output "latest_ready_revision" {
  description = "Most recent revision that passed its startup probe. A later rollback names this value."
  value       = module.service.latest_ready_revision
}
