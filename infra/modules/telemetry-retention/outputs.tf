output "retention_policy" {
  description = <<-EOT
    Retention actually in force per signal class, and whether this configuration
    set it. ADR-0007 asks for explicit retention rather than provider defaults;
    where the provider does not accept a retention setting at all, that is stated
    here rather than left to look configured.
  EOT
  value = {
    operational_logs = {
      days       = var.log_retention_days
      configured = true
      note       = "Set on the _Default log bucket."
    }
    debug_logs = {
      days       = var.debug_log_retention_days
      configured = var.debug_log_retention_days != null
      note       = var.debug_excluded_from_default_bucket ? "Routed to a separate log bucket and excluded from _Default, so this window is the only copy." : "Routed to a separate log bucket AND still copied to _Default, so the effective window is the longer of the two. The accepted policy puts both at 14 days precisely so the two agree."
      effective_days = var.debug_log_retention_days == null ? var.log_retention_days : (
        var.debug_excluded_from_default_bucket ? var.debug_log_retention_days : max(var.debug_log_retention_days, var.log_retention_days)
      )
    }
    audit_logs = {
      days       = 400
      configured = false
      note       = "Fixed by the provider on the _Required bucket and not shortenable. Audit is not telemetry (ADR-0007) and gets its own design before any real audit obligation exists."
    }
    traces = {
      days       = 30
      configured = false
      note       = "Google's documented 30-day _Trace retention, accepted on 2026-09-15 as a deliberate exception to the former 3-to-7-day target. It is provider behaviour, not an IaC-configurable deletion guarantee, and no live aging has been observed."
    }
    metrics = {
      days       = 730
      configured = false
      note       = "Google's documented 24 months for OTLP metrics with progressive downsampling: original frequency for one week, one-minute intervals for the next five weeks, then ten-minute intervals. Accepted as provider behaviour on 2026-09-15; not 24 months of full-resolution detail and not a configurable TTL."
    }
  }
}
