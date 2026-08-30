terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

# The federation surface. No provider key, secret key, service account key file,
# or equivalent long-lived credential exists anywhere in this design; GitHub
# presents its per-job OIDC token and receives a short-lived access token in
# exchange, per ADR-0005.

module "trust" {
  source = "../delivery-trust"

  repository_owner       = var.repository_owner
  repository_name        = var.repository_name
  repository_id          = var.repository_id
  repository_owner_id    = var.repository_owner_id
  allowed_refs           = var.allowed_refs
  allowed_workflow_paths = var.allowed_workflow_paths
  allowed_event_names    = var.allowed_event_names
}

resource "google_iam_workload_identity_pool" "delivery" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = "Delivery federation"
  description               = "Short-lived credentials for the reviewed delivery workflow. No long-lived key exists."
  disabled                  = false
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.delivery.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "GitHub Actions"
  description                        = "Accepts GitHub Actions OIDC tokens that satisfy the reviewed trust conjunction."
  disabled                           = false

  # The first gate. Evaluated before any token is exchanged, so a subject failing
  # it never obtains a credential at all — regardless of what IAM bindings exist.
  attribute_condition = module.trust.attribute_condition
  attribute_mapping   = module.trust.attribute_mapping

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"

    # Restricting the audience means a token minted for some other audience —
    # including the default `https://github.com/OWNER` audience a careless
    # workflow might request — is not accepted here.
    allowed_audiences = var.allowed_audiences
  }
}

# The second gate. Even for a token that satisfies the condition above, this
# decides which principal it may impersonate. Written against the exact
# repository attribute; never an owner-wide attribute and never `*`.
resource "google_service_account_iam_member" "deployer_impersonation" {
  service_account_id = var.deployer_service_account_id
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.delivery.name}/${module.trust.principal_set_attribute}"
}
