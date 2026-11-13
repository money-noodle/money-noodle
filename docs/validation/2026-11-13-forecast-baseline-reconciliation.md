# Restored-baseline reconciliation — local qualification (November 13, 2026)

## Scope and authority

This record qualifies one slice of the reduced #243 acceptance: "Restore/forecast baseline is reconciled before first recording; excluded paper balances/orders remain unchanged." Rai approved the reduced scope on 2026-11-13T00:45:09Z; the paper implementation is #293 and is not touched here. Head `2209068` on `claim-v1/issue-243`, PR #275, still draft.

**This is not deployed evidence.** It does not satisfy the #243 acceptance item that requires staged dry-then-forecast validation with a deployed SHA; that item stays open and depends on separate deployment and activation approval. No migration was added, no grant or role changed, no provider or production database was touched, the cycle schedule stays paused (`infra/stacks/engine-jobs/cycle.tfvars`), `COMPILED_PAPER_BUNDLE_AVAILABLE` stays false, and no order of any kind was placed.

## What was measured

The gate is decided by `services/engine-jobs/src/domain/forecast-baseline.ts` on one read-only snapshot taken through `ForecastStore.readBaseline()` after the lease is held and before the first tick. See [the forecast runbook](../operations/forecast-cycle.md#restored-baseline-reconciliation-november-13-2026) for the contract and the divergence codes.

Offline (`services/engine-jobs/src/forecast-baseline.test.ts`, 6 tests): the reconciled case including a first-run and a later-run snapshot; every divergence code, each from a snapshot that differs from the reconciled one in exactly the field it is about, with multiple divergences reported together in a fixed order; unreadable snapshots (non-object, null, missing field, negative count, fractional count, untrimmed run id, empty digest) failing closed; a reachability assertion that every documented code is produced by some case and no case produces a code outside the documented list. Wiring, through `runCycleJob` with the in-memory cycle and forecast stores: a refusal records the outcome row, spends the run id and releases the lease with `ticksCompleted: 0` and no call to `calculate`, `resolve` or any recording path; a reconciled snapshot runs the lane; and the earlier refusals stay ahead of the gate — a paused intent, a same-run-id replay and a lease held by another owner each refuse without the baseline being read at all.

Real adapter (`services/engine-jobs/checks/forecast-baseline-postgres.mjs`, inside the existing `engine-jobs:contract` target): against PostgreSQL 16 in a disposable database of its own, built from migrations 0001–0006 and read as `engine_writer` on the grants 0002 and 0005 already give that role. The reconciled snapshot is asserted field by field; each attribution dimension (`engine.ledger_state`, `engine.ledger_order`, `engine.forecast_row`) is then perturbed on its own with a row the baseline restore did not load and asserted to add exactly its own divergence; removing those rows returns the snapshot to reconciled; the overlay split between `origin_restore_run_id` and `origin_run_id` is asserted directly; and an open restore run, and then no completed restore run at all, are asserted to report their divergences together. Reading the baseline is also asserted to change no row count.

Discrimination: two mutants were confirmed caught rather than assumed. Counting `origin_run_id` as adopted overlay rows in the adapter fails the hosted vector (`adoptedFromBaseline: 2` against the expected `1`); removing the gate from the lane fails two offline wiring tests.

## Local gates on this head

`verify:runtime`, `format:check`, `verify:foundation` (349/349), `verify:boundaries` (20 probes) green. `nx run-many -t lint,typecheck,test,contract,build --skip-nx-cache` green for all four projects — 20 tasks, including `engine-jobs:contract` against the disposable loopback PostgreSQL 16 instance; engine-jobs 27 test files / 381 tests. `pnpm audit --audit-level high` exits 0 with the one known visible moderate (`GHSA-g3hv-75wg-m249`, minimatch) unchanged and no new advisory. Full-history secret scan clean at 387 commits with the three approved #243 fingerprints unchanged.

Local and CI validation is not deployed validation. The first recording run, and the staged dry-then-forecast evidence #243 still requires, remain separately approved.
