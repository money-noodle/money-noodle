# The reviewed inputs for the scheduled cycle job (#243, ADR-0013 §1, §3).
#
# The same mechanism as `exposure.tfvars` and `restore.tfvars`: a committed record
# admitted by a narrow `.gitignore` exception and passed with `-var-file` only
# when it exists. It exists because the dispatched `apply` exposes only
# `image_digest`, `source_commit` and `confirmation`, so without it there is no
# reviewed way to say which lane the cadence runs or whether its trigger fires.
#
# It carries two flags, two numbers and a boolean. Nothing here is
# account-specific: no identity, no connection string, no host, no path
# (SECURITY.md).
#
# `--mode dry` is the only lane stage 1 implements. The entrypoint accepts
# `forecast` and `paper` and refuses them at run start with the outcome
# `mode-not-implemented`, so editing this line before the lane is ported changes
# what is refused, not what runs.
#
# `--ticks 4` is v1's cadence inside one short run: four ticks at 15-second
# spacing is one scheduled minute.
cycle_arguments = ["--mode", "dry", "--ticks", "4"]

# The trigger is created paused and stays paused until the bring-up in
# docs/operations/engine-cycle.md is complete and its first hand-started
# execution has been read. Un-pausing is a one-line change to this file with its
# own pull request, so "the engine started cycling" is a reviewed event.
cycle_schedule_paused = true

# Off until the `engine-cycle-writer-database-url` container exists, carries a
# version, and `engine-cycle-runtime` may read it — maintainer actions in
# docs/operations/engine-cycle.md. Cloud Run refuses a job that references a
# secret which does not exist, so turning this on early breaks the apply rather
# than the run.
cycle_secret_binding_enabled = false
