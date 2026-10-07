# Restoring the v1 archive

> **Status:** Operational runbook for the one-time `restore` job of `services/engine-jobs` (#241, Working [ADR-0013](../architecture/decisions/ADR-0013-m4-engine-boundary.md) §1–2)
> **Prepared:** 2026-10-07
> **Evidence:** none yet. The job has not run; its first execution produces the dated document described below.

The v1 worker is stopped. Its authoritative state exists in two places: the content-addressed archive (gzip blobs plus a manifest per run) and the workstation's data directory. Whether a successful archive run completed after the worker's final write is **unknown** (maintainer, 2026-10-06), so this job verifies before it loads, and the workstation copy stays primary until the first archive written by the new system verifies.

The restore is a **transform, not a byte-exact copy**: live rows are dropped at the paper seam, mirror-pair identifiers are carried as inert metadata with no join target, live-skip and mirror-pair evidence are not loaded, and the eight authoritative stores plus the research journals become rows in the `engine` schema.

## Inputs

Every location is an input to the execution. None is a default anywhere in this repository, and none appears in the evidence document (`SECURITY.md`).

| Input | How it reaches the job | Notes |
| --- | --- | --- |
| Staged archive root (`--archive`) | a directory mounted on the execution, holding the bucket prefix's `manifests/` and `blobs/` as laid out in the bucket | Staged read-only by the maintainer with the archive read credential. The job reads the **last** manifest by key order and never writes to the archive. |
| Workstation copy (`--workstation`) | a directory mounted on the execution, holding the v1 data directory as last written | Comes from the maintainer's workstation. Supply it; the job cannot establish completeness without it. |
| Evidence output (`--evidence-dir`) | a directory the maintainer collects after the run | The job writes `<date>-v1-archive-restore.md` there from the committed template, before and after the load. |
| `engine_writer` connection string | `ENGINE_RESTORE_WRITER_DATABASE_URL`, bound by reference from Secret Manager | The job holds no DDL and refuses a non-empty schema. |
| `--allow-workstation-absent` | an explicit flag | The documented override, see below. Never a default. |

## Before the first execution (maintainer actions)

1. Apply `services/platform-api/migrations/0001-identity-budgets-and-control.sql`, then `services/platform-api/migrations/0002-engine-restore-tables.sql`, as the schema owner. The job cannot create tables and will fail its first `select` without them.
2. Publish the `engine-restore-runtime` identity from the bootstrap stack (the infrastructure child's declaration, keyed `engine-restore`), so `infra/stacks/engine-jobs` can read it from the contract.
3. Apply `infra/stacks/platform` with `engine_restore_secrets_enabled = true`, which declares the two empty containers (`engine-restore-writer-database-url`, `engine-restore-archive-read-credential`) and grants their accessor to the restore identity. Enter both secret versions out of band.
4. Apply `infra/stacks/engine-jobs` at the published `engine-jobs` image digest with `restore_secret_binding_enabled = true` and the three locations in `restore_arguments`.
5. Stage the archive prefix and the workstation copy on the execution's mounts. Nothing in the pipeline does this, and no credential value passes through the repository.

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
3. Transforms at the paper seam and recomputes the paper bankroll's realized figure from its orders and three correction classes. A non-zero discrepancy refuses the load.
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

- It does not read the archive over the network from inside the execution. The archive is staged for it; the read credential exists so the maintainer can stage it.
- It does not create, migrate or drop any table, and it does not touch the public projection schema.
- It does not schedule anything, start any engine, or write an intent row. Incrementing the control epoch after a reseed (ADR-0013 §3) is the cycle child's contract to honour and is recorded here as a follow-up for #243.
- It does not provision a second archive copy (maintainer, 2026-10-06).
