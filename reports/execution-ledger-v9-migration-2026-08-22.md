# Execution ledger v9 migration and bounded funded reads — 2026-08-22

## Question and deciding checks

Can the funded worker stop cloning and serializing complete terminal audit evidence every 15 seconds without
changing an order, money term, execution decision, risk/reconciliation identity, strategy attribution, report,
or analysis input?

The deciding checks were:

1. rehydrate every v9 row and compare every field to the frozen v8 input, preserving array position because
   five legacy logical IDs have duplicate rows;
2. compare compact-row paper/live and strategy summaries, funding epochs, lifetime whole-cent P&L, maker
   cohorts over a price/spread grid, hourly filled-order counts, long-shot funding, and daily loss;
3. verify every immutable batch by SHA-256 and referenced per-row key;
4. run the full invariant suite and require startup reconciliation READY after publication;
5. measure fixed polling separately from explicit full-report hydration.

This is a storage/performance migration, not an economic evaluation. It changes no policy. Exact order P&L
and whole-cent budget P&L remain separate views.

## Inputs and migration

The worker was operator-paused with paused operator intent, `autoResumeEligible: false`, and 0¢ reserved. The
server was stopped before publication. The frozen input was:

- `data/execution-ledger-legacy/paper-orders.v8.b3372001d3f51d532c6a882f7440a12ec96cf0ee727c6755173524666bc168a2.json`
- 36,347,633 bytes
- 3,794 rows: 1,775 unfilled, 1,242 lost, 441 sold, 329 won, and 7 rejected
- 2,061 paper and 1,733 live rows

V9 retained every compact identity/control/money row in `data/paper-orders.json` and moved heavy immutable
fields for 3,548 seal-safe rows into 30 content-addressed batches. It kept 246 rows complete because their
counterfactual/current-state seal gate did not pass. Publication wrote and read back batches first, wrote a
content-addressed frozen v8 copy, then atomically renamed v9 over the canonical ledger last.

Result at publication:

| Measure | V8 | V9 hot ledger |
| --- | ---: | ---: |
| Orders | 3,794 | 3,794 |
| Canonical bytes | 36,347,633 | 6,261,288 |
| Share retained hot | 100% | 17.23% |
| Immutable evidence bytes | — | 31,894,405 |
| Immutable evidence batches | — | 30 |

The hot ledger shrank 82.77%. Total durable evidence grew slightly because references and direct safety
fallbacks are additive; this migration targets funded-path residency, not disk retention.

`npm run verify:execution-ledger` passed after publication with 3,548 compact rows and a 36,425,378-byte fully
hydrated compatibility view. The larger hydrated byte count is expected: v9 materializes direct issuance
fallbacks previously recovered through `entryDecision`, while full readers still receive that original
snapshot.

## Cross-system equivalence

The migration gate passed full-field positional equivalence and compact control equivalence. The complete
Vitest run passed 133 files / 1,073 tests, including mirror, strategy isolation, budget, reconciliation,
venue-target integrity, runtime ownership, and v9 corruption/rollback cases. TypeScript and the Next 16.3.0
production build passed. Two independent analysis readers then hydrated v9 successfully:

- `npm run analyze:paper-live-mirror` loaded all 3,794 rows and reproduced its 103-attempt / 55-window current
  paper cohort;
- `npm run analyze:exit-counterfactuals` loaded lifecycle observations and completed all paper/live arms.

Those analysis figures are compatibility smoke checks, not new policy findings.

After restart, startup reconciliation completed READY at `2026-08-22T19:16:53.876Z`: 0 local open positions,
0 venue-managed positions, 0 resting orders canceled, 0 recovered fills, 0¢ reserved, and operator intent
still paused. Venue balance was 5,824.76¢. This is the authoritative activation check; migration itself never
resumed trading.

A later restart of the final code encountered transient full-history Kalshi timeouts. Startup/manual and two
periodic attempts correctly left reconciliation BLOCKED, automation operator-paused, auto-resume false, and 0¢
reserved; no check was bypassed. Basic authenticated account reads still returned in about 140 ms, isolating the
failure to the larger history snapshot. The worker was stopped to end 30-second retry pressure, then started once
cleanly. The next recorded periodic reconciliation completed READY at `2026-08-22T20:10:26.842Z` with zero local
or venue-managed positions, zero resting cancellations, zero recovered fills, and zero reservations. This
transient establishes that full venue-history reconciliation has its own scaling/availability follow-up; it is
not evidence that v9 may narrow reconciliation.

## Fixed-read measurements

Five sequential local production requests were measured after warm-up while the collector remained active:

| Route | Response bytes | Observed latency |
| --- | ---: | ---: |
| `/api/dashboard` | 165,814–166,061 | 4.4–19.9 ms normally; one 658.3 ms collector-contention sample |
| `/api/trading/control` | 19,133–19,589 | 101.7–116.6 ms normally; one 327.5 ms sample |
| `/api/performance/summary` | 522 | 30.5–42.7 ms |
| `/api/paper-budget` | 7,932 | 7.8–13.3 ms |
| `/api/trading/history?limit=50` | 153,085 | 41.2–48.4 ms |

Before the compact control work, the control route was approximately 1.1 MB and 67.6 seconds cold. Immediately
before v9, after payload bounding and forecast compaction, it was about 19 KB and 276–500 ms. These are not
controlled benchmark distributions; network/API work and collector phase differ between samples. They establish
that fixed UI polling no longer hydrates terminal evidence and that the local surface is responsive.

## Residency result and remaining cause

V9 materially reduced ordinary RSS but did not close process high-water behavior. In a four-minute sample after
startup, RSS was commonly 290–850 MB and intermittently reached 1.55 GB. A subsequent 30-second native sample
was idle in `kevent` for 19,408/24,888 main-thread samples (78.0%), but reported 2.8 GB physical footprint and
3.1 GB peak. Structured clone appeared in 19 samples (0.08%), versus 128/4,117 (3.11%) in the pre-v9 profile.
That supports the narrow claim that the funded ledger clone stopped dominating.

The same v9 sample still caught JSON parsing in 1,528/24,888 main-thread samples (6.14%). At measurement time,
append-only observational journals included approximately 15.5 MB of contract paths, 12.5 MB of calendar
evaluation, and 8.8 MB of exit-policy sentinels. Their stores and owning compactors are separate from the money
ledger. No journal was truncated or casually cached in this migration. Lowering their footprint requires its
own checksum/generation/concurrency/crash-window design; RSS alone does not authorize changing them.

The largest caveat is that macOS RSS/physical-footprint peaks are allocator high-water observations, not
retained-heap measurements, and the sample covers one local worker over minutes rather than a long soak. V9
solves the measured complete-terminal-ledger mutation cost. It does not claim the whole process is memory-optimal.

## Policy and operations

No forecast, buy policy, paper/live mirror rule, fill, fee, sizing, risk ceiling, budget, order body, provider
capability, strategy funding, reconciliation rule, or live arming changed. Automatic v9 evidence compaction
remains disabled. The next compaction is a manual owning operation until this generation has longer observation
and an independent off-machine restore test. Live remains operator-paused.
