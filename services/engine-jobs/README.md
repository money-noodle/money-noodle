# engine-jobs

The `services/engine-jobs` deployment family of Working [ADR-0013](../../docs/architecture/decisions/ADR-0013-m4-engine-boundary.md): one image, one entrypoint per job, each deployed as its own Cloud Run Job under its own workload identity. This project holds the first entrypoint, `restore` (#241). The cycle, projection-writer, observer and archive jobs are later children and are not here.

## Entrypoints

| Entrypoint | Trigger | Identity | Runbook |
| --- | --- | --- | --- |
| `dist/restore/main.js` | manual, one-time | `engine-restore-runtime` | [`docs/operations/restoring-the-v1-archive.md`](../../docs/operations/restoring-the-v1-archive.md) |

## Layout

- `src/domain/` — the v1 archive contract, the verify-first comparison, blob verification, the ledger v9 and forecast storage verifiers, the paper bankroll recomputation, the transform at the paper seam, and the evidence renderer. Pure; no I/O beyond the in-memory tree.
- `src/application/restore.ts` — the job over ports: archive source, engine store, evidence writer.
- `src/adapters/archive/` — a filesystem archive source over a staged copy of the bucket layout.
- `src/adapters/engine-store/` — the one place that opens a database connection, as `engine_writer`, plus the in-memory fake the tests use.
- `src/restore/main.ts` — the entrypoint. Every location is an argument; the connection string arrives by reference as `ENGINE_RESTORE_WRITER_DATABASE_URL`.
- `templates/` — the evidence document template, also committed under `docs/validation/templates/`.

Ported logic is attributed in a comment at the top of each module ("ported from the v1 archive's … , sanitized"). Nothing here names a bucket, endpoint, path, project or credential, and no test needs a database or a network.

## Checks

```bash
pnpm nx run engine-jobs:typecheck
pnpm nx run engine-jobs:lint
pnpm nx run engine-jobs:test
pnpm nx run engine-jobs:build
```
