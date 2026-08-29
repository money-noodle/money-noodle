output "service_name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.service.name
}

output "uri" {
  description = "Public `*.run.app` URI. The interim entry point until the reviewed domain cutover."
  value       = google_cloud_run_v2_service.service.uri
}

output "runtime_service_account_email" {
  description = "This service's own runtime identity."
  value       = google_service_account.runtime.email
}

output "latest_ready_revision" {
  description = "Most recent revision that passed its startup probe. This is the value a later rollback names."
  value       = google_cloud_run_v2_service.service.latest_ready_revision
}

output "deployed_image" {
  description = "Fully qualified image reference, by digest, that this service is running."
  value       = local.image
}

output "deployed_digest" {
  description = "Digest of the running artifact, so `what is running` is answerable without reading the service."
  value       = var.image_digest
}

output "source_commit" {
  description = "Reviewed commit the running artifact was built from."
  value       = var.source_commit
}
