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
  description = "Accepted monthly ceiling in USD."
  type        = number
  default     = 30
}

variable "budget_threshold_percents" {
  description = "Accepted alert thresholds."
  type        = list(number)
  default     = [50, 80, 100]
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
  description = "Debug log retention."
  type        = number
  default     = 7
}

variable "secrets" {
  description = "Secret containers to declare. Empty for the first slice."
  type = map(object({
    owner                  = string
    consuming_principal    = string
    rotation_interval_days = number
    revocation_procedure   = string
    recovery_path          = string
  }))
  default = {}
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
