# Money Noodle - Implementation Status

> Living status document. Updated 2026-08-14.
> Product requirements and architecture decisions live in [SPEC.md](SPEC.md).

## Executive Summary

Money Noodle is operational as a local research dashboard, continuous paper shadow trader, public paper-track-record publisher, and explicitly armed live Kalshi trader. Core UP/YES and DOWN/NO entry, managed maker execution, paper maker mirroring, signed Kalshi reconciliation, quiescent pause/drain, loss gates, budget epochs, provider permissions, contract provenance, target integrity, standalone reduce-only exits, protected switching, model evaluation, and immutable promotion accounting are implemented.

The system is mechanically capable. The unresolved question is economic: current evidence does not justify stake expansion, taker execution, looser entry gates, queue-aware execution changes, or adding a second live venue. The next work should prioritize event-loop/storage durability and decision-grade evidence over new trading features.

| Area | Status |
| --- | --- |
| Dashboard and public paper track record | Functional locally and through optional Postgres projection |
| Forecast and performance tracking | Functional; large forecast history is now the main latency risk |
| Live execution | Kalshi live-capable and active in local control; no current open/working positions in the local ledger snapshot |
| Paper execution | Continuous, maker-mode mirrored, independently accounted, and no longer limited to one order per cycle |
| Model evaluation | Automatic walk-forward scheduler and immutable manual promotion ledger implemented; latest run retained baseline |
| Provider expansion | Registry, permissions, variants, and budgets implemented; only Kalshi is live-capable |
| Operational safety | Startup/periodic/manual reconciliation, quiescent drain, guarded auto-resume, loss gates, and failure injection are implemented |

## Current Measured State

Snapshot from local durable files on 2026-08-14:

- Forecast history: 48,291 rows, 28,291 qualifying rows, 27,625 resolved qualifying rows, 2,191 resolved asset-cycles, and 463 resolved qualifying close windows.
- Live ledger lifetime: 821 non-exit orders, 396 settled entries, 230 settled windows, -112.11 cents exact realized P&L on 12,128.40 cents exact stake, 1 open and 0 working orders, 420 unfilled entries.
- Paper ledger lifetime: 781 non-exit orders, 746 settled entries, 332 settled windows, +366.70 cents exact realized P&L on 27,600 cents stake, 0 open and 0 working orders, 35 unfilled entries.
- Current live budget control: active, live mode, 2,000 cents starting budget, 679 cents available, 171 cents reserved, -1,150 cents current-epoch whole-cent realized P&L, 2,000 cents peak-equity reference.
- Budget audit: live control roll-forward matches the durable budget audit and current open reservation exactly. The 2026-08-14 BNB partial-exit chain is balanced: 200c reserved, 13c released, 108c partial exit settled for 126c, and the 79c remainder settled for 0c. Paper spendable budget matches the current reset epoch using whole-cent `pnlCents`; exact sold-exit `payoutCents` remain a reporting/accounting view and explain the apparent lifetime difference.
- Latest walk-forward run: `walk-forward:500:fnv1a-26981834`, generated 2026-08-14T17:26:16.618Z, 500 checkpoint windows, decision `baseline_retained`. Candidate mean window return was 3.07% versus baseline 3.89%; candidate had 3 positive folds and beat baseline in 3 folds, below promotion criteria.
- Forecast storage remains the dominant cadence risk: `data/forecast-history.json` is 228.8 MB and `data/forecast-history.journal.jsonl` is 39.1 MB. Full parse/stringify work can still block the event loop for seconds.

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
- Paper execution now mirrors the managed maker lifecycle instead of assuming immediate ask fills. Paper uses its own two-attempt maker retry ceiling by default and may submit every paper-selected candidate in one cycle until the configured portfolio, correlation, bankroll, or provider-funding constraints bind; live remains serialized one order at a time.
- Explicit live arming, environment opt-in, kill switch, pause/resume, per-trade cap, order-rate cap, budget allocation, loss stops, and automatic safety suspension on ambiguous failures.
- Pause is a quiescent drain: withdraw intent, serialize behind execution, cancel/confirm managed remainders, reconcile authoritatively, and report restart-safe only when no working or uncertain transaction remains.
- Startup and periodic reconciliation read venue orders, fills, positions, resting orders, and cash before live execution. Managed remainders are canceled/confirmed; contradictory state fails closed. Prior partial reduce-only exits are included when validating original entry fills, so reconciliation does not replay the same exit or compare full acquisition history against only the open remainder.
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

### 1. Fix Forecast Storage and Event-Loop Blocking

Why this is first: the trading cadence and dashboard freshness now depend more on local file size than on upstream feeds. A 15-second system cannot keep full-history parse/stringify in the request or collector path.

Started 2026-08-14:

- Added `lib/forecast-storage.ts` and `scripts/verify-forecast-storage.ts`.
- `npm run verify:forecast-storage` replays the legacy snapshot plus journal, builds a coexistence shard plan, and verifies row identity plus current summary counters before writing anything.
- A verified `--write` run created ignored local shard artifacts under `data/forecast-history-shards/`: 49,219 effective rows, 3,082 open rows, 46,137 terminal rows, and 7 daily terminal shards. Summary counters matched exactly: 29,197 issued, 971 pending, 28,226 resolved, 2,358 cycles, 2,254 resolved cycles, 480 resolved windows, and 507 calibration windows.
- The first materialized `open.json` is still 14 MB, so the next runtime step must reduce/seal old unresolved rows before switching the collector to the hot-set file.
- Off-machine archive phase 1 is active: dedicated one-year Scaleway application credentials have object read/write and bucket read permissions but no object-delete or bucket-write permission. The app archives daily from the persistent worker; rolling local deletion remains deliberately disabled until repeated manifests and an independent restore test pass.

Plan:

1. Implement rollups from [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md), gated on reproducing today's summary field by field over the full history.
2. Shard immutable settled history by day and keep only a small unresolved/hot set in the active file.
3. Move expensive aggregation behind a worker boundary or cached rollup reader so dashboard and collector requests cannot block on full-history parsing.
4. Keep retention policy unchanged during the migration; this is a storage-layout change, not evidence deletion.

Done means: 15-second collection remains fresh through restart, forecast scoring matches pre-migration output, compaction no longer serializes the whole history, and the dashboard can report degraded rollup state explicitly.

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

Instrumentation is implemented; the next step is evidence, not execution changes.

Remaining work:

- Segment fill and return by displayed-ahead proxy, imbalance, repricing path, resting duration, profit state, probability deterioration, asset, side, and time remaining.
- Compare accepted filled orders with accepted no-fills by settlement window.
- Recalibrate maker fill probability only after enough prospective fills and no-fills exist.
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
- Maker-execution paper shadow and maker-shadow correction.
- Explicit averaging-window parsing, Kraken-to-venue reference drift, and target-integrity reporting.
- Complete position-lifecycle, liquidation, queue/depth, and path observations.
- Versioned HOLD/EXIT/SWITCH action counterfactuals.
- Separate strict-value versus profit-reversal exit reports.
- Durable budget epochs, peak-equity drawdown, and stake-expansion criteria.
- Immutable model promotion/rollback core and authenticated write route.
- Public paper performance projection to Postgres.
- Market identity, per-provider tracking, per-provider budgets, and global-caps regression guard.
