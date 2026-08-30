variable "project_id" {
  description = "Google Cloud project. Supplied at bootstrap; never committed."
  type        = string
}

variable "region" {
  description = "Replication location for user-managed replication."
  type        = string
}

variable "secrets" {
  description = <<-EOT
    Secret containers to declare, keyed by secret id. Empty for the first slice,
    which needs no operational secret: the API base URL, service name, contract
    compatibility range, and telemetry destination are typed non-secret
    configuration (ADR-0003, ADR-0005). Putting non-secrets here would obscure
    which values actually matter.

    Each entry must record owner, consuming principal, rotation interval,
    revocation procedure, and recovery path before it can be created. Values are
    never supplied here.
  EOT
  type = map(object({
    owner                  = string
    consuming_principal    = string
    rotation_interval_days = number
    revocation_procedure   = string
    recovery_path          = string
  }))
  default = {}

  validation {
    condition = alltrue([
      for id, secret in var.secrets :
      secret.rotation_interval_days > 0
    ])
    error_message = "Every secret must declare a positive rotation interval. A secret with no rotation plan is a secret nobody will ever rotate."
  }

  validation {
    condition = alltrue([
      for id, secret in var.secrets :
      length(trimspace(secret.revocation_procedure)) > 0 && length(trimspace(secret.recovery_path)) > 0
    ])
    error_message = "Every secret must record a revocation procedure and a recovery path, which are needed exactly when there is no time to invent them."
  }

  validation {
    condition = alltrue([
      for id, secret in var.secrets :
      can(regex("^[a-zA-Z0-9_-]{1,255}$", id))
    ])
    error_message = "Secret ids must be alphanumeric with hyphens or underscores."
  }
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
