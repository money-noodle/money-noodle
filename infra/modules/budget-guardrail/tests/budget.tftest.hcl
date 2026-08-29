# Cost containment.
#
# ADR-0007 requires the budget to exist before the first remote deployment rather
# than after the first surprising bill. These tests pin the accepted ceiling and
# thresholds so that lowering the guard is a visible change, not a default edit.

mock_provider "google" {}

variables {
  project_id            = "example-project"
  project_number        = "123456789012"
  billing_account_id    = "example-billing-account"
  alert_email_addresses = ["maintainer@example.test"]
}

run "the_accepted_ceiling_and_thresholds_are_configured" {
  command = plan

  assert {
    condition = one([
      for amount in google_billing_budget.monthly_ceiling.amount :
      one([for specified in amount.specified_amount : specified.units])
    ]) == "30"
    error_message = "The accepted USD 30 monthly ceiling must be what is configured."
  }

  assert {
    condition = one([
      for amount in google_billing_budget.monthly_ceiling.amount :
      one([for specified in amount.specified_amount : specified.currency_code])
    ]) == "USD"
    error_message = "The ceiling is denominated in USD, matching the accepted decision and the dated pricing evidence."
  }

  assert {
    condition = length([
      for rule in google_billing_budget.monthly_ceiling.threshold_rules :
      rule if rule.spend_basis == "CURRENT_SPEND"
    ]) == 3
    error_message = "The accepted 50, 80, and 100 percent actual-spend alerts must all exist."
  }

  assert {
    condition = alltrue([
      for percent in [0.5, 0.8, 1.0] : anytrue([
        for rule in google_billing_budget.monthly_ceiling.threshold_rules :
        rule.threshold_percent == percent && rule.spend_basis == "CURRENT_SPEND"
      ])
    ])
    error_message = "Each of the accepted 50, 80, and 100 percent thresholds must be present at the right level."
  }
}

run "a_promotional_credit_cannot_mask_real_spend" {
  command = plan

  assert {
    condition = one([
      for filter in google_billing_budget.monthly_ceiling.budget_filter :
      filter.credit_types_treatment
    ]) == "EXCLUDE_ALL_CREDITS"
    error_message = "Credits must be excluded, otherwise a credit hides spend approaching the ceiling until the credit runs out."
  }
}

run "a_budget_without_a_notification_channel_is_refused" {
  command = plan

  variables {
    alert_email_addresses = []
  }

  expect_failures = [var.alert_email_addresses]
}

run "dropping_an_accepted_threshold_is_refused" {
  command = plan

  variables {
    threshold_percents = [80, 100]
  }

  expect_failures = [var.threshold_percents]
}

run "quietly_raising_the_ceiling_is_refused" {
  command = plan

  variables {
    monthly_ceiling = 5000
  }

  expect_failures = [var.monthly_ceiling]
}
