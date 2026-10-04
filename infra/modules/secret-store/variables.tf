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

variable "accessor_members" {
  description = <<-EOT
    IAM members granted `roles/secretmanager.secretAccessor` on a declared
    secret, keyed by secret id. Empty by default: a container with no consumer is
    a container nobody can read, which is the correct starting state.

    This grant lives here, beside the container, rather than in the service stack
    that consumes the secret. Setting IAM on a secret needs Secret Manager
    authority, and the federated deployer that runs a routine service deploy holds
    no Secret Manager role at all (ADR-0005). A grant declared in the release path
    is therefore a grant the routine deploy cannot create — it fails the deploy
    rather than widening anything — so the authority boundary decides where the
    resource is declared (#217).

    Members are service accounts only. A human principal, a group, a domain, or
    one of the `allUsers` wildcards would make a runtime credential readable by
    something that is not a workload, so those are refused below rather than
    reviewed case by case.
  EOT
  type        = map(list(string))
  default     = {}

  validation {
    condition = alltrue([
      for secret_id, members in var.accessor_members :
      contains(keys(var.secrets), secret_id)
    ])
    error_message = "A secret accessor must name a secret this store declares; granting access to an undeclared container silently creates nothing."
  }

  validation {
    condition = alltrue(flatten([
      for secret_id, members in var.accessor_members : [
        for member in members :
        can(regex("^serviceAccount:[a-z][-a-z0-9]*@[a-z][-a-z0-9]*\\.iam\\.gserviceaccount\\.com$", member))
      ]
    ]))
    error_message = "Secret accessors are service accounts in this project's own IAM namespace. A user, group, domain, or allUsers/allAuthenticatedUsers member would let something that is not a workload read a runtime credential."
  }

  validation {
    condition = alltrue([
      for secret_id, members in var.accessor_members :
      length(members) == length(distinct(members))
    ])
    error_message = "Each accessor appears once per secret; a repeated member is a sign two places are granting the same access."
  }
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
