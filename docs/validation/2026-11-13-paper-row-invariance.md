# Paper balances and orders across a real forecast cycle — qualification (November 13, 2026)

## Scope and authority

A follow-up inside the reduced #243 scope approved on 2026-11-13, dispatched after review of the baseline gate recorded in [the baseline reconciliation record](2026-11-13-forecast-baseline-reconciliation.md). It repairs one finding in the job's output and closes one proof gap in the acceptance item "excluded paper balances/orders remain unchanged". The acceptance item is **not** redefined; what changed is what is actually proven about it. Branch `claim-v1/issue-243`, PR #275 still draft, #243 still open, #293 still deferred. No deployment, activation, provider call or production write: this is build-and-test evidence, not deployed evidence.

## Finding 1 — the job did not say which divergence refused the run

`application/cycle.ts` returned `baselineDivergences` on the refusal, and `cycle/main.ts` dropped the field when it built its one JSON line, so a Cloud Run execution logged `forecast-baseline-unreconciled` and nothing about which of the eight divergences caused it. The entrypoint now prints the codes.

What is emitted is codes only, drawn from the closed `FORECAST_BASELINE_DIVERGENCES` vocabulary: no count, no key, no run or account identifier, no row content, no connection reference. The field is absent entirely when a run applies.

Measured by `services/engine-jobs/checks/forecast-baseline-postgres.mjs`, which runs the **real compiled entrypoint** (`node services/engine-jobs/dist/cycle/main.js --mode forecast --ticks 1`) against the disposable probe database and asserts on what it prints: exactly one JSON line; `outcome: refused`; `reason: forecast-baseline-unreconciled`; `baselineDivergences` equal to `['baseline-ambiguous', 'paper-state-changed']` for that fixture; every code a member of the closed vocabulary; the key set exactly the eight keys the job has always printed plus that one; no `engine_writer` or host substring anywhere in the line; and, after the fixture is made reconciled again, a second execution whose line carries `reason: forecast-run` and **no** `baselineDivergences` key at all.

Discriminating: removing the field from `cycle/main.ts` and rebuilding fails that vector with `AssertionError [ERR_ASSERTION]: the printed line must name which divergences refused the run`.

## Finding 2 — a count is not proof the paper values are unchanged

The gate counts rows against `restore_run_id`. A row **updated in place** keeps both its count and its attribution, and `engine_writer` holds `update` on `engine.ledger_state` and `engine.ledger_order` (migration 0002), so this is a real gap rather than a theoretical one. Before this run nothing anywhere compared the content of those rows across a cycle: the existing probes seeded `'{}'` values and never re-read them.

Two claims are now kept apart.

### Proven here: the cycle changes nothing in the excluded paper tables

`services/engine-jobs/checks/forecast-paper-invariance-postgres.mjs`, in a disposable database of its own, against the real adapters:

- **Seeded with content, not placeholders.** Two balances with nonzero cents, counters and an identifier (`paper-bankroll` holding `cashCents: 1234567`, `equityCents: 2345678`, `openRiskCents: 45600`; `paper-persistence` holding a loss counter, a realized total and a settled order id), and two orders with nonzero stakes (4200 and 13750 cents), realized P&L of both signs, bankroll, mirror-pair, evidence index columns and a `row` carrying side, price, fee rate and fill time. The vector asserts the fixture is nonzero and non-empty before it proves anything, so a comparison cannot pass for the wrong reason.
- **A cycle that really runs.** `runCycleJob` in `forecast` mode over the real Postgres cycle and forecast stores, with a persisted `resume` intent and only the public feeds stubbed. It asserts the lane actually worked rather than merely returned: one new `engine.forecast_cycle_row` with `origin_run_id` of that run, one `engine.forecast_oracle_sample` for it, and the restored row resolved as an overlay with `origin_restore_run_id` — i.e. real recording **and** real resolution.
- **Exact before/after comparison.** Every column of both tables, with `jsonb` rendered as text, ordered deterministically, compared after the applied cycle, after a **same-run-id replay** (refused `run-already-recorded`) and after a **paused control** (refused `intent-paused`). All three compare equal.
- **A discriminating mutation.** One balance and one order are then edited in place — `cashCents` 1234567 → 1234568, `stake_cents` 4200 → 4201 and the order's `price` 0.47 → 0.48 — with the row counts and every `restore_run_id` asserted unchanged. The comparison is asserted to **fail** on that state (`assert.throws`), and the fixture is restored and asserted equal again, so the assertion is sensitive and two-sided.
- **A structural tripwire**, in `src/forecast-baseline.test.ts`: the forecast adapter must contain `from engine.ledger_state` and `from engine.ledger_order` and must not contain `insert into`, `update` or `delete from` against either.

Discriminating, at the level that matters: a mutant adding `update engine.ledger_state set value=jsonb_set(value,'{cashCents}','999'::jsonb)` inside the adapter's `recordObservation` transaction was confirmed caught — `AssertionError [ERR_ASSERTION]: a recording cycle must not touch paper rows`, with the diff naming `'{"cashCents": 999, …}'` against `'{"cashCents": 1234567, …}'`.

### Not proven here: that the restored contents equal the source archive's

The same vector measures the blind spot rather than hiding it: with the in-place edit present, counts and attribution unchanged, `evaluateForecastBaseline(await store.readBaseline())` still returns `reconciled`. The runtime gate therefore cannot be read as value-level proof against a source baseline, and this record does not claim it.

Closing that at runtime needs authority this lane does not hold. The minimal path is to let a verification step read the manifest the baseline already records — `engine.restore_run.manifest_key` and `manifest_digest` — from its archive location under read-only credentials and compare the rows to it: a provider read grant plus a decision on where that comparison runs, and no schema change. The alternative, a per-row content attestation written at restore time, requires schema authority for a new column. Neither is implemented, neither was invented here, and no digest or hashing machinery was added for either. (The contract-provenance fingerprint used by the invariance fixture is the existing provenance contract's, reproduced so the restored row resolves instead of being disposed of as `missing-provenance`.)

## Checks

Recorded in the final report for the pushed head: the uncached project matrix including both contract targets against a disposable loopback PostgreSQL 16 instance, the repository gates, the audit and the full-history secret scan, plus the required CI and Delivery checks on the exact final head. The API and web image package pins from earlier today are untouched, and `services/engine-jobs/Dockerfile` is deliberately untouched — its identical pins are still awaiting separate approval.

## Acceptance status after this run

| Reduced #243 acceptance | Status |
| --- | --- |
| Bounded collector → forecast recording → eligible resolution | Implemented; exercised against real PostgreSQL, including in this run's invariance vector. **Not deployed.** |
| Persisted pause/resume authoritative; missing/stale/paused refuses recording | Implemented and tested, now also with a paused control proven not to touch paper rows. **Not deployed.** |
| One writer by store-held lease; same-run-id replay cannot duplicate | Implemented and tested, now also with a replay proven not to touch paper rows. **Not deployed.** |
| Baseline reconciled before first recording; excluded paper balances/orders unchanged | Presence-and-attribution reconciliation implemented and tested; no-change-during-cycle now proven at value level; equality with the source archive **not proven** and needs the authority named above. **Not deployed.** |
| Staged dry-then-forecast validation with deployed SHA | **Not started.** Requires separately authorized deployment and activation, which nothing here has. |
| No live venue execution path; paper admission disabled | Unchanged and fail-closed: `COMPILED_PAPER_BUNDLE_AVAILABLE` false, cycle schedule paused, no order placed. |
