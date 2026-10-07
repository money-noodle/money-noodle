variable "platform_state_bucket" {
  description = "State bucket holding the platform stack's published contract. Supplied at apply; never committed."
  type        = string
}

variable "bootstrap_state_bucket" {
  description = "State bucket holding the bootstrap stack's published contract, read to learn the job's runtime identity. Supplied at apply; never committed."
  type        = string
}

variable "job_name" {
  description = "Cloud Run Job name, and the key of this job's runtime identity in the bootstrap contract (ADR-0013 §1: `engine-restore-runtime`)."
  type        = string
  default     = "engine-restore"

  validation {
    condition     = var.job_name == "engine-restore"
    error_message = "This stack declares the restore job only; its name is the identity key and stays pinned."
  }
}

variable "image_name" {
  description = "Image name within the Artifact Registry repository. One image serves every job in the family (ADR-0013 §1)."
  type        = string
  default     = "engine-jobs"
}

variable "image_digest" {
  description = "Immutable `sha256:` digest of the engine-jobs image for this reviewed commit."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be a full sha256 digest; deploying by tag breaks attribution and rollback (ADR-0005)."
  }
}

variable "artifact_version" {
  description = "Attributable artifact version."
  type        = string
}

variable "source_commit" {
  description = "Reviewed commit the artifact was built from."
  type        = string
}

variable "restore_arguments" {
  description = <<-EOT
    Arguments passed to the restore entrypoint at execution: the staged archive
    root, the workstation copy and the evidence output directory, as mounted on
    the execution. Supplied at apply by the maintainer for the one-time run and
    never committed, because the archive and workstation locations are inputs
    and not defaults (SECURITY.md). Empty by default, which makes the job print
    its usage and exit without touching anything.
  EOT
  type        = list(string)
  default     = []
}

variable "accessible_secret_ids" {
  description = <<-EOT
    Secret Manager secret ids this job may read: the `engine_writer` connection
    string and the archive read credential, both declared as empty containers in
    the platform stack with their accessor grant to `engine-restore-runtime`
    (ADR-0013 §2, #250 pattern). Declared intent only; the grant lives beside the
    container, because this apply holds no Secret Manager authority (#217).
  EOT
  type        = list(string)
  default = [
    "engine-restore-writer-database-url",
    "engine-restore-archive-read-credential",
  ]
}

variable "secret_environment" {
  description = <<-EOT
    Environment variables injected from Secret Manager by reference, keyed by
    variable name. `ENGINE_RESTORE_WRITER_DATABASE_URL` is the connection string
    for `engine_writer`; `ENGINE_RESTORE_ARCHIVE_READ_CREDENTIAL` is the read-only
    credential the operator uses to stage the archive for the execution. No value
    appears here, in a plan, or in state.
  EOT
  type        = map(string)
  default = {
    ENGINE_RESTORE_WRITER_DATABASE_URL     = "engine-restore-writer-database-url"
    ENGINE_RESTORE_ARCHIVE_READ_CREDENTIAL = "engine-restore-archive-read-credential"
  }
}

variable "restore_secret_binding_enabled" {
  description = <<-EOT
    Whether the job binds its two secret references. **Off.** Correct to turn on
    only once both containers exist, each carries a version, and
    `engine-restore-runtime` may read them: the maintainer actions in
    docs/operations/restoring-the-v1-archive.md. Cloud Run refuses a job that
    references a secret which does not exist, so this must not be set true in an
    environment whose containers have not been created. Turning it on is the last
    one-line change before the one-time execution, exactly as #219 and #250 did.
  EOT
  type        = bool
  default     = false
}

variable "timeout_seconds" {
  description = "Execution timeout. The verified v1 restore drill moved about 1.4 GB; one hour is generous and bounded."
  type        = number
  default     = 3600
}

variable "cpu" {
  description = "CPU limit for the execution."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit for the execution. The restore holds the decompressed tree in memory while it verifies; sized for the inventory's stated archive, to be revisited against the execution's own evidence."
  type        = string
  default     = "4Gi"
}

variable "deletion_protection" {
  description = "Whether the job resists `destroy`. Off by default: a one-time job is retired after its evidence is merged."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Additional resource labels."
  type        = map(string)
  default     = {}
}
