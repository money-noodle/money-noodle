# Restoring the v1 archive

> **Status:** Operational runbook for the one-time `restore` job of `services/engine-jobs` (#241, Working [ADR-0013](../architecture/decisions/ADR-0013-m4-engine-boundary.md) §1–2)
> **Prepared:** 2026-10-07
> **Evidence:** none yet. The job has not run; its first execution produces the dated document described below.

The v1 worker is stopped. Its authoritative state exists in two places: the content-addressed archive (gzip blobs plus a manifest per run) and the workstation's data directory. Whether a successful archive run completed after the worker's final write is **unknown** (maintainer, 2026-10-06), so this job verifies before it loads, and the workstation copy stays primary until the first archive written by the new system verifies.

The restore is a **transform, not a byte-exact copy**: live rows are dropped at the paper seam, mirror-pair identifiers are carried as inert metadata with no join target, live-skip and mirror-pair evidence are not loaded, and the eight authoritative stores plus the research journals become rows in the `engine` schema.

## Inputs

Every location is a path inside the execution, under one mounted staging bucket. The three paths are a committed, reviewed record — `infra/stacks/engine-jobs/restore.tfvars` — because the dispatched apply exposes only the image digest, the source commit and the confirmation, so there is otherwise no reviewed way to tell the job what to do. The **bucket name** is not in this repository: the platform stack creates it from a name supplied at apply, and the `engine-jobs` stack publishes it as the `stage_bucket` output, so read it from `tofu output` or from the apply log (`SECURITY.md`).

That bucket is the restore's staging area and nothing more: private, versioned, with a bounded object life, readable and appendable by the restore job's own identity alone. It is **not** the single object store Proposed [ADR-0008](../architecture/decisions/ADR-0008-single-object-store.md) would decide, and declaring it does not promote that record — ADR-0013 §2 is explicit that the accepted object-storage direction is the existing archive. It is retired with the job.

| Input | How it reaches the job | Notes |
| --- | --- | --- |
| Staged archive root (`--archive`) | `/mnt/stage/archive`, a prefix of the staging bucket mounted on the execution, holding the archive's `manifests/` and `blobs/` as laid out in the bucket | Uploaded by the maintainer with their own account and the archive read credential. The job reads the **last** manifest by key order; its grant carries no delete, so it cannot write to the staged copy. |
| Workstation copy (`--workstation`) | `/mnt/stage/workstation`, a prefix of the same mount, holding the v1 data directory as last written | Comes from the maintainer's workstation. Supply it; the job cannot establish completeness without it. |
| Evidence output (`--evidence-dir`) | `/mnt/stage/evidence`, the one place the execution writes | The job writes `<date>-v1-archive-restore.md` there from the committed template, before and after the load. The maintainer downloads it and opens the evidence pull request. |
| `engine_writer` connection string | `ENGINE_RESTORE_WRITER_DATABASE_URL`, bound by reference from Secret Manager | The job holds no DDL and refuses a non-empty schema. |
| `--allow-workstation-absent` | an explicit flag | The documented override, see below. Never a default. |

## Before the first execution (maintainer actions)

1. Apply `services/platform-api/migrations/0001-identity-budgets-and-control.sql`, then `services/platform-api/migrations/0002-engine-restore-tables.sql`, as the schema owner. The job cannot create tables and will fail its first `select` without them.
2. Publish the `engine-restore-runtime` identity from the bootstrap stack (the infrastructure child's declaration, keyed `engine-restore`), so `infra/stacks/engine-jobs` can read it from the contract.
3. Apply `infra/stacks/platform` with `engine_restore_secrets_enabled = true`, which declares the one empty container (`engine-restore-writer-database-url`) and grants its accessor to the restore identity. Enter the secret version out of band. No archive credential is declared anywhere in this repository: the job reads a staged copy and never opens the bucket, so the credential the maintainer stages with stays in the maintainer's custody.
4. Apply `infra/stacks/platform` again with `engine_restore_secrets_enabled = true` and `engine_restore_stage_bucket` set, which creates the staging bucket. The pipeline cannot do this: the deployer that runs a dispatched apply holds no Cloud Storage role at all, so a bucket declared in the release path could only fail the apply that needed it. Follow the same convention the state buckets use, `<state-bucket-prefix>-engine-restore-stage`, which is what the workflow derives for its own plans.
5. Re-apply `infra/stacks/bootstrap`, which binds the bucket's two grants: object read and create for the restore identity, and `storage.buckets.get` for the deployer so the pipeline's own plan of the platform stack can refresh the bucket. They are declared there rather than beside the bucket because setting bucket IAM is never the deployer's to do, and because a bucket IAM resource in a stack the pipeline plans would itself need `storage.buckets.getIamPolicy` — a permission no Cloud Storage predefined role carries without `setIamPolicy`, which would let the pipeline grant itself read on the staged copy. [`../../infra/bootstrap.md`](../../infra/bootstrap.md#re-applying-bootstrap-for-the-engine-restore-job-identity-241) records the delta.
   If a platform apply before this change already created the grant, that platform state still holds `google_storage_bucket_iam_member.engine_restore_stage_object_user[0]`, which the stack no longer declares. Run `tofu state rm 'google_storage_bucket_iam_member.engine_restore_stage_object_user[0]'` against the platform state once, after the bootstrap re-apply. It changes nothing in the project — the live binding is the one bootstrap now owns — and it is what stops the pipeline's next plan from being refused on a resource it has no permission to refresh.
6. **Prerequisite: #257 merged** (`ci(delivery): dispatch plan/apply/drift and build the image for the engine-jobs stack`). It is the only reviewed route to the next steps; applying the stack with `tofu` by hand is forbidden (`AGENTS.md`, `docs/operations/delivery.md`). Once it is merged, the next push to `main` publishes the `engine-jobs` image digest, and a dispatched `apply` for the `engine-jobs` stack applies `infra/stacks/engine-jobs` at that digest. The gate and the three locations come from the committed `restore.tfvars`, which the workflow passes with `-var-file` when the stack has one; nothing needs to be typed into the dispatch beyond the digest, the source commit and the confirmation.

## Staging the inputs and running the one execution

The bucket name is published, not written down. Read it once:

```bash
# From the engine-jobs stack, after the dispatched apply. The apply log carries
# it too, with the account-chosen part of the name redacted.
tofu output -raw stage_bucket
```

Then upload with your own account — the job's identity can read and append, and
nothing in the pipeline stages anything:

```bash
# Placeholders only. Neither local path nor the bucket name belongs in a commit.
gcloud storage cp -r <local archive copy>/ "gs://<stage-bucket>/archive/"
gcloud storage cp -r <workstation data directory>/ "gs://<stage-bucket>/workstation/"
```

Start exactly one execution by hand:

```bash
gcloud run jobs execute engine-restore --region <region> --wait
```

Collect the evidence document and open its pull request:

```bash
gcloud storage cp "gs://<stage-bucket>/evidence/*.md" docs/validation/
```

Nothing in the pipeline executes the job, and no credential value passes through
the repository. Read the finding in the evidence document before reading anything
else: the verify-first rule below decides whether a load was permitted at all.

## The verify-first rule

The job's first act is to compare the last manifest with the workstation copy and write the finding. The classification:

- **complete** — every manifest file is in the workstation copy with the same sha256 and byte count, and the workstation holds no archive-eligible file the manifest lacks. The load proceeds.
- **incomplete** — the workstation holds eligible files the manifest does not list: the final writes happened after the last archive run. The load is refused.
- **differing** — the same files, different bytes. The load is refused.
- **workstation-absent** — no workstation copy was supplied. Completeness cannot be established from the manifest alone, so the load is refused unless `--allow-workstation-absent` is passed. Record why in the pull request that carries the evidence document; the acceptance check names "incomplete manifest and workstation copy absent" as the case that must refuse, and this is the conservative reading of it.

"Eligible" means what the v1 writer would have captured: `*.json`/`*.jsonl` and frozen quarantine copies, never hidden files, locks, temps or the archive's own state file. Those are excluded by design and are not "missing".

When the finding is `incomplete` or `differing`, the workstation copy is the truer stopping point. The intended path is to run the v1 archive once more from the workstation so a complete manifest exists, then re-run this job. This job never loads from the workstation copy directly, because then nothing content-addressed would stand behind the loaded rows.

## What the job does after the finding permits a load

1. Verifies every sha256 in the manifest against the blobs (decompressed digest and byte count). One failure refuses the load.
2. Runs the ledger v9 verifier (every evidence reference resolves to a checksummed batch holding that order's row; every row structurally sound) and the forecast storage verifier (shard, rollup, id-artifact and open-set checksums against the index; counts; terminal-only shards; no duplicate or colliding ids; journal replay). Either failing refuses the load. The forecast verifier's rollup-summary equivalence check is **not** ported and the evidence document says so.
3. Transforms at the paper seam and reconciles the manifest to the load: every manifest entry is classified as **loaded** (with its target table), **intentionally not loaded** with a reason (`live-side`, `lease/lock/archive-state`, `superseded`, `evidence-frozen`), or **UNMAPPED**. The counts sum to the manifest total, and the evidence document lists all three classes by name. Any UNMAPPED entry refuses the load unless `--allow-unmapped` is passed; the override loads nothing extra, and the list is recorded either way, so the pull request carrying the evidence must say why each unmapped entry was acceptable. It then recomputes the paper bankroll's realized figure from its orders and three correction classes. A non-zero discrepancy refuses the load.
4. Inspects the engine schema. Any row in a restore target table, or a prior `engine.restore_run` for the same manifest digest and schema version, refuses the load (ADR-0013 §1 idempotency).
5. Loads every row set in **one transaction**, re-counts inside it, and rolls back on any count that differs from the plan. Exit code 0 only on `loaded`.

## How to read the evidence document

The template is [`../validation/templates/v1-archive-restore-evidence.md`](../validation/templates/v1-archive-restore-evidence.md). The job writes it twice: once with the verify-first finding and "load not yet attempted", and once at the end with the outcome. The final document has five sections:

1. **Verify first** — the finding, the counts, and every file that is not equal with sha256 prefixes.
2. **Blob verification and the semantic verifiers** — blobs verified of total, every failure, both verifier results, and what the forecast verifier does not check.
3. **The transform at the paper seam** — paper orders carried, live orders dropped, mirror-pair ids carried, trading-control keys dropped, and the list of what is never loaded.
4. **Paper bankroll** — order-derived realized P&L, maker-fee corrections added back, strategy-leak and reconciliation corrections (reported, not added), recomputed versus restored, and the discrepancy, which must be zero.
5. **Reconciliation** — per table: source store, planned rows, loaded rows as the store reported them inside the transaction, the digest of the planned rows, and whether they reconcile.

Commit the final document under `docs/validation/` in a pull request that references #241 and #80. Counts and hashes only; it carries no row content and no location.

## Rollback

Rollback is to **discard the schema contents**: the schema owner runs the `truncate` listed at the end of `0002-engine-restore-tables.sql`, which empties every restore target table and `engine.restore_run`. Nothing in v1 changed — the archive and the workstation copy are never written — so the state after rollback is the state before the run. Re-running the job afterwards is permitted; it will refuse until the tables are empty.

## What this job does not do

- It does not read the archive over the network from inside the execution, and it binds no archive credential. The archive is staged for it by the maintainer with a credential this repository never declares.
- It does not silently drop a store. Every manifest entry is loaded, intentionally not loaded for a stated reason, or refused as unmapped; `provider-budgets.json` is loaded with its paper ceiling only, and the `.json` halves of the frozen sentinel stores are loaded as snapshot rows beside their journals.
- It does not create, migrate or drop any table, and it does not touch the public projection schema.
- It does not schedule anything, start any engine, or write an intent row. Incrementing the control epoch after a reseed (ADR-0013 §3) is the cycle child's contract to honour and is recorded here as a follow-up for #243.
- It does not provision a second archive copy (maintainer, 2026-10-06).
