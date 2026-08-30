output "secret_ids" {
  description = "Declared secret container ids. Empty for the first slice."
  value       = sort(keys(google_secret_manager_secret.secret))
}

output "custody_register" {
  description = <<-EOT
    Owner, consuming principal, rotation interval, revocation procedure, and
    recovery path for every declared secret. Published so custody is reviewable
    without reading any secret value — there is nothing here a value could leak
    through.
  EOT
  value = {
    for id, secret in var.secrets : id => {
      owner                  = secret.owner
      consuming_principal    = secret.consuming_principal
      rotation_interval_days = secret.rotation_interval_days
      revocation_procedure   = secret.revocation_procedure
      recovery_path          = secret.recovery_path
    }
  }
}
