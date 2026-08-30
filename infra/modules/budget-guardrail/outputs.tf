output "budget_name" {
  description = "Resource name of the budget."
  value       = google_billing_budget.monthly_ceiling.name
}

output "monthly_ceiling" {
  description = "Accepted monthly ceiling, published so a drift report can show it without reading the billing account."
  value       = "${var.currency_code} ${var.monthly_ceiling}"
}

output "threshold_percents" {
  description = "Actual-spend alert thresholds in force."
  value       = var.threshold_percents
}

output "notification_channel_ids" {
  description = "Monitoring notification channels the budget alerts through."
  value       = [for channel in google_monitoring_notification_channel.budget : channel.id]
}
