variable "platform_state_bucket" {
  description = "State bucket holding the platform stack's published contract. Supplied at apply; never committed."
  type        = string
}

variable "api_state_bucket" {
  description = "State bucket holding the API stack's published contract, read to learn the API origin."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "web"
}

variable "runtime_service_account_id" {
  description = "Account id for the web's own runtime identity, mechanically distinct from the API's."
  type        = string
  default     = "web-runtime"
}

variable "image_name" {
  description = "Image name within the Artifact Registry repository."
  type        = string
  default     = "web"
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

variable "api_base_url_override" {
  description = <<-EOT
    Explicit API origin, overriding the value read from the API stack's published
    contract. This is the seam the reviewed `api.noodle.money` cutover moves
    through, without any change to this stack's structure. It is never used to
    point the web at a developer laptop.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.api_base_url_override == null || startswith(coalesce(var.api_base_url_override, "https://"), "https://")
    error_message = "The API origin must be HTTPS. The web never falls back to a local process (`overview.md` failure rules)."
  }
}

variable "trace_sample_ratio" {
  description = "Head sampling ratio."
  type        = number
  default     = 1
}

variable "extra_env" {
  description = "Additional non-secret typed configuration."
  type        = map(string)
  default     = {}
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
