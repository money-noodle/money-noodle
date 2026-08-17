# Money Noodle - Implementation Status

> Living status document. Updated 2026-08-14.
> Product requirements and architecture decisions live in [SPEC.md](SPEC.md).

## Executive Summary

Money Noodle is operational as a local research dashboard, continuous paper shadow trader, public paper-track-record publisher, and explicitly armed live Kalshi trader. Core UP/YES and DOWN/NO entry, managed maker execution, paper maker mirroring, signed Kalshi reconciliation, quiescent pause/drain, loss gates, budget epochs, provider permissions, contract provenance, target integrity, standalone reduce-only exits, protected switching, model evaluation, and immutable promotion accounting are implemented.

The system is mechanically capable. The unresolved question is economic: current evidence does not justify stake expansion, taker execution, looser entry gates, queue-aware live gates, or adding a second live venue. None of those change here.

A second production policy is being added on the same market — the long-shot round trip, §2 below. It is a new trading feature, which this guidance deprioritizes, and it proceeds as an explicit operator decision under a bounded learning budget carved from the existing allocation rather than added to it. It relaxes none of the constraints above and changes no rule of the edge policy.

| Area | Status |
| --- | --- |
| Dashboard and public paper track record | Functional locally and through optional Postgres projection |
| Forecast and performance tracking | Functional and deterministic; large forecast history is now a memory-residency risk rather than a latency one |
| Live execution | Kalshi live-capable and active in local control; no current open/working positions in the local ledger snapshot |
| Paper execution | Continuous and independently accounted; exact-contract managed repricing now uses public trade/queue evidence concurrently with live |
| Model evaluation | Automatic walk-forward scheduler and immutable manual promotion ledger implemented; latest run retained baseline |
| Provider expansion | Registry, permissions, variants, and budgets implemented; only Kalshi is live-capable |
| Operational safety | Startup/periodic/manual reconciliation, quiescent drain, guarded auto-resume, loss gates, and failure injection are implemented |

## Current Measured State

Snapshot from local durable files on 2026-08-14:

- Forecast history: 49,600 rows, 29,600 qualifying rows, 29,577 resolved qualifying rows, 2,426 resolved asset-cycles, and 519 resolved qualifying close windows.
- Live ledger lifetime: 821 non-exit orders, 396 settled entries, 230 settled windows, -112.11 cents exact realized P&L on 12,128.40 cents exact stake, 1 open and 0 working orders, 420 unfilled entries.
- Paper ledger lifetime: 781 non-exit orders, 746 settled entries, 332 settled windows, +366.70 cents exact realized P&L on 27,600 cents stake, 0 open and 0 working orders, 35 unfilled entries.
- Current live budget control: active, live mode, 2,000 cents starting budget, 679 cents available, 171 cents reserved, -1,150 cents current-epoch whole-cent realized P&L, 2,000 cents peak-equity reference.
- Budget audit: live control roll-forward matches the durable budget audit and current open reservation exactly. The 2026-08-14 BNB partial-exit chain is balanced: 200c reserved, 13c released, 108c partial exit settled for 126c, and the 79c remainder settled for 0c. Paper spendable budget matches the current reset epoch using whole-cent `pnlCents`; exact sold-exit `payoutCents` remain a reporting/accounting view and explain the apparent lifetime difference.
- Latest reviewed walk-forward run: `walk-forward:550:fnv1a-866cfdc4`, generated 2026-08-15T00:00:23.891Z, 550 checkpoint windows, decision `baseline_retained`. Candidate mean window return was 4.37% versus baseline 4.81%; it beat baseline in only 2 of 5 folds and had a larger maximum drawdown, so it is not citable for promotion.
- Forecast storage is a memory-residency risk, not a cadence risk. `data/forecast-history.json` is 188.7 MB and `data/forecast-history.journal.jsonl` is 12.2 MB. The parse itself costs ~1.2 s once per process behind a promise cache; the ~10 s blocks previously attributed to it were quadratic grouping in `summarizePerformance`, now fixed and 643 ms. What binds is that the process holds ~396 MB of retained heap to serve a hot set of 135 rows, and grows ~40 MB a day.

### Edge policy v17, reviewed 2026-08-17

Three days of `buy-binary-edge-net5to35-quality50-owned55-price5to97-v17` are now reportable, and the
policy is losing money on both tracks while the gate it enforces is not the reason. Full review in
[reports/edge-policy-review-2026-08-17.md](reports/edge-policy-review-2026-08-17.md); reproduce with
`npm run analyze:entry-realization`. Figures are one read at 2026-08-17T07:17:38Z, settled entries only.

- The gate is intact. In the v17 era the rows it admits win 58.8% and return +14.9% [+8.9, +21.0] over
  892 settlement windows, against +15.4% in the era before it. The market did not deteriorate.
- The book is negative: live −565c on 13,185c (−4.3%) over 110 settled entries, paper −1,458c on 15,550c
  (−9.4%) over 117. Retired-policy entries on the same ledger returned +570c on 8,457c.
- **Fill selection is a leak and the previous 3.4pp figure was pooled across policy eras.** Split out,
  v17 filled entries win 19.2pp ±14.3 less than unfilled on live (t = −2.63) and 20.3pp ±12.4 less on
  paper (t = −3.21), while capturing a −3.96c maker discount. The earlier eras are too small or too
  low-base-rate to serve as a control, so "this is new" is *not* established.
- **Entries fired on an edge spike lose.** Decisions where `netEdge` sat 2pp or more above the
  `medianNetEdge` that `signalEligibility` already stamps win 34.0% against 58.7%, deduplicated to 228
  unique `(symbol, window, side)` decisions and clustered by window. It holds within every edge band and
  on 6 of 6 assets. It is retroactive screening on a threshold chosen after the fact and promotes nothing.
- The walk-forward evaluator cannot referee any of this: `WalkForwardParameters` has no maximum-edge or
  selected-side-floor dimension, so its baseline is not the production gate, and `selectedTrade` scores
  buy-at-the-ask-and-hold — the exact counterfactual this review shows is biased. Hardening §3 below is
  now a prerequisite to promotion rather than parallel work.

### Buy policy v18: the edge-spike freshness gate, shipped 2026-08-17

`buy-binary-edge-net5to35-quality50-owned55-price5to97-fresh2pp-v18` refuses an entry whose net edge sits
2pp or more above the median of its qualifying snapshots. Design in
[docs/edge-spike-sentinel-design.md](docs/edge-spike-sentinel-design.md); manifest history carries the
decision.

**This was made on an asymmetry, not on evidence clearing a bar, and the record says so.** The threshold
was chosen after inspecting the bins, on three days, with paper's own clustered interval spanning zero —
retroactive screening, which promotes nothing. What authorizes it is that declining this volume costs
roughly nothing while the book is negative, and not declining it costs real money if the effect is real.

- The rule is `lib/edge-spike-policy.ts`: pure, restrictive-only, tunable through
  `MONEY_NOODLE_MAX_EDGE_SPIKE`, with the tolerance on the refusing side so noise can only refuse.
- The gate sits in `evaluateSignalPersistenceWithRequirements` as a declared member of
  `SignalPersistenceRequirements`. That layer takes no execution mode, so the mirror invariant holds by
  construction, and the two-snapshot candidate lane states the ceiling explicitly rather than inheriting
  it, keeping its own comparison to one variable.
- `edge-spike-sentinel-v1` (`lib/edge-spike-sentinel.ts`, `data/edge-spike-sentinels.json`) records every
  decision that reaches the gate, admitted or refused, **at decision time**. Both arms come from one
  evaluation on one population; the admitted arm is deliberately not taken from the order ledger, because
  scoring real fills against a counterfactual would reproduce the maker selection the gate addresses.
  Review bar 60 resolved windows in the declined arm — a review bar, not a promotion criterion.
- **Known cost, accepted:** the version bump discards 156 accumulated v17 adaptive-regime windows and the
  gate permits entries for 12 settlement windows while it re-warms. Scoping regime evidence to the policy
  version is correct, and special-casing a "compatible" bump would start exactly the drift it prevents.

Rollback criterion, stated now rather than after the fact: if the declined arm comes back at or above the
admitted arm over enough independent windows, the gate goes. The reason for it was never that the evidence
was strong.

Remaining: a report surface for the sentinel, and one independent re-derivation of the §3 figures from the
order ledger rather than the analysis script — the specific way the v14 DOWN suspension failed.

The other open items are listed in the review's §6, and none of them changed here.

Interpretation: the newer exact ledger snapshot is slightly negative lifetime and the current live budget epoch is down materially. Stake expansion must use both views, plus drawdown, maker-fill quality, model evaluation, and reconciliation health. Do not treat a near-flat lifetime P&L alone as readiness. The fresh evidence-by-feature review is recorded in [reports/monitoring-review-2026-08-14.md](reports/monitoring-review-2026-08-14.md); it authorizes no new live feature.

## Implemented

### Forecast and Research

- Next.js App Router dashboard with charts, countdowns, data freshness states, factor drill-downs, public paper mode, signed private controls, and Money Noodle branding.
- Polymarket, Kalshi, Kraken, CoinGecko, CoinDesk, Crypto.com public spot research, and historical ingestion for configured crypto assets.
- Venue-independent settlement probability from Kraken reference/current price, realized volatility, and time remaining. Venue prices are benchmarks and execution costs, not inputs to the tradeable probability.
- Binary buy policy currently requires an enabled side, selected-side probability floor, net edge after fees, estimate quality, price band, signal maturity, portfolio selection, and execution permission.
- Every qualifying calculation and bounded non-qualifying samples are tracked with accuracy, Brier/log loss, calibration, cycle-balanced metrics, benchmarks, and realized-versus-predicted edge.
- Versioned replay snapshots preserve issuance-time probability inputs. Historical rows without exact replay inputs are labeled rather than silently reconstructed.
- Calendar/time-of-day, regime, cycle-path, funding-rate, contract-comparability, exit, maker, and action-counterfactual reports exist under [reports](/Users/raiphairow/code/money/reports).

### Execution and Safety

- Signed Kalshi balances, positions, orders, fills, cancellation, and v2 order submission.
- Managed post-only maker entries for UP/YES and DOWN/NO with passive repricing, bounded retries, cancellation confirmation polling, fill/fee reconciliation, and exact sub-cent accounting.
- Paper execution now mirrors live's exact-contract managed maker pricing instead of assuming immediate ask fills or holding one stale dashboard bid. A shared pure state machine chooses the refreshed initial passive limit and all progressive reprices. Paper polls independently every two seconds while live management runs concurrently, keeps live's issuance-sized quantity, and requires opposite-outcome public taker prints to consume displayed queue-ahead volume; ask touch alone is telemetry, not a fill. Incomplete terminal trade evidence is excluded rather than scored as a miss. The two-attempt paper retry ceiling, portfolio/correlation/funding limits, and separate bankroll remain unchanged.
- Contemporaneous paper intents receive a separate `matched-live-fill-shadow-v1` overlay when live fills authoritatively. It is capped at observed live and requested paper quantity and records exact live price/fee terms, but cannot alter the independent paper status, budget, P&L, or public track record. The maker report exposes matched, both-filled, and live-only counts without blending the lanes.
- Explicit live arming, environment opt-in, kill switch, pause/resume, per-trade cap, order-rate cap, budget allocation, loss stops, and automatic safety suspension on ambiguous failures.
- Pause is a quiescent drain: withdraw intent, serialize behind execution, cancel/confirm managed remainders, reconcile authoritatively, and report restart-safe only when no working or uncertain transaction remains.
- Startup and periodic reconciliation read venue orders, fills, positions, resting orders, and cash before live execution. Managed remainders are canceled/confirmed; contradictory state fails closed. Prior partial reduce-only exits are included when validating original entry fills, so reconciliation does not replay the same exit or compare full acquisition history against only the open remainder. The fill-cost ceiling is the `reservedStakeCents` authorization captured at issuance, so repricing a reporting-only shadow field cannot move a fail-closed safety threshold.
- Operator intent is separated from operational state. Manual pause/kill/config changes never auto-resume; system suspensions may guarded-auto-resume only after authoritative reconciliation and normal readiness checks pass.
- Side-aware standalone reduce-only exits and protected live switching are implemented. Sell paths cannot create reverse exposure; partial/uncertain exits stop and reconcile rather than auto-chasing.
- Budget epochs, peak-equity drawdown accounting, current-epoch/lifetime P&L separation, and explicit stake-expansion criteria are implemented.

### Data, Public Projection, and Policy Identity

- Atomic JSON writes for cache, forecast history, provider settings, budget control, execution ledger, promotion ledger, and evaluation history.
- Forecast history is sharded: a hot open set the cycle reads and writes, immutable daily shards, and per-shard rollups that reproduce the lifetime summary without loading a sealed row. The legacy snapshot is retained during coexistence and is no longer on any read path.
- A local-only Scaleway Object Storage archive is enabled against private bucket `money-noodle-archive-857bea21`. A detached nice-priority worker runs every 24 hours, stores gzip-compressed content-addressed blobs, verifies every new upload by full read-back SHA-256 and byte count, and writes an immutable manifest only after the set passes. The first verified archive covered 31 files and 471,687,329 source bytes, uploading 43,128,615 compressed bytes. This first phase performs no local deletion and never runs on Vercel.
- Optional Postgres public paper projection is implemented with migrations:
  - [001_public_paper_projection.sql](/Users/raiphairow/code/money/db/migrations/001_public_paper_projection.sql)
  - [002_public_paper_performance.sql](/Users/raiphairow/code/money/db/migrations/002_public_paper_performance.sql)
- Hosted/stateless reads can serve replicated public paper budget and performance without live credentials or execution authority.
- Provider registry covers Polymarket, Kalshi, Crypto.com, ForecastEx, and Robinhood with per-market research/paper/live capability boundaries. New providers fail closed.
- Provider permissions are authoritative and separate for research, paper, and live. Budget venue fields are compatibility projections only.
- Per-provider budgets and per-market percentage allocations are implemented; market/global exposure caps remain global so budget splitting cannot multiply correlated exposure.
- Active policy manifest and read-only Policy view expose current forecast, buy, execution, exit, switch, regime, and provider-variant versions.
- Immutable model promotion/rollback ledger and authenticated `/api/model/promotion` write route are implemented. The route records decisions only while authenticated, same-origin, paused, quiescent, restart-safe, and with zero reserved budget. It cannot change compile-time model parameters.

## Prioritized Plan

### 1. Reduce Forecast Storage Residency

Why this is first: the process holds ~396 MB of retained heap to serve a working set of 135 rows, and adds ~40 MB a day. Extrapolated, the heap passes 1 GB in about two weeks and the default Node ceiling shortly after. Startup already costs 6-11 s to first useful response and grows linearly.

This section previously read "a 15-second system cannot keep full-history parse/stringify in the request or collector path." That premise was wrong and is worth recording as wrong, because it is what turned this into a fire drill. The parse costs ~1.2 s once per process; the ~10 s blocks were quadratic grouping in `summarizePerformance`. Sharding is still the right answer, but for memory rather than for blocking.

Started 2026-08-14:

- Added `lib/forecast-storage.ts` and `scripts/verify-forecast-storage.ts`.
- `npm run verify:forecast-storage` replays the legacy snapshot plus journal, builds a coexistence shard plan, and verifies row identity plus the full summary before writing anything.
- The gate compares the whole summary field by field, not eight counters: exact for anything countable, and a `1e-12 × max(1, |left|, |right|)` combined absolute/relative tolerance for float aggregates, because IEEE addition is not associative and a different row order legitimately moves the last digits. The absolute floor prevents last-bit noise near zero from becoming a false relative failure. Byte-identical output is not an achievable bar.
- Passing the gate required giving every reported ordering and tie-sensitive selection a total order by `id`. Ties are the ordinary case here, so `timeline`, both streaks, the per-cycle representative row, `recent`, grouped sorts, and the missed-buy selections previously could depend on durable row order. The missed-buy gate now uses the compact persisted provenance reference directly and covers an asset/window split across shards, including a globally nearest snapshot that contributes no candidate.
- A verified `--write` run over 49,703 live rows emitted `forecast-storage-v2`: 79 open rows, 49,624 terminal rows across 8 shards, and 6.6 MB of sufficient-statistic rollups standing in for roughly 190 MB of history. Both shard rows and rollups have indexed SHA-256 checksums, and the verification path now consumes the exact rollup objects that are written rather than rebuilding them invisibly from rows. The older 14 MB / 3,082-row open artifact was a symptom of event-loop starvation; resolution has caught up.
- Off-machine archive phase 1 is active: dedicated one-year Scaleway application credentials have object read/write and bucket read permissions but no object-delete or bucket-write permission. The app archives daily from the persistent worker; rolling local deletion remains deliberately disabled until repeated manifests and an independent restore test pass.

Plan:

1. ~~Build `summarize(sealedRollups, openRows)` beside the current function, both running and compared under the existing gate on live data, with nothing switching over.~~ **Done.** `summarizeFromRollups` in `lib/forecast-rollup.ts` reproduces the full summary under the gate over the 49,703-row live history, in 134 ms against 624 ms, from 6.6 MB of rollups standing in for roughly 190 MB of rows. Both paths run on every gate run and nothing has switched over. The merge depends on no property of the layout: it sorts ordered columns, merges cycles/windows by key, and globally re-selects the missed-buy snapshot per asset/window. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §4.1.
2. ~~Switch the reader.~~ **Done 2026-08-16, and measured.** `readForecasts()` returns the open set; sealed shards load lazily for the evaluator and the on-demand reports. Retained heap to serve the hot set fell from **426 MB to 17 MB** (RSS 493 MB to 70 MB): 1,549 open rows plus nine shard rollups standing in for 50,713 sealed rows. `/api/dashboard` warms in ~1 s and then serves in ~12 ms. The summary is unchanged, produced by `summarizeFromStorage` as sealed statistics plus the open rows, which the gate proves field-by-field against the direct scan.

   The switch is gated on `index.json`: absent or version-mismatched, every path falls back to reading whole history exactly as before, so it reverts by deleting one file. Sealing now also clears the journal — without that the next read replays events for rows already inside a shard and double-counts every lifetime figure.
3. Keep retention policy unchanged during the migration; this is a storage-layout change, not evidence deletion.

Rollups must come before sharding, not after. Every cycle `updateTracking` reads the whole array and the cached summary scans all of it every 60 seconds, so switching the reader while the summary still needs sealed rows would either keep the archive resident anyway or re-read the history every minute. The residency win is gated on the summary no longer needing sealed rows.

The worker boundary previously listed here is deferred indefinitely. It relocates work without reducing residency, which is not what binds. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §5.

Done means: retained heap and startup time measurably drop, forecast scoring matches pre-migration output under the gate, 15-second collection remains fresh through restart, and the dashboard can report degraded rollup state explicitly. **All four met as of 2026-08-16.** `/api/performance` carries `forecastStorage`, and the signed Performance dialog shows an explicit incomplete-figures notice when a shard rollup cannot be read — a missing rollup still produces a summary, just from fewer shards, so silently under-reporting a lifetime figure is the failure this guards against.

Two follow-ups remain, neither of which is residency:

- **Payload split** (design §7 item 2, agreed separately): the freshness badge should judge only market data, so no future slow subsystem can blank the trading view.
- **Retire the legacy snapshot.** `data/forecast-history.json` is 207 MB, frozen since the seal, and on no read path — it is the coexistence copy. Deleting it is what makes the switch irreversible, so it should wait until the sharded layout has run through several seals and an evaluator pass.

### 2. Build the Long-Shot Round-Trip Policy

Started 2026-08-14. A second production policy on `crypto-15m`, running beside the edge policy: buy a side
whose executable Kalshi ask reaches 10¢ within the first three minutes, sell through a resting reduce-only
GTC limit at 90¢. Design, arithmetic, and the screening behind every parameter are in
[docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md);
SPEC §12.10 and the 2026-08-14 decision-log entries carry the decisions.

This is a new trading feature, which the guidance above deprioritizes relative to storage and evidence. It
is being built anyway as an explicit operator decision, under a bounded learning budget: 30% of the
`crypto-15m` cap, a 20¢ opening ticket, and a derived halt at 300¢ of policy equity. Roughly $7–12 buys the
~60 resolved attempts needed to separate "real" from "hopeless," which is the only question that sample size
can answer.

What the screening does and does not support is recorded honestly. Buy-and-hold on this trigger has no edge:
20.2% ± 3.7pp over 119 candidates against a 22.2% break-even, so the cheap side wins about exactly what it
costs. The round-trip exit is **unmeasured** — path sampling is provably blind there, observing winners
reach 90¢ in 68.4% of cases where the true figure must be 100% — and that is the reason to collect rather
than a reason to believe.

Delivery order:

1. ~~Pure rule layer and ticket/cap arithmetic.~~ **Done.** `lib/long-shot-policy.ts`. Entry rule, ticket
   sizing, caps, and round-trip economics asserted against the production fee and sizing code rather than a
   copy, so a fee-model change breaks the test.
2. ~~`strategyId` on orders and summaries.~~ **Done.** `lib/strategy-registry.ts`, absent meaning the edge
   policy exactly as absent `marketId` means `crypto-15m`. One ledger, not two, because reconciliation is
   account-wide and a split file would leave real resting orders unmatched. `lib/strategy-isolation.test.ts`
   pins the money boundary in both directions.
3. ~~Per-policy budget sub-allocation and the derived halt.~~ **Done.** `lib/strategy-budget-policy.ts`. The
   percentage funds a strategy once; its equity then rolls forward on its own P&L. Applying the percentage
   continuously would size one strategy's ticket from the other's results and dilute its own losses so the
   halt could never fire on the strategy that earned it.
4. ~~Resting reduce-only GTC limit exits.~~ **Superseded.** Kalshi refuses `reduce_only` with
   `good_till_canceled`; verified against the production API. `lib/target-exit-policy.ts` polls the
   owned-side bid every two seconds and submits a reduce-only IOC at the mark instead.
5. ~~Buy-and-hold sentinels, written at trigger time.~~ **Done.** `lib/hold-sentinel.ts`.
6. ~~Contract price-path recorder.~~ **Done.** `lib/contract-path.ts`. Compact per-window triples rather
   than the rewritten array `cycle-path-store` uses, at under 700 KB/day.
7. ~~Reporting split by entry generation and regime.~~ **Done.** `lib/long-shot-report.ts`.

8. ~~Durable stores and collection wiring.~~ **Done, collection only.** `lib/contract-path-store.ts`,
   `lib/hold-sentinel-store.ts`, and `lib/long-shot-execution.ts` run detached from `processCycle`
   alongside the calendar and persistence lanes. Contract paths and hold sentinels accumulate from the
   next cycle onward.

9. ~~Execution.~~ **Done.** `runLongShot` and `runLongShotExits` in `paper-execution.ts`, inside the
   serialized engine queue and deliberately separate from `runPaper`/`runLive` — threading a second policy
   through the edge policy's selection, persistence, maker-retry, portfolio-ranking and regime-gate path
   would change behaviour the mirror invariant depends on. Exits run before entries so a position that
   reaches its mark frees its slot for a same-cycle re-entry.
10. ~~Two-second exit poll.~~ **Done.** Quotes are fetched outside the write queue and only the ledger
    mutation is queued, per the 2026-08-14 decision that upstream waits must not sit inside the queue they
    serve. A tick never queues behind itself, so a slow venue produces fewer polls rather than a backlog.

Enabled and running as of 2026-08-15. Entry is a price-capped taker IOC at the mark — an explicit exception
to maker-only production execution, because the trigger is defined as the ask reaching the mark. Every
account-wide protection still applies unchanged: kill switch, live arming, the reconciliation barrier, the
drain, and the shared hourly filled-order ceiling.

Funded at 30% of the Kalshi `crypto-15m` cap: 600¢, a 20¢ ticket, halting below 300¢. `npm run fund:long-shot`
reports and re-applies it, refusing unless automation is paused with nothing reserved or open.

Current state: the paper lane is live and the live lane is blocked by ordinary controls (`state: paused`,
`mode: paper`) rather than by any breaker — the edge policy's loss gate is clear at 0¢ current-epoch
drawdown and +225.85¢ lifetime. Contract paths are accumulating across all seven assets. No trigger has
fired yet, which matches the ~4/day the screening measured.

Live findings so far, in the order they were measured:

- **Cheap sides are common; cheap sides *early* are rare.** Only 2% of sides that reach 10¢ do so inside
  the first five minutes — a contract becomes cheap *because* the underlying already moved, so cheapness
  and clock-remaining are close to mutually exclusive. The entry window, not the price mark, is what
  limits candidate flow.
- **Fifteen-second entry sampling was not the constraint.** Of 586 recorded cheap-side episodes, only 13%
  lasted a single sample and half persisted beyond ninety seconds. One-second polling was added anyway,
  for the shared quote cache and to make a wider window affordable, not to catch flickers.
- **A still-falling price is a trend, not a dip.** Candidates still falling at the next sample reached 90¢
  0.9% of the time against 2.6% for those that stalled. Real, and worth filtering — but it moves the rate
  from 2.2% to 2.6% against a 12.5% bar.
- **No configuration of marks clears break-even.** All sixteen cells of an entry/exit sweep land between
  0.48 and 0.72, and the flatness rather than the best cell is the finding. See
  [docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md) §14a and
  `npm run analyze:long-shot-marks`.

Current stance: **stop tuning, keep collecting.** Every touch rate measured so far is a floor taken at
fifteen-second sampling, and closing the best ratio needs 1.39× more touches against a measured coverage
shortfall of 1.36×. The one-second polling now running removes that bias; re-run the sweep against paths
recorded under it before concluding anything. The paper lane costs nothing while that accumulates.

Remaining: the report surface, and the durable stores' retention policy once the journal starts growing.

Done means: the policy trades paper and live under the mirror invariant, the edge policy's behaviour is
byte-for-byte unchanged, exposure caps and the shared kill switch/reconciliation/drain still bind across
both, and 60 resolved attempts are reportable against the 12.5% break-even clustered by settlement window.

### 3. Harden Walk-Forward Review Before Any Model Promotion

The evaluator and promotion ledger exist, but promotion criteria still need to become decision-grade.

Remaining work:

- Add review thresholds for held-out Brier/log loss regression, coverage, drawdown, and window-clustered uncertainty.
- Report signal-policy return separately from maker-executable return so model quality is not confused with fill selection.
- Add the explicit clock/quality candidate dimension now that quality replay inputs are persisted prospectively.
- Correct for winner's curse from selecting the largest apparent edge across correlated assets.
- Require stable held-out return across enough independent windows before any parameter deploy-and-record cycle.

Current stance: baseline retained. No automatic evaluator result may change production, and no manual promotion should be recorded unless every evidence gate clears.

### 4. Decide the Profit-Reversal Exit Policy From Prospective Evidence

Strict value exits and the 75% profit-reversal lock are measured separately. Strict value remains executable. `profit-reversal-75-v1` is already withheld from execution by default on its own negative evidence; arming and high-water observations continue so the counterfactual remains prospective. The local environment explicitly keeps it disabled.

Remaining work:

- Keep collecting complete position paths so HOLD arms are no longer approximate.
- Re-run exit policy reports after enough new armed downturns under the current implementation.
- Require a separate manual evidence review before `MONEY_NOODLE_PROFIT_REVERSAL_EXIT=true` may restore execution or before a replacement reduce-only rule is introduced.
- Preserve strict reduce-only semantics: exits reduce only existing exposure and never become opposite-side buys.

The small historical live cohort supports conservative withholding, not permanent refutation or a replacement rule.

### 5. Accumulate and Evaluate Maker Queue/Depth Evidence

Instrumentation and the queue-aware paper simulator are implemented; the next step is held-out evidence, not live execution changes. Before this deployment, same-signal paper/live maker agreement was only 29.7% across 37 paired attempts (19 live-only fills and 7 paper-only fills), which is the baseline the new independent and matched-live lanes must improve on prospectively. The first post-deployment review has only 2 matched intents.

Remaining work:

- Segment fill and return by displayed-ahead proxy, imbalance, repricing path, resting duration, profit state, probability deterioration, asset, side, and time remaining.
- Compare accepted filled orders with accepted no-fills by settlement window.
- Measure independent-paper/live agreement and disagreements against the separately stored matched-live overlay; never substitute the selected live fill for the independent paper result.
- Recalibrate maker fill probability only after enough prospective fills and no-fills exist under `paper-managed-maker-trade-queue-v2`.
- Keep production `maker` execution unless maker/taker shadow results pass strict held-out gates. The review surface now clusters taker shadows by settlement window, compares them with the same intents' actual maker execution, and separates the active buy-policy cohort from historical policy mixtures; the prior unclustered +24.7% headline was not deployment-grade evidence.

Forbidden for now: depth-aware sizing, more retries, taker promotion, stale maker-to-taker fallback, or queue-aware live gates.

### 6. Verify First Organic Live Switch and Continue Exit Verification

The switch engine, reconciliation matcher, partial-exit handling, replacement withholding, and switch-versus-hold accounting are implemented and tested. A real organic switch has still not been economically verified end to end.

When it occurs naturally, verify:

- Reduce-only exit order side/action.
- Venue fills, fees, remaining quantity, and reservation release.
- Replacement withholding after zero or partial exit.
- Replacement submission only after a complete confirmed exit.
- Switch-versus-hold and standalone exit counterfactual accounting.

Never force a live switch just to exercise the path.

### 7. Provider Variant and Policy Visibility Follow-Through

The provider registry foundation is in place. The next useful work is observability and clean attribution before new execution adapters.

Remaining work:

- Add dashboard, performance, open-order, and decision-history filters for live/paper, provider, provider variant, market, and policy version.
- Move static policy manifest details into a durable model/policy registry with historical parameter diffs, dataset fingerprints, and audited promotion/rollback lineage.
- Add per-(provider, market) policy overrides for thresholds, sizing, and execution style.
- Defer candidate-set funding/ranking changes until there is a second live-capable provider, because it cannot change behavior before then.
- Add any new provider read/paper-first behind official API verification, operator eligibility, and explicit capabilities. No scraping path may imply live capability.

### 8. Secondary Work After Safety and Evidence

These are useful, but lower priority than storage, evaluation, exits, and maker evidence:

- Operator alerts for fills, orders, settlement, reconciliation, and drain state.
- Historical execution replay/backtesting with clearly labeled reconstructed assumptions.
- Demo/sandbox venue testing where supported.
- Consolidated venue exposure/P&L views that never blend live with paper.
- Durable workers, leases, backups, restore tests, runbooks, and deployment observability.
- Same-origin/CSRF enforcement on every mutation or billable research route, not only trading/model-promotion controls.
- Dependency pinning and security cleanup for packages currently set to `latest`.
- GitHub unreachable-object purge request and confirmation that the old Kalshi key ID is revoked.

## Guardrails

- Do not increase stake size from live P&L alone. Require independent live windows, lifetime and current-epoch P&L, drawdown, maker adverse-selection evidence, walk-forward results, reconciliation health, and real switch/exit verification.
- Do not add venue prices to the tradeable probability. They remain benchmarks and execution costs.
- Do not promote DOWN/NO or any side-specific gate mechanically. Side-specific profitability must be proven in held-out clustered windows.
- Do not manually trade the same active Kalshi ticker while automation owns or may enter it; shared-account netting has already caused reconciliation to block correctly.
- Do not let public/stateless deployments gain execution authority. They may read replicated paper projections only.

## Retired From Roadmap

These were previously listed as remaining work and are now implemented:

- Accepted-order `not_found` consistency handling and separated issuance/approved/submitted/amended/fill prices.
- Exact-contract maker-execution paper shadow, shared live/paper repricing transitions, public trade/queue fill evidence, and separate matched-live overlays.
- Explicit averaging-window parsing, Kraken-to-venue reference drift, and target-integrity reporting.
- Complete position-lifecycle, liquidation, queue/depth, and path observations.
- Versioned HOLD/EXIT/SWITCH action counterfactuals.
- Separate strict-value versus profit-reversal exit reports.
- Durable budget epochs, peak-equity drawdown, and stake-expansion criteria.
- Immutable model promotion/rollback core and authenticated write route.
- Public paper performance projection to Postgres.
- Market identity, per-provider tracking, per-provider budgets, and global-caps regression guard.
