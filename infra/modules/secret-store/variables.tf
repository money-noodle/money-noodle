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
    that consumes the secret. Setting IAM on a secret needs Secret Manager authority
    to *mutate*, and the federated deployer that runs a routine service deploy holds
    none: since the 2026-10-05 amendment to ADR-0005 it holds secret-level metadata
    read on declared containers and nothing more (#224). A grant declared in the
    release path is therefore a grant the routine deploy cannot create — it fails the
    deploy rather than widening anything — so the authority boundary decides where
    the resource is declared (#217).

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

variable "metadata_reader_members" {
  description = <<-EOT
    IAM members granted secret-level **metadata** read on a declared secret, keyed
    by secret id. Empty by default.

    This exists for one reason: an identity that must *plan* these resources without
    being allowed to read what they hold. Every pipeline plan of the stack holding
    this module refreshes each container and each IAM member on it as the federated
    deployer, and with no grant that refresh fails with 403 on
    `secretmanager.secrets.get` — which blocked every routine deploy after the first
    container existed (#224).

    What they receive is `roles/secretmanager.viewer` bound to the single secret:
    `secretmanager.secrets.get` and `secretmanager.secrets.getIamPolicy`, which is
    what refreshing a container and an IAM member on it reads, plus list and
    version-metadata permissions. **No `secretmanager.versions.access`**, so a
    reader can see that a version exists and never what it contains, and nothing
    that mutates. The role is fixed in this module rather than taken as an input,
    because which role a reader gets is a custody decision rather than a knob.

    A metadata reader is not an accessor. The two lists are separate so that a
    plan-only identity and a value-consuming workload can never be confused for one
    another, and so that `accessor_register` keeps meaning "who can read the value".

    Members are service accounts only, for the same reason as `accessor_members`: a
    human, a group, a domain or an `allUsers` wildcard is not a workload.
  EOT
  type        = map(list(string))
  default     = {}

  validation {
    condition = alltrue([
      for secret_id, members in var.metadata_reader_members :
      contains(keys(var.secrets), secret_id)
    ])
    error_message = "A metadata reader must name a secret this store declares; a reader on an undeclared container silently creates nothing."
  }

  validation {
    condition = alltrue(flatten([
      for secret_id, members in var.metadata_reader_members : [
        for member in members :
        can(regex("^serviceAccount:[a-z][-a-z0-9]*@[a-z][-a-z0-9]*\\.iam\\.gserviceaccount\\.com$", member))
      ]
    ]))
    error_message = "Metadata readers are service accounts in this project's own IAM namespace. A user, group, domain, or allUsers/allAuthenticatedUsers member must never be given standing read on a credential container, even for metadata."
  }

  validation {
    condition = alltrue([
      for secret_id, members in var.metadata_reader_members :
      length(members) == length(distinct(members))
    ])
    error_message = "Each metadata reader appears once per secret; a repeated member is a sign two places are granting the same access."
  }
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
