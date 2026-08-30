variable "project_id" {
  description = "Google Cloud project owning the registry. Supplied at bootstrap; never committed."
  type        = string
}

variable "region" {
  description = "Registry location. Must match the Cloud Run region so pulls stay on the free intra-location path."
  type        = string
}

variable "repository_id" {
  description = "Artifact Registry repository id."
  type        = string
  default     = "platform"
}

variable "deployer_service_account_email" {
  description = "The federated deployer, the only principal permitted to push images."
  type        = string
}

variable "image_puller_members" {
  description = <<-EOT
    IAM members permitted to pull. This is the Cloud Run service agent, not a
    workload runtime identity: ADR-0005 forbids the web and API workload
    identities from reading the registry.
  EOT
  type        = list(string)
  default     = []
}

variable "keep_recent_versions" {
  description = "Number of recent image versions retained regardless of age, so rollback targets survive cleanup."
  type        = number
  default     = 20

  validation {
    condition     = var.keep_recent_versions >= 5
    error_message = "Retain at least five versions; rollback needs a target that still exists."
  }
}

variable "untagged_retention_days" {
  description = "Age at which an untagged image version becomes eligible for deletion."
  type        = number
  default     = 30
}

variable "cleanup_dry_run" {
  description = <<-EOT
    Whether cleanup policies only report what they would delete. Defaults to true:
    a deletion policy that has never been observed against real data is a policy
    whose blast radius is unknown. Set to false once a dry-run cycle has been
    reviewed.
  EOT
  type        = bool
  default     = true
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
