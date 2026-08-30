variable "project_id" {
  description = "Google Cloud project that owns the state bucket. Supplied at bootstrap; never committed."
  type        = string
}

variable "region" {
  description = "Bucket location. `us-west1` per ADR-0004, which is also one of the three regions carrying the Cloud Storage always-free allotment."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "stack" {
  description = "Name of the stack whose state this bucket holds."
  type        = string

  validation {
    condition     = contains(["bootstrap", "platform", "web", "api"], var.stack)
    error_message = "stack must be one of bootstrap, platform, web, or api. A new stack is a reviewed decision, not a typo."
  }
}

variable "deployer_service_account_email" {
  description = "The single federated deployer principal permitted to read and write this state."
  type        = string
}

variable "state_versions_retained" {
  description = "Number of noncurrent state versions to retain for restore."
  type        = number
  default     = 20

  validation {
    condition     = var.state_versions_retained >= 5
    error_message = "Retain at least five noncurrent versions; a restore path with no history is not a restore path."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Age at which a noncurrent state version is deleted."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 30
    error_message = "Retain noncurrent state for at least thirty days; corruption is often noticed well after it happens."
  }
}

variable "kms_key_name" {
  description = "Optional customer-managed encryption key. Null uses provider-managed encryption, which ADR-0006 accepts as the minimum."
  type        = string
  default     = null
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
