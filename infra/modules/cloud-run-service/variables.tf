variable "project_id" {
  description = "Google Cloud project. Supplied at bootstrap; never committed."
  type        = string
}

variable "region" {
  description = "Cloud Run region. `us-west1` per ADR-0004."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name. One service per deployable project."
  type        = string

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$", var.service_name))
    error_message = "service_name must be a valid Cloud Run service name: lowercase, starting with a letter, at most 49 characters."
  }
}

variable "runtime_service_account_id" {
  description = "Account id for this service's own runtime identity. Distinct per service, so blast radius is mechanical rather than conventional."
  type        = string

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{4,28}[a-z0-9])$", var.runtime_service_account_id))
    error_message = "runtime_service_account_id must be 6 to 30 characters, lowercase, starting with a letter."
  }
}

variable "repository_url" {
  description = "Artifact Registry repository path, without image name or digest."
  type        = string
}

variable "image_name" {
  description = "Image name within the repository."
  type        = string
}

variable "image_digest" {
  description = "Immutable `sha256:` digest of the image to run. Never a tag."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be a full `sha256:` digest. Deploying by mutable tag breaks attribution and rollback (ADR-0005)."
  }
}

variable "artifact_version" {
  description = "Attributable artifact version reported by the service and attached to every telemetry signal."
  type        = string
}

variable "source_commit" {
  description = "Reviewed source commit the artifact was built from."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.source_commit))
    error_message = "source_commit must be a full 40-character commit SHA, so `what is running` is answerable from the commit."
  }
}

variable "environment" {
  description = "Deployment environment name. Production is the only standing environment (`delivery.md`)."
  type        = string
  default     = "production"
}

variable "revision_suffix" {
  description = "Suffix for the revision name, letting a rollback target an existing revision by name. Null lets Cloud Run generate one."
  type        = string
  default     = null
}

variable "rollback_revision" {
  description = <<-EOT
    Existing revision name to send all traffic to. When set, no new revision is
    created and traffic is reassigned — the accepted rollback mechanism, which
    requires no rebuild and does not touch the other service.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.rollback_revision == null || can(regex("^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$", var.rollback_revision))
    error_message = "rollback_revision must be a valid existing Cloud Run revision name."
  }
}

variable "container_port" {
  description = "Port the container listens on."
  type        = number
}

variable "cpu" {
  description = "CPU limit."
  type        = string
}

variable "memory" {
  description = "Memory limit."
  type        = string
}

variable "min_instances" {
  description = "Minimum instances. Zero keeps idle cost at zero, per `principles.md` and the accepted cost model."
  type        = number
  default     = 0

  validation {
    condition     = var.min_instances == 0
    error_message = "The first slice runs scale-to-zero. A standing minimum instance count is a cost and architecture decision that needs its own record."
  }
}

variable "max_instances" {
  description = "Maximum instances. A bound on both blast radius and spend."
  type        = number
  default     = 4

  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 20
    error_message = "max_instances must be between 1 and 20 while the USD 30 ceiling stands."
  }
}

variable "max_concurrency" {
  description = "Maximum concurrent requests per instance."
  type        = number
  default     = 80
}

variable "request_timeout_seconds" {
  description = "Request timeout."
  type        = number
  default     = 30
}

variable "readiness_path" {
  description = "Path proving the deployment is ready to serve its declared contract."
  type        = string
  default     = "/health/ready"
}

variable "liveness_path" {
  description = "Path proving the process can answer."
  type        = string
  default     = "/health/live"
}

variable "startup_failure_threshold" {
  description = "Consecutive startup probe failures before the revision is considered failed and traffic is not moved to it."
  type        = number
  default     = 10
}

variable "ingress" {
  description = "Cloud Run ingress setting."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"

  validation {
    condition = contains([
      "INGRESS_TRAFFIC_ALL",
      "INGRESS_TRAFFIC_INTERNAL_ONLY",
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    ], var.ingress)
    error_message = "ingress must be one of the documented Cloud Run ingress settings."
  }
}

variable "allow_unauthenticated" {
  description = "Whether `allUsers` may invoke. True for the interim public `*.run.app` entry point."
  type        = bool
  default     = false
}

variable "authorised_invoker_members" {
  description = "IAM members granted `run.invoker`, for example the web runtime identity on the API service."
  type        = list(string)
  default     = []
}

variable "accessible_secret_ids" {
  description = "Secret Manager secret ids this service may read. Empty for the first slice, which needs no operational secret."
  type        = list(string)
  default     = []
}

variable "telemetry_endpoint" {
  description = "OTLP endpoint. Null disables telemetry configuration and the telemetry IAM grants with it."
  type        = string
  default     = null
}

variable "trace_sample_ratio" {
  description = "Head sampling ratio, propagated through trace context so it can be lowered later without re-instrumenting."
  type        = number
  default     = 1

  validation {
    condition     = var.trace_sample_ratio > 0 && var.trace_sample_ratio <= 1
    error_message = "trace_sample_ratio must be greater than zero and at most one."
  }
}

variable "extra_env" {
  description = <<-EOT
    Additional non-secret typed configuration, such as the API base URL the web
    is configured with. Secret values never travel this way: they are mounted
    from Secret Manager by the consuming service.
  EOT
  type        = map(string)
  default     = {}
}

variable "deletion_protection" {
  description = "Whether the provider refuses to destroy this service. True by default; removing a running service is a reviewed change."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
