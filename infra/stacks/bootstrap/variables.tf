variable "project_id" {
  description = "Google Cloud project id. Supplied by the maintainer at bootstrap; never committed."
  type        = string
}

variable "region" {
  description = "Region. `us-west1` per ADR-0004; EU residency is not required for this slice."
  type        = string
  default     = "us-west1"
}

variable "state_bucket_prefix" {
  description = <<-EOT
    Prefix for the four state bucket names. Bucket names are globally unique
    across all of Google Cloud, so this must be something the maintainer owns or
    can reasonably claim. It is a name, not a secret, but it is account-specific
    and so arrives as a variable.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{2,40}$", var.state_bucket_prefix))
    error_message = "state_bucket_prefix must be a valid Cloud Storage name fragment."
  }
}

variable "deployer_service_account_id" {
  description = "Account id for the federated deployer."
  type        = string
  default     = "delivery-deployer"
}

variable "deployer_roles" {
  description = <<-EOT
    Project roles held by the deployer. Deliberately enumerated rather than
    defaulted to a broad role, and validated below against the roles that would
    collapse the trust boundaries ADR-0005 exists to establish.
  EOT
  type        = list(string)
  default = [
    # Cloud Run administration, not `run.developer`. A service is created private
    # and its named invokers are service-level `roles/run.invoker` bindings, which
    # `run.developer` cannot set. The role is confined to Cloud Run: it grants no
    # project IAM, no identity administration and nothing outside the service.
    "roles/run.admin",
    # Registry administration, not writer: the platform stack creates the image
    # repository and sets its repository-level IAM, which writer cannot do. The
    # role is confined to Artifact Registry and also covers pushing images.
    "roles/artifactregistry.admin",
    "roles/iam.serviceAccountUser", # act as the runtime identities it deploys
    # No Secret Manager administrative role: it could grant the deployer
    # secretAccessor and collapse the custody boundary. Revisit with the first
    # real secret and a separate policy-administration design.
    "roles/logging.admin",     # configure log buckets, sinks, and retention
    "roles/monitoring.editor", # notification channels and dashboards
    "roles/serviceusage.serviceUsageAdmin",
  ]

  validation {
    condition = length([
      for role in var.deployer_roles : role
      if contains([
        "roles/owner",
        "roles/editor",
        "roles/iam.securityAdmin",
        "roles/resourcemanager.projectIamAdmin",
        "roles/secretmanager.admin",
      ], role)
    ]) == 0
    error_message = "The deployer must not hold owner, editor, Secret Manager admin, or IAM-administration roles. ADR-0005 rejects broad or self-escalating administrative rights for convenience."
  }

  validation {
    condition = length([
      for role in var.deployer_roles : role
      if contains([
        "roles/secretmanager.secretAccessor",
        "roles/secretmanager.viewer",
      ], role)
    ]) == 0
    error_message = "The deployer must not be able to read secret values that runtime workloads consume (ADR-0005). It manages containers, not contents."
  }
}

variable "runtime_service_accounts" {
  description = <<-EOT
    Runtime identity account id per deployable service, keyed by the Cloud Run
    service name that service's stack declares.

    These are created by this maintainer-applied stack rather than by the
    delivery pipeline. Creating a service account needs
    `iam.serviceAccounts.create` and granting it a project role needs
    `resourcemanager.projects.setIamPolicy`; the deployer role validation above
    refuses both, so the pipeline could not create them without becoming the most
    powerful identity in the platform (ADR-0005, 2026-09-19 amendment).
  EOT
  type        = map(string)
  default = {
    "platform-api" = "platform-api-runtime"
    "web"          = "web-runtime"
  }

  validation {
    condition = alltrue([
      for account_id in values(var.runtime_service_accounts) :
      can(regex("^[a-z]([-a-z0-9]{4,28}[a-z0-9])$", account_id))
    ])
    error_message = "Each runtime account id must be 6 to 30 characters, lowercase, starting with a letter."
  }

  validation {
    condition = (
      length(distinct(values(var.runtime_service_accounts))) ==
      length(var.runtime_service_accounts)
    )
    error_message = "Each service must hold its own runtime identity. A shared one makes blast radius conventional rather than mechanical (ADR-0005)."
  }
}

variable "runtime_telemetry_roles" {
  description = <<-EOT
    Project roles granted to every runtime identity. Telemetry export is the only
    project-level authority a runtime identity holds in the first slice: writing
    telemetry is not reading anything and not deploying anything.

    `telemetry.writer` and `serviceusage.serviceUsageConsumer` are what Google's
    current Telemetry API documentation requires for OTLP ingestion with a quota
    project; the three older per-signal roles remain for the classic ingestion
    paths.
  EOT
  type        = list(string)
  default = [
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/telemetry.writer",
  ]

  validation {
    condition = alltrue([
      for role in var.runtime_telemetry_roles : anytrue([
        for prefix in [
          "roles/cloudtrace.",
          "roles/logging.",
          "roles/monitoring.",
          "roles/serviceusage.",
          "roles/telemetry.",
        ] : startswith(role, prefix)
      ])
    ])
    error_message = "A runtime identity may hold only telemetry write authority at project level (ADR-0005)."
  }

  validation {
    condition = length([
      for role in var.runtime_telemetry_roles : role
      if contains([
        "roles/owner",
        "roles/editor",
        "roles/logging.admin",
        "roles/monitoring.admin",
        "roles/serviceusage.serviceUsageAdmin",
        "roles/telemetry.admin",
      ], role)
    ]) == 0
    error_message = "A runtime identity must not hold an administrative role. It writes telemetry and does nothing else."
  }
}

variable "billing_account_id" {
  description = "Billing account on which bootstrap grants the deployer only budget-management authority. Supplied by the maintainer; never committed."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must use the documented Google Cloud billing account format."
  }
}

variable "allowed_audiences" {
  description = "Audiences accepted from the GitHub OIDC token. The delivery workflow requests this value explicitly."
  type        = list(string)
  default     = ["money-noodle-delivery"]
}

variable "repository_owner" {
  description = "GitHub owner authorised for delivery."
  type        = string
  default     = "money-noodle"
}

variable "repository_name" {
  description = "GitHub repository authorised for delivery."
  type        = string
  default     = "money-noodle"
}

variable "repository_id" {
  description = "Immutable numeric GitHub repository id. Supplied by the maintainer at bootstrap; never committed."
  type        = string
}

variable "repository_owner_id" {
  description = "Immutable numeric GitHub owner id. Supplied by the maintainer at bootstrap; never committed."
  type        = string
}

variable "allowed_refs" {
  description = "Refs authorised for delivery. Only protected `refs/heads/main` is permitted."
  type        = list(string)
  default     = ["refs/heads/main"]

  validation {
    condition     = length(var.allowed_refs) == 1 && one(var.allowed_refs) == "refs/heads/main"
    error_message = "Bootstrap cannot reauthorize a migration or additional branch; allowed_refs must be exactly `refs/heads/main`."
  }
}

variable "allowed_workflow_paths" {
  description = "Workflows authorised for delivery. Only `.github/workflows/delivery.yml` is permitted."
  type        = list(string)
  default     = [".github/workflows/delivery.yml"]

  validation {
    condition = (
      length(var.allowed_workflow_paths) == 1 &&
      one(var.allowed_workflow_paths) == ".github/workflows/delivery.yml"
    )
    error_message = "Bootstrap cannot authorize another or additional workflow; allowed_workflow_paths must be exactly `.github/workflows/delivery.yml`."
  }
}

variable "allowed_event_names" {
  description = "Events authorised for delivery: push, workflow_dispatch, and exact-workflow scheduled drift."
  type        = list(string)
  default     = ["push", "workflow_dispatch", "schedule"]

  validation {
    condition = (
      length(var.allowed_event_names) == 3 &&
      toset(var.allowed_event_names) == toset(["push", "workflow_dispatch", "schedule"])
    )
    error_message = "Bootstrap delivery events must be exactly push, workflow_dispatch, and schedule."
  }
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
