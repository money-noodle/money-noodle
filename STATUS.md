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
- The walk-forward evaluator could not referee any of this. **Two of the three defects are fixed as of
  2026-08-18:**
  - `WalkForwardParameters` now carries `maximumEdge` and `minimumSelectedProbability`, defaulted to the
    production constants and held fixed across the candidate sweep, so the baseline **is** the gate the
    desk runs. Sweeping a gate bound would let the search rediscover a policy by fitting it; that belongs
    in the manifest, not a candidate set.
  - `selectedTrade` now scores **per dollar committed** rather than per contract. The desk sizes by stake,
    so a win at cost 0.45 returns 1.22 per dollar against 0.55 per contract. Per-contract scoring
    systematically misweights across price levels — the exact axis on which return per dollar rises with
    edge while win rate falls. `profitPerContract` is retained beside it so earlier runs stay comparable.
    **Every historical `meanWindowReturn` was produced in the old unit** and promotion-ledger entries
    predating this are not restated.
  - A structural property surfaced while testing: the 0.55 side floor and the 0.35 edge ceiling together
    make any cost at or below 0.20 unreachable, since `cost > sideProbability − 0.35 ≥ 0.20`.
  - **Still open:** `selectedTrade` scores buy-at-the-ask-and-hold, which the decomposition shows is
    neither what the desk earns nor a clean bound — fill selection costs −19pp and the exits are worth
    +14.6pp. An execution arm is the remaining piece.
  - The suite did not catch the scoring-unit change: none of its seven assertions touched
    `meanWindowReturn`. Six tests now pin both gates and the unit.

### High edge is the best band — and the diagnosis is unstable, 2026-08-18

[reports/edge-magnitude-2026-08-18.md](reports/edge-magnitude-2026-08-18.md). Measured on the **admitted**
population rather than the desk's filled orders, return per $1 *rises* steeply with edge — 5–10pp earns
+11.6%, 25–35pp earns **+44.0% ±11.5**, positive on 8 of 9 days — even though the win rate falls from
62.7% to 51.9%. **Win rate is the wrong statistic across price levels.** Ranking *filled* orders by edge
shows the top quintile at 28.1%, which reads as calibration failure and is a selection artifact of
execution. **Do not lower the max-edge ceiling**; that band is the most profitable thing the gate admits.

Fill selection is not uniform: the gap widens from −6.4pp at 5–10pp edge to −17.3pp at 25–40pp, and
high-edge orders fill *more* often (63–65%). The rows worth most are the ones execution damages most. No
cell is individually significant; the monotone shape is what carries it.

**Three reversals in one session**, each from a control that should have been applied first: fill selection
−25pp → −19pp conditional; window selection −16pp → −0.1pp; high edge miscalibrated → most profitable.
Surviving effects sit at t=1.5–1.7. Per AGENTS §6 the instability is itself the result, and **no execution
or gate change is authorized on this evidence.**

**The binding constraint is refereeing, not measurement.** Every open question ends at "needs prospective
evidence," and the walk-forward evaluator cannot supply it — see §3 below.

### v19 — the edge-spike gate is disarmed, 2026-08-18, by operator decision

`buy-binary-edge-net5to35-quality50-owned55-price5to97-v19`, manifest entry in `lib/policy-manifest.ts`.
The spike ceiling no longer refuses an entry. **The spike is still computed and still recorded on every
decision** by `edge-spike-sentinel-v1`, because that sentinel is the only prospective evidence that could
ever justify re-arming it — turning the gate off must not turn off the measurement.

**Recorded plainly: the evidence did not ask for this.** Over 52 graded sentinels the gate refused 7, and
those refusals returned −24.4% against −7.2% for admitted decisions — +17.2pp in the gate's favour at
t=0.43, directionally supportive and far from conclusive. v18's book was *not* measurably worse than v17's
(t=−1.36 paper, −0.41 live, n=37/44 over two days), so "v18 is underperforming" is not established either.
This is an operator decision taken with that stated. It is reversible through
`MONEY_NOODLE_EDGE_SPIKE_GATE=true` without a further version bump, and the bump's known cost — discarding
the accumulated adaptive-regime windows and re-warming — was accepted again.

A design defect was fixed in passing: the first version read `process.env` inside `evaluateSignalPersistence`,
which made the rule untestable from a fixture. `spikeGateEnabled` is now a declared field on
`SignalPersistenceRequirements` beside `maximumEdgeSpike`, so a caller states what it holds fixed. Tests
pin both the armed logic and that production is disarmed.

### Where the loss comes from — decomposed 2026-08-18

Full chain in [reports/loss-decomposition-2026-08-18.md](reports/loss-decomposition-2026-08-18.md);
`npm run analyze:loss-decomposition`. Each stage is conditional on the last, so the deltas sum to the gap
between what the gate is worth and what the desk realizes. **It changes the diagnosis.**

| stage | live | Δ |
|---|---|---|
| every admitted row, at ask, held | +14.4% | |
| in windows the desk was active for | +14.3% | **−0.1%** |
| contracts it actually ordered | −1.4% | **−15.7%** |
| the ones that filled | −20.8% | **−19.4%** |
| repriced at the maker fill | −17.5% | **+3.4%** |
| with the exits it took = realized | −2.9% | **+14.6%** |

- **Window selection costs nothing** (−0.1pp). The earlier "+16.2pp for passed-over contracts" was
  contract selection, not window selection.
- **Contract selection is a real and previously unseparated leak**: −15.7pp live, −11.8pp paper.
- **Fill selection is half its reputation**: −19.4pp conditional against −44.5pp standalone. Every prior
  reading of this policy used the inflated figure, which double-counts contract selection.
- **The maker discount helps** (+3.4pp), confirming that switching to taking would forfeit it.
- **The exit rule is the desk's strongest component** (+14.6pp live, +17.8pp paper). Execution is not
  uniformly the problem — one part of it is carrying the rest.

Two leaks of comparable size remain, both inside windows the desk was right to trade. A fix aimed only at
fills addresses at most half.

### Fill selection, stress-tested 2026-08-18 — real, stable, and conflated with window selection

Full checks in [reports/fill-selection-robustness-2026-08-18.md](reports/fill-selection-robustness-2026-08-18.md).
The −25pp fill-selection figure survives every robustness test except the decisive one:

- **Not the price effect.** Mean limit prices differ by 1.6¢; pricing both arms at their own limit and
  holding to settlement, the gap is −48.7pp (t=−3.23) live, −51.1pp (t=−3.77) paper.
- **Not a method artifact.** Free permutation of fill labels: p=0.0004 live, p<0.0001 paper.
- **Stable across all four days** of the cohort, with no drift toward zero, and negative in 26 of 26
  sub-cohorts (8/8 days, 12/12 asset-tracks, 6/6 price bands).
- **But the within-window permutation — which holds window quality fixed — is p=0.064 on live**, where
  only **21 of 140 windows** contain both a filled and an unfilled order. Paper reaches p=0.002.

So there are **two overlapping leaks**: the desk orders in worse windows (+16.2pp live, +21.3pp paper for
passed-over contracts) *and* fills the worse orders within them. Which dominates is unresolved on live, and
it decides the fix. The effect is also concentrated — DOGE/ETH/HYPE carry it on live while BNB/SOL/BTC
show almost nothing. **No execution change is authorized until the decomposition below is measured.**

### Taking the ask instead of resting — measured 2026-08-18, not supported

Full measurement in [reports/take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md); reproduce
with `npm run analyze:take-the-ask`. It was proposed as the response to the v17 fill-selection leak and
**the data contradicts the proposal.**

With the proper control — the same maker fills held to settlement rather than exited — the three effects
separate on the 206 live and 225 paper decisions of the v17 cohort:

- **The maker discount is worth keeping**: repricing the same fills at the issuance ask with the taker fee
  costs **−15.7pp live and −9.2pp paper**. Buying ~4¢ under the ask at zero fee is genuinely valuable.
- **The standalone exits help**, adding +4.3pp live and +13.0pp paper. They are not the problem.
- **The missed fills are the leak**, worth +2,869c live and +4,642c paper — the decisions the resting order
  never filled, which win about 25pp more than the ones it did.

**Taking the ask does not improve the rate of return** (−1.0% ±8.1 live, +1.8% ±7.8 paper, indistinguishable
from as-traded and from zero); its apparent cash advantage comes entirely from deploying about twice the
capital, which the 2,000c budget cannot do. It also does not replicate on v18, where it is worse on both
tracks. The problem is not maker versus taker: **the maker fills the losers and misses the winners.** A
selective rule — crossing only where the signal is worth 4¢ — is untested and is where this points.

### OPEN: the entry gate charges a fee the desk does not pay

**Close when v18's freshness sentinel reports.** Plan and measurements in
[docs/entry-gate-fee-design.md](docs/entry-gate-fee-design.md).

`venueFeeRate` deducts a Kalshi **taker** fee from every candidate's net edge, and production executes as
a **maker**, which Kalshi charges nothing for — 497 live maker fills at a mean of 0.000c against 0.682c
across 5 taker fills. At mid price that is 1.75pp, or 35% of the 5pp `MIN_NET_EDGE`.

Done 2026-08-17, behaviour-neutral:

- The two fee models are consolidated. `lib/venue-fee-schedule.ts` holds the schedule and the
  maker-is-free fact; `venueFeeCents` (charged whole cents) and `venueFeeRate` (marginal rate) both derive
  from it. They stay separate accessors because deriving the rate from the cents function would import a
  1c floor and ceiling rounding into a continuous expected-value test.
- `venueFeeRate` takes a required role, so all nine call sites declare which schedule they mean. Every one
  currently passes `ENTRY_FEE_ROLE`, which is `'taker'` — so nothing moved, and the whole correction is
  one constant.
- `lib/venue-fill.test.ts` pins the refactor against the pre-refactor formula over 99 prices × 8 sizes ×
  2 venues. That grid caught a real regression: composing the fee as a fraction and scaling back to cents
  reintroduced float dust (`0.07 × 0.5 × 0.5 × 400 = 7.000000000000001`) that turned a clean 7c fee into
  8c until the §1 epsilon was applied.

Not done, and deliberately: flipping `ENTRY_FEE_ROLE` to `'maker'`. Measured over 11,479 admitted rows in
2,154 windows it moves **1.0% of volume** — 201 rows cross the floor and are admitted, 125 cross the
`MAX_NET_EDGE` ceiling and are refused, and both marginal cohorts are individually noise. It is a
correctness fix with no expected improvement in return, and it shifts `edgeStrength` ranking and the
`netEdge − medianNetEdge` measure that v18's sentinel is currently evaluating. Disturbing a running
evaluation for that is not worth it.

When the sentinel reports: flip the constant, bump the policy version, add a manifest entry citing the
design doc, and correct the analysis scripts in the same change — each carries its own copy of the rate.

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
- Budget epochs, peak-equity drawdown accounting, current-epoch/lifetime P&L separation, and explicit stake-expansion criteria are implemented. The automation panel and the budget dialog date each track's figures with the moment its funding opened, from one shared formatter, and report the bankroll reset count beside it. Paper's original bankroll predates funding stamping and holds no opening timestamp, so it is anchored to its first trade (2026-08-08T21:12:37.137Z), labelled as a first trade rather than a funding; a reset dates itself from that point on.

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
whose executable Kalshi ask reaches 10¢ with at least ten minutes left on the clock, sell through a
one-second poll submitting a reduce-only IOC at 90¢. Design, arithmetic, and the screening behind every
parameter are in
[docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md);
SPEC §12.10 and the 2026-08-14 decision-log entries carry the decisions.

This is a new trading feature, which the guidance above deprioritizes relative to storage and evidence. It
is being built anyway as an explicit operator decision, under a bounded learning budget: 30% of the
`crypto-15m` cap, a 20¢ opening ticket, and a derived halt at 300¢ of policy equity. Roughly $7–12 buys the
~60 resolved attempts needed to separate "real" from "hopeless," which is the only question that sample size
can answer.

What the screening does and does not support is recorded honestly. Buy-and-hold on this trigger has no edge:
20.2% ± 3.7pp over 119 candidates against a 22.2% break-even, so the cheap side wins about exactly what it
costs. The round-trip exit is **unmeasured**, and that is the reason to collect rather than a reason to
believe. (The "68.4% where the true figure must be 100%" reading of that blindness is **withdrawn** as of
2026-08-17: winners need not pass through 90¢, because these contracts settle on a close-price comparison.
See design §14b.)

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
10. ~~One-second exit poll.~~ **Done.** `TARGET_EXIT_POLL_MS`. Quotes are fetched outside the write queue and only the ledger
    mutation is queued, per the 2026-08-14 decision that upstream waits must not sit inside the queue they
    serve. A tick never queues behind itself, so a slow venue produces fewer polls rather than a backlog.

Enabled and running as of 2026-08-15. Entry is a price-capped taker IOC at the mark — an explicit exception
to maker-only production execution, because the trigger is defined as the ask reaching the mark. Every
account-wide protection still applies unchanged: kill switch, live arming, the reconciliation barrier, the
drain, and the shared hourly filled-order ceiling.

Funded at 30% of the Kalshi `crypto-15m` cap: 600¢, a 20¢ ticket, halting below 300¢. `npm run fund:long-shot`
reports and re-applies it, refusing unless automation is paused with nothing reserved or open.

Current state, read 2026-08-18: the paper lane is live and **the long-shot live lane is blocked by its own
per-strategy arming flag** — `liveEnabled` is false because `MONEY_NOODLE_LONG_SHOT_LIVE_ENABLED` is unset.
It is *not* blocked by the desk controls, which are `state: active`, `mode: live`: the desk is armed for
the edge policy. Distinguishing the two is the whole point of the separate flag, and conflating them is
what placed three unintended live long-shot orders on 2026-08-15. No breaker is involved either way — the
edge policy's loss gate is clear. Contract paths are accumulating across all seven assets.

**Cohort as of 2026-08-17: 25 resolved paper attempts under `long-shot-round-trip-buy10-sell90-win600-v1`,
of which 1 sold at the mark** — against the 60 `LONG_SHOT_REVIEW_ATTEMPTS` requires before a first review.
Accumulating at roughly 12/day, so the bar is about three days out. The three `sold` rows in the earlier
`buy40` cohort were strict-value exits, not round trips: `observeAndExecuteStandaloneExits` is now scoped
to `EDGE_BINARY_BUY` precisely because it closed long-shot positions at 48–76¢ on 2026-08-15. Do not read
them as the exit working.

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
- **No buy→sell *gap* is priced loosely enough to pay either**, measured 2026-08-17 over 1,506 windows
  spanning 62 hours. Banding the entry (so a 40→60 row describes buying at 40, which a cumulative ≤40¢
  cohort does not) and grading misses at their real settlement, 131 populated cells span 0.43–0.82. The
  touch rate tracks break-even at ~0.6–0.8× of it everywhere: narrow gaps are achieved more often in
  almost exact proportion to paying less. See §14b and `npm run analyze:long-shot-gaps`.
- **Selling earlier trades return for the appearance of success.** Dropping the exit from 90¢ to 20¢ raises
  the sold-at-mark rate from 8.2% to 26.5% by selling all five winners in the cohort at ~2× rather than
  letting them settle at ~10×, in exchange for rescuing 8 of 44 losers. Paired on identical triggers, every
  exit earlier than 90¢ is negative; only 95¢ (+0.044) and never selling (+0.088) are positive, both
  t=1.76 among 17 comparisons. **Sold-at-mark rate is not a proxy for return, and moves against it here.**
- **The coverage correction is withdrawn, and with it the last cell above break-even.** Both §14a's
  1.36× and its successor rested on "every winner passed through 90¢ on its way to 100¢". **That is false
  here**: these contracts settle on a close-price comparison, and over 1,033 resolved windows the winning
  side was still bid **below 90¢ in 10.0% of cases**, below 10¢ in 0.8%. The like-for-like replacement —
  dense 1s paths decimated to 15s — implies 1.00–1.25× where entry detection is stable and swings wildly
  at ≤10¢, so **no correction is applied**. Uncorrected, **not one of the 131 grid cells clears 1.00**;
  the best reaches 0.82. This also removes the structural argument in design §3.3 that selling early beats
  holding — about a tenth of winners are reachable only by holding, which is the direction the paired
  never-sell comparison already pointed.
- **No entry filter screens out bad candidates.** Thirty entry-time filters measured 2026-08-17 on the
  wide ≤30¢ cohort (n=429) and re-checked in the production band. Closed off as unsupported: **the
  forecast model as a veto** (it prices the side at or above the ask on 100% of production-band
  candidates — there is no disagreement to trade on, so the entry rule ignoring the forecast per design §2
  costs nothing), **spread filtering** (98% of candidates sit inside 4¢), and **asset exclusion** (no
  asset is 1.6 SE from the cohort mean; §13 stays empty). The stall filter measures a 1.04 lift here
  against the 0.9%-vs-2.6% reading §7 records — a disagreement, reported rather than smoothed. See
  [reports/long-shot-filter-screen-2026-08-17.md](/Users/raiphairow/code/money/reports/long-shot-filter-screen-2026-08-17.md)
  and `npm run analyze:long-shot-filters`.
- **The one signal that separates candidates does not select any.** Three separately-derived measures —
  fell <10¢ from the window high, local volatility <0.1%, volatility ratio <1 — move together and all say
  *the side that got cheap without a big move is the better bet*, which is the opposite of the intuition
  that a long shot needs a large move. It **keeps 1 of 49 candidates at ≤10¢**: sides reach 10¢ *by*
  collapsing, restating §7. The subset surviving the confound check is stronger (n=16, ratio 1.27, return
  +0.834 ± 0.391) but its mean entry is **28.8¢** — a different strategy, not a filter on this one, and
  n=16 after thirty tests is a hypothesis rather than a result.

Current stance: **stop tuning, keep collecting.** Nothing measured authorizes a parameter change. The live
10¢→90¢ configuration sits in the best corner of the grid (0.77, with 95¢ at 0.82, n=48) and **no cell in
the grid clears 1.00**. The direction the data leans is later exits, not earlier ones, and never-selling
leads both — at t=1.76 on the best of many comparisons, a question rather than a result, but one the §3.3
correction now makes more plausible rather than less.

**Revisit trigger.** Re-run `npm run analyze:long-shot-gaps` and `npm run analyze:long-shot-filters` when
either arrives, and record the result here whichever way it falls:

1. **60 resolved attempts at one policy version** (`LONG_SHOT_REVIEW_ATTEMPTS`), which is the first review
   the design permits. About three days out at the current rate.
2. **Dense path coverage above a few hundred windows.** Only 45 of 1,506 windows currently carry the 1s
   sampling added 2026-08-16, which is why the fifteen-second blindness can only be bounded at 1.00–1.25×
   and not pinned. This is a smaller gap than the withdrawn correction implied, so it is no longer
   plausible that it lifts the best cell from 0.82 above 1.00 — it is worth closing to retire the caveat,
   not because a result is expected to change.

**A proposed volatility-trading strategy was measured and does not work as described** (2026-08-18,
[reports/maker-fill-adverse-selection-2026-08-18.md](/Users/raiphairow/code/money/reports/maker-fill-adverse-selection-2026-08-18.md),
`npm run analyze:maker-fills`). Entering on an intra-cycle direction change far from the 50¢ open is a
**coin flip**: eighteen configurations on the unbiased fifteen-second data, 1,200–2,000 signals each, all
between 48.3% and 50.5% with every interval covering 50%. And the taking economics are prohibitive — a
round trip at 70¢ needs an **8.14¢ move** at the current ticket and never less than ~4¢ at any size,
because most of the cost is proportional. Fees peak at 50¢, so trading near the middle is worst.

What survives is **execution, not prediction**: Kalshi charges nothing on a resting fill, so posting
collects the spread rather than paying it. Resting buys show **no detectable adverse drift** — every
horizon indistinguishable from zero across 15,000–17,000 fills over 1,611 windows, against an
unconditional control at zero. That is *no evidence of* adverse selection rather than evidence of none:
the mechanism is queue position, and a fifteen-second sample cannot distinguish a one-tick touch from a
sweep. Settling it needs depth recorded at the posted price over time, which the contract-path recorder
does not carry although the venue exposes it. **Nothing here authorizes a market-making strategy.**

**A bounded maker-fill experiment is running** (design §17, started 2026-08-18). It records order-book
depth and executed trade prints for the live `crypto-15m` contracts every 60 seconds, so a resting order
can be scored on whether volume actually traded **through** its price rather than on whether the quote
merely touched it — the distinction `analyze:maker-fills` cannot make and the one that decides whether
patient execution survives here. `npm run experiment:maker-depth`, bounded by 48 hours, a 45,000-request
cap, and a stop on repeated venue refusals, whichever binds first. It is a standalone script and is
deliberately **not** wired into `processCycle`: an instrument that is not on the execution path cannot
delay, gate, size, price, or trade. Both endpoints are public and unauthenticated. `data/maker-depth-experiment.jsonl`,
about 0.6 MB a day, retained 14 days as an instrument rather than a track record.

The fill rule it enables lives in `lib/maker-depth-experiment.ts`: a post fills once traded volume at or
through its price exceeds the size displayed ahead of it, with the size ahead **fixed at posting** so a
cancellation cannot fill an order and only executions advance the queue. It still cannot see private FIFO
rank or hidden size, so `displayedAhead` remains a stated proxy. **Nothing here authorizes a market-making
strategy.**

**The swing-trading premise is measured and closed** (2026-08-18,
[reports/swing-trading-2026-08-18.md](/Users/raiphairow/code/money/reports/swing-trading-2026-08-18.md),
`npm run analyze:swing-exit`). The swing is **real** — the owned-side bid reaches entry +2¢ in 64–81% of
positions — and selling into it loses to simply holding in every band and target size, by about 0.15 per $1
over 2,835 positions. A high hit rate with a capped gain and an uncapped loss is the shape.

Two further results from the same file:

- **Trajectory is a real signal, and smaller than the cost of taking it.** Trend efficiency (`slope ÷
  range`, already computed as `cycleRegime.trendEfficiency`) shows monotone mean reversion worth 2–3¢
  between extreme quintiles, and it **survives** measurement on a single consistent price series — bid-only
  t=3.52, ask-only t=2.64 — so it is not merely bid-ask bounce, though the spread's own reversion is
  enormous (t=20.65) and accounts for roughly 1.5¢ of the 3.3¢ mid effect. Traded as a taker it still loses
  (−1.4 to −2.1¢ gross before fees), because **the spread is widest exactly when trend efficiency is
  extreme**: a ~2¢ signal cannot cover a ~3.5¢ entry. An earlier reading here called it pure bid-ask bounce
  and is withdrawn. Any trajectory feature must be reported in traded form beside observed form.
- **A stop helps substantially and does not rescue it**, cutting the loss from −0.20 to −0.07 per $1. This
  **corrects §15b**, where stops appeared to hurt: that reading used the lowest bid of the whole window
  with no ordering and so fired the stop on positions that had already hit their target. Note the
  structural tilt it exposes — at a symmetric ±3¢ the stop fires 66% against the target's 30%, because
  entry pays the ask and is marked against the bid, putting the stop about a spread closer.

**Fine path recording is live** (design §18, 2026-08-18). Every eligible contract is now recorded at
**two seconds** rather than fifteen, using quotes `longShotEntryTick` already fetches for the entry
decision — **no additional venue requests**. Before this, fine sampling began only once a side fell below
the entry mark, at roughly 9¢/91¢: across 57 such windows, **zero** had the 20–80¢ range inside the fine
region, so every trajectory measurement in this repo was made at a resolution that hides ~37% of price
movement and conceals a 2¢-or-larger swing in 8.7% of intervals. Compaction thins windows older than
`CONTRACT_PATH_FINE_RETENTION_DAYS` back to the coarse grid, so the resolution is not a permanent ~130 MB
liability.

A standalone two-second poller was tried first and **withdrawn within a minute**: it rate-limited the live
desk inside thirty seconds on the endpoint it was polling. Kalshi's budget is per account and the repo's
limiter is per process, so a second process duplicating the desk's reads competes with it. Recorded here
because the instinct to add a separate collector will recur.

The one open hypothesis is the **quiet-market signal** above. If it is worth testing it needs a committed
sentinel arm at a higher entry band, written at decision time and followed to settlement — not a filter
bolted onto a policy whose candidates it does not select, and not a retroactive re-screen (§5.5). That is a
design decision, not a parameter, and is unstarted.

**Operator-defined analysis bands are implemented** (design §15a). The dashboard's long-shot dialog now
carries a band editor: each band is one hypothesis — buy inside an entry range, sell at an exit — measured
against every recorded window, with touch rate, break-even, ratio, and clustered return per $1. Saving
starts no backfill, because the stored candidate summaries carry no band, entry mark, or entry window:
`lib/long-shot-candidate.ts` keeps the first occurrence of each distinct ask with the peak bid reachable
after it, so any band is a lookup. Measured on the current data, backfill of 1,590 paths takes 69ms and a
band evaluates in single-digit milliseconds.

Two guards are structural rather than procedural, because this is a retroactive-screening surface and
AGENTS §5.5 says screening may filter an idea and may never promote one: no module that can price, size,
gate, or trade may import the band store (`lib/analysis-bands.test.ts` asserts it), and the number of
configurations ever evaluated is displayed as the multiple-comparison denominator.

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
- **The concrete gate for flipping to `adaptive`, measured 2026-08-18: the shadow's taker-flagged orders must show a materially worse maker outcome than its maker-flagged ones. They do not.** Over 618 orders carrying an `entryExecutionDecision` (74 flagged taker, all executed as maker), the fill-selection gap is −11.2pp on taker-flagged against −13.1pp on maker-flagged, with identical fill rates (51% against 50%). The recommendation shows **no discriminating power on the thing that decides it** — the gap is slightly smaller where it says taker, which is the wrong way round. Re-grade when the flagged count roughly doubles; `MIN_TAKER_MAKER_SAMPLES=30` means the per-cohort recommendation is itself running on small samples. Until that reverses, flipping `adaptive` would be acting on a signal with no demonstrated skill.
- A wholesale switch to taking is separately measured and **not supported**: see
  [reports/take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md). The maker discount is worth
  +3.4pp live and +1.5pp paper, and taking everything changes the *rate* not at all — its apparent cash
  gain comes from deploying about twice the capital, which the budget cannot do. The selective per-order
  rule above is the only version of this question still open.

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
