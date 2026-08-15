# Money Noodle - Implementation Status

> Living status document. Updated 2026-08-14.
> Product requirements and architecture decisions live in [SPEC.md](SPEC.md).

## Executive Summary

Money Noodle is operational as a local research dashboard, continuous paper shadow trader, public paper-track-record publisher, and explicitly armed live Kalshi trader. Core UP/YES and DOWN/NO entry, managed maker execution, paper maker mirroring, signed Kalshi reconciliation, quiescent pause/drain, loss gates, budget epochs, provider permissions, contract provenance, target integrity, standalone reduce-only exits, protected switching, model evaluation, and immutable promotion accounting are implemented.

The system is mechanically capable. The unresolved question is economic: current evidence does not justify stake expansion, taker execution, looser entry gates, queue-aware live gates, or adding a second live venue. The next work should prioritize storage residency and decision-grade evidence over new trading features.

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
- Latest walk-forward run: `walk-forward:500:fnv1a-26981834`, generated 2026-08-14T17:26:16.618Z, 500 checkpoint windows, decision `baseline_retained`. Candidate mean window return was 3.07% versus baseline 3.89%; candidate had 3 positive folds and beat baseline in 3 folds, below promotion criteria.
- Forecast storage is a memory-residency risk, not a cadence risk. `data/forecast-history.json` is 188.7 MB and `data/forecast-history.journal.jsonl` is 12.2 MB. The parse itself costs ~1.2 s once per process behind a promise cache; the ~10 s blocks previously attributed to it were quadratic grouping in `summarizePerformance`, now fixed and 643 ms. What binds is that the process holds ~396 MB of retained heap to serve a hot set of 135 rows, and grows ~40 MB a day.

Interpretation: lifetime live is slightly positive, but the current live budget epoch is down materially. Stake expansion must use both views, plus drawdown, maker-fill quality, model evaluation, and reconciliation health. Do not treat lifetime positive P&L alone as readiness.

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
- Forecast history journal and compaction path exist, but the legacy full-history file remains too large and still needs sharding/rollups.
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
- The gate compares the whole summary field by field, not eight counters: exact for anything countable, and a 1e-12 relative tolerance for float aggregates, because IEEE addition is not associative and a different row order legitimately moves the last digits. Byte-identical output is not an achievable bar.
- Passing the gate required giving six reported orderings a total order by `id`. Ties are the ordinary case here, so `timeline`, both streaks, the per-cycle representative row, `recent`, and the grouped sorts previously depended on where rows sat in the durable file and could shift across a compaction or journal replay with no data change. Only two were found by reading the code; the gate found the other four. Last run over 49,600 live rows: `ok: true`, no errors.
- The 14 MB / 3,082-row `open.json` recorded here earlier was a symptom of the stall, not an independent blocker: while the event loop was starved, `resolveDueForecasts` could not keep up and unresolved rows piled into the hot set. With the loop fixed the hot set is 135 rows. The materialized artifacts under `data/forecast-history-shards/` are stale from that earlier `--write` run.
- Off-machine archive phase 1 is active: dedicated one-year Scaleway application credentials have object read/write and bucket read permissions but no object-delete or bucket-write permission. The app archives daily from the persistent worker; rolling local deletion remains deliberately disabled until repeated manifests and an independent restore test pass.

Plan:

1. ~~Build `summarize(sealedRollups, openRows)` beside the current function, both running and compared under the existing gate on live data, with nothing switching over.~~ **Done.** `summarizeFromRollups` in `lib/forecast-rollup.ts` reproduces the full summary from per-shard sufficient statistics with zero differences over the 49,675-row live history, in 134 ms against 624 ms, from 6.1 MB of rollups standing in for 188.7 MB of rows. Both paths run on every gate run and nothing has switched over. The merge depends on no property of the layout: an early measurement said shards never overlap in resolution time, that turned out to be false within the hour, and the merge now sorts rather than assuming. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §4.1.
2. **Next.** Switch the reader: `readForecasts()` returns the open set only, and sealed shards become lazily loaded for the evaluator and `/api/performance`. This is the step where retained heap and startup time actually drop, and it is measured that way rather than by cycle latency.
3. Keep retention policy unchanged during the migration; this is a storage-layout change, not evidence deletion.

Rollups must come before sharding, not after. Every cycle `updateTracking` reads the whole array and the cached summary scans all of it every 60 seconds, so switching the reader while the summary still needs sealed rows would either keep the archive resident anyway or re-read the history every minute. The residency win is gated on the summary no longer needing sealed rows.

The worker boundary previously listed here is deferred indefinitely. It relocates work without reducing residency, which is not what binds. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §5.

Done means: retained heap and startup time measurably drop, forecast scoring matches pre-migration output under the gate, 15-second collection remains fresh through restart, and the dashboard can report degraded rollup state explicitly.

### 2. Harden Walk-Forward Review Before Any Model Promotion

The evaluator and promotion ledger exist, but promotion criteria still need to become decision-grade.

Remaining work:

- Add review thresholds for held-out Brier/log loss regression, coverage, drawdown, and window-clustered uncertainty.
- Report signal-policy return separately from maker-executable return so model quality is not confused with fill selection.
- Add the explicit clock/quality candidate dimension now that quality replay inputs are persisted prospectively.
- Correct for winner's curse from selecting the largest apparent edge across correlated assets.
- Require stable held-out return across enough independent windows before any parameter deploy-and-record cycle.

Current stance: baseline retained. No automatic evaluator result may change production, and no manual promotion should be recorded unless every evidence gate clears.

### 3. Decide the Profit-Reversal Exit Policy From Prospective Evidence

Strict value exits and the 75% profit-reversal lock are now measured separately. The latest exit analysis showed strict value helping more than profit reversal, but the live profit-reversal sample remains small.

Remaining work:

- Keep collecting complete position paths so HOLD arms are no longer approximate.
- Re-run exit policy reports after enough new windows under the current implementation.
- Decide whether `profit-reversal-75-v1` should remain live, be disabled, or be replaced by a different reduce-only rule.
- Preserve strict reduce-only semantics: exits reduce only existing exposure and never become opposite-side buys.

No behavior change is justified solely from the small live profit-reversal cohort.

### 4. Accumulate and Evaluate Maker Queue/Depth Evidence

Instrumentation and the queue-aware paper simulator are implemented; the next step is held-out evidence, not live execution changes. Before this deployment, same-signal paper/live maker agreement was only 29.7% across 37 paired attempts (19 live-only fills and 7 paper-only fills), which is the baseline the new independent and matched-live lanes must improve on prospectively.

Remaining work:

- Segment fill and return by displayed-ahead proxy, imbalance, repricing path, resting duration, profit state, probability deterioration, asset, side, and time remaining.
- Compare accepted filled orders with accepted no-fills by settlement window.
- Measure independent-paper/live agreement and disagreements against the separately stored matched-live overlay; never substitute the selected live fill for the independent paper result.
- Recalibrate maker fill probability only after enough prospective fills and no-fills exist under `paper-managed-maker-trade-queue-v2`.
- Keep production `maker` execution unless maker/taker shadow results pass strict held-out gates.

Forbidden for now: depth-aware sizing, more retries, taker promotion, stale maker-to-taker fallback, or queue-aware live gates.

### 5. Verify First Organic Live Switch and Continue Exit Verification

The switch engine, reconciliation matcher, partial-exit handling, replacement withholding, and switch-versus-hold accounting are implemented and tested. A real organic switch has still not been economically verified end to end.

When it occurs naturally, verify:

- Reduce-only exit order side/action.
- Venue fills, fees, remaining quantity, and reservation release.
- Replacement withholding after zero or partial exit.
- Replacement submission only after a complete confirmed exit.
- Switch-versus-hold and standalone exit counterfactual accounting.

Never force a live switch just to exercise the path.

### 6. Provider Variant and Policy Visibility Follow-Through

The provider registry foundation is in place. The next useful work is observability and clean attribution before new execution adapters.

Remaining work:

- Add dashboard, performance, open-order, and decision-history filters for live/paper, provider, provider variant, market, and policy version.
- Move static policy manifest details into a durable model/policy registry with historical parameter diffs, dataset fingerprints, and audited promotion/rollback lineage.
- Add per-(provider, market) policy overrides for thresholds, sizing, and execution style.
- Defer candidate-set funding/ranking changes until there is a second live-capable provider, because it cannot change behavior before then.
- Add any new provider read/paper-first behind official API verification, operator eligibility, and explicit capabilities. No scraping path may imply live capability.

### 7. Secondary Work After Safety and Evidence

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
