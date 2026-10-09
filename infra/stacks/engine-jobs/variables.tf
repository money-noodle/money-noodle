variable "platform_state_bucket" {
  description = "State bucket holding the platform stack's published contract. Supplied at apply; never committed."
  type        = string
}

variable "bootstrap_state_bucket" {
  description = "State bucket holding the bootstrap stack's published contract, read to learn the job's runtime identity. Supplied at apply; never committed."
  type        = string
}

variable "job_name" {
  description = "Cloud Run Job name of the one-time restore job, and the key of its runtime identity in the bootstrap contract (ADR-0013 §1: `engine-restore-runtime`)."
  type        = string
  default     = "engine-restore"

  validation {
    condition     = var.job_name == "engine-restore"
    error_message = "The restore job's name is its identity key and stays pinned."
  }
}

variable "cycle_job_name" {
  description = <<-EOT
    Cloud Run Job name of the scheduled cycle job, and the key of both its runtime
    identity and its trigger identity in the bootstrap contract (ADR-0013 §1:
    `engine-cycle-runtime` runs it, `engine-cycle-scheduler` starts it).

    Pinned for the same reason `job_name` is: the name *is* the identity key, so an
    unpinned name is a job that could be wired to run as another unit's identity.
    This stack declares both jobs and is applied as one unit at one digest; the
    two pins together are the fixed set of jobs it may declare.
  EOT
  type        = string
  default     = "engine-cycle"

  validation {
    condition     = var.cycle_job_name == "engine-cycle"
    error_message = "The cycle job's name is its identity key and stays pinned."
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

variable "stage_mount_path" {
  description = <<-EOT
    Where the staging bucket is mounted on the execution. A path inside the
    container, not an identifier: it names nothing account-specific, which is why
    it can be a default here and in the committed `restore.tfvars`.
  EOT
  type        = string
  default     = "/mnt/stage"

  validation {
    condition     = can(regex("^/[a-z0-9/_-]{2,62}$", var.stage_mount_path))
    error_message = "stage_mount_path must be an absolute container path."
  }
}

variable "restore_arguments" {
  description = <<-EOT
    Arguments passed to the restore entrypoint at execution: the staged archive
    root, the workstation copy and the evidence output directory, which are
    subdirectories of the staged mount.

    Carried in the committed `restore.tfvars` rather than supplied ad hoc,
    because the dispatched apply exposes only the digest, the source commit and
    the confirmation — so there was no reviewed way to set this at all (#241).
    The file holds mount paths and nothing account-specific, exactly as
    `exposure.tfvars` holds one boolean, and it is admitted by the same kind of
    narrow `.gitignore` exception. Empty by default, which makes the job print
    its usage and exit without touching anything.

    An absolute path outside the mount fails the job's own precondition rather
    than producing an execution that cannot find its inputs.
  EOT
  type        = list(string)
  default     = []
}

variable "cycle_arguments" {
  description = <<-EOT
    Arguments passed to the cycle entrypoint at execution: the lane and the tick
    budget. Carried in the committed `cycle.tfvars` on exactly the terms
    `restore.tfvars` is (#241, #243), because the dispatched apply exposes only
    the digest, the source commit and the confirmation.

    `--mode dry` is the committed value and the only lane stage 1 implements. The
    entrypoint accepts `forecast` and `paper` so the argument shape is settled,
    and refuses them at run start with the outcome `mode-not-implemented`, so
    changing this file before the lane is ported cannot execute one.

    `--ticks 4` is v1's cadence inside one short run: four ticks at 15-second
    spacing is one scheduled minute (ADR-0013 §1). Nothing here is
    account-specific; it is two flags and two numbers.
  EOT
  type        = list(string)
  default     = ["--mode", "dry", "--ticks", "4"]

  validation {
    condition = alltrue([
      for argument in var.cycle_arguments :
      can(regex("^(--[a-z-]{3,20}|[a-z]{3,10}|[0-9]{1,2})$", argument))
    ])
    error_message = "A cycle argument is a flag, a lane name or a small number. Anything else — a path, a host, an identifier — does not belong in a committed file (SECURITY.md)."
  }

  validation {
    condition     = !contains(var.cycle_arguments, "live")
    error_message = "There is no live lane. ADR-0013 §5 refuses a live execution path, and the entrypoint would reject the mode anyway."
  }
}

variable "cycle_schedule" {
  description = <<-EOT
    The Cloud Scheduler cron for the cycle job, in UTC. Every minute: one
    scheduled minute is one run of `--ticks 4` at 15-second spacing, which is v1's
    cadence expressed as short runs rather than as a resident worker (ADR-0013 §1,
    §5). A schedule, not an identifier.
  EOT
  type        = string
  default     = "* * * * *"

  validation {
    condition     = can(regex("^[-0-9*/, ]{9,40}$", var.cycle_schedule))
    error_message = "cycle_schedule must be a cron expression."
  }
}

variable "cycle_schedule_paused" {
  description = <<-EOT
    Whether the schedule is created paused. **True** here, so the first apply
    creates a trigger that fires nothing: the job's bring-up order is migration
    0004, the secret version and one hand-started execution read in the evidence
    *before* a cadence starts (docs/operations/engine-cycle.md).

    Un-pausing is a one-line change to the committed `cycle.tfvars` with its own
    pull request, exactly as `restore_secret_binding_enabled` was, so "the engine
    started cycling" is a reviewed event with a diff rather than a console click.
  EOT
  type        = bool
  default     = true
}

variable "cycle_control_epoch" {
  description = <<-EOT
    The control epoch the cycle job evaluates intent against (ADR-0013 §3,
    condition 2), passed as the non-secret `ENGINE_CYCLE_CONTROL_EPOCH`. The same
    mechanism and the same default as the API's
    `PLATFORM_API_ENGINE_CONTROL_EPOCH`: configuration rather than a stored
    counter, because the epoch increments on events neither the API nor this job
    performs — a restore, a reseed, a migration — and a workload that could
    increment it could silently invalidate the operator's standing intent.

    Raise it **with** the event that caused it, and in step with the API's: an
    epoch the two disagree on is an operator whose resume the engine ignores.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.cycle_control_epoch >= 1 && floor(var.cycle_control_epoch) == var.cycle_control_epoch
    error_message = "cycle_control_epoch must be a positive integer."
  }
}

variable "cycle_timeout_seconds" {
  description = <<-EOT
    Execution timeout for one cycle run. Two minutes: four ticks at 15-second
    spacing is 45 seconds of waiting plus the work, and a run that outlives its
    own scheduled minute is a second runner waiting to happen. The store lease
    bounds correctness; this bounds cost.
  EOT
  type        = number
  default     = 120

  validation {
    condition     = var.cycle_timeout_seconds > 0 && var.cycle_timeout_seconds <= 540
    error_message = "A cycle run is short by design; a long timeout would let one run outlive several schedules."
  }
}

variable "cycle_secret_environment" {
  description = <<-EOT
    Environment variables injected from Secret Manager by reference for the cycle
    job, keyed by variable name. `ENGINE_CYCLE_WRITER_DATABASE_URL` is the
    connection string for `engine_writer`, the only secret this job consumes. No
    value appears here, in a plan, or in state.
  EOT
  type        = map(string)
  default = {
    ENGINE_CYCLE_WRITER_DATABASE_URL = "engine-cycle-writer-database-url"
  }
}

variable "cycle_secret_binding_enabled" {
  description = <<-EOT
    Whether the cycle job binds its secret reference. **Off** here, and turned on
    by the committed `cycle.tfvars`, mirroring `restore_secret_binding_enabled`
    exactly and for the same reason: Cloud Run refuses a job that references a
    secret which does not exist, so this must not be true in an environment whose
    container has not been created and filled. The maintainer actions are in
    docs/operations/engine-cycle.md.
  EOT
  type        = bool
  default     = false
}

variable "accessible_secret_ids" {
  description = <<-EOT
    Secret Manager secret ids this job may read: the `engine_writer` connection
    string alone, declared as an empty container in the platform stack with its
    accessor grant to `engine-restore-runtime` (ADR-0013 §2, #250 pattern).
    Declared intent only; the grant lives beside the container, because this
    apply holds no Secret Manager authority (#217). The archive read credential
    is deliberately absent: the job reads a staged filesystem copy and never
    opens the bucket, so a binding would be a credential path with no consumer.
    The maintainer stages the archive with a credential this stack never sees.
  EOT
  type        = list(string)
  default = [
    "engine-restore-writer-database-url",
    # The cycle job's own `engine_writer` connection string (#243). A separate
    # container from the restore's, so retiring the one-time job retires its
    # credential without touching the cadence's.
    "engine-cycle-writer-database-url",
  ]
}

variable "secret_environment" {
  description = <<-EOT
    Environment variables injected from Secret Manager by reference, keyed by
    variable name. `ENGINE_RESTORE_WRITER_DATABASE_URL` is the connection string
    for `engine_writer`, the only secret this job consumes. No value appears
    here, in a plan, or in state.
  EOT
  type        = map(string)
  default = {
    ENGINE_RESTORE_WRITER_DATABASE_URL = "engine-restore-writer-database-url"
  }
}

variable "restore_secret_binding_enabled" {
  description = <<-EOT
    Whether the job binds its secret reference. **Off** here, and turned on by the
    committed `restore.tfvars` the dispatched apply passes. Correct to turn on
    only once the container exists, carries a version, and
    `engine-restore-runtime` may read it: the maintainer actions in
    docs/operations/restoring-the-v1-archive.md. Cloud Run refuses a job that
    references a secret which does not exist, so this must not be set true in an
    environment whose container has not been created. Turning it on is the last
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

variable "cycle_memory" {
  description = "Memory limit for a cycle execution. Small: stage 1 holds a lease, an intent row and a counter, and later stages hold one cycle's working set, never an archive."
  type        = string
  default     = "512Mi"
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
