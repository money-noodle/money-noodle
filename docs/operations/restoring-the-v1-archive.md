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

## What the restore loads, and what stays in the archive

**Maintainer decision, 2026-10-08.** The restore loads only the authoritative
stores the engine resumes from. The histories those stores index are read by
neither the engine nor the UI, so they stay in the append-only archive, are never
staged and are never fetched; each is listed in the evidence document as
intentionally not loaded, with the reason `historical-archive-retained` and the
manifest's own sha256 and size.

| Loaded | What it carries |
| --- | --- |
| `paper-orders.json` | the paper ledger with its bankroll corrections, live rows dropped at the seam, and the evidence batch index each paper order carries (`evidence_sha256`, `evidence_row_key`) |
| `trading-control.json` | the paper fields of trading control |
| `trading-providers.json` | the provider registry, live flag dropped |
| `provider-budgets.json` | provider paper ceilings |
| `contract-provenance.json` | contract provenance |
| `model-promotions.json` | the manual model promotion ledger |
| `forecast-history.journal.jsonl` | the forecast journal, replayed onto the open set |
| `forecast-history-shards/index.json` | the forecast **shard index**: shard ids, hashes and row counts. It is also what says which journal bytes the last seal already incorporated, so the journal cannot be read without it |
| `forecast-history-shards/open.<hash>.json` | the open forecast set at the last seal, which the journal replays onto. Its name carries its own hash, so which one the index names is only knowable after the index is read: every candidate is staged, and one the index does not name is recorded as `superseded` |

| Not loaded | Reason code |
| --- | --- |
| sealed forecast shard rows, rollups and id artifacts | `historical-archive-retained` |
| evidence batch bodies (`execution-order-evidence/batch.<hash>.json`) | `historical-archive-retained` |
| the research journals and snapshots — sentinels, choice sets, timing shadows, calendar evaluation | `historical-archive-retained` |
| the retired v1 exit sentinel (`exit-policy-sentinels.json`, `exit-policy-sentinels.journal.jsonl`), replaced by v2 then v3 | `historical-archive-retained` |
| live-side stores, including live skips | `live-side` |
| leases, locks and the archive's own state file | `lease/lock/archive-state` |
| a lock directory the lease holder quarantined (`forecast-history.write.lock.corrupt-<stamp>/owner.json`); a corrupt lease is still a lease | `lease/lock/archive-state` |
| derived, rebuildable, pre-v9 and quarantine copies | `superseded` |
| a whole store the v1 writer moved aside (`<store>.corrupt-<stamp>/**`, every file under it, such as the quarantined shard root's `index.json`, `open.json`, day and rollup files) | `superseded` |
| the forecast storage repair record (`forecast-history-repair-<stamp>.json`), which names what was quarantined and what was installed | `superseded` |
| copies the operator moved under `archive/` by hand (legacy v2 forecast snapshots) | `superseded` |
| `llm-control.json`: the v1 dashboard's research-LLM switches, read by the v1 UI routes only, never by the engine; configuration re-entered by hand | `superseded` |
| stores of features v1 retired and removed — the long-shot strategy (`long-shot-candidates.journal.jsonl`, `long-shot-settlements.json`, `hold-sentinels.json`, `analysis-bands.json`) and experiment sweeps of retired collectors (`*-experiment.jsonl`: fine paths, maker depth). No v1 code writes or reads them and no engine table exists for them under any scope, which is what separates them from a research store a wider scope could still load | `retired-feature` |

The table lives in `services/engine-jobs/src/domain/load-scope.ts` as one load
scope named `authoritative`, which is the default and currently the only one.
`stage-list`, the staged download, the blob verification, the transform and the
evidence document all read that one table, so what the operator uploaded and what
the job says it loaded cannot disagree. A store the table has never heard of is
**UNMAPPED** and still refuses the load; narrowing what is loaded did not narrow
what must be accounted for.

This narrows acceptance check 4 of #241 accordingly, and [ADR-0013](../architecture/decisions/ADR-0013-m4-engine-boundary.md#2-the-engine-store) §2 carries the note.

## Staging the inputs and running the one execution

The bucket name is published, not written down. Read it once:

```bash
# From the engine-jobs stack, after the dispatched apply. The apply log carries
# it too, with the account-chosen part of the name redacted.
tofu output -raw stage_bucket
```

### Stage only what the job loads

The restore loads the authoritative stores the engine resumes from and leaves
their histories in the archive (maintainer decision 2026-10-08, above). Those
histories are most of the archive by size, so the staging step is a short list
rather than a sync. `stage-list` prints that list from the latest manifest, and
printing it is the same code path the job itself uses to decide what to fetch, so
the two cannot drift apart.

Build the job once and ask it what to upload:

```bash
pnpm nx run engine-jobs:build
node services/engine-jobs/dist/restore/main.js stage-list \
  --manifest <local copy of the latest manifest>.json \
  --manifest-key <its object key inside the archive>
# Object keys on stdout, one per line, manifest first.
# One summary line on stderr: N files to stage, bytes compressed and uncompressed,
# and how many entries stay in the archive.
```

`pnpm nx run engine-jobs:stage-list -- --manifest <file>` does the same through
Nx and builds first.

Download the latest manifest, run the list, then fetch exactly those objects from
the archive with your own credential. Placeholders only: no endpoint, bucket,
local path or credential belongs in a commit.

```bash
# 1. The latest manifest. Keys sort lexically, so the last one is the latest.
aws s3 ls --endpoint-url <archive endpoint> \
  "s3://<archive bucket>/<archive prefix>/manifests/" --recursive | tail -1
aws s3 cp --endpoint-url <archive endpoint> \
  "s3://<archive bucket>/<manifest key>" "<staging dir>/<manifest key>"

# 2. What to stage, as object keys relative to the archive root.
node services/engine-jobs/dist/restore/main.js stage-list \
  --manifest "<staging dir>/<manifest key>" --manifest-key "<manifest key>" \
  > "<staging dir>/stage.keys"

# 3. Only those objects, each under its own key so the layout is preserved.
while read -r key; do
  aws s3 cp --endpoint-url <archive endpoint> \
    "s3://<archive bucket>/${key}" "<staging dir>/${key}"
done < "<staging dir>/stage.keys"

# 4. Every manifest, because the job reads the last one and compares it. The
#    manifests are small; the blobs are the part that is selective.
aws s3 cp --recursive --endpoint-url <archive endpoint> \
  "s3://<archive bucket>/<archive prefix>/manifests/" \
  "<staging dir>/<archive prefix>/manifests/"
```

Then upload with your own account — the job's identity can read and append, and
nothing in the pipeline stages anything. Relative paths are preserved, because
the job resolves each manifest object key against the archive mount root:

```bash
gcloud storage cp -r "<staging dir>/" "gs://<stage-bucket>/archive/"
gcloud storage cp -r <workstation data directory>/ "gs://<stage-bucket>/workstation/"
```

Expect the staged bytes to be a **fraction of the full archive**: the sealed
forecast shard rows, the evidence batch bodies and the research journals are the
bulk of it and none of them is staged. The summary line says what was selected
and what was left; the evidence document repeats both, entry by entry, with each
retained entry's manifest hash and size.

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

The job's first act is to compare the last manifest with the workstation copy and write the finding. The comparison is over the **load scope**: the question it answers is whether what the job is about to load is the same stopping point the workstation holds, and an entry that is never loaded cannot change a loaded row. Entries outside the scope are counted on both sides — the counts are in the evidence document — and not compared, so a research journal written after the last archive run is reported and does not refuse the load, while a new store the scope would load does. The classification:

- **complete** — every in-scope manifest file is in the workstation copy with the same sha256 and byte count, and the workstation holds no in-scope archive-eligible file the manifest lacks. The load proceeds.
- **incomplete** — the workstation holds eligible files the manifest does not list: the final writes happened after the last archive run. The load is refused.
- **differing** — the same files, different bytes. The load is refused.
- **workstation-absent** — no workstation copy was supplied. Completeness cannot be established from the manifest alone, so the load is refused unless `--allow-workstation-absent` is passed. Record why in the pull request that carries the evidence document; the acceptance check names "incomplete manifest and workstation copy absent" as the case that must refuse, and this is the conservative reading of it.

"Eligible" means what the v1 writer would have captured: `*.json`/`*.jsonl` and frozen quarantine copies, never hidden files, locks, temps or the archive's own state file. Those are excluded by design and are not "missing".

When the finding is `incomplete` or `differing`, the workstation copy is the truer stopping point. The intended path is to run the v1 archive once more from the workstation so a complete manifest exists, then re-run this job. This job never loads from the workstation copy directly, because then nothing content-addressed would stand behind the loaded rows.

## What the job does after the finding permits a load

1. Verifies every sha256 **it loads** against the blobs (decompressed digest and byte count). One failure refuses the load. A retained entry is not fetched, so a blob absent for one of them is not a failure; its manifest hash and size are recorded instead.
2. Runs the ledger v9 verifier and the forecast storage verifier, each told what the scope staged. Under `authoritative` the ledger's evidence **references** are checked — version, content-addressed file name against the hash, no two orders claiming one file at different hashes — and the batch bodies are not read, because they are not staged. The forecast verifier checks the index version, its per-shard row counts against the terminal total it publishes, the v4 exact-ID metadata, the open-set checksum, the open row count and the journal replay; the sealed shard, rollup and id-artifact checksums are **not** checked, for the same reason. Either verifier failing refuses the load. What was not checked is named in the evidence document, including the rollup-summary equivalence check that was never ported.
3. Transforms at the paper seam and reconciles the manifest to the load: every manifest entry is classified as **loaded** (with its target table), **intentionally not loaded** with a reason (`historical-archive-retained`, `live-side`, `lease/lock/archive-state`, `superseded`, `evidence-frozen`, `retired-feature`), or **UNMAPPED**. The counts sum to the manifest total, and the evidence document lists all three classes by name, each retained entry with its manifest hash and size. Any UNMAPPED entry refuses the load unless `--allow-unmapped` is passed; an unmapped store is staged and fetched so the refusal can name it, the override loads nothing extra, and the list is recorded either way, so the pull request carrying the evidence must say why each unmapped entry was acceptable. It then recomputes the paper bankroll's realized figure from its orders and three correction classes. A non-zero discrepancy refuses the load.
4. Inspects the engine schema. Any row in a restore target table, or a prior `engine.restore_run` for the same manifest digest and schema version, refuses the load (ADR-0013 §1 idempotency).
5. Loads every row set in **one transaction**, re-counts inside it, and rolls back on any count that differs from the plan. Exit code 0 only on `loaded`.

## How to read the evidence document

The template is [`../validation/templates/v1-archive-restore-evidence.md`](../validation/templates/v1-archive-restore-evidence.md). The job writes it twice: once with the verify-first finding and "load not yet attempted", and once at the end with the outcome. The final document has five sections:

1. **Verify first** — the finding, the counts, and every file that is not equal with sha256 prefixes.
2. **Blob verification and the semantic verifiers** — blobs verified of the staged total, every failure, both verifier results, and what each verifier does not check, including everything the load scope left in the archive.
3. **The transform at the paper seam** — paper orders carried, live orders dropped, mirror-pair ids carried, trading-control keys dropped, the list of what is never loaded, and the manifest-to-load reconciliation with every retained entry's reason, manifest hash and size.
4. **Paper bankroll** — order-derived realized P&L, maker-fee corrections added back, strategy-leak and reconciliation corrections (reported, not added), recomputed versus restored, and the discrepancy, which must be zero.
5. **Reconciliation** — per table: source store, planned rows, loaded rows as the store reported them inside the transaction, the digest of the planned rows, and whether they reconcile.

Commit the final document under `docs/validation/` in a pull request that references #241 and #80. Counts and hashes only; it carries no row content and no location.

## Rollback

Rollback is to **discard the schema contents**: the schema owner runs the `truncate` listed at the end of `0002-engine-restore-tables.sql`, which empties every restore target table and `engine.restore_run`. Nothing in v1 changed — the archive and the workstation copy are never written — so the state after rollback is the state before the run. Re-running the job afterwards is permitted; it will refuse until the tables are empty.

## What this job does not do

- It does not read the archive over the network from inside the execution, and it binds no archive credential. The archive is staged for it by the maintainer with a credential this repository never declares.
- It does not silently drop a store. Every manifest entry is loaded, intentionally not loaded for a stated reason, or refused as unmapped, and `provider-budgets.json` is loaded with its paper ceiling only.
- It does not load history. Sealed forecast shard rows, evidence batch bodies and the research journals and snapshots stay in the append-only archive (maintainer decision 2026-10-08): they are history for analysis, read by neither the engine nor the UI. What is loaded is the **index** of each — the shard index with its hashes and row counts, and the evidence batch reference each paper order carries — so the pointer into the archive survives the restore even though the bodies are not in the engine store.
- It does not create, migrate or drop any table, and it does not touch the public projection schema.
- It does not schedule anything, start any engine, or write an intent row. Incrementing the control epoch after a reseed (ADR-0013 §3) is the cycle child's contract to honour and is recorded here as a follow-up for #243.
- It does not provision a second archive copy (maintainer, 2026-10-06).
