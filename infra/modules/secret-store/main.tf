terraform {
  required_version = "1.12.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.0"
    }
  }
}

# ADR-0005: the managed secret store is declared and reachable from the first
# apply even though the first slice stores nothing in it, so that the first
# capability needing a credential does not also have to invent custody under
# delivery pressure.
#
# This module creates secret *containers* and their access boundary. It never
# creates a secret *version*: a value would have to pass through OpenTofu
# variables, plans, and state to get here, and secret values never enter Git,
# images, build logs, telemetry, or handoffs. Versions are added out of band by
# the maintainer and the container is then already waiting for them.

locals {
  # One grant per (secret, member) pair, flattened so each is its own address and
  # a removed consumer is a removed resource rather than an edited list.
  accessor_grants = {
    for grant in flatten([
      for secret_id, members in var.accessor_members : [
        for member in members : {
          secret_id = secret_id
          member    = member
        }
      ]
    ]) : "${grant.secret_id}/${grant.member}" => grant
  }

  metadata_grants = {
    for grant in flatten([
      for secret_id, members in var.metadata_reader_members : [
        for member in members : {
          secret_id = secret_id
          member    = member
        }
      ]
    ]) : "${grant.secret_id}/${grant.member}" => grant
  }

  # Not a variable, deliberately. The role a metadata reader receives is a custody
  # decision, not a deployment knob: an input here would be the one place a future
  # edit could quietly pass `roles/secretmanager.admin` and still satisfy every
  # validation in this module.
  #
  # `roles/secretmanager.viewer` is the narrowest predefined role that lets a
  # principal refresh both resources this module declares. It carries
  # `secretmanager.secrets.get` and `secretmanager.secrets.getIamPolicy`, which is
  # exactly what a plan of the container and of an IAM member on it reads, plus
  # list and version-*metadata* permissions. It does **not** carry
  # `secretmanager.versions.access`, so a holder can see that a version exists and
  # never what it contains, and it carries nothing that mutates: no create, no
  # update, no destroy, no `setIamPolicy` (#224, ADR-0005 2026-10-05 amendment).
  #
  # A project custom role with only the two `get` permissions would be narrower
  # still on paper, and was rejected: a `google_project_iam_custom_role` in this
  # stack's state is itself refreshed by the deployer on every pipeline plan, which
  # needs `iam.roles.get` — a permission the deployer's enumerated roles do not
  # include. It would move the same 403 from the secret to the role.
  metadata_reader_role = "roles/secretmanager.viewer"
}

resource "google_secret_manager_secret" "secret" {
  for_each = var.secrets

  project   = var.project_id
  secret_id = each.key

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  # Labels carry label-safe values only. A provider label accepts lower-case
  # letters, digits, hyphen and underscore, and a mocked provider never applies
  # that rule: the first real apply was refused for the space in a custody phrase
  # (#221). Custody facts are prose, so they are annotations, below.
  labels = merge(var.labels, {
    "managed-by" = "opentofu"
  })

  annotations = {
    # Every secret records owner, consuming principal, rotation interval,
    # revocation procedure, and recovery path (ADR-0005). Recording them beside
    # the secret is what keeps them true; a wiki page drifts.
    "owner"                  = each.value.owner
    "consuming-principal"    = each.value.consuming_principal
    "rotation-interval-days" = tostring(each.value.rotation_interval_days)
    "revocation-procedure"   = each.value.revocation_procedure
    "recovery-path"          = each.value.recovery_path
  }

  # Provider-scheduled rotation is deliberately not configured here. Secret
  # Manager's rotation schedule publishes to a Pub/Sub topic, which means a
  # topic, a subscription, and a responder — infrastructure that would exist to
  # serve zero secrets. The interval is recorded as an annotation now so the
  # obligation is written down, and the scheduling mechanism is built with the
  # first real secret, which is also the first time it can be tested end to end.

  lifecycle {
    prevent_destroy = true
  }
}

# The access boundary for those containers, declared beside them.
#
# Per secret and per member, never a project-level role, and never the deployer:
# the identity that runs a deploy manages containers, not contents (ADR-0005).
# Creating this binding needs Secret Manager authority, which belongs to the
# stack a maintainer applies rather than to the routine release path (#217).
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = local.accessor_grants

  project = var.project_id
  # Through the resource, so the grant cannot be created before the container it
  # applies to, and cannot survive a secret this store stopped declaring.
  secret_id = google_secret_manager_secret.secret[each.value.secret_id].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}

# Metadata read for the identities that must *plan* these resources without ever
# reading a value.
#
# Every pipeline plan of the stack holding this module refreshes the containers
# above and every IAM member on them, as the federated deployer. With no grant at
# all that refresh fails with 403 on `secretmanager.secrets.get`, which is what
# blocked every routine deploy after the first container was created (#224). The
# answer is the narrowest read that makes a plan possible, at secret level only:
# never a project-level Secret Manager role, never a value, never a mutation.
resource "google_secret_manager_secret_iam_member" "metadata_reader" {
  for_each = local.metadata_grants

  project = var.project_id
  # Through the resource, as above: a reader cannot be granted on a container this
  # store does not declare, and the grant goes when the container goes.
  secret_id = google_secret_manager_secret.secret[each.value.secret_id].secret_id
  role      = local.metadata_reader_role
  member    = each.value.member
}
