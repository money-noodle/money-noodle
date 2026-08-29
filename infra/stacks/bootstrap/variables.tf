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
    "roles/run.developer",           # deploy revisions and reassign traffic; not run.admin
    "roles/artifactregistry.writer", # push images
    "roles/iam.serviceAccountUser",  # act as the runtime identities it deploys
    "roles/secretmanager.admin",     # create and manage secret containers
    "roles/logging.admin",           # configure log buckets, sinks, and retention
    "roles/monitoring.editor",       # notification channels and dashboards
    "roles/serviceusage.serviceUsageAdmin",
  ]

  validation {
    condition = length([
      for role in var.deployer_roles : role
      if contains([
        "roles/run.developer",
        "roles/editor",
        "roles/iam.securityAdmin",
        "roles/resourcemanager.projectIamAdmin",
      ], role)
    ]) == 0
    error_message = "The deployer must not hold owner, editor, or IAM-administration roles. ADR-0005 rejects broad administrative rights for convenience."
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

variable "allowed_audiences" {
  description = "Audiences accepted from the GitHub OIDC token. The delivery workflow requests this value explicitly."
  type        = list(string)
  default     = ["money-noodle-delivery"]
}

variable "repository_owner" {
  description = "GitHub owner authorised for delivery."
  type        = string
  default     = "phairow"
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
  description = <<-EOT
    Refs authorised for delivery. `refs/heads/v2` during the rebuild. At cutover
    this becomes protected `refs/heads/main` and `v2` is removed, which ADR-0005
    lists as one of its revisit triggers.
  EOT
  type        = list(string)
  default     = ["refs/heads/v2"]
}

variable "allowed_workflow_paths" {
  description = "Workflows authorised for delivery."
  type        = list(string)
  default     = [".github/workflows/delivery.yml"]
}

variable "allowed_event_names" {
  description = "Events authorised for delivery. Never `pull_request`."
  type        = list(string)
  default     = ["push", "workflow_dispatch"]
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
