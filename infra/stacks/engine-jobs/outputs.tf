# Published contract of the engine-jobs stack. Nothing reads it yet; it exists so
# "which image did the restore run" is answerable from state.

output "contract_restore_job_name" {
  description = "The restore job's Cloud Run Job name."
  value       = google_cloud_run_v2_job.restore.name
}

output "contract_runtime_service_account_email" {
  description = "The restore job's own runtime identity, created by the bootstrap stack and consumed here."
  value       = local.runtime_service_account_email
}

output "deployed_digest" {
  description = "Digest the job executes, so `what ran` is answerable from state."
  value       = var.image_digest
}

output "secret_environment_bound" {
  description = "Secret-backed variables this job binds, as name to secret container id. Empty until the binding is enabled. No value exists in this stack, its plan, or its state."
  value       = local.secret_environment
}
