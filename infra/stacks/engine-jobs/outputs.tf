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

output "contract_cycle_job_name" {
  description = "The cycle job's Cloud Run Job name."
  value       = google_cloud_run_v2_job.cycle.name
}

output "contract_cycle_runtime_service_account_email" {
  description = "The identity the cycle execution runs as, created by the bootstrap stack and consumed here."
  value       = local.cycle_runtime_service_account_email
}

output "contract_cycle_trigger_service_account_email" {
  description = <<-EOT
    The identity Cloud Scheduler presents to start the cycle job. A different
    principal from the one the execution runs as, holding no project role and one
    job-level `run.invoker` binding (ADR-0013 §1, #243).
  EOT
  value       = local.cycle_trigger_service_account_email
}

output "cycle_schedule" {
  description = "The cron the cycle job is triggered on, in UTC. Published so the cadence is answerable from state."
  value       = google_cloud_scheduler_job.cycle.schedule
}

output "cycle_schedule_paused" {
  description = "Whether the trigger is paused. True until the reviewed bring-up is complete; un-pausing is a tfvars change with its own pull request."
  value       = google_cloud_scheduler_job.cycle.paused
}

output "cycle_arguments" {
  description = "The lane and tick budget the cycle job executes with, so `which mode is cycling` is answerable from state without reading a container."
  value       = var.cycle_arguments
}

output "cycle_control_epoch" {
  description = "The control epoch the cycle job evaluates intent against. An operator comparing this with the API's configured epoch is comparing the two halves of ADR-0013 §3 condition 2."
  value       = var.cycle_control_epoch
}

output "cycle_secret_environment_bound" {
  description = "Secret-backed variables the cycle job binds, as name to secret container id. Empty until the binding is enabled. No value exists in this stack, its plan, or its state."
  value       = local.cycle_secret_environment
}
