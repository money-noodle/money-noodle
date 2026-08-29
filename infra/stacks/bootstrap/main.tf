terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }

  # The one stack that cannot start with remote state, because it creates the
  # buckets remote state lives in. It is applied once with local state and then
  # migrated into the bucket it just made, so that even the bootstrap ends up
  # reconciled into code and remote state rather than living on a laptop.
  #
  # `infra/stacks/bootstrap/backend.gcs.tfbackend.example` holds the migration
  # configuration; `infra/bootstrap.md` holds the procedure and the exact list of
  # values the maintainer supplies.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  state_buckets = {
    bootstrap = "${var.state_bucket_prefix}-bootstrap"
    platform  = "${var.state_bucket_prefix}-platform"
    web       = "${var.state_bucket_prefix}-web"
    api       = "${var.state_bucket_prefix}-api"
  }

  # Only the services bootstrap itself needs. Everything else is enabled by the
  # platform stack, so that the smallest possible surface is turned on by the one
  # apply a human runs by hand.
  required_services = [
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
  ]
}

resource "google_project_service" "bootstrap" {
  for_each = toset(local.required_services)

  project = var.project_id
  service = each.value

  # Disabling an API is a destructive act with effects far outside this stack.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# The single federated deployer principal from ADR-0005. It exists before the
# state buckets so it can be granted access to them as they are created.
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = var.deployer_service_account_id
  display_name = "Delivery deployer"
  description  = "Federated CI principal. Holds no key: it is reachable only by OIDC token exchange from the reviewed delivery workflow."

  depends_on = [google_project_service.bootstrap]
}

module "state" {
  source   = "../../modules/state-bucket"
  for_each = local.state_buckets

  project_id                     = var.project_id
  region                         = var.region
  bucket_name                    = each.value
  stack                          = each.key
  deployer_service_account_email = google_service_account.deployer.email
  labels                         = var.labels

  depends_on = [google_project_service.bootstrap]
}

module "federation" {
  source = "../../modules/workload-identity-federation"

  project_id                  = var.project_id
  deployer_service_account_id = google_service_account.deployer.name
  allowed_audiences           = var.allowed_audiences

  repository_owner       = var.repository_owner
  repository_name        = var.repository_name
  repository_id          = var.repository_id
  repository_owner_id    = var.repository_owner_id
  allowed_refs           = var.allowed_refs
  allowed_workflow_paths = var.allowed_workflow_paths
  allowed_event_names    = var.allowed_event_names

  depends_on = [google_project_service.bootstrap]
}

# Project-level authority for the deployer, granted as named roles rather than a
# broad administrative role. ADR-0005 rejects granting the deployer broad rights
# for convenience: it would make the CI principal the most powerful identity in
# the platform, reachable from any workflow change.
#
# Notably absent: `roles/owner`, `roles/editor`, `roles/secretmanager.admin`,
# and any secretAccessor role. The deployer creates secret containers but cannot
# read the values runtime workloads consume.
resource "google_project_iam_member" "deployer" {
  for_each = toset(var.deployer_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"

  depends_on = [google_project_service.bootstrap]
}
