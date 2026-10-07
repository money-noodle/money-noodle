# The reviewed inputs for the one-time restore execution (#241, ADR-0013 §1).
#
# The same mechanism as `exposure.tfvars`: a committed record admitted by a narrow
# `.gitignore` exception and passed with `-var-file` only when it exists. It
# exists because the dispatched `apply` exposes only `image_digest`,
# `source_commit` and `confirmation`, so without it there is no reviewed way to
# set either value below — and a restore applied with neither set is a job that
# prints its usage and exits.
#
# It carries a boolean and three container mount paths. Nothing here is
# account-specific: the bucket behind the mount is named by the platform stack's
# published contract and never written down in this repository (SECURITY.md).
#
# `restore_secret_binding_enabled` is correct to be true only once the
# `engine-restore-writer-database-url` container exists, carries a version, and
# `engine-restore-runtime` may read it. Those are maintainer actions 1-3 in
# docs/operations/restoring-the-v1-archive.md, and they are done.
restore_secret_binding_enabled = true

# `--workstation` is supplied deliberately: the job cannot establish completeness
# without it, and the documented override that proceeds without one is never a
# default here.
restore_arguments = [
  "--archive",
  "/mnt/stage/archive",
  "--workstation",
  "/mnt/stage/workstation",
  "--evidence-dir",
  "/mnt/stage/evidence",
]
