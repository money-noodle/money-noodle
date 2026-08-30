# Provider-free policy module.
#
# It owns one thing: the exact conjunction of claims a GitHub Actions OIDC token
# must satisfy before Google Cloud will exchange it for a short-lived credential.
# It emits that conjunction twice — once as the CEL string handed to the
# workload identity pool provider, and once as an evaluator over candidate
# subjects — so the policy can be tested offline, with no provider, no project,
# and no credential.

variable "repository_owner" {
  description = "GitHub organisation or user that owns the delivery repository, for example `phairow`."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-]{0,38}$", var.repository_owner))
    error_message = "repository_owner must be a single GitHub login segment; it may not contain `/` or `*`."
  }
}

variable "repository_name" {
  description = "GitHub repository name that owns delivery, for example `money-noodle`."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,100}$", var.repository_name))
    error_message = "repository_name must be a single GitHub repository segment; it may not contain `/` or `*`."
  }
}

variable "repository_id" {
  description = <<-EOT
    Immutable numeric GitHub repository id. Supplied by the maintainer at bootstrap.
    This is not a secret, but it is an account-specific identifier, so it is never
    committed: it arrives as a variable. Pinning the numeric id means that deleting
    the repository and re-creating a repository with the same name does not inherit
    delivery authority.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.repository_id))
    error_message = "repository_id must be the numeric GitHub repository id."
  }
}

variable "repository_owner_id" {
  description = "Immutable numeric GitHub account id of the repository owner. Supplied by the maintainer at bootstrap."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.repository_owner_id))
    error_message = "repository_owner_id must be the numeric GitHub account id."
  }
}

variable "allowed_refs" {
  description = <<-EOT
    Exact git refs permitted to obtain delivery authority. Only protected
    `refs/heads/main` is authorised. Wildcards are rejected by validation on
    purpose: a pattern is how an unintended ref acquires authority.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.allowed_refs) > 0
    error_message = "At least one ref must be authorised, otherwise delivery can never run."
  }

  validation {
    condition     = length(var.allowed_refs) == 1 && one(var.allowed_refs) == "refs/heads/main"
    error_message = "Money Noodle delivery authority is invariantly limited to exactly `refs/heads/main`."
  }

  validation {
    condition     = alltrue([for ref in var.allowed_refs : startswith(ref, "refs/heads/")])
    error_message = "Only branch refs may hold delivery authority; tag and pull-request refs are not deployable."
  }

  validation {
    condition     = alltrue([for ref in var.allowed_refs : !can(regex("[*?]", ref))])
    error_message = "allowed_refs must be exact refs. Wildcards are forbidden."
  }
}

variable "allowed_workflow_paths" {
  description = <<-EOT
    Repository-relative paths of the workflows permitted to obtain delivery authority.
    Constrains `job_workflow_ref`, so a newly added or edited unrelated workflow cannot
    mint a deployment credential.
  EOT
  type        = list(string)

  validation {
    condition = (
      length(var.allowed_workflow_paths) == 1 &&
      one(var.allowed_workflow_paths) == ".github/workflows/delivery.yml"
    )
    error_message = "Money Noodle delivery authority is invariantly limited to exactly `.github/workflows/delivery.yml`."
  }

  validation {
    condition     = length(var.allowed_workflow_paths) > 0
    error_message = "At least one workflow path must be authorised."
  }

  validation {
    condition     = alltrue([for path in var.allowed_workflow_paths : startswith(path, ".github/workflows/")])
    error_message = "allowed_workflow_paths must be repository-relative paths under .github/workflows/."
  }

  validation {
    condition     = alltrue([for path in var.allowed_workflow_paths : !can(regex("[*?]", path))])
    error_message = "allowed_workflow_paths must be exact paths. Wildcards are forbidden."
  }
}

variable "allowed_event_names" {
  description = <<-EOT
    GitHub event names permitted to obtain delivery authority. `pull_request` is
    excluded by validation: pull request runs, including runs from forks, must never
    hold provider authority.
  EOT
  type        = list(string)
  default     = ["push", "workflow_dispatch", "schedule"]

  validation {
    condition     = length(var.allowed_event_names) > 0
    error_message = "At least one event name must be authorised."
  }

  validation {
    condition     = !contains(var.allowed_event_names, "pull_request") && !contains(var.allowed_event_names, "pull_request_target")
    error_message = "Pull request events must never hold delivery authority; they can be triggered from an untrusted fork."
  }

  validation {
    condition = (
      length(var.allowed_event_names) == 3 &&
      toset(var.allowed_event_names) == toset(["push", "workflow_dispatch", "schedule"])
    )
    error_message = "Only push, workflow_dispatch, and schedule may obtain delivery trust; schedule is reserved for exact-workflow read-only drift."
  }
}

variable "candidate_subjects" {
  description = <<-EOT
    Test-only input. Candidate OIDC token claim sets to evaluate against the policy,
    so that the exclusion rules can be asserted offline. Production stacks leave this
    empty; it creates no resource and reaches no provider.
  EOT
  type = list(object({
    name                = string
    repository          = string
    repository_id       = string
    repository_owner_id = string
    ref                 = string
    ref_type            = string
    job_workflow_ref    = string
    event_name          = string
  }))
  default = []
}
