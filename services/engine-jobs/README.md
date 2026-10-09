# engine-jobs

The `services/engine-jobs` deployment family of Working [ADR-0013](../../docs/architecture/decisions/ADR-0013-m4-engine-boundary.md): one image, one entrypoint per job, each deployed as its own Cloud Run Job under its own workload identity. This project holds two entrypoints: `restore` (#241), the one-time archive load, and `cycle` (#243), the engine's cadence — stage 1 of which is the skeleton: the lease, the persisted-intent evaluation, the run record and the tick loop, with no cycle performed yet. The projection-writer, observer and archive jobs are later children and are not here.

## Entrypoints

| Entrypoint | Trigger | Identity | Runbook |
| --- | --- | --- | --- |
| `dist/restore/main.js` | manual, one-time | `engine-restore-runtime` | [`docs/operations/restoring-the-v1-archive.md`](../../docs/operations/restoring-the-v1-archive.md) |
| `dist/restore/main.js stage-list` | by hand, before the one execution | none — no database, no network | [`docs/operations/restoring-the-v1-archive.md`](../../docs/operations/restoring-the-v1-archive.md#staging-the-inputs-and-running-the-one-execution) |
| `dist/cycle/main.js` | Cloud Scheduler, every minute (created paused) | `engine-cycle-runtime`, started by `engine-cycle-scheduler` | [`docs/operations/engine-cycle.md`](../../docs/operations/engine-cycle.md) |

## Layout

- `src/domain/` — the v1 archive contract, the verify-first comparison, blob verification, the ledger v9 and forecast storage verifiers, the paper bankroll recomputation, the transform at the paper seam, and the evidence renderer. Pure; no I/O beyond the in-memory tree.
- `src/application/restore.ts` — the job over ports: archive source, engine store, evidence writer.
- `src/adapters/archive/` — a filesystem archive source over a staged copy of the bucket layout.
- `src/adapters/engine-store/` — the one place that opens a database connection, as `engine_writer`, plus the in-memory fake the tests use.
- `src/domain/intent.ts` — whether the engine may run, decided from `engine.control_intent` alone: ADR-0013 §3's three staleness conditions, with missing and stale treated identically to paused. Pure, and unit-tested over the action grid.
- `src/domain/cycle-store.ts` — the cycle job's store port, the closed set of reason codes, and the lease's pure parts. The lease is a store row with an owner, an expiry and a fencing token, because ADR-0013 §1 moved it off disk.
- `src/application/cycle.ts` — the cycle job over that port: lease, run record, intent, ticks, one outcome row, job health, release.
- `src/domain/load-scope.ts` — **which v1 stores are loaded**, as one table keyed by manifest path, under one named load scope (`authoritative`, the default and currently the only one). The histories the authoritative stores index — sealed forecast shard rows, evidence batch bodies, the research journals — are not loaded, not staged and not fetched (maintainer decision 2026-10-08). Decidable from the manifest alone, which is what lets `stage-list`, the staged download, the blob verification, the transform and the evidence document answer one question one way.
- `src/domain/stage-list.ts` — the same table, read the other way: which archive object keys the operator has to upload before an execution, and what stays behind with its manifest hash and size.
- `src/domain/manifest-classification.ts` — manifest-to-load reconciliation: every manifest entry is loaded, intentionally not loaded for a stated reason, or unmapped; an unmapped entry refuses the load unless `--allow-unmapped` is passed, and is recorded either way.
- `src/cycle/main.ts` — the cycle entrypoint. `--mode dry|forecast|paper`, `--ticks`, `--run-id`; the non-secret `ENGINE_CYCLE_CONTROL_EPOCH`, and the connection string by reference as `ENGINE_CYCLE_WRITER_DATABASE_URL`. A refusal is the job working, so it exits 0 and says why in one JSON line.
- `src/restore/main.ts` — the restore entrypoint, with two subcommands. Every location is an argument; the connection string arrives by reference as `ENGINE_RESTORE_WRITER_DATABASE_URL`. Flags: `--scope`, `--allow-workstation-absent`, `--allow-unmapped`; the last two are documented overrides, never defaults. `stage-list --manifest <file>` prints object keys on stdout, one per line, and a one-line summary on stderr, so it pipes straight into a copy loop.
- `templates/` — the evidence document template, also committed under `docs/validation/templates/`.

Ported logic is attributed in a comment at the top of each module ("ported from the v1 archive's … , sanitized"). Nothing here names a bucket, endpoint, path, project or credential, and no test needs a database or a network.

## Checks

```bash
pnpm nx run engine-jobs:typecheck
pnpm nx run engine-jobs:lint
pnpm nx run engine-jobs:test
pnpm nx run engine-jobs:build
```

What to upload before the one execution, from a local copy of the latest manifest:

```bash
pnpm nx run engine-jobs:build
node services/engine-jobs/dist/restore/main.js stage-list --manifest <manifest json>
# or, building first:
pnpm nx run engine-jobs:stage-list -- --manifest <manifest json>
```
