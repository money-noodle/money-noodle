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

    The default declares the projection reader's connection string plus the five
    containers the signed-in surface needs (#242). Every container is created
    empty: a **value is never supplied here**, because reaching this variable
    means passing through an OpenTofu plan and into remote state. The maintainer
    adds each version out of band, and the containers are already waiting for them
    (ADR-0012, ADR-0013, #209).

    What is deliberately absent: there is no venue, broker or exchange credential
    of any kind. ADR-0013 §4 gives the live budget no execution path in M4, and
    `tools/live-budget-inertness.test.mjs` fails the build if one appears here.
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

    # --- The signed-in surface (#242, ADR-0013) --------------------------------
    #
    # Three database roles and two identity values. The three roles are three
    # containers because they are three authorities: ADR-0013 §2 gives the API a
    # SELECT-only read of the engine schema and an INSERT-only control path, and
    # one connection holding both would be one merge away from being a role that
    # reads and writes. The account store is this service's own schema, which
    # `overview.md` has always reserved for it.

    # SELECT on an explicitly granted subset of the engine schema. The API reads
    # control intent, the outcomes jobs appended, and job health through it, and
    # can record nothing.
    "platform-api-engine-reader-database-url" = {
      owner                  = "maintainer"
      consuming_principal    = "platform-api runtime service account"
      rotation_interval_days = 90
      revocation_procedure   = "Drop or alter the engine_reader role at the provider, then add a new secret version. A revision without a working value serves the public dashboard and answers the signed-in reads as unavailable; it never invents one."
      recovery_path          = "Recreate the engine_reader role with SELECT on the granted subset and add a new secret version. Nothing in this repository holds or can reconstruct the value."
    }

    # INSERT on the one append-only control table, and nothing else — no SELECT,
    # no UPDATE, no DELETE, nothing on any other table or schema (ADR-0013 §2).
    "platform-api-engine-recorder-database-url" = {
      owner                  = "maintainer"
      consuming_principal    = "platform-api runtime service account"
      rotation_interval_days = 90
      revocation_procedure   = "Drop or alter the engine_control_recorder role at the provider, then add a new secret version. With no working value the API records no intent and says so; it never performs the effect instead."
      recovery_path          = "Recreate the engine_control_recorder role with INSERT on the control tables alone and add a new secret version. The rows already recorded are unaffected and are not restored from here."
    }

    # SELECT, INSERT, UPDATE on this service's own schema: the account, its two
    # budget records, and the session rows that make sign-in revocable.
    "platform-api-account-database-url" = {
      owner                  = "maintainer"
      consuming_principal    = "platform-api runtime service account"
      rotation_interval_days = 90
      revocation_procedure   = "Drop or alter the platform_app role at the provider, then add a new secret version. Rotating it does not revoke outstanding sessions; revoking a session is an UPDATE on its row, and revoking all of them is a statement the schema owner runs."
      recovery_path          = "Recreate the platform_app role with privileges on this service's own schema alone and add a new secret version. Session rows are not reconstructable from this repository and do not need to be: a lost session is a sign-in."
    }

    # The identity provider's expected audience and issuer. Not credentials — a
    # token bearing them still has to carry a valid signature — but environment
    # identifiers, which SECURITY.md keeps out of the repository, so they travel
    # the same way everything else does.
    "platform-api-identity-audience" = {
      owner                  = "maintainer"
      consuming_principal    = "platform-api runtime service account"
      rotation_interval_days = 365
      revocation_procedure   = "Change the expected audience and add a new secret version. Tokens addressed to the previous audience stop being accepted at the next revision; existing sessions are unaffected until they expire or are revoked."
      recovery_path          = "Read the audience from the identity provider's configuration and add a new secret version. No value is held in this repository."
    }

    "platform-api-identity-issuer" = {
      owner                  = "maintainer"
      consuming_principal    = "platform-api runtime service account"
      rotation_interval_days = 365
      revocation_procedure   = "Change the expected issuer and add a new secret version. A token from any other issuer is refused, whatever it is signed with."
      recovery_path          = "Read the issuer from the identity provider's configuration and add a new secret version. No value is held in this repository."
    }

    # The single account's identifier (ADR-0013 §4: one account, two budgets).
    "platform-api-identity-account-id" = {
      owner                  = "maintainer"
      consuming_principal    = "platform-api runtime service account"
      rotation_interval_days = 365
      revocation_procedure   = "Change the account identifier and add a new secret version. Every outstanding session is bound to the previous account and is refused on the next request, because the binding is checked per request and not only at sign-in."
      recovery_path          = "Read the identifier from the account row the schema owner's migration created and add a new secret version."
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

    The default grants every container to the platform API and to nothing else.
    The web is deliberately absent from all of them: it is never a database
    client, and that rule is enforced in the api/web runtime contract as well as
    here (ADR-0012, ADR-0013). The web's signed-in pages reach engine data only
    through the API's contract, carrying an opaque session identifier and no
    credential of any kind.

    This is the only place `secretAccessor` is granted. The service stacks declare
    which secrets they intend to read, and the module validates that a bound
    reference is a declared one, but they create no Secret Manager IAM: the deployer
    identity that runs a routine deploy can mutate nothing in Secret Manager, so a
    grant declared there could only fail the deploy (#217). Since 2026-10-05 that
    identity does hold secret-level metadata read on each declared container, which
    is what lets it plan this stack at all and carries no access to a value (#224,
    ADR-0005).
  EOT
  type        = map(list(string))

  default = {
    "platform-api-projection-database-url"      = ["platform-api"]
    "platform-api-engine-reader-database-url"   = ["platform-api"]
    "platform-api-engine-recorder-database-url" = ["platform-api"]
    "platform-api-account-database-url"         = ["platform-api"]
    "platform-api-identity-audience"            = ["platform-api"]
    "platform-api-identity-issuer"              = ["platform-api"]
    "platform-api-identity-account-id"          = ["platform-api"]
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
