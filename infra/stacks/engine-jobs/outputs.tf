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

# Read back by the scheduled drift job in delivery.yml, as the api and web
# stacks publish them, so a drift plan reloads the configured artifact rather
# than an empty value.
output "artifact_version" {
  description = "Attributable artifact version the job was applied with."
  value       = var.artifact_version
}

output "source_commit" {
  description = "Reviewed commit the applied artifact was built from."
  value       = var.source_commit
}

output "stage_bucket" {
  description = <<-EOT
    The staging bucket this job mounts, or null before the platform stack declares
    it. Published so the maintainer reads the name from `tofu output` or the apply
    log rather than from this repository, which never contains it (#241).
  EOT
  value       = local.stage_bucket
}

output "stage_mount_path" {
  description = "Where the staging bucket is mounted on the execution, so the runbook's upload paths and the applied arguments cannot drift apart."
  value       = var.stage_mount_path
}

output "secret_environment_bound" {
  description = "Secret-backed variables this job binds, as name to secret container id. Empty until the binding is enabled. No value exists in this stack, its plan, or its state."
  value       = local.secret_environment
}
