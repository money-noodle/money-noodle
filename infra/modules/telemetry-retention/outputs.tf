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
      note       = "Routed to a separate log bucket so a shorter window is expressible."
    }
    audit_logs = {
      days       = 400
      configured = false
      note       = "Fixed by the provider on the _Required bucket and not shortenable. Audit is not telemetry (ADR-0007) and gets its own design before any real audit obligation exists."
    }
    traces = {
      days       = 30
      configured = false
      note       = "UNVERIFIED against a live project: Cloud Trace retention is not exposed as a configurable field by this provider. The accepted 3-to-7-day target for detailed traces is therefore not met by configuration and is carried as an open item, not as a satisfied requirement."
    }
    metrics = {
      days       = null
      configured = false
      note       = "UNVERIFIED against a live project: Cloud Monitoring metric retention is not exposed as a configurable field by this provider. The accepted 30-to-90-day operational-metric target is carried as an open item."
    }
  }
}
