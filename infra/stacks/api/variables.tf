variable "platform_state_bucket" {
  description = "State bucket holding the platform stack's published contract. Supplied at apply; never committed."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "platform-api"
}

variable "runtime_service_account_id" {
  description = "Account id for the API's own runtime identity, mechanically distinct from the web's."
  type        = string
  default     = "platform-api-runtime"
}

variable "image_name" {
  description = "Image name within the Artifact Registry repository."
  type        = string
  default     = "platform-api"
}

variable "image_digest" {
  description = "Immutable `sha256:` digest published by the delivery workflow for this reviewed commit."
  type        = string
}

variable "artifact_version" {
  description = "Attributable artifact version."
  type        = string
}

variable "source_commit" {
  description = "Reviewed commit the artifact was built from."
  type        = string
}

variable "revision_suffix" {
  description = "Revision name suffix set by the delivery workflow, so a later rollback can name this revision."
  type        = string
  default     = null
}

variable "rollback_revision" {
  description = "Existing revision to send all traffic to. Set only when rolling back."
  type        = string
  default     = null
}

variable "allow_unauthenticated" {
  description = "Whether `allUsers` may invoke, matching the accepted public `api.noodle.money` target."
  type        = bool
  default     = true
}

variable "authorised_invoker_members" {
  description = <<-EOT
    IAM members granted `run.invoker`. The web runtime identity belongs here, so
    the least-privilege path from web to API exists and is testable even while the
    service is also publicly invocable.
  EOT
  type        = list(string)
  default     = []
}

variable "accessible_secret_ids" {
  description = "Secret Manager secret ids the API may read. Empty for the first slice."
  type        = list(string)
  default     = []
}

variable "trace_sample_ratio" {
  description = "Head sampling ratio."
  type        = number
  default     = 1
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
