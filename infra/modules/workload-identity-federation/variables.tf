variable "project_id" {
  description = "Google Cloud project hosting the workload identity pool. Supplied at bootstrap; never committed."
  type        = string
}

variable "pool_id" {
  description = "Workload identity pool id."
  type        = string
  default     = "github-delivery"
}

variable "provider_id" {
  description = "Workload identity pool provider id."
  type        = string
  default     = "github-actions"
}

variable "deployer_service_account_id" {
  description = "Fully qualified resource id of the deployer service account this federation may impersonate."
  type        = string
}

variable "allowed_audiences" {
  description = <<-EOT
    Audiences accepted from the GitHub token. The delivery workflow requests this
    audience explicitly. Leaving the audience unconstrained would accept tokens
    minted for an unrelated purpose.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.allowed_audiences) > 0
    error_message = "At least one audience must be specified; an unconstrained audience is not an acceptable default here."
  }
}

variable "repository_owner" {
  description = "GitHub owner authorised for delivery."
  type        = string
}

variable "repository_name" {
  description = "GitHub repository authorised for delivery."
  type        = string
}

variable "repository_id" {
  description = "Immutable numeric GitHub repository id. Supplied at bootstrap."
  type        = string
}

variable "repository_owner_id" {
  description = "Immutable numeric GitHub owner id. Supplied at bootstrap."
  type        = string
}

variable "allowed_refs" {
  description = "Exact refs authorised for delivery. `refs/heads/v2` during the rebuild; protected `refs/heads/main` after cutover."
  type        = list(string)
}

variable "allowed_workflow_paths" {
  description = "Exact workflow paths authorised for delivery."
  type        = list(string)
}

variable "allowed_event_names" {
  description = "Event names authorised for delivery. Never `pull_request`."
  type        = list(string)
  default     = ["push", "workflow_dispatch"]
}
