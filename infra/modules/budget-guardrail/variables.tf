variable "project_id" {
  description = "Project owning the notification channels."
  type        = string
}

variable "project_number" {
  description = <<-EOT
    Numeric project number the budget filter scopes to. Supplied at bootstrap and
    never committed: budget filters take project numbers, not project ids.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.project_number))
    error_message = "project_number must be the numeric Google Cloud project number."
  }
}

variable "billing_account_id" {
  description = <<-EOT
    Billing account the budget is attached to. Supplied at bootstrap through a
    variable and never committed, per the issue's recovery-and-cleanup rule that
    billing data does not go into issues or Git.
  EOT
  type        = string
  sensitive   = true
}

variable "display_name" {
  description = "Budget display name."
  type        = string
  default     = "Money Noodle platform monthly ceiling"
}

variable "monthly_ceiling" {
  description = "Monthly ceiling. The maintainer accepted USD 30 for the first slice."
  type        = number
  default     = 30

  validation {
    condition     = var.monthly_ceiling > 0 && var.monthly_ceiling <= 100
    error_message = "Raising the ceiling above USD 100 is a maintainer decision that needs its own record, not a variable default change."
  }
}

variable "currency_code" {
  description = "Budget currency. USD, matching the accepted ceiling and the dated pricing evidence, which performs no currency conversion."
  type        = string
  default     = "USD"
}

variable "threshold_percents" {
  description = "Actual-spend alert thresholds as percentages. The maintainer accepted 50, 80, and 100."
  type        = list(number)
  default     = [50, 80, 100]

  validation {
    condition = (
      contains(var.threshold_percents, 50) &&
      contains(var.threshold_percents, 80) &&
      contains(var.threshold_percents, 100)
    )
    error_message = "The accepted 50, 80, and 100 percent thresholds must all be present; removing one is a maintainer decision."
  }
}

variable "forecast_alert" {
  description = "Whether to additionally alert when forecast spend reaches the ceiling, which warns while it is still actionable."
  type        = bool
  default     = true
}

variable "alert_email_addresses" {
  description = "Addresses notified. Supplied at bootstrap; never committed."
  type        = list(string)

  validation {
    condition     = length(var.alert_email_addresses) > 0
    error_message = "A budget with no notification channel is not a control."
  }
}
