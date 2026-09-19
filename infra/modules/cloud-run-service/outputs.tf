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

output "configured_revision_suffix" {
  description = "Revision suffix in desired state, preserved during traffic-only rollback."
  value       = var.revision_suffix
}

output "deployed_image" {
  description = "Fully qualified image reference, by digest, that this service is running."
  value       = local.image
}

output "deployed_digest" {
  description = "Digest of the running artifact, so `what is running` is answerable without reading the service."
  value       = var.image_digest
}

output "artifact_version" {
  description = "Attributable version of the configured artifact."
  value       = var.artifact_version
}

output "source_commit" {
  description = "Reviewed commit the running artifact was built from."
  value       = var.source_commit
}

output "public_invoker_members" {
  description = "Members holding `roles/run.invoker` through the public binding. Empty means the service is private; derived from the declared resource, not from the input."
  value       = google_cloud_run_v2_service_iam_member.public[*].member
}

output "telemetry_env" {
  description = <<-EOT
    The telemetry configuration this module renders into the container. Exposed
    so offline tests can assert desired configuration directly rather than
    re-deriving it from an expression. It contains configuration only: the
    exporter obtains short-lived credentials from this service's own workload
    identity at runtime, so no credential appears here or in any environment
    variable.
  EOT
  value       = local.telemetry_env
}

output "telemetry_roles" {
  description = <<-EOT
    Roles the runtime identity is declared to hold for telemetry export. Desired
    configuration in unapplied source: this module grants nothing, and an actual
    grant is a separately authorized operation.
  EOT
  value       = sort([for grant in google_project_iam_member.runtime_telemetry : grant.role])
}
