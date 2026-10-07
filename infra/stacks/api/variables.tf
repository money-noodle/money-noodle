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
  default = [
    "platform-api-projection-database-url",
    # #242, ADR-0013. Three database roles and three identity values, each an
    # empty container the maintainer fills out of band. Declared intent only: the
    # `secretAccessor` grant is in the maintainer-applied platform stack, because
    # this apply holds no Secret Manager authority at all (#217, #224).
    "platform-api-engine-reader-database-url",
    "platform-api-engine-recorder-database-url",
    "platform-api-account-database-url",
    "platform-api-identity-audience",
    "platform-api-identity-issuer",
    "platform-api-identity-account-id",
  ]
}

variable "secret_environment" {
  description = <<-EOT
    Environment variables injected from Secret Manager by reference, keyed by
    variable name.

    `PLATFORM_API_PROJECTION_DATABASE_URL` is the connection string for the
    SELECT-only role on the existing public paper projection. The API reads four
    tables through it and refuses readiness if the role holds more than SELECT or
    the database is unreachable (ADR-0012).

    The six that follow are the signed-in surface (#242, ADR-0013). The two engine
    connections are separate because the roles behind them are separate
    authorities — `engine_reader` holds SELECT on a granted subset and can record
    nothing, `engine_control_recorder` holds INSERT on the one append-only control
    table and can read nothing — and one variable carrying both would be one merge
    away from a role that does both. The account connection is this service's own
    schema. The three identity values are the audience, the issuer and the single
    account's identifier.

    No value appears here, in a plan, or in state; the maintainer adds each secret
    version out of band. An absent value is a legitimate state: the API serves the
    public dashboard and answers the signed-in routes as not configured.
  EOT
  type        = map(string)
  default = {
    PLATFORM_API_PROJECTION_DATABASE_URL      = "platform-api-projection-database-url"
    PLATFORM_API_ENGINE_READER_DATABASE_URL   = "platform-api-engine-reader-database-url"
    PLATFORM_API_ENGINE_RECORDER_DATABASE_URL = "platform-api-engine-recorder-database-url"
    PLATFORM_API_ACCOUNT_DATABASE_URL         = "platform-api-account-database-url"
    PLATFORM_API_IDENTITY_AUDIENCE            = "platform-api-identity-audience"
    PLATFORM_API_IDENTITY_ISSUER              = "platform-api-identity-issuer"
    PLATFORM_API_IDENTITY_ACCOUNT_ID          = "platform-api-identity-account-id"
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

variable "identity_secret_binding_enabled" {
  description = <<-EOT
    Whether this revision binds the six signed-in references — the two engine
    connections, this service's own schema, and the three identity values — from
    Secret Manager. **Off.**

    This default is only correct once the six containers exist, each carries a
    version, and the service's runtime identity may read them. Those are the
    maintainer actions of `#250` — platform stack applied, versions entered out of
    band — completed 2026-10-07; turning the default on is the last one-line change
    of that rollout, with its own pull request, exactly as `#219`/`#220` did for the
    projection's gate. Cloud Run refuses a revision that references a secret which
    does not exist, so this must not be set true in an environment whose containers
    have not been created.

    It stays a variable afterwards for the same reason the projection's does: it is
    the documented way to take the references back out. The API already handles the
    absent state honestly — it serves the public dashboard and answers the
    signed-in routes as not configured — so turning the binding off degrades the
    service rather than breaking it (ADR-0013 §4).
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
