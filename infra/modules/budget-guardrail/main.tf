terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

# ADR-0007: the budget exists before the first remote deployment, not after the
# first surprising bill. Free allotments are per billing account, so they will be
# consumed faster as projects are added and the first real charge would otherwise
# arrive without warning.

resource "google_monitoring_notification_channel" "budget" {
  for_each = toset(var.alert_email_addresses)

  project      = var.project_id
  display_name = "Budget alerts (${each.value})"
  type         = "email"

  labels = {
    email_address = each.value
  }

  # A disabled notification channel is a budget with no alert.
  enabled = true
}

resource "google_billing_budget" "monthly_ceiling" {
  billing_account = var.billing_account_id
  display_name    = var.display_name

  budget_filter {
    projects = ["projects/${var.project_number}"]
    # Credits are excluded so that a promotional credit cannot mask real spend
    # approaching the ceiling.
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
    calendar_period        = "MONTH"
  }

  amount {
    specified_amount {
      currency_code = var.currency_code
      units         = tostring(var.monthly_ceiling)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.threshold_percents
    content {
      threshold_percent = threshold_rules.value / 100
      spend_basis       = "CURRENT_SPEND"
    }
  }

  # Forecast alerting at the ceiling gives warning before the ceiling is actually
  # reached, which is the only kind of warning that is still actionable.
  dynamic "threshold_rules" {
    for_each = var.forecast_alert ? [100] : []
    content {
      threshold_percent = 1.0
      spend_basis       = "FORECASTED_SPEND"
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [
      for channel in google_monitoring_notification_channel.budget : channel.id
    ]
    # The budget notifies the maintainer. It does not disable billing: an
    # automatic shutdown would turn a cost surprise into an outage, and the
    # accepted design surfaces conditions rather than silently acting on them.
    disable_default_iam_recipients = false
  }
}
