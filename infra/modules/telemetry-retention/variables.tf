variable "project_id" {
  description = "Google Cloud project. Supplied at bootstrap; never committed."
  type        = string
}

variable "region" {
  description = "Location for the debug log bucket."
  type        = string
}

variable "log_retention_days" {
  description = <<-EOT
    Retention for operational logs. ADR-0007's accepted starting default for debug
    logs is 7 to 14 days; operational logs sit at the upper end of that window
    because they are what an incident is reconstructed from.
  EOT
  type        = number
  default     = 14

  validation {
    condition     = var.log_retention_days >= 7 && var.log_retention_days <= 30
    error_message = "Operational log retention must be between 7 and 30 days. A longer window is a cost and privacy decision needing its own record."
  }
}

variable "debug_log_retention_days" {
  description = "Retention for debug-severity logs, at the short end of the accepted 7-to-14-day window. Null routes debug logs nowhere separate."
  type        = number
  default     = 7

  validation {
    condition     = var.debug_log_retention_days == null || (var.debug_log_retention_days >= 1 && var.debug_log_retention_days <= 14)
    error_message = "Debug log retention must be between 1 and 14 days when configured."
  }
}

variable "debug_bucket_id" {
  description = "Bucket id for debug logs."
  type        = string
  default     = "debug-logs"
}
