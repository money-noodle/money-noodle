variable "bootstrap_state_bucket" {
  description = "State bucket holding the bootstrap stack's published contract. Supplied at apply; never committed."
  type        = string
}

variable "project_number" {
  description = "Numeric project number, needed by the budget filter and the Cloud Run service agent identity. Supplied at bootstrap; never committed."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.project_number))
    error_message = "project_number must be the numeric Google Cloud project number."
  }
}

variable "billing_account_id" {
  description = "Billing account the budget attaches to. Supplied at apply; never committed."
  type        = string
  sensitive   = true
}

variable "registry_repository_id" {
  description = "Artifact Registry repository id."
  type        = string
  default     = "platform"
}

variable "monthly_ceiling" {
  description = "Accepted monthly alert budget in USD; an alerting amount, not a hard spending cap."
  type        = number
  default     = 25
}

variable "budget_threshold_percents" {
  description = "Accepted alert thresholds."
  type        = list(number)
  default     = [20, 50, 80, 100]
}

variable "budget_alert_email_addresses" {
  description = "Addresses the budget alerts. Supplied at apply; never committed."
  type        = list(string)
}

variable "log_retention_days" {
  description = "Operational log retention."
  type        = number
  default     = 14
}

variable "debug_log_retention_days" {
  description = <<-EOT
    Debug log retention. The 2026-09-15 accepted policy is 14 days for
    application and debug logs alike, which is also what keeps the `_Default`
    bucket's own copy from being a longer-lived contradiction.
  EOT
  type        = number
  default     = 14
}

variable "secrets" {
  description = <<-EOT
    Secret containers to declare, keyed by secret id, with the custody record
    each one must carry before it can exist (ADR-0005).

    The default declares the projection reader's connection string and nothing
    else. The container is created empty: a **value is never supplied here**,
    because reaching this variable means passing through an OpenTofu plan and
    into remote state. The maintainer adds the version out of band, and the
    container is already waiting for it (ADR-0012, #209).
  EOT
  type = map(object({
    owner                  = string
    consuming_principal    = string
    rotation_interval_days = number
    revocation_procedure   = string
    recovery_path          = string
  }))

  default = {
    # SELECT-only role on the existing public paper projection. The API reads four
    # tables through it and can do nothing else; readiness refuses to pass if the
    # role ever holds more than SELECT, so an over-granted replacement value fails
    # the next revision rather than quietly widening what the API can do.
    "platform-api-projection-database-url" = {
      owner                  = "maintainer"
      consuming_principal    = "platform-api runtime service account"
      rotation_interval_days = 90
      revocation_procedure   = "Drop or alter the SELECT-only database role at the provider, then add a new secret version. The next revision fails its readiness probe until a working value exists, so a revoked credential cannot serve traffic."
      recovery_path          = "Recreate the SELECT-only role at the database provider and add a new secret version. Nothing in this repository holds or can reconstruct the value; the projection itself is written by a separate system and is not restored from here."
    }
  }

  validation {
    condition = alltrue([
      for id, secret in var.secrets :
      can(regex("^[a-z][a-z0-9-]{0,61}$", id))
    ])
    error_message = "Secret ids are lower-case, hyphenated names, so the id that appears in a Cloud Run secret reference is predictable."
  }
}

variable "secret_consumer_services" {
  description = <<-EOT
    Which services may read each declared secret, keyed by secret id with the
    Cloud Run **service names** that consume it. Service names, never account
    addresses: the identity is resolved through the bootstrap stack's published
    contract, so no account identifier is committed here and a renamed identity
    cannot leave a stale grant behind.

    The default grants the projection connection string to the platform API and
    to nothing else. The web is deliberately absent: it is never a database
    client, and that rule is enforced in the api/web runtime contract as well as
    here (ADR-0012).

    This is the only place `secretAccessor` is granted. The service stacks declare
    which secrets they intend to read, and the module validates that a bound
    reference is a declared one, but they create no Secret Manager IAM: the
    deployer identity that runs a routine deploy holds no Secret Manager role, so
    a grant declared there could only fail the deploy (#217).
  EOT
  type        = map(list(string))

  default = {
    "platform-api-projection-database-url" = ["platform-api"]
  }

  validation {
    condition = alltrue(flatten([
      for secret_id, services in var.secret_consumer_services : [
        for service in services :
        can(regex("^[a-z][a-z0-9-]{0,62}$", service))
      ]
    ]))
    error_message = "A consumer is named by its Cloud Run service name, which is lower-case and hyphenated. An account email here would be a committed identifier and would also bypass the bootstrap contract."
  }

  validation {
    condition = alltrue([
      for secret_id, services in var.secret_consumer_services :
      length(services) > 0 && length(services) == length(distinct(services))
    ])
    error_message = "Each secret lists at least one consumer, once. An empty list is a secret nobody can read, which is better expressed by removing the entry."
  }
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
