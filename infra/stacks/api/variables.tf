variable "platform_state_bucket" {
  description = "State bucket holding the platform stack's published contract. Supplied at apply; never committed."
  type        = string
}

variable "bootstrap_state_bucket" {
  description = "State bucket holding the bootstrap stack's published contract, read to learn the runtime and deployer identities. Supplied at apply; never committed."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "platform-api"

  validation {
    condition     = var.service_name == "platform-api"
    error_message = "The API stack must identify its application as platform-api."
  }
}

variable "image_name" {
  description = "Image name within the Artifact Registry repository."
  type        = string
  default     = "platform-api"
}

variable "image_digest" {
  description = "Immutable `sha256:` digest published by the delivery workflow for this reviewed commit."
  type        = string
}

variable "artifact_version" {
  description = "Attributable artifact version."
  type        = string
}

variable "source_commit" {
  description = "Reviewed commit the artifact was built from."
  type        = string
}

variable "revision_suffix" {
  description = "Revision name suffix set by the delivery workflow, so a later rollback can name this revision."
  type        = string
  default     = null
}

variable "rollback_revision" {
  description = "Existing revision to send all traffic to. Set only when rolling back."
  type        = string
  default     = null
}

variable "allow_unauthenticated" {
  description = <<-EOT
    Whether `allUsers` may invoke this service. Default false, because the
    accepted exposure order creates the service privately, verifies it
    independently, and only then exposes it as a separate reviewed step. The
    accepted public `api.noodle.money` target is the end state, not the state
    the creating apply may produce.

    Nothing in the pipeline supplies this value. It is set only by a committed
    `exposure.tfvars` in this directory, reviewed as its own pull request, which
    every job planning this stack passes by `-var-file` when it exists. Applying
    a plan that changes the resulting binding needs the distinct typed
    confirmation and passes the saved-plan exposure guard first (#180).
  EOT
  type        = bool
  default     = false
}

variable "authorised_invoker_members" {
  description = <<-EOT
    Additional IAM members granted service-level `run.invoker`, beyond the web
    runtime identity and the post-apply verifier that this stack always grants
    from the bootstrap contract. Empty by default: a further invoker is a
    reviewed decision, not a convenience.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for member in var.authorised_invoker_members :
      startswith(member, "serviceAccount:") || startswith(member, "group:")
    ])
    error_message = "An additional invoker must be a service account or a group. Public access is the separate `allow_unauthenticated` step (ADR-0005)."
  }
}

variable "accessible_secret_ids" {
  description = <<-EOT
    Secret Manager secret ids the API may read. Defaults to the read-only paper
    projection's connection string, declared as an empty container by the platform
    stack (ADR-0012, #209). Granting access to a container with no version is
    deliberate and harmless: the grant is what lets the maintainer supply the value
    without a second apply.
  EOT
  type        = list(string)
  default     = ["platform-api-projection-database-url"]
}

variable "secret_environment" {
  description = <<-EOT
    Environment variables injected from Secret Manager by reference, keyed by
    variable name.

    `PLATFORM_API_PROJECTION_DATABASE_URL` is the connection string for the
    SELECT-only role on the existing public paper projection. The API reads four
    tables through it and refuses readiness if the role holds more than SELECT or
    the database is unreachable (ADR-0012). No value appears here, in a plan, or in
    state; the maintainer adds the secret version out of band.
  EOT
  type        = map(string)
  default = {
    PLATFORM_API_PROJECTION_DATABASE_URL = "platform-api-projection-database-url"
  }
}

variable "projection_secret_binding_enabled" {
  description = <<-EOT
    Whether this revision binds the projection connection string from Secret
    Manager. **On.**

    This default is only correct once the secret container exists, carries a version,
    and is readable by this service's runtime identity. Those are steps 2 and 3 of
    "Enabling the projection secret" in `infra/bootstrap.md`, done by the maintainer
    outside any deploy; turning the default on is step 4, and it is the last thing to
    merge for exactly that reason (#219, after #217).

    It stays a variable rather than becoming unconditional, because it is the
    documented way to take the reference back out: setting it to false renders a
    revision that binds no secret at all, which is how a projection incident is
    contained without reverting the port. The API already handles that state
    honestly — readiness passes and no endpoint claims projection data — so turning
    the binding off degrades the service rather than breaking it (ADR-0012).

    Changing it is a reviewed one-line change either way. Enabling or disabling a
    credential path is a decision with a pull request behind it rather than a side
    effect of a release, and Cloud Run refuses a revision referencing a secret that
    does not exist, so this must not be set true in an environment whose container
    has not been created.
  EOT
  type        = bool
  default     = true
}

variable "trace_sample_ratio" {
  description = "Head sampling ratio."
  type        = number
  default     = 1
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
