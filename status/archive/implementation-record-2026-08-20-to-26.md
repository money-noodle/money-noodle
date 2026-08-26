# Money Noodle - Implementation Status

> Living status document. Updated 2026-08-26.
> Product principles and the canonical specification map live in [SPEC.md](SPEC.md); detailed normative
> requirements and decision history live in its indexed [`spec/`](spec/) modules. The modular extraction on
> 2026-08-25 changed documentation structure only, not product behavior or funded authority. The decision index
> routes 157 preserved rows into bounded immutable archives, and CI runs `npm run verify:spec` to check canonical
> module coverage, local links and anchors, archive counts, ADR indexing, and agent-context size limits.
> Design discovery and lifecycle now live in [`docs/README.md`](docs/README.md): all 46 top-level documents carry
> controlled type, approval, implementation, canonical-requirement, and decision metadata, and CI runs
> `npm run verify:docs`. Design documents remain supporting rationale, not requirement or runtime authority.
>
> **Operational-state warning:** this document records dated snapshots; it is not a live interlock or the
> authority for whether funded execution is running. Before any operational action, read the authenticated
> Automation surface and `data/trading-control.json`. At the latest operational snapshot, the control record
> was active / `live`, revision 7,057, with 1,525¢ available, zero reserved, and operator intent active.
> Startup full reconciliation completed READY at 2026-08-26T02:01:25.667Z with zero local/venue managed
> positions, resting orders, or reservations. The maintainer explicitly chose continued funded collection
> rather than Pause while the written economic gates mature. That state may change after publication.

## Executive Summary

Money Noodle is operational as a local research dashboard, continuous paper shadow trader, public paper-track-record publisher, and environment-gated, explicitly armable live Kalshi trader. Core UP/YES and DOWN/NO entry, managed maker execution, paper maker mirroring, signed Kalshi reconciliation, quiescent pause/drain, loss gates, budget epochs, provider permissions, contract provenance, target integrity, standalone reduce-only exits, protected switching, model evaluation, and immutable promotion accounting are implemented.

The **repeated-episode order-identity defect found on 2026-08-20 was mechanically repaired and its known ledger damage corrected on 2026-08-21**. New live episode IDs retain collision-resistant identity through every create retry; reconciliation no longer fuzzy-matches truncated legacy IDs and blocks one venue order from owning multiple local entries. Ledger v9 preserves the HYPE before/after correction and trading control preserves the +54¢ whole-cent audit event. V9 retains every identity/control/money row in the shared account ledger while hydrating heavy immutable terminal evidence from verified content-addressed batches on demand. Separately, current economic evidence does not justify stake expansion, unconditional taker execution, an automatic entry relaxation, queue-aware live gates, or adding a second live venue. The shared buy rule remains **v22** — a 2026-08-20 operator narrowing to a +5pp edge floor and a 10–75¢ price band, not an evidence promotion. Live execution identity is now `maker-high30-requalify3-fresh1c-bounded-taker-pilot-v7`; its bounded v1 treatment completed at the compiled 10-authorization / 300¢ ceiling and subsequent eligible intents retain incumbent maker execution. Episode policy and sizing are unchanged.

A 2026-08-21 mirror review found that paper v4 first attempts were useful but its generation check suppressed every episode after episode 1. The defect was repaired under v5 and neutral calibration advanced current paper execution to `paper-managed-execution-route-ioc-requalify3-calibrated-v6`. The 2026-08-26 exact live-v7/paper-v6 review now covers 170 terminal exact pairs across 93 windows. Conditional on 122 accepted same-route/same-quantity live makers, paper captured only 24/66 live fills (36.4%), with 63.1% fill agreement and clustered paper-minus-live fill rate −35.93pp ±5.72pp. Paper remains a materially conservative approximation, not live-equivalent; F2 continues and no calibration or live rule changed.

The former long-shot round trip is **retired**. Its frozen 12¢→97¢/600s paper cohort completed 150 attempts across 76 independent windows, lost 1,410.93¢ exact on 4,979¢ staked, and measured the 97¢ exit at −98.93¢ versus holding. Its live lane was never armed. Execution, polling, collection, UI/API, estimators, and strategy-level allocation splitting are removed; historical ledger identity and durable evidence remain. The edge policy and capital ceilings are unchanged.

| Area | Status |
| --- | --- |
| Dashboard and public paper track record | Functional locally and hosted; bounded summary/full-report split implemented. Managed Postgres access recovered and durable production projections returned 200 after the 2026-08-22 deployment. |
| Forecast and performance tracking | Collection is implemented; the 2026-08-22 interleaved-writer corruption was repaired into checksum-valid, content-addressed v3 after restoring 88 qualified archived rows. Automatic v3 seals and a 138-file independent Scaleway restore passed on 2026-08-24; aggregate economic conclusions still require recalculation. |
| Live execution | Kalshi live-capable; repeated-episode and external-position ownership are repaired. Dynamic exchange identity is runtime-confirmed. Bounded taker v1 completed with three accepted IOC submissions, no treatment safety stop, negative/inconclusive treatment-minus-control evidence, and no route promotion. |
| Paper execution | Continuous under neutral v6. Exact live-v7/paper-v6 review found material undercapture over 122 accepted comparable makers. F2 has 121/121 complete records across 53 windows, but its 100-window and 300-window/30-race gates remain closed and F3 is unactivated. |
| Model evaluation | Evaluator v2 remains barred from promotion and production remains Blend 0.4. Phase 2's written wiring review passed at 45 closed windows with 5,169/5,169 complete-family rows and zero replay error; 100/300 gates remain closed. Confirmed-signal evaluation stays queued after the base final review, followed strictly by venue, portfolio, authorization, and lifecycle layers. |
| Provider expansion | Registry, permissions, variants, and budgets implemented; only Kalshi is live-capable |
| Operational safety | Collision-resistant bounded live IDs, exact reconciliation ownership, quiescent drain, account reconciliation, kill switch, and budget/risk ceilings are implemented. Runtime readiness and operator state must be read from the live control surfaces named above, not inferred from this table. |

### Long-shot v2 completed and the strategy is retired, 2026-08-26

[`reports/long-shot-v2-final-review-2026-08-26.md`](reports/long-shot-v2-final-review-2026-08-26.md) records the fixed review at `2026-08-26T01:37:23.326Z`. The precommitted 60-window gate passed with 150/150 resolved paper attempts across 76 UTC settlement windows, complete trigger/peak/outcome coverage, zero unexecuted triggers, and no live attempts. Exact P&L was **−1,410.93¢** on 4,979¢ staked; whole-cent bankroll P&L was −1,415¢. Clustered round-trip return was −17.18% ±26.75pp SE and hold was −14.71% ±27.56pp SE.

The primary paired exit comparison was **−2.47pp ±0.85pp per dollar / −98.93¢** across all 150 attempts. All 11 positions sold at the 97¢ target later settled in the owned side. This rejects the target-exit's value on the committed cohort. The hold estimate remains broad, so retirement is a negative-evidence plus complexity/load judgment rather than a claim that every possible cheap-contract strategy is disproven.

Long-shot entry/exit/trailing pollers, paper/live execution, sentinel/candidate writes, Postgres replication, authenticated UI/API, funding command, and strategy-specific analysis tools are removed. Active allocation is again provider → market only; legacy strategy-allocation fields are dropped during runtime normalization and receive no read or write authority. `long-shot-round-trip` remains a retired registry identity for historical ledger, compaction, P&L, corrections, and reconciliation attribution. Durable worker files and the applied database migration were not deleted or rewritten. No edge forecast, admission, execution, exit, sizing, market, or capital setting changed.

Validation passed typecheck, 133 test files / 998 tests, lint with zero errors / 26 inherited warnings, production build, and `git diff --check`. The generated route manifest omits `/api/long-shot`; the restarted worker returned HTTP 404 for it. Before activation, an unrelated BNB cancellation ambiguity correctly held a 30¢ reservation and system pause through contract close; periodic reconciliation then proved zero positions/orders/fills, released the reservation, and guarded-auto-resumed without manual mutation. The built worker restarted with operator intent unchanged and completed startup full reconciliation READY at revision 7,057 / `2026-08-26T02:01:25.667Z`, with 1,525¢ available and zero reservations or open positions. Obsolete local `MONEY_NOODLE_LONG_SHOT_*` settings were removed; Vercel's production environment contained no matching variables. Production deployment `dpl_AdJoZGjQ4ihWyQLEN3an8LMs8pqH` reached READY and was aliased to `https://noodle.money`; the homepage and compact paper summary returned HTTP 200 and `/api/long-shot` returned 404.

### Exact live-v7 / paper-v6 mirror reviewed; paper remains conservative, 2026-08-26

[`reports/paper-live-exact-v7-mirror-review-2026-08-26.md`](reports/paper-live-exact-v7-mirror-review-2026-08-26.md) replaces the stale v4-only analyzer scope with the prospective exact `entry-execution-mirror-pair-v1` cohort. From the first live-v7 intent through `2026-08-26T02:14:27.274Z`, it found 171 exact pairs, 170 terminal pairs across 93 independent close windows, 77 paper-only IDs, 16 live-only IDs, and zero ambiguous IDs. All six route/quantity mismatches were expected paper-treatment/live-capacity-withheld pilot cases; there were zero unexpected route mismatches.

The primary accepted same-route/same-quantity maker subset has 122 pairs across 77 windows: 24 both filled, three paper-only, 42 live-only, and 53 neither. Paper fill rate was 22.13% against live 54.10%; agreement was 63.11%, live-fill capture 36.36%, and paper-positive precision 88.89%. Window-clustered paper-minus-live fill rate was **−35.93pp ±5.72pp SE**. The 24 both-filled makers acquired equal quantity and paper paid 0.958¢ more per contract on average. The paper bankroll tied exactly at 10,000¢ start − 3,802¢ realized − 0¢ open = 6,198¢ available.

This is diagnostic fidelity evidence, not a return selector. Exact FIFO position and cancellations ahead remain private, different fill cells deploy different capital, and the earlier v4 cohort used a looser one-second retrospective pairing method. No queue-clear fraction, horizon, paper generation, funded route, entry, exit, sizing, or capital changed. F2 remains frozen at 121/121 complete records across 53/100 windows, 69 known live pairs, one observed create race, and zero grace-induced fill changes; F3 remains blocked.

### Kalshi event-order routing now uses exact dynamic exchange identity, 2026-08-25

[`docs/kalshi-exchange-index-wire-design.md`](docs/kalshi-exchange-index-wire-design.md) repairs a stale funded wire
constant. The last accepted local live order was created at 03:51:23Z; the next 15 consecutive creates from
04:11:24Z through 08:03:48Z returned `market_not_found` and reconciled absent. Fresh exact-market API responses for
all six funded-capable active 08:30Z contracts returned `exchange_index: 2`, while maker create/amend, taker entry,
and reduce-only exit bodies all hardcoded index 0. Index 2 is current evidence, not the replacement constant.

Every order path now reads the exact signed active market immediately before submission, requires exact ticker,
active status, and a non-negative safe-integer `exchange_index`, and injects that value into the fixed-decimal wire
body. Maker create retries capture one index and fail before another submit if it changes; management refreshes
must retain the accepted index before amendment. Taker entry uses its exact quote index, and reduce-only exit adds a
fresh exact-market identity read without changing its limit, quantity, or reduce-only semantics. Missing,
string-coerced, fractional, negative, unsafe, inactive, mismatched, or changing identity has no fallback and fails
before the next wire request. Accepted entry and exit indexes are durable audit fields only.

Validation passed typecheck, 147 files / 1,168 tests, 59 focused live-order/target/reconciliation tests, lint with
zero errors / 37 inherited warnings, production build, execution-ledger v9 verification over 4,662 orders, source
search proving no `exchange_index: 0` remains under `lib/`, and `git diff --check`. Activation used operator
pause/drain at revision 6,633 with zero reservations; the built worker completed READY startup reconciliation at
revision 6,634 / 2026-08-25T08:36:46.502Z, and explicit Resume set active revision 6,635 at
2026-08-25T08:37:07.009Z.

The initial 30-minute natural-opportunity watch through 09:07Z found zero post-resume reservations because no
positive-edge binary buy qualified; the gate was open and all seven markets were `WATCH`. The later runtime review
through the 14:33Z issuance observed **22 natural live attempts, 19 accepted entries, and two accepted exits**. All
19 accepted entries durably carried `venueExchangeIndex: 2`, both accepted exits carried
`exitVenueExchangeIndex: 2`, no accepted row had missing/malformed index, and zero post-repair attempt recorded
`market_not_found`. The cohort ended with seven unfilled, 12 lost, one won, one sold, and one still-open row; those
economic outcomes do not authorize a policy conclusion. The runtime wire confirmation gate is complete without an
artificial funded test.

Production source deployment `dpl_DdSaB76cS6iKZoqgdeKDWBMinyf7` completed READY and was aliased to
`https://noodle.money`; the homepage, compact paper-performance summary, and paper-budget endpoints returned HTTP
200. Hosted remains stateless and has no funded wire authority.

### Adaptive regime UI now states permission and probability plainly, 2026-08-25

The signed Automation strip and Budget dialog no longer call `negativeReturnConfidence` “negative confidence” or
format resolved/minimum windows like a capacity fraction. An open gate now says **entry permission remains open**,
labels the metric **estimated negative-return probability**, states the probability required to pause, calls
`weightedMeanEdge` **weighted recent fee-aware return**, and shows resolved windows and minimum separately. Closed
and reopened reasons use the same vocabulary. The internal field, normal-CDF arithmetic, 99% pause threshold, 75%
resume threshold, 12-window minimum, half-life, evidence cohort, and entry authority are unchanged.

The wording change passed typecheck, 147 files / 1,169 tests including explicit open/closed/reopened copy semantics,
lint with zero errors / 37 inherited warnings, and the production build. Rollout used manual pause/drain at revision
6,743 with the existing 24¢ open-position reservation intact and authoritative full reconciliation READY. The built
worker completed startup reconciliation READY at revision 6,744 / 2026-08-25T14:36:38.532Z; explicit Resume set
active revision 6,745 at 14:36:57.059Z. The live read then showed `phase: open`, `allowsEntries: true`, and the new
reason: “Entry permission remains open: estimated negative-return probability is 23.0%; pausing requires 99.0%.”

Production deployment `dpl_GJpGYKZATAfANmwxykgYJn7bVBoQ` completed READY under the explicit
`phairows-projects` scope and was aliased to `https://noodle.money`. The homepage, compact paper-performance
summary, and paper-budget endpoints returned HTTP 200. Hosted remains stateless and has no funded control or order
authority.

### Due prospective checkpoints reviewed; no economic promotion, 2026-08-25

Four fixed reviews now record the active collection posture without changing production:

- [`reports/forecast-candidate-phase2-wiring-review-2026-08-25.md`](reports/forecast-candidate-phase2-wiring-review-2026-08-25.md): the 10-window smoke passed with 5,169/5,169 complete-family rows, 45 closed windows, 95.59% production scoreable coverage, 100% candidate availability, and replay error 0. Phase 2 continues; 100/300 gates remain closed and Phase 3 does not start.
- [`reports/paper-execution-timing-10-window-review-2026-08-25.md`](reports/paper-execution-timing-10-window-review-2026-08-25.md): F2 wiring passed with 45/45 records across 20 windows, 25 exact live pairs, 100% timing coverage, 18 accepted/accepted targets, and zero grace differences. The 100/300 pair gates remain closed and F3 does not start.
- [`reports/bounded-taker-pilot-v1-closure-2026-08-25.md`](reports/bounded-taker-pilot-v1-closure-2026-08-25.md): v1 stopped at ten authorizations / 300¢. Three signed IOC submissions were accepted with no treatment safety stop, but treatment-minus-control was −7.12pp ±17.56pp live and −7.88pp ±12.65pp paper. `reviewUnlocked` is false; no extension or route switch is proposed.
- [`reports/live-paper-economic-monitor-2026-08-25.md`](reports/live-paper-economic-monitor-2026-08-25.md): the fixed day ending 14:30Z found 47 live fills across 34 windows and −259.466¢ exact P&L on one attribution route, versus 52 paper fills across 42 windows and −258.308¢. The complete ask-priced signal surface remained positive while fills were negative, preserving implementation selection and exits as leads rather than promoting a retrospective filter.

The maker restrictions remain locked: live spread has only 13/20 divergent windows and weak paper support; spike has ten live divergences and is negative in paper. Exit v2's later approved accounting repair now reports 48/50 complete live positions across 36 windows and 47/52 complete paper positions across 39 windows. Coverage passes 90%, but every arm remains below the separate 60-window and 20-divergence gates and `reviewUnlocked` remains false. Stake expansion is explicitly ineligible because current-epoch clustered return was −7.9% ±8.7pp over 189 windows, peak drawdown was 26.6%, and lifetime exact P&L was negative. These observations authorize continued frozen collection and fixed-UTC review, not tuning.

### Remaining exit-v2 gaps are outcome-selected zero-bid states, 2026-08-26

[`reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md`](reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md)
replays 9,240 v2 events across 150 sentinels. Official close-bounded coverage was 71/78 live (91.03%) and
62/72 paper (86.11%). Aggregate cycle observation remained above 97%, but 52/57 live and 48/50 paper pre-close
unavailable cycles occurred within 90 seconds of close. Durable forecast rows show representative losing sides
converging from a 0.1–0.2¢ bid to a fresh one-sided market with zero owned-side bid. `exitObservationTerms`
correctly refuses zero liquidation value, but v2 then conflates known non-executability with missing evidence.

The selection is load-bearing: every position made incomplete by cycle coverage was a loss (six live, nine paper).
The only two incomplete winners were separately explained by after-close enrolment and missing paper trigger-depth
evidence. Candidate economics over complete paths are therefore not promotion-grade even if raw counts reach 60;
every `reviewUnlocked` remains false. Historical generic unavailable events cannot be relabelled safely because
they retain no rejected quote or reason. The evaluated option is a fresh prospective v3 event distinguishing
`observed_executable`, `observed_non_executable`, and genuine `unavailable`. The maintainer deferred that work on
2026-08-26; v2 remains diagnostic-only, and no v3 design or implementation has started.

The same read found 190 public exact-market Kalshi 429 messages across seven contracts in one 20:15Z window. That
burst did not coincide with an incomplete exit position and F2 remained 100% available, so it is not assigned as
the exit-coverage cause. It does invalidate the traffic reference's prior “solid” assessment: caller/time
attribution and effective-burst accounting are incomplete. Long-shot live arming remained false.

During this read-only review, a separate BTC maker cancellation race produced 14 periodic reconciliation failures:
the venue's resting list named order `01a03b96-6c48-7f6e-8322-4eb6c765e3e2`, while cancel and exact lookup returned
`not_found`. The desk correctly system-paused, retained the 30¢ reservation, and did not auto-resume while state was
ambiguous. After the 01:15Z contract close, periodic reconciliation proved zero local/venue positions, fills,
resting orders, and reservations; it released the reservation and system-auto-resumed at revision 7,026. No manual
resume or ledger mutation was performed.

### Exit-v2 coverage now uses close-bounded evaluator opportunities, 2026-08-25

[`reports/exit-sentinel-v2-coverage-diagnosis-2026-08-25.md`](reports/exit-sentinel-v2-coverage-diagnosis-2026-08-25.md)
replays all 6,333 immutable v2 journal events through `npm run analyze:exit-sentinel-coverage`. The active cohort
had 50 resolved live / 52 resolved paper positions but published only 34 / 36 complete (68.0% / 69.23%). Aggregate
pre-close observation was actually 1,508/1,529 live (98.63%) and 1,371/1,393 paper (98.42%). The report classified
120 live and 91 paper cycles at or after exact contract close as unavailable while waiting for outcome resolution;
zero could have executed an exit. One delayed settlement added 23 false misses over 343.204 seconds.

Excluding only those non-opportunities mechanically produces 48/50 live (96.0%) and 47/52 paper (90.38%) while
retaining every genuine pre-close gap and one paper candidate trigger lacking exact book evidence. Fourteen of 16
published live incompletes and 11 of 16 paper incompletes are therefore mechanical. The root is explicit:
`maintainExitPolicySentinels` classifies every unresolved sentinel before its due-resolution pass, and
`exitSentinelPathComplete` has no close bound. Waiting unchanged would keep selecting evidence by settlement
latency and late-entry path length.

The maintainer selected Option A. The written §10 amendment now defines an opportunity as
`positionOpenedAt <= cycle.at < closesAt`. The pure report defensively omits historical timestamp-proven
non-opportunities, maintenance no longer appends new at/after-close cycles, and out-of-window observations cannot
move candidate state. Existing events were not migrated or backfilled; every genuine pre-close miss and paper
trigger-depth gap remains.

The recalculated runtime report at 16:48Z had 48 complete live positions / 36 windows and 47 complete paper
positions / 39 windows. Incremental candidate results were mixed and interim: live clustered means ranged from
+2.98pp to +17.31pp, while paper ranged from −7.04pp to +7.96pp; the largest divergent count was 17. Every arm
remains `reviewUnlocked: false`. The separate 60-window, 20-divergence, Holm, positive-cash, and simultaneous-track
gates remain closed. Typecheck, 147 test files / 1,170 tests, lint with zero errors / 37 inherited warnings, the
production build, and execution-ledger v9 verification passed. The built worker restarted without pausing funded
intent, completed READY startup reconciliation at revision 6,755, and retained the existing 29¢ open position.
Production exits and all money authority are unchanged.

### External venue positions no longer inherit rejected local ownership, 2026-08-25

[`docs/external-venue-position-ownership-design.md`](docs/external-venue-position-ownership-design.md) corrects the
exact-contract ownership boundary exposed by acceptable BNB and SOL positions created outside Money Noodle. The
previous current-position check treated every future-closing local row as an owner, including authoritatively
rejected and unfilled attempts. It could therefore compare an external venue position against local open quantity
zero and hold funded operation suspended until contract close.

`reconcileExecutionLedger` now claims a future exact ticker only while a local live Kalshi entry is `open`,
`pending_reservation`, `uncertain`, or exit-pending. Rejected, unfilled, sold, won, lost, and invalid rows do not own
current position. Pending and uncertain rows still claim the ticker with expected quantity zero, and open rows
still require exact signed venue quantity, so a lost response, hidden fill, overlapping external position, or exit
contradiction remains fail-closed. Unrelated resting orders, duplicate identity, fill/reservation ceilings, venue
cash, global risk, and all budget/accounting behavior are unchanged. External activity receives no local ledger or
P&L authority.

The status/side fault grid passed 31 focused reconciliation tests and the complete repository passed typecheck,
147 files / 1,156 tests, lint with zero errors / 37 inherited warnings, production build, execution-ledger v9
verification over 4,653 orders, and `git diff --check`. Activation used manual pause/drain at revision 6,617 with
zero reservations and READY full reconciliation; the built worker completed startup full reconciliation READY at
revision 6,618 / 2026-08-25T07:55:02.621Z. The maintainer-approved explicit Resume set active revision 6,619 at
2026-08-25T07:55:18.711Z. The first post-restart periodic incremental reconciliation completed READY with no blocker at
2026-08-25T08:00:04.766Z. The next BNB and DOGE creates returned `market_not_found`; each retained its reservation
through the 30-second consistency window, reconciled to rejected/zero-reserved in 32.260 and 32.087 seconds, and
then guarded-auto-resumed at revisions 6,623 and 6,627. This demonstrates that rejected lifecycle rows no longer
hold ticker ownership until close; it does not weaken the uncertainty window. Simultaneous external and Money
Noodle ownership of one exact ticker remains unsupported and blocking.

Production source deployment `dpl_7BXnyjSnv3PDX1ELvPQEYfD8VCJD` completed READY and was aliased to
`https://noodle.money`. The homepage, compact paper-performance summary, and paper-budget endpoints returned HTTP
200 after deployment. Hosted remains stateless, so funded activation authority stays with the separately monitored
local worker.

### Paper settlement operationally healthy but last-day economics negative, 2026-08-25

The fixed 24-hour review ending 2026-08-25T05:15:00Z found 183 edge-paper attempts across 68 settlement windows:
48 fills, 135 confirmed no-fills, zero rejected/nonterminal rows, and no currently overdue paper position with a
close at or before that boundary. Forty ordinary binary outcomes settled in 14.168 seconds median / 35.117 seconds
p95; one BNB outcome took 364.977 seconds and
left no reservation or accounting contradiction. Execution-ledger v9 verification passed, and the 10,000¢ paper
bankroll tied exactly to −3,258¢ whole-cent realized P&L, 0¢ open stake, and 6,742¢ available.

Economic performance did not share that health. The 48 terminal fills over 37 independent windows lost **398.481¢
exact on 1,250¢**, or −31.88% aggregate ROI and −30.93% ±15.77pp settlement-window-clustered standard error. SOL
and DOGE supplied 364.544¢ / 91.5% of the exact loss. Eight sold positions were 53.519¢ better than hold, so exits
did not explain the day's loss. End-to-end fidelity over 161 exact pairs / 67 windows was 80.1%, but 12 of 14
paper-only fills occurred when live never accepted a working order: 10 post-only acknowledgement races and two
reconciled-absent intents. Conditional on 125 same-route, same-quantity accepted live makers, paper agreement was
84.8%, live-fill capture 58.5%, and paper-positive precision 92.3%. Paper therefore assumes acceptance too early
while remaining conservative after comparable acceptance. The corrected broader held-out queue review now has 94
accepted-maker windows at 85.8% agreement, 67.6% capture, and 88.5% precision. Every one of the last day's 116
classified maker misses carried all six two-second trade reads; consuming-print observation lag was 1.221 seconds
median / 2.072 seconds p95. Faster whole-horizon polling is therefore not the first repair. A prospective final
read-after-horizon grace and separate sub-second create/acknowledgement model are better-scoped candidates. Private
FIFO rank and cancellations remain unobserved, and neither cohort authorizes a calibration or policy conclusion.

The public compact/full performance and budget endpoints returned 200 in 0.119/0.308/0.116 seconds at the check;
the compact projection was about 41 seconds old and the full projection about seven minutes old. The lifetime
public edge-paper record was −3,800.552¢ exact / −6.23% on cumulative stake, while the separately labelled
whole-cent bankroll was −3,258¢ with a 0¢ residual. Forecast accuracy, paper execution P&L, and budget control are
not interchangeable. `npm run analyze:paper-settlement` now reproduces rolling last/prior-day settlement, money,
latency, fidelity, and bankroll checks without writing durable data. Full method and caveats:
[`reports/paper-settlement-health-2026-08-25.md`](reports/paper-settlement-health-2026-08-25.md). No forecast, paper
fill, exit, bankroll, public projection, or funded behavior changed.

### Paper-execution fidelity Phase F1 establishes exact neutral control, 2026-08-25

[`docs/paper-execution-fidelity-v2-design.md`](docs/paper-execution-fidelity-v2-design.md) adds a four-stage
workstream alongside—but not inside or ahead of—the strict seven-layer decision roadmap. F2 will prospectively
separate the sub-second create/acknowledgement race from one event-time-bounded read-after-horizon evidence grace;
F3 will score a frozen queue-clear family only after comparable live acceptance; F4 will validate at most one
combined generation. None is activated by F1, and a retained or manually adopted paper generation must be frozen
before any later serial execution-evidence cohort uses it.

F1 repairs one dormant calibration-ownership discrepancy. The approved `queueClearFraction` definition applies
when paper joins each displayed queue, but implementation applied it only initially. The pure transformation now
owns initial acceptance, later recovery from unavailable depth, and every price-changing amendment. Complete
simulations with no calibration and an explicit neutral zero calibration are exactly equal; a manager test proves
a nonzero candidate applies after an amendment. The active store remains absent/neutral, so execution stays
`paper-managed-execution-route-ioc-requalify3-calibrated-v6`; no paper result, bankroll entry, public projection,
or funded path changes and no runtime restart is required.

The corrected calibration analyzer now excludes open rows and narrows queue scoring to accepted same-route,
same-quantity maker pairs. The rolling settlement analyzer separately reports acceptance attribution, comparable
queue fidelity, six-read coverage, public-read latency, and consuming-print observation lag. Phase F1 validation
passed typecheck, 145 test files / 1,136 tests, lint with 37 inherited warnings and no errors, execution-ledger v9
verification over 4,626 rows, and `git diff --check`. Those gates authorized only the separate F2 implementation
recorded below; they did not activate an evidence clock.

### Paper-execution timing shadow loaded; first-decision clock pending, 2026-08-25

Phase F2 is implemented under immutable `paper-execution-timing-shadow-v1`: one exact public maker-price quote
400ms after detached observer start, a second 250ms after the first completes, and one trade-history read three
seconds after the unchanged 12-second executable horizon. The final replay admits only prints whose venue event
time lies inside that horizon and applies each against the limit and queue then in force. The shadow stores bounded
public prints and independent acceptance/grace results in its own append-only journal; it never reads live status or
fills to choose, never mutates a paper order, and is absent from policy, portfolio, sizing, budget, settlement,
reconciliation, live orders, and public projection. `npm run analyze:paper-execution-timing` reports exact-pair
identity, acceptance confusion, decision/acceptance/grace coverage, read latency, and replay differences without
writing data.

Optional traffic is capped at six maker intents per calculation and three no-retry public requests each. Overflow,
backoff, malformed evidence, and request failures become unavailable. The continuously saturated upper bound is 18
reads/calculation (1.2/s across 15 seconds); the inspected 160-maker day implies about 480/day (0.006/s average).
The canonical traffic inventory is updated in
[`docs/venue-traffic-and-rate-limits.md`](docs/venue-traffic-and-rate-limits.md).

The implementation passed its pure event-time, exact-horizon, wrong-aggressor, duplicate-print, fixed-delay,
request-cap, immutable-order, append/reload, source-isolation, and durable-intent-before-observer tests. Typecheck,
147 test files / 1,146 tests, lint with zero errors / 37 inherited warnings, the production build, and execution-
ledger v9 verification over 4,639 rows passed.

The first restart boundary correctly stopped on control revision 6,563: reconciliation saw venue position −1.89
for `KXBTC15M-26AUG250230-30` against local open 0.00 with 30¢ reserved. No restart, resume, or ledger edit crossed
that contradiction. The authoritative path later cleared it to active revision 6,566 with zero reserved. The
maintainer-requested activation then used the normal manual pause/drain: revision 6,568 became operator-paused,
zero-reserved, reconciliation READY, and quiescent/restart-safe. The already-built worker started and completed
startup reconciliation READY at revision 6,569 / 2026-08-25T06:32:24.832Z. It remains manually paused; funded
execution was not resumed implicitly, while paper collection continues.

The new process has loaded F2, but no eligible paper maker appeared before the explicit live resume and
`data/paper-execution-timing-shadows.journal.jsonl` remained absent. Therefore the prospective F2 clock has **not**
been backdated to restart or resume: activation is the timestamp of the first durable timing decision. At
2026-08-25T06:46:43.218Z the maintainer explicitly resumed live from READY reconciliation with zero reservations,
so future exact paper/live maker pairs can now score acceptance; no funded state was resumed automatically.
Reproduce the zero-row boundary with `npm run analyze:paper-execution-timing`.

### F2 first-decision and two-window wiring smoke recorded, 2026-08-25

The F2 clock began at **2026-08-25T06:47:41.724Z**. A bounded watch through 07:32Z stopped before its two-hour
maximum after two independent UTC close windows had complete evidence and the second system suspension recovered
through READY reconciliation. All 7 expected exact paper makers had one decision, acceptance result, and final-
grace result: 100% decision/acceptance/grace coverage, zero unavailable or missing records, zero timing-shadow
runtime errors, and zero event-time replay differences from production paper fills.

Public-read latency was 68ms median / 105ms maximum for create and 71ms / 153ms for acknowledgement. Request
scheduling landed 2ms median late beyond both frozen delays, with 101ms create, 243ms acknowledgement, and 226ms
final-grace maxima. Actual timestamps are durable, so later scoring need not pretend nominal and realized timing
were equal.

Acceptance efficacy remains unmeasured. Five records had no live counterpart while funded execution was suspended;
the other two exact live attempts returned `market_not_found`, entered uncertain/reserved fail-closed handling, and
later reconciled absent. The public timing candidate classified both books accepted, but no public quote model can
predict that provider response. There were zero accepted live makers and zero post-only-race targets, so accepted
recall is undefined and the 10-window wiring gate remains closed.

Attribution correction: the simultaneous unmatched BNB and SOL venue positions were acceptable activity created
outside Money Noodle, not outcomes of the local `market_not_found` attempts. The pre-correction account-wide
reconciler retained rejected local ticker ownership, so it remained fail-closed until each external mismatch
disappeared and then ran guarded auto-resume. No local accepted venue ID or fill was recovered. The overlap is not evidence of a Money Noodle
accounting contradiction or of paper calibration behavior. Full method, counts, timing, and caveats:
[`reports/paper-execution-timing-smoke-2026-08-25.md`](reports/paper-execution-timing-smoke-2026-08-25.md).
Continue F2 unchanged to 10 independent windows; no model or policy change is authorized.

### Opportunity decision introduction and UI vocabulary aligned, 2026-08-24

[`docs/live-opportunity-decision-flow.md`](docs/live-opportunity-decision-flow.md) now provides the short ordered
introduction to the edge strategy's seven states: market observation, base signal, confirmed signal, venue
candidate, provisional portfolio selection, live authorization, and authoritative attempt/outcome. It follows
runtime order, points to the owning symbols, and explicitly records the current provider-agnostic persistence,
pre-gate portfolio read model, and funding-after-provisional-ranking seams so later refinement starts from actual
behavior rather than an idealized reconstruction.

The dashboard now calls the complete searchable grid **Current markets**, labels portfolio state as provisional,
and distinguishes base signals from confirmed or attempted signals. Its no-signal explanation names the complete
base-policy categories rather than claiming price alone rejected every market. The README links the introduction
and corrects its stale v22 price range to 10–75¢. These are documentation and presentation changes only: no
forecast, buy policy, persistence, portfolio, route, sizing, budget, reconciliation, or order behavior changed.

### Pure production forecast boundary established, 2026-08-24

Phase 1 of [`docs/forecast-model-and-evaluator-v3-design.md`](docs/forecast-model-and-evaluator-v3-design.md) is
implemented. `lib/forecast-model.ts` now owns the versioned, venue-independent Blend 0.4 arithmetic: basis
log-odds weighting, bounded per-term slow tilt, aggregate scaling, temperature, and final probability caps.
`buildPrediction` still owns source acquisition, explanations, confidence, and the separate venue-informed
comparison, while exact calibration replay calls the same pure probability combiner rather than reconstructing
that arithmetic independently.

The production constants, `MODEL_VERSION`, buy policy, factor values, confidence, and all money paths are
unchanged. A frozen pre-extraction formula test spans missing/flat/positive/negative basis, remaining-time and
volatility cases, slow-tilt cap boundaries, and candidate weighting at `1e-12`; exact dashboard replay and all
invariants remain green. Validation passed typecheck, 142 test files / 1,127 tests, and the Next.js production
build. Phase 2 candidate collection is now implemented below; uncertainty inputs, evaluator v3, simulated
execution, and final review remain unimplemented and milestone-gated by the design document.

### Prospective forecast candidate family activated, 2026-08-25

Phase 2 of [`docs/forecast-model-and-evaluator-v3-design.md`](docs/forecast-model-and-evaluator-v3-design.md) began
prospective local collection at **2026-08-25T03:17:17.456Z** under immutable
`forecast-candidate-registry-v1`. Every new forecast issuance stamps the exact production control, the previously
locked 0.65-basis/0.5-slow hypothesis, exact settlement-average mechanics, basis-only, production-capped intraday,
and half-slow candidates. Each available arm independently selects from funded-capable actionable sides through
the shared v22 fee-aware policy; model/provider/policy versions, active maximum-edge and DOWN controls, confidence,
probability, best quote, admitted entry, and qualify/refuse result are durable beside exact contract provenance.
No candidate is imported or read by policy, persistence, portfolio, execution style, sizing, budget, reconciliation,
or order modules; `lib/forecast-candidate-isolation.test.ts` protects that boundary.

The first runtime smoke read found **8 issuance rows in 1 open settlement window**, all 8 carrying the complete
six-arm family, all 48 arm calculations available, all actionable candidate quotes narrowed to the funded-capable
provider, and maximum production-control replay error **0**. This is wiring evidence only, not efficacy. Run
`npm run analyze:forecast-candidates` for current independent-window, exact-family, availability, and
venue-specific outcome coverage. The gates remain 10 windows for smoke, 100 closed windows with at least 95%
production funded-outcome coverage, and 300 closed windows with at least 90% availability for every retained arm;
continuous collection makes the final count nominally about 75 hours, but outages and missing outcomes extend it.

Activation used a quiescent funded restart: operator intent was withdrawn, the execution queue drained, and
manual full reconciliation passed before shutdown. The production build started locally at 2026-08-25T03:17:11Z;
a second manual full reconciliation completed READY at 2026-08-25T03:18:21.726Z, and the operator intent was
explicitly resumed at 2026-08-25T03:18:22.050Z with one reconciled open position, no blockers, and collection
continuing. Production Blend 0.4, buy policy v22, execution, capital, and every live authority are unchanged.
Validation passed typecheck, 145 test files / 1,133 tests, lint with 37 warnings and no errors, and the Next.js
production build.

### Confirmed-signal evaluation queued after the base-signal program, 2026-08-25

[`docs/confirmed-signal-evaluation-design.md`](docs/confirmed-signal-evaluation-design.md) freezes the next-layer
question without starting its evidence clock. It classifies confirmation conditions as economic selectors, safety
invariants, or diagnostics; keys actionable evidence by exact strategy, market, provider contract, asset, side,
and UTC close; and forbids cross-provider observations or outcomes from maturing another contract. Cross-provider
prices remain diagnostic unless separately approved as a versioned forecast input.

The first family will compare exact production, exact-provider two-consecutive-over-15-seconds, exact-provider
first-pass, exact-provider three-consecutive-over-30-seconds, and an exact-provider current-plus-one-of-the-prior-two
rule that tolerates one genuine policy failure but never missing or malformed evidence. Warm-up, cutoff, freshness,
base policy, and fees stay fixed. Four comparisons against production carry one predeclared Holm correction.
Signal results cannot promote a change without a separate prospective execution shadow.

This work is **strictly serial**. It starts only after base-signal Phases 2–6 finish and the retained or promoted
base version is frozen, because changing the base probability changes which observations can confirm. Confirmation
then requires exact-control grid/25-observation parity, 10-window wiring, 100 closed windows at 95% exact-provider
outcome coverage, 300 closed windows with 90% per-arm availability and 100 divergent windows, followed by 200
execution-scoreable and 100 divergent windows before one review. The updated overall timeline is in
[`docs/forecast-model-and-evaluator-v3-design.md`](docs/forecast-model-and-evaluator-v3-design.md) §14. Only the
current base Phase 2 has a calendar estimate; the confirmation clock does not begin at its three-day checkpoint.
No runtime, store, forecast, confirmation, policy, execution, capital, or live authority changed.

### Venue-candidate review queued after confirmed signal, 2026-08-25

[`docs/venue-candidate-evaluation-design.md`](docs/venue-candidate-evaluation-design.md) places the next runtime
layer after the confirmed-signal final handoff. It separates exact contract/provider identity, quote validity,
freshness, quantity lattice, all-in reservation, and other safety/mechanical feasibility from economic spread or
implementation-shortfall selection; it moves sizing, portfolio, execution lifecycle/style, funding, and live
readiness out of the conceptual venue-attractiveness question while retaining every production recheck until a
separate approved change.

The first venue phase is attribution, not a threshold candidate: fault-grid and 25-observation exact-control parity,
then 10-window wiring, 100 closed windows at 95% exact-provider coverage, and 300 closed windows with 100 windows
where a current economic selector independently changes the candidate—or a documented inert/insufficiently-active
finding. It records displayed confirmation ask, construction quote, exact pre-submit quote, submitted limit,
public simulated or authoritative fill/no-fill, fees, exit, and terminal outcome as separate views. Only after that
report may an amendment freeze a small new-outcome family; the likely areas are spread, route-specific spread, or
quote-age/implementation shortfall, not preselected thresholds. A new cohort then requires 300 signal windows, 200
execution-scoreable windows, and 100 divergent windows before one corrected review.

This program is Phases 11–14 in the serial roadmap. It cannot start while confirmation is unsettled because a
confirmation change alters the population, time, side, and quote entering venue candidacy. Current single-funded-
provider ranking is explicitly not evidence for multi-provider routing; a second funded provider remains fail-closed
pending its own exact target, adapter, funding, reconciliation, fill, and routing design. No runtime, store, provider,
policy, sizing, route, capital, reconciliation, or live authority changed.

### Portfolio-selection evaluation queued after venue candidacy, 2026-08-25

[`docs/portfolio-selection-evaluation-design.md`](docs/portfolio-selection-evaluation-design.md) adds Phases 15–18
to the strict serial roadmap. It starts only after the venue-candidate final review freezes the exact candidate
population. The existing `portfolio-choice-set-v1` journal remains an issued-order integrity sentinel; because it
omits no-order calculations, it cannot evaluate unused capacity, a new ranking formula, or a later promotion
candidate.

Phase 15 adds a separate observation-only full-cycle generation and requires fault/tie/boundary-grid parity plus 25
exact live-runtime controls, 10-window wiring, and 100 closed windows with 95% complete decision/outcome coverage
and complete issued-intent coverage. Phase 16 compares production greedy selection with exhaustive optimization
under production's own objective, eligibility-before-selection, reranking after a downstream skip, and hard-ceiling-
only attribution. Its exit is 300 closed windows plus 100 windows with a solver, selector, eligibility-order, or
rerank difference—or a documented inert/insufficient-activity finding.

Only then may an amendment freeze at most one small stateful family. Every arm must maintain its own causal shadow
positions and capacity rather than reuse production exposure after choices diverge. Signal readiness requires 300
closed windows, 90% per-arm availability, and 100 divergent windows; execution readiness requires 200 scoreable,
90% public-evidence coverage, and 100 divergent windows before one corrected review. The review cannot loosen a
hard exposure ceiling without separate capital/downside approval. Current production ranking, constraints, sizing,
capital, execution, and live authority are unchanged.

### Live-authorization evaluation queued after portfolio selection, 2026-08-25

[`docs/live-authorization-evaluation-design.md`](docs/live-authorization-evaluation-design.md) adds Phases 19–22
to the strict serial roadmap. It starts only after portfolio selection freezes. Existing `live-skip-v1` remains a
first-blocker episode journal; the new generation records every simultaneous authority result for each portfolio-
selected exact candidate, including no-intent outcomes, without gaining order or control authority.

Phase 19 requires a pure boundary/fault grid plus 25 exact live-runtime controls, 10-window wiring, and 100 closed
windows with 95% complete authority/outcome coverage and 100% durable-intent/reservation coverage. Phase 20 tests
pause, kill, reconciliation, provider/budget revision, strategy funding, duplicate identity, malformed wire terms,
lost response, crash, fill, cancellation, and recovery boundaries. It requires every declared fault plus 1,000
seeded schedules per critical pause/reconciliation/reservation race, then 300 closed windows and 100 independent
authority differences or a documented inert/insufficient-activity result.

Only then may an amendment freeze one focused fail-closed authorization generation: a proven safety repair,
fencing generation, bounded reconciliation lease, strategy-funding ownership correction, or exact control if no
repair is justified. Its held-out gate is 300 closed windows, 100 portfolio-selected authorization opportunities,
95% complete manifests, 100% issued-intent/reservation coverage, and seven continuous days at the configured
reconciliation cadence before one final review. Safety correctness is decided by fault and invariant evidence, not
higher return; capital loosening and misplaced economic/lifecycle changes remain separate programs. No runtime,
control, risk, budget, reconciliation, order, or live authority changed.

### Attempt-and-outcome evaluation queued after live authorization, 2026-08-25

[`docs/attempt-outcome-evaluation-design.md`](docs/attempt-outcome-evaluation-design.md) adds Phases 23–26 as the
final decision-layer program. It starts only after the live-authorization final review freezes the exact authority
generation. The shared execution and budget ledgers remain authoritative; a future append-only observer projects
current behavior into separate intent, venue-order, position, and cash states and cannot be read by policy, order
management, retry, exit, budget, reconciliation, settlement, or any live authority.

Phase 23 requires a pure valid/impossible-state grid plus 25 terminal live-runtime controls, 10 authorized-intent
window wiring, and 100 closed authorized-intent windows with 95% diagnostic-transition coverage and 100% critical
accepted-order, fill, reservation, release, position, and settlement coverage. Phase 24 faults every boundary from
durable intent through cash, requires 1,000 deterministic seeded schedules per critical submit/accept/fill/cancel/
reconcile/settle race, then 300 closed authorized-intent windows and 100 nontrivial refusal, rejection, zero-fill,
partial-fill, uncertainty/recovery, or early-exit paths—or a documented insufficient-activity finding.

Only then may an amendment freeze one mutually exclusive generation: a lifecycle/provenance, recovery/ownership/
cancellation/settlement, or exact/whole-cent accounting repair; one focused post-authorization economic management
family; or exact production control. Safety/accounting validation requires a new 300-window cohort, complete
critical ownership/money coverage, repeated fault gates, and seven continuous days without an unexplained gap.
Economic validation requires 300 closed/100 divergent windows followed by 200 execution-scoreable/100 divergent
windows. The final review keeps execution disposition separate from economic outcome and exact P&L separate from
whole-cent budget control. No status, schema, route, retry, management, reconciliation, settlement, accounting, or
funded behavior changed.

### Object archive restored independently and rebuildable caches reclaimed, 2026-08-24

The expanded archive captured **138 stable files / 1,436,922,799 source bytes** in manifest
`money-noodle/v1/manifests/2026/08/24/2026-08-24T16-16-01-305Z.json`; 30 blobs were new and 108 content-addressed
blobs were reused. A clean `/tmp` restore downloaded 130,967,357 compressed bytes and reproduced every file under
its manifest checksum and source byte count. The restored production forecast verifier passed over 74,817 current
rows, including 73,680 sealed rows in 17 shards and the 2026-08-24 automatic-seal generation; the restored v9
execution ledger passed over 4,397 orders and 3,548 compact evidence references. An earlier 133-file restore had
also passed independently. Exact `.next/cache` and `.next/dev` cleanup reclaimed 2,905,120 KiB while retaining
`.next/server`/`.next/static`; the running dashboard remained HTTP 200 and filesystem availability rose to about
34 GiB after temporary restore removal.

No durable local source was deleted. The bucket had suspended versioning, no lifecycle expiration, and no Object
Lock. Remote-primary eviction remains blocked on Object Lock/enforceable retention or a second independently
verified bucket plus the durable tier catalog and owner-aware hydration. The operator subsequently set a 10%
free-space reserve. `npm run check:disk` measures blocks available to the worker and fails below it. The first
2026-08-24 check found only 42.20 GiB / 4.56% available. Docker cleanup raised that to 71.43 GiB, then the operator
removed an accidentally fully allocated 512 GiB Android-emulator SD card (`Galaxy_S25_Ultra` was configured with
`sdcard.size=512G`). The final check passed with **586.36 GiB / 63.30%** available against the 92.64 GiB threshold;
`~/.android` fell to about 8.57 GiB and the independent `Medium_Phone_API_35` AVD remains. The entire Money Noodle
tree was only about 3.0 GiB and `data/` about 1.37 GiB; no application evidence was deleted. Method, totals, and caveats:
[the dated restore report](reports/object-storage-restore-and-disk-reclamation-2026-08-24.md) and
[the design](docs/object-storage-retention-and-disk-safety-design.md).

### Funded health hour found no unresolved account issue; v3 seal approaches, 2026-08-23

A read-only 2026-08-23T19:25:35Z–20:25:35Z observation made 240 dashboard and 60 authenticated control reads.
All returned 200. Dashboard latency was 4.6 ms median / 91.3 ms p95 / 747.5 ms maximum; control was 141.0 ms /
281.4 ms / 2.984 seconds. Collector gaps had 15.024-second median, 29.382-second p95, 44.877-second maximum, and
none exceeded 45 seconds. Twelve periodic checkpoints advanced; all completed READY, generally in
0.644–1.536 seconds, with one 7.850-second pass overlapping managed transactions. RSS was 160,544–919,312 KiB
and ended at 482,304 KiB; no sustained rise or >1 GiB event appeared. The evaluator file stayed byte-identical.
At the now-due 1,300-window boundary, 47 additional dashboard reads had zero failures and 738 ms maximum latency,
confirming automatic replay remained retired.

One accepted DOGE order returned `not_found` during managed cancellation. The engine retained authority,
system-suspended, refused the first unconfirmed reconciliation, then completed READY and guarded-auto-resumed
about 72 seconds later. Subsequent reconciliation found zero reservation, position, or resting-order
contradiction. This is successful fail-closed recovery, not unresolved exposure. `managed-maker` nevertheless
displayed that old error after reconciliation became READY until a later maker success cleared it by 20:33Z, a
bounded observability defect rather than current degraded state.

The forecast journal grew 2,792,017 bytes to 9,170,124 in the hour. At that single-hour rate, the 50 MiB owning
seal threshold is roughly 15.5 hours away; rate variation is the main caveat. At that observation time the first
automatic v3 seal and independent archive restore were the next operational gate; both subsequently passed on
2026-08-24. Disk was 97% allocated with about 32.5 GiB available and lost only 5,204 KiB during the hour, so it
was not an immediate exhaustion event but needed capacity alerts before bursty builds/archives. Funded control ended active at 2,382¢ available / 0¢ reserved / +382¢
current-epoch whole-cent P&L. Full methods and transaction evidence:
[the dated monitor](reports/live-health-monitor-2026-08-23.md).

### Incremental background reconciliation activated and live resumed, 2026-08-23

A one-hour 2026-08-23T02:53:26Z–03:53:28Z funded-runtime observation found that five-minute full-live-tier
reconciliation was the operational bottleneck: 12 completed passes included seven READY and five timeout-blocked
results; successful passes still took 57.9–65.2 seconds, collector success advanced only 154 times against about
240 nominal 15-second ticks, and eight of 58 compact control reads exceeded 20 seconds. Fail-closed first/second
failure suspension and guarded recovery worked, reservations returned to zero, and no account contradiction was
found. The failure was availability and scheduling, not a relaxed safety gate.

Current Kalshi OpenAPI 3.28.0 and bounded production reads verified order/fill `min_ts`/`max_ts`, 1,000-row
pagination, exact order reads, order-scoped fills, current resting orders/positions, and the moving historical
cutoff. Order `min_ts` is creation-based rather than update-based. In one 2026-08-23T05:21Z two-hour slice, 10
orders returned in 178.7 ms, four fills in 79.5 ms, zero resting orders in 77.1 ms, and three nonzero positions in
95.9 ms; exact order and fill reads took 141.3/87.9 ms. The chief caveat is that this is one current-account slice,
not a latency distribution, and Kalshi does not promise an atomic snapshot across endpoints.

The implementation in `docs/incremental-background-reconciliation-design.md` keeps full current-account audits
for startup/manual/pause-drain, and gives periodic/event recovery a durable overlapped checkpoint, fixed-window
order/fill deltas, exact active/pending transaction reads, current cash/positions/resting orders, and historical-
cutoff escalation. Its process-global timer is independent of the collector. Reconciliation `running` still
blocks new live exposure, but venue I/O runs outside the shared ledger serializer; a short fingerprinted commit
retries if local live authority changed. Paper, collection, and control reads remain available. No forecast,
entry, route, size, fee, budget ceiling, exit, or strategy semantic changes. Typecheck, 136 test files / 1,085
tests, lint with zero errors / 37 inherited warnings, and the production build passed.

The funded worker was manually paused and drained restart-safe with zero reservations and zero local/venue-managed
positions, then rebuilt and restarted at 2026-08-23T07:09:22Z. Full startup reconciliation passed in 1.688 seconds
against 6,213.89¢ venue cash. The first independent periodic incremental pass completed READY in 0.622 seconds at
2026-08-23T07:14:26Z and advanced the durable checkpoint. Across 83 dashboard reads spanning that first periodic
boundary, maximum latency was 900 ms and none exceeded one second; collector success advanced during the same
window. This is only one empty-position periodic pass, so it does not yet measure targeted pending recovery or
establish a latency distribution. The restart did not infer permission to reactivate funded execution. After
that verification, the operator explicitly resumed at 2026-08-23T07:15:26Z; control revision 5,673 became active
in live mode with 2,465¢ available, 0¢ reserved, healthy collection, and reconciliation READY.

A subsequent funded observation from 07:21:02Z–08:21:03Z closed the first active-hour gate: 12/12 periodic
checkpoints completed READY and advanced the watermark in 0.444–11.722 seconds, including passes overlapping
locally active funded transactions. Zero reservations or uncertain state remained. The old 58–65-second routine
pass and reconciliation-caused collector starvation did not recur. See
[the activation monitor](reports/incremental-reconciliation-monitor-2026-08-23.md).

That hour isolated a different availability blocker. At the 1,250-window automatic walk-forward checkpoint,
`maybeRunWalkForwardEvaluation` was awaited by the collector and synchronous evaluation occupied the shared Node
worker from approximately 07:30:25Z–07:33:09Z: 11 dashboard and two control reads timed out at eight seconds,
collector success had a 177.868-second gap, CPU stayed near one core, and RSS peaked at 1,154,416 KiB. The prior
reconciliation had already completed in 0.594 seconds. The old worker reproduced the stall at its 1,275-window
run, generated at 2026-08-23T13:46:11.975Z. Evaluator v2 is monitoring-only and barred from promotion.

The approved [offline-evaluation design](docs/offline-walk-forward-evaluation-design.md) is now activated.
`background-collector.ts` has no evaluator import or launch, and no same-event-loop timer replaces it. Explicit
`npm run evaluate:walk-forward-offline` execution requires exact confirmation plus paused operator state and zero
reservations; procedure additionally requires restart-safe drain and a stopped worker or isolated snapshot. The
command preserves the existing atomic store/checkpoint sequence and v2 promotion ban. Typecheck, 138 test files /
1,093 tests, lint with zero errors / 37 inherited warnings, and the production build passed. With the funded worker
stopped, the command reloaded 1,283 windows, correctly found no checkpoint due before 1,300, added no run, and did
not rewrite `model-evaluations.json`. The rebuilt worker restarted at 2026-08-23T15:47:43Z; full startup
reconciliation passed in 1.705 seconds against 6,152.61¢ venue cash with zero positions/reservations. The first
post-restart periodic pass completed READY in 0.450 seconds while collection advanced normally. The operator
explicitly resumed at 2026-08-23T16:08:28Z; control revision 5,803 became active in live mode with 2,398¢
available, 0¢ reserved, healthy collection, and reconciliation READY.

### Active strict-value exits remain adverse; alternatives evaluated, 2026-08-23

The fresh 2026-08-23T16:09:07Z read used 4,028 execution orders and 80,612 forecasts. Active-v22 live strict
exits were **0/34 versus authoritative hold across 30 windows**, giving up 128.2834¢ with clustered incremental
return −11.97% ±3.11pp. The active-v6 execution subset was 0/23 over 19 windows, −93.5138¢ and −11.71% ±3.84pp.
Paper points the same way: one of 28 exits beat hold over 24 windows, −165.652¢ and −15.88% ±9.11pp.
Lifetime history still disagrees—live strict exits remained +773.0¢ and +5.3% ±7.3pp over 114 windows—so the
finding is active-regime failure, not proof that liquidation never helps.

A seven-margin current-policy replay found hold, 10¢, and 20¢ arms ahead of production, but those margins were
inspected retrospectively and counterfactual live sales assume executable-bid fills. The separate 26-rule replay
found no persuasive replacement after multiple comparisons: the best raw row had clustered t=0.48, and no related
rule group supplied stable promotion evidence. This makes exit policy a high-priority design/prospective-sentinel
decision; it authorizes no automatic rule change. See
[the strict-value review](reports/strict-value-exit-review-2026-08-23.md).

### Prospective exit sentinel v2 activated; production policy unchanged, 2026-08-24

A fresh read of all 429 v1 sentinel records established that the existing prospective family was not
promotion-grade: active-v22 live had 38 complete positions across 34 windows from 150 resolved positions (25.3%
coverage), while the corrected-identity paper diagnostic had 39 across 34 windows from 158 (24.7%). The 5¢ arm
was positive in both incomplete diagnostics, but no arm reached 60 windows, 20 divergent windows, 90% coverage,
or corrected significance. V1 paper outcomes also assumed full best-bid fills rather than the production IOC
depth model. The dated inputs, totals, methods, and dominant coverage/executability caveat are in
[the v1 review and v2 repair report](reports/prospective-exit-sentinel-v1-review-and-v2-repair-2026-08-24.md).

The approved v2 repair now starts separate `exit-policy-sentinels-v2` snapshot/journal files and preserves all v1
evidence unchanged. It keeps the four precommitted arms, stamps `entryDecision.executionPolicyVersion` so paper
uses its actual calibrated execution generation, enrolls filled positions independently of first-quote
availability, records observed/unavailable evaluator cycles before resolution, and scores paper triggers with the
existing reduce-only IOC depth/fee model, including no-fill and partial-fill remainders. Missing paper depth makes
a triggered path incomplete. The review flag now also enforces positive cash and clustered mean, one-sided Holm
family correction, and simultaneous positive live/paper eligibility. No sentinel can mutate production.

Activation used a paused quiescent drain with zero reservations and successful manual full reconciliation. The
v2 store began prospectively at 2026-08-24T17:08:03.205Z; its first paper position carried the calibrated-v6
paper identity, recorded bounded IOC evidence, resolved with 100% explicit-cycle coverage, and reported
sub-epsilon equal cash differences as zero. The first post-activation periodic incremental reconciliation passed
READY in 1.319 seconds while v2 collection remained readable. After the reporting-epsilon correction, the final
rebuilt worker restarted at 2026-08-24T17:44:11Z and startup full reconciliation passed in 2.040 seconds with zero
local or venue-managed positions. Explicit Resume set control revision 6,214 active in live mode with 2,105¢
available and 0¢ reserved. Vercel production deployment `dpl_9hMJfeinHWQAfV67v8HhadDeV6hN` reached READY and
was aliased to `noodle.money`; the homepage, sanitized dashboard, and public paper-summary routes returned 200.
The latest local validation passed typecheck, 140 test files / 1,111 tests, lint with zero errors / 37 inherited
warnings, and a production build. The cited Vercel deployment passed its own production build before the
local-only maker-report gate correction.

### Last-day opportunity loss is execution-selected, not an entry-tightening case, 2026-08-24

The 2026-08-24T17:37:52Z read used 75,362 durable forecasts and 4,402 orders through the resolved
2026-08-24T17:30Z window. In the latest 24 hours, production-v22's 402 first-to-fire Kalshi positions across 86
windows returned +33.1% ±7.8pp at the ask; candidates in funded-active windows returned +18.1% ±6.9pp and the
131 ordered positions +20.7% ±11.0pp. The 46 positions that actually filled reversed to −32.8% ±15.5pp at their
issuance terms and realized −226.1777¢ on 1,144.95¢, −28.4% ±16.7pp over 31 windows. Accepted maker misses would
have won 73/101 and returned +45.4% ±12.2pp at their posted prices, versus 16/46 and −23.7% ±17.5pp for held
fills. Current-v6's 73 paired fill/miss windows retain a −25.1% ±12.8pp fill-return gap.

None of twelve non-inert entry-tightening screens beat v22 when omissions earned zero; the same null held over 72
hours and active-v22 history. Crossing every first ordered ask was retrospectively positive (+15.4% ±10.0pp last
day; +19.0% ±6.5pp current v6), but assumes full IOC fills and ignores capital/rate-slot displacement. Actual v6
taker evidence is only five fills. Strict exits again cost value—0/10 beating hold, −58.2277¢ and −24.0% ±7.6pp
last day—but explain only about one quarter of the loss and remain under untouched v2 prospective evaluation.
No production policy changes. The dated method, horizon comparisons, twelve-comparison cost, and fill-causality
caveat are in [the live opportunity review](reports/live-opportunity-review-2026-08-24.md).

The review also found that maker-sentinel `reviewUnlocked` checked counts but not its approved economic/statistical
lock. Reporting now requires scoreable coverage, positive exact cash and clustered mean, Holm correction across
both arms, and simultaneous positive live/paper eligibility; all current maker candidate flags recalculate false.
This changes no sentinel evidence or order path.

### Bounded taker pilot v1 activated, 2026-08-24

The maintainer approved and activated
[`bounded-taker-pilot-v1`](docs/bounded-taker-experiment-design.md) under execution generation
`maker-high30-requalify3-fresh1c-bounded-taker-pilot-v7`. It changes no v22 buy rule: eligible first-episode,
sub-30pp baseline makers with incumbent caps no greater than 30¢ are assigned by immutable SHA-256 identity to
25% taker treatment / 75% maker control. Treatment reruns the production venue buy rule at a fresh exact quote,
retains the 1¢ movement and active 75¢/10¢ price/spread ceilings, and submits only a capped IOC limit. The pilot
is compiled to at most 30¢ per treatment, 300¢/10 authorizations, 80 live assignments, two authorizations/hour,
one/settlement timestamp, 14 days, and 150¢ gross realized treatment losses. It has no promotion state.

Activation used the exact typed environment confirmation, a paused quiescent drain, zero reservations, and a
successful manual full reconciliation. The worker restarted at 2026-08-24T18:17:51Z; startup full reconciliation
passed in 1.994 seconds with zero local/venue-managed positions, and explicit Resume set revision 6,224 active in
live mode with 2,105¢ available and 0¢ reserved. Local validation passed typecheck, 141 test files / 1,123 tests,
lint with zero errors / 37 inherited warnings, and the production build. The execution-generation change starts
a fresh live cohort for generation-scoped maker and exit sentinels; prior v6 evidence remains durable and is not
pooled.

The first assignment was the same HYPE DOWN intent on live and paper, bucket 7,285/control. Both used the managed
maker; both filled 0.65 contract, validating mode-free assignment and separate fill accounting. The first
treatment was the same ETH DOWN intent on both tracks, bucket 847, authorized at 30¢ from a 51¢ issuance ask.
The exact refresh saw 72¢, beyond the 52¢ one-cent cap, so live submitted no venue order, paper independently
classified the same pre-submit movement refusal, and the live reservation returned in full. The conservative
pilot allowance still consumed the 30¢ authorization as designed. At the post-inspection read the pilot was
collecting with three live assignments, one treatment authorization / 30¢ authorized, zero treatment loss,
reconciliation READY, and no treatment ambiguity. This is operational evidence only; actual treatment IOC fills
remain zero. A follow-up durable-stamp identity check and explicit submission/acceptance/refusal counters passed
the same full validation, then a final quiescent restart at 2026-08-24T19:02:47Z passed startup reconciliation in
1.833 seconds; explicit Resume set revision 6,238 active with 2,167¢ available and 0¢ reserved.

A 2026-08-24T20:49Z reporting audit found that the treatment arm's generic `submissionAttempts` counter included
the maker submission from a treatment assignment withheld by the pilot's hourly ceiling. Assignment, P&L, and
all execution controls were correct; only route attribution was wrong. The report now counts only the intended
experimental IOC in treatment submission/acceptance fields and exposes withheld maker submissions/acceptances
separately. At the deciding 13-live-assignment read, this changes treatment IOC submissions from one to zero and
reports one withheld maker submission instead; the two authorized treatments remain pre-submit quote refusals.
The reporting-only correction activated through another quiescent drain with zero reservations; the
2026-08-24T20:50:31Z startup full reconciliation passed in 2.281 seconds and explicit Resume set revision 6,274
active with 2,172¢ available and 0¢ reserved.

### Live resumed; paper settlement and mirror behavior monitored, 2026-08-22

Production deployment `dpl_GcGwXaNANrHtY8uPYzGGfkHsJfSX` reached READY and was aliased to `noodle.money`.
Managed Postgres access had recovered: root, paper budget, compact paper performance, and full paper performance
returned durable 200 responses. After startup and a fresh manual account-wide reconciliation passed, the
operator explicitly resumed live at `2026-08-22T22:53:16.472Z`. Three paired attempts in the next observed
settlement window matched symbol, side, maker route, and requested quantity. Two paper/live pairs both rested
without filling; one paper maker filled and lost 23¢ while live failed closed before placement after the guarded
post-only retries. Every live reservation returned and subsequent periodic reconciliation remained READY with
zero local/venue-managed positions.

The current v6 held-out mirror cohort was 70 intents in 28 independent windows: both/paper-only/live-only/neither
was 12/4/9/45, or 81.4% fill/no-fill agreement, 57.1% capture of live fills, and 75.0% paper-positive precision.
A separate paper HYPE position issued while live was paused filled at 48¢, exited at 77¢ for +15.66¢ exact / +15¢
control P&L, and later resolved DOWN; holding would have lost 28¢. That row validates its paper lifecycle but is
not mirror evidence. The freshly recalculated broader report also found 15 current-policy live strict exits in
12 windows, none beating authoritative hold and giving up 68.7974¢ in aggregate. This is a priority evaluation
finding, not authority for a retroactive policy change. See
[the dated monitor report](reports/live-paper-resume-monitor-2026-08-22.md) for methods, cohorts, caveats, and the
priority-ordered findings. No forecast, policy, calibration, budget, or order rule changed.

### Noodle Land whimsical design direction locked; refinement precedes specification, 2026-08-22

The product direction for Noodle Land and the Noodle Lab is agreed in
[docs/whimsical-gamification-design.md](docs/whimsical-gamification-design.md): one noodle equals one cent;
Noodle Land is an ambient visual layer with optional deeper immersion; the Paper Pot and Live Stove remain
separate; Noodle Gain/Drain describe verified settled changes; Nomi is a simple vector mascot; and levels,
titles, parties, and accomplishments reward exploration, null results, freshness, and evidence discipline
rather than P&L, deposits, stake, live arming, order count, or trade frequency. Exact dollars and authoritative
paper/live, money, safety, and contract labels remain visible, and no whimsical state may influence a forecast,
policy, budget, order, or reconciliation path.

This is intentionally **pre-specification and pre-implementation**. A standalone, dependency-free visual
prototype now lives at `docs/prototypes/noodle-land/index.html`, with a reusable review sheet at
`docs/prototypes/noodle-land/nomi-character-sheet.svg`. Its current friendly-character pass gives Nomi a warm
pearl-onion face rather than using the app mark's black negative space. Gold noodles, green arrow-leaves, and
the broken navy orbit retain the main mascot's visual identity, while curious, noodling, comparing, eureka,
cautious, and resting now reshape the whole character instead of attaching rigid props to an unchanged icon.
The latest motion/theme pass stages 72 outlined SVG noodles in a center burst, orbital curl, and viewport-wide
noodle rain using the playful palette. The prototype now opens in light mode, retains a dark toggle, and applies
theme-aware surfaces and contrast to the hero, event console, research scale, category cards, sublevels, and
party strands. The Great Noodle Scale now uses friendly onion Nomi as its pivot, a rounded gold noodle beam,
and two leaf-rimmed cream bowls; Don't Noodle and Noodle This move lower with their respective pans while
remaining horizontal and clear of the tipping beam. The seven noodle types remain distinct
aqua/green/gold/coral/lilac/orange/pink categories, each with four same-hue sublevels (28 sample labels total).
The latest prototype naming pass gives every broth an alliterative title and sublevel family, using clear puns
selectively (`Udon Know Yet`, `Bayesically Brilliant`, and `Noodlini & Beyond`). A separate, deferred brainstorm
at [docs/noodle-progression-naming-options.md](docs/noodle-progression-naming-options.md) preserves four
alternative ten-level groups; none is selected and the prototype remains at seven categories. Category shade
is progression decoration only, not an outcome, readiness, track, or trading signal. The
exact-mark, separate-bowl, friendly pre-progression, first
colorful-progression, and softer first passes remain alongside it for comparison. It uses invented, labelled
paper values and has no app
imports, network calls, persistence, route, or trading authority. Bowl scaling, transition deduplication,
progress ownership and persistence, exact unlock events, public/private scope, mascot production geometry,
copy, motion, accessibility, and comprehension testing still require another approved design pass before any
`SPEC.md` decision or product code change. No store, schema, app component, policy, or funded behavior is
authorized by the prototype.

### Execution ledger v9 activated; fixed UI reads are bounded, 2026-08-22

The separately approved [v9 design](docs/execution-ledger-v9-design.md) is implemented and activated locally.
The stopped-worker migration retained all 3,794 order rows, reduced the funded hot ledger from 36,347,633 bytes
to 6,261,288 bytes, and moved heavy immutable fields for 3,548 seal-safe rows into 30 SHA-256-addressed batches.
A frozen v8 input remains content-addressed under `data/execution-ledger-legacy/`; rollback hydrates the current
generation rather than copying that stale input over newer orders. Five legacy logical IDs have duplicate rows,
so references use a per-row content key and preserve array position rather than deduplicating history.

The migration gate rehydrated and compared every field, then compared compact paper/live strategy summaries,
funding epochs, lifetime whole-cent P&L, maker cohorts over a grid, hourly rate counts, long-shot funding, and daily
loss. `npm run verify:execution-ledger`, both MJS/TypeScript compatibility readers, typecheck, 133 test files /
1,073 tests, lint with zero errors / 37 inherited warnings, and the production build passed. The migration activation startup reconciliation completed READY at `2026-08-22T19:16:53.876Z` with zero
local/venue-managed positions, no recovered fills or resting remainders, and zero reservations. A later final-code
restart encountered transient full-history Kalshi timeouts and correctly remained blocked/paused; after stopping
the retry pressure and making one clean restart, periodic reconciliation completed READY at
`2026-08-22T20:10:26.842Z` with the same zero-position/zero-reservation result. Control stayed operator-paused;
no policy or money semantic changed.

Five-request production observations after warm-up measured dashboard responses at 4.4–19.9 ms normally,
control summaries at 101.7–116.6 ms normally for about 19 KB, signed performance summaries at 30.5–42.7 ms,
paper budget at 7.8–13.3 ms, and 50-row trade history at 41.2–48.4 ms. One dashboard sample took 658.3 ms and one
control sample 327.5 ms under collector contention. These are bounded local observations, not latency
distributions. Fixed readers use compact rows; full reports and analyses hydrate evidence explicitly.

Residency improved but is not closed. A four-minute RSS sample was commonly 290–850 MB with spikes to 1.55 GB.
A later 30-second native sample was 78.0% idle and found structured clone in only 19/24,888 main-thread samples
(0.08%), down from 128/4,117 in the pre-v9 profile, but JSON parse remained 1,528/24,888 (6.14%) and physical
footprint still reached 2.8 GB / 3.1 GB peak. Append-only contract-path, calendar, and exit-sentinel journals were
approximately 15.5/12.5/8.8 MB and remain separate owning-store work; none was truncated or casually cached.
See the [migration report](reports/execution-ledger-v9-migration-2026-08-22.md) for method and caveats.
Automatic v9 evidence compaction remains disabled pending longer observation and a separate owning-store activation decision; the 2026-08-24 independent archive restore passed.

Public replication now probes unavailable Postgres with the compact summary before constructing a full report;
the exhausted quota therefore cannot repeatedly force execution-evidence hydration for a payload it will reject.
Hosted projection availability itself remains blocked on the external quota.

### Dashboard reporting read path bounded; hosted database quota still blocked, 2026-08-22

The 2026-08-22 investigation found no new forecast corruption: the current v3 verifier passed direct-versus-rollup
comparison over 75,378 rows. It found two independent reporting failures. First, the signed homepage polled the
complete `/api/performance` report every 15 seconds; a cold request took 6.323 seconds and returned about 970 KB
because it loaded lifetime forecast rows and every analytical report merely to render two trade rows. Second,
the public automation and performance panels independently polled the same approximately 311 KB Postgres JSON
record every minute, about 622 KB/minute or 896 MB/day for one continuously open tab before any other reader.
The managed provider now rejects reads with Postgres error 53000, “project has exceeded the data transfer quota.”
The Vercel deployment itself remained Ready; hosted paper/performance data remain unavailable until quota access
returns. No database upgrade/reset was attempted in this change.

The approved repair in [docs/reporting-read-path-design.md](docs/reporting-read-path-design.md) separates bounded
homepage summaries from on-demand full reports. The signed poll now reads a 517-byte execution summary with no
forecast import; direct current-process measurements at 2026-08-22T17:20Z were 408 ms cold / 166 ms warm over
3,649 edge-policy orders. The public summary was 2,062 bytes with four recent rows, 890 ms cold / 238 ms warm;
its remaining warm cost was the advancing forecast journal replay, not a shard scan. These are direct module
measurements rather than production-build HTTP timings, which is the main caveat. The public page owns one shared
summary hook, successful identity-free reads carry bounded shared-cache directives, and first-load failures render
an explicit unavailable state. Public budget and performance routes return 503 instead of inventing a zero record.

The existing JSONB row requires no migration. A `homepage` member updates once per minute while the complete
approximately 310 KB report updates at most once per 15 minutes; compact SQL selects only bounded fields across
the database connection, with compatibility reconstruction for older documents. The full report remains available
only when its dialog opens. Current local verification at 2026-08-22T17:20Z found 1,140 edge-paper settlements,
−3,349.004¢ exact order P&L and −2,792¢ corrected whole-cent funding P&L. Signed and public paper funding history
now agree on that edge-only cohort; the previous signed epoch blended 124 long-shot settlements and violated
strategy isolation. Live and paper records, provider rows, epochs, lifetime totals, maker reports, sentinels, and
stake-expansion evidence are all narrowed back to `edge-binary-buy` for this report without splitting the shared
account ledger or changing reconciliation.

The 50 MB forecast-journal compaction threshold did not change. The design records the checksum/generation,
process-global ownership, clone, crash-window, and grid-test gates required before implementing an incremental
hot-state cache; repeatedly resealing history was not assumed to be cheaper than replay. Live remained
operator-paused throughout and no execution or policy behavior changed.

Typecheck, 132 test files / 1,064 tests, and the production build passed. The local production server restarted
from the built revision; startup reconciliation completed READY at `2026-08-22T17:30:11.435Z` with zero local
or venue-managed positions and zero reservations. Control remained operator-paused at revision 5,533 with
2,086¢ available and +86¢ current-epoch whole-cent P&L. Vercel production deployment
`dpl_AjHfJMjBGvRUhBvPXp3EE7a4HzBQ` reached Ready and was aliased to `noodle.money`. Hosted root/dashboard smoke
checks returned 200; paper budget and compact/full paper-performance reads returned their expected explicit 503
projection-unavailable responses rather than zero records because the provider quota remains exhausted.

### Hourly crypto (strike) market designed and approved; implementation pending, 2026-08-21

The plan for a second trading market — `crypto-1h`, Kalshi hourly crypto threshold contracts — is
approved in design only (`docs/second-market-hourly-crypto-design.md`, SPEC §3.6 and the 2026-08-21
decision log). No registry, budget, policy, or execution code changed; the 15m desk and long-shot
cohort are untouched.

API verification (2026-08-21) settled the product question: Kalshi has **no hourly or daily
up/down-vs-open contract**. `KXBTC15M` is the only literal up/down series ("Bitcoin price up down");
the hourly series resolves against absolute strikes (100 of 100 sampled `KXBTC` markets are `T` or `B`,
series titled "Bitcoin range"); the daily series `BTC`/`BTCD`/`ETH`/`ETHD` are strike/range products
("range"/"Above/below") and are dormant today; and no 45-minute crypto series exists (`KXBTC45` etc.
404). Decisions locked: T (threshold) contracts only, band contracts deferred; 8pp edge floor as a
collection-cohort number (1.6× the v22 5pp applied to a surface bearing no calibration history);
per-market caps 3/2/1 rather than the 15m's measured 9/6/3; 60s evaluation cadence; cross-market
exposure deliberately ignored (each market's caps bind within itself; 15m-UP + 1h-DOWN is permitted
as different contracts); a strike-grid helper admits strikes within a measured ±N σ of spot, at most
one strike per asset/window; all ten assets (BTC/ETH/SOL/XRP/DOGE/HYPE/BNB/TON/NEAR/ZEC) participate
fully in paper. Settlement keys on the CF Benchmarks 60-second index average vs an absolute strike —
new target-integrity work. Capability is market-data + paper first; Kalshi live on the hourly market
stays off until a separate promotion under SPEC §12.5.

Two refinements landed in the design since the decision above. First, the candidate model was corrected:
the threshold surface is an **up/down pair, not a strike grid** — measured against the live API, the
nearest future window carries 188/300/75 contracts for BTC/ETH/HYPE but only **2 threshold (`T`) each**
(the rest are the deferred band family), so the plan no longer builds a strike-grid helper and instead
holds at most one T position per asset/window. A deep-wing-pair verification item was added. Second, a
canonical per-venue traffic/rate-limit/recovery reference was added at
`docs/venue-traffic-and-rate-limits.md`: steady public reads are ~23 per 15s today (Kalshi 7, Polymarket
8, Kraken 8) rising to ~31 per 15s after `ASSETS` widens to ten, still well inside Kalshi's 20 req/s
sustained; the binding constraints are the signed-read burst during reconciliation/manager and the
hourly grid **payload** (not request count). Kalshi has full throttle machinery; Polymarket, Kraken, and
CoinGecko currently have none and rely on generic stale fallback — a readiness gap noted for future work.

### Long-shot v2's untouched collection commitment is complete, 2026-08-26

The 2026-08-21 commitment below is preserved as the no-interim-tuning decision. The cohort subsequently
passed its authoritative 60-window boundary with 150 resolved attempts across 76 windows and was retired
under the final review linked above. It is no longer collecting, executable, allocatable, or visible in the
product; live was never armed. Historical snapshots below remain dated evidence, not current runtime state.

### Terminal no-fill history labels no longer imply an active trade, 2026-08-21

Trade history now reserves `pending` P&L for `open`, `pending_reservation`, and `uncertain` orders. Terminal
`unfilled` and `rejected` rows display `no fill`; terminal settlement rows missing a realized value display
`P&L unavailable`, and invalid rows display `no P&L`. Existing realized exact/whole-cent values retain their
prior formatting and precedence. This is a pure display classification: no API, ledger, status, money,
execution, reconciliation, or policy behavior changed. Typecheck, lint (0 errors / 37 inherited warnings),
122 test files / 1,017 tests, and the production build passed. The first full test run timed out at the
inherited `lib/walk-forward.test.ts:77` five-second boundary; its focused 14/14 rerun and the final full
rerun passed. The runtime precheck found active operator intent with zero positions and reservations, so the
worker was pause/drained before activation. Startup reconciliation completed READY at
`2026-08-21T04:54:29.709Z`; funded control remains operator-paused, quiescent, and restart-safe, and was not
automatically resumed. Commit `34b20a6` passed GitHub CI and Vercel production deployment
`dpl_5AQTqMLibKe6xbjkorqzkRCDEqto` reached READY at `noodle.money`; a production-bundle smoke check found
all three terminal labels.

### Repeated maker episode identity repaired and corrected, 2026-08-21

The order-size investigation found one venue fill attributed to all three local HYPE UP episodes for the
14:30Z window. `placeKalshiBuy` constructs post-only acknowledgement-race IDs from the first 30 characters
of the episode client ID; episode suffixes occur after that prefix. `clientMatches` accepts the same
truncated `-1`/`-2` forms for every local episode, so the later episode-3 venue order matched episodes 1
and 2 despite both having terminal zero-fill observations. Before correction, all three local rows carried
one venue order ID and the same 0.47-contract cost/P&L attribution.

This was a local matching defect, not a duplicate Kalshi fill. It is now resolved by
`maker-high30-requalify3-fresh1c-idv2-v6`: deterministic 40-character SHA-256-derived episode IDs retain
exact `-1`/`-2` create-attempt suffixes without truncation; duplicate generated IDs stop before reservation;
and reconciliation permits only exact v2 lost-response candidates, detects one-venue-to-many-local
ownership before applying fills, and never grants canceled zero-fill legacy retry records fill authority.

The idempotent correction advanced the ledger to v8, retained complete before/after snapshots, restored
episodes 1 and 2 to their terminal observed zero-fills, and left episode 3 as the sole 0.47-contract loss.
Exact reporting improved 53.58¢. Whole-cent control received an appended +54¢ `corrected` audit event,
moving available/realized from 1,755¢/−245¢ to 1,809¢/−191¢. A second run changed nothing. The first
strict startup exposed 40 historical canceled zero-fill create-race records; signed reads confirmed their
fill and remainder were both zero, so compatibility recognizes only that exact terminal shape without
making it a match. Typecheck, lint (0 errors / 37 inherited warnings), 120 test files / 1,002 tests, and the
production build passed. Final v6 startup reconciliation completed READY at
`2026-08-21T01:27:47.789Z` with zero local and venue-managed positions; automation remained operator-paused
and restart-safe. Commit `fa1bf7c` passed GitHub CI and Vercel production deployment
`dpl_9YZhUMmEDRS8Yr16eG4evyvqUCZX` reached READY at `noodle.money`; public smoke checks showed v6 while
retaining the expected 200/401/503 stateless boundaries. Full design and evidence:
[docs/live-order-identity-correction-design.md](docs/live-order-identity-correction-design.md) and
[reports/kalshi-order-size-and-fill-mechanics-2026-08-20.md](reports/kalshi-order-size-and-fill-mechanics-2026-08-20.md).

### Paper mirror v4 reviewed and requalification repaired under v5, 2026-08-21

A final current-ledger replay of `paper-managed-execution-route-ioc-v4` measured 103 paper attempts in 55
settlement windows from `2026-08-20T06:09:04Z` through `2026-08-21T02:16:39Z`. The primary one-to-one
cohort has 69 exact symbol/side/close/episode pairs starting within one second across 41 windows. Route and
requested quantity matched 69/69; fill/no-fill matched 79.7% (15 both, five paper-only, nine live-only,
40 neither). Window-clustered paper-minus-live fill rate was −2.8pp ±9.4pp. Conditional on 61 accepted
live makers, paper had no false-positive fills but reproduced only 15/24 live fills: 85.2% overall agreement
and 62.5% live-fill capture. Exact FIFO rank and cancellations ahead remain private, so this supports
“conservative approximation,” not “live equivalent.”

The audit found a deterministic defect more important than calibration: `runPaper` validated the paper-v4
simulator identity, while production-shaped paper rows exposed the shared live route identity first. The
identities never equaled, so `adaptiveEntryEpisodeDecision` rejected every paper zero-fill as a stale
generation. Paper recorded 103 episode-1 attempts and zero later episodes while live recorded 14 episode-2
and five episode-3 attempts, including four fills. The test fixture had deleted the shared route field and
therefore missed the production shape. No funded path read paper outcomes.

The repair advances paper execution to `paper-managed-execution-route-ioc-requalify3-v5` and makes
generation ownership lane-aware: paper reads its simulator generation and live retains its route generation.
Production-shaped tests keep both fields and v4 cannot authorize v5. New orders stamp exact
`entry-execution-mirror-pair-v1` identities from the complete calculation and episode; the signed performance
report counts paired, one-sided, ambiguous, both-fill, paper-only, live-only and neither-fill outcomes without
nearest-time inference or conditioning on a live fill. Each successful paper trade read now records bounded
read timing, consuming print count/quantity and time bounds, queue before/after and fill added. None of these
fields is public or read by execution.

Current paper exit-depth evidence is small but directionally aligned: 7/13 paper exits and 10/17 live exits
completed, with 7/8 agreement among same-position decisions starting within one second. The paper edge
bankroll tied exactly at the final read (10,000¢ start − 2,284¢ realized − 0¢ open = 7,716¢ available). The dry-run checker
now excludes separately funded long-shot open stake and reported a 0¢ residual without writing data.
Authenticated `queue_position_fp` collection remains deferred: it shares signed-read capacity with fills and
reconciliation, so an unbudgeted observation could affect money-state execution. See
[docs/paper-live-mirror-fidelity-repair-design.md](docs/paper-live-mirror-fidelity-repair-design.md) and
[reports/paper-live-mirror-fidelity-2026-08-21.md](reports/paper-live-mirror-fidelity-2026-08-21.md);
reproduce with `npm run analyze:paper-live-mirror`.

Typecheck, lint (0 errors / 37 inherited warnings), 121 test files / 1,007 tests, and the production build
passed. The active worker was pause/drained from funded mode with zero positions and reservations, then
restarted. Startup reconciliation completed READY at `2026-08-21T02:55:42.322Z` with zero local and
venue-managed positions; control remained operator-paused and restart-safe at 1,780¢ available / −220¢
realized. The signed performance route published `entry-execution-mirror-pair-v1` with a clean zero-row
prospective cohort. Commit `5b7e258` passed GitHub CI and Vercel production deployment
`dpl_AXognWmXECmYaVBTE2Tfj3BXZ9JG` reached READY at `noodle.money`; smoke checks retained the expected
200/401/503 stateless boundaries and exposed no pair identity publicly. No policy or funded execution
changed, and live was not automatically resumed.

### Versioned paper fill calibration ships under a v6 cohort, 2026-08-21

A window-level reload of the v5 2026-08-21 mirror period found the paper maker fill model sinking on a
structural queue mechanism: `applyTradePrintsToPaperQueue` treats the displayed public depth
(`displayedAhead`) as the full real queue and depletes it only with aggressive opposite-taker prints,
never modeling earlier orders cancelling or FIFO advancement. Over the recent edge cohort (intents since
2026-08-21T02:17Z) paper realized **−419¢ over 26 filled** while live realized **+343¢ over 25 filled**.
Of 12 live-filled slots paper did not fill, **11 were attempted by paper** — its own simulation refused
the fill; the largest live-only winners (SOL +383¢, HYPE +231¢) are exactly those. Paper is a conservative
lower bound, not live-equivalent.

This change ships, under SPEC §12.5, a **versioned, bounded paper fill calibration** (`queueClearFraction`
in `[0, 0.5)`) held in a new atomic durable store `data/paper-fill-calibration.json`, defaulting to **0** =
exact current conservative semantics, plus a recorded, manual `adoptPaperFillCalibration` path that appends
immutable history. It is **never read from a live fill**; paper P&L stays independent. Paper execution
advances to `paper-managed-execution-route-ioc-requalify3-calibrated-v6`; every future manual adoption gets
the next generated paper execution cohort (v7 first, then v8, and so on), including a rollback to zero.

A read-only held-out review joins the prospective mirror pair intents for exactly the active paper execution
cohort and, on the second half of that cohort's settlement windows, reports
both/paper-only/live-only/neither agreement, capture, precision, and the live-only missed upper bound —
without re-simulation, because the ledger's `paper_trade_evidence` is a per-read summary rather than a
per-print stream, and the review refuses to pretend a candidate could be replayed from it. It never promotes.

Typecheck, lint (0 errors / 37 inherited warnings), 123 test files / 1,025 tests, and the production build
pass. No paper P&L changes (default queueClearFraction is 0) and live is not resumed. Design:
[docs/paper-fill-calibration-design.md](docs/paper-fill-calibration-design.md); reproduce the review with
`npm run analyze:paper-fill-calibration`.

Deployed: the built local runtime restarted with startup reconciliation passing on a quiescent desk
(zero local/venue positions, zero reserved, active/live, 2,203¢ available); new paper episodes stamp
`paper-managed-execution-route-ioc-requalify3-calibrated-v6`. Commit `4c9dc91` passed GitHub CI; hosted
deployment `dpl_Lgr9GKhcaNpQLrcPdbaoFKYtE5Vp` reached Ready and was aliased to `noodle.money`,
where the expected root-200 / anonymous-401 stateless boundaries held and no calibration field is public.

### Paper calibration cohort and provenance boundary enforced, 2026-08-22

A follow-up audit found that the first store implementation did not mechanically deliver two promises above:
a non-neutral adoption could keep stamping paper v6, and its append-only history omitted the applicable
execution identity and held-out window count. The held-out analyzer also selected all prospective pair IDs
without filtering paper execution generation, so its purported current-v6 split contained some v5 rows.
No calibration had been adopted and `data/paper-fill-calibration.json` was absent, so all affected runtime
orders used the neutral zero fraction; no paper fill, P&L, funded path, or historical row required correction.

The boundary now fails closed. The store generates monotonic execution cohorts starting at v7, preserves the
complete calibration record on every history entry without truncation, requires positive held-out windows and
a reason, validates continuous generation history, and rejects malformed state rather than silently reverting;
a paper-store failure withholds paper entry without crossing the shared orchestrator into funded live.
Paper reads the calibration before intent creation, stamps its full provenance and execution identity, and
manages the order from that issuance-time copy. A mid-order adoption therefore cannot alter the fill assumption.
The held-out analyzer selects the active execution identity before forming its window split and prints that
identity. Active sentinel reports use the same store-owned identity. The neutral no-store path remains exact
v6 behavior. Design: [docs/paper-fill-calibration-design.md](docs/paper-fill-calibration-design.md).

Typecheck, lint (0 errors / 37 inherited warnings), 123 test files / 1,026 tests, and the production build
passed. The first full test run timed out at the inherited `lib/walk-forward.test.ts:77` five-second boundary;
its focused 14/14 rerun and the final full rerun passed. No runtime restart or funded-control action was taken.

### Authenticated edge order-book monitoring and stable signal transitions implemented, 2026-08-20

Positive-edge cards now expose an on-demand selected-side Kalshi ladder with price, level quantity,
cumulative displayed depth, spread, and timestamp. Only one operator panel polls at a time, every two
seconds from request completion; hidden tabs pause reads. The authenticated stateful route uses public depth
only and a read helper that does not populate the execution depth cache, so opening the UI cannot alter
policy, pricing, paper/live fill evidence, or signed request budgets. Public/stateless dashboards receive no
monitoring data.

Awaiting-confirmation signals are visible by default. Signal cards and both opportunity grids reserve
minimum height. A signal that stops qualifying now keeps its last qualified snapshot and calculation time in
an explicitly labeled expired section until the market window closes; it remains fully visible and its
stateful ladder remains inspectable. Requalification replaces that snapshot. Only the window close starts
the 2.4-second fade and removal. This retention exists only in the mounted browser and writes no evidence.
Design: [docs/edge-order-book-monitor-design.md](docs/edge-order-book-monitor-design.md).

The revised built local runtime restarted after a quiescent drain and authoritative reconciliation. Startup
reconciliation completed READY at `2026-08-20T22:32:44.323Z` with zero local or venue-managed open
positions. Automation remains manually paused because the separate repeated-episode identity defect above
is not mechanically cleared. Hosted deployment `dpl_GGRw8SBrPf7SYTx2RyRMQuFGLq5b` from commit
`ecfbd93` reached READY and is aliased to `noodle.money`; verification returned 200 for the public dashboard,
401 for an anonymous ladder request, and the expected stateless 503 for an authenticated ladder request. The public signal-retention
lifecycle is active there, while the host still receives no monitoring data or execution authority.

### Runtime task cadences are visible without merging their schedulers, 2026-08-20

The data-freshness dialog now separates input TTLs from eight task clocks and shows each task's cadence,
activation condition, purpose, request cost, last run, and process-local health. The shared registry covers
dashboard prefetch, 15-second edge observation, exact pre-submit quotes, the bounded 2-second managed maker,
ordinary and active-trailing long-shot entry watches, long-shot target exits, and periodic/event-triggered
reconciliation. Existing timers, queues, quote caches, request budgets, and policy behavior are unchanged;
price trajectory and spread remain observation-only evidence. Design boundary:
[docs/task-cadence-observability-design.md](docs/task-cadence-observability-design.md).

Signed open-order rows now show the latest owned-side venue bid/ask and its age, updating from the managed-order
or open-position observations already captured by the execution engine. Values older than one 15-second
calculation window are visibly stale. This adds no venue request, polling loop, ledger field, or path back into
pricing and execution.

### Eight-window decision trajectory collection implemented, 2026-08-20

`quote-trajectory-spread-observation-v2` retains the v1 trailing-60-second and cycle-to-date features and
adds nullable 2/30/60/120/240/360/480/600-second grids for selected-side ask movement in cents, canonical
Kraken movement in percent, oldest-quote age in seconds, and a 0–8 venue coverage count. The boundary
selection refuses to call an ordinary 15-second sample a 2-second move. Dashboard calculation derives exact
provider/side slices only from already-fetched source-timestamped paths; the public projection strips all of
them.

Ledger envelope v7 writes one exact provider/contract/side/close-time clone to top-level
`PaperOrder.quoteTrajectorySpread` when each edge order is built, before any placement or fill. The same
builder owns paper, live, and post-miss requalified episodes, so filled, unfilled, refused, rejected, and
requalified decisions retain their own issuance evidence without duplicating it inside the entry snapshot.
Legacy rows remain absent. No policy, ranking, gate, sizing, execution, fill, exit, reconciliation, budget,
or promotion path reads the grid. Design and forward review contract:
[docs/edge-window-consensus-evaluation-design.md](docs/edge-window-consensus-evaluation-design.md).

Typecheck, lint (0 errors / 37 inherited warnings), 118 test files / 988 tests, and the production build
passed. The restart precheck unexpectedly found automation active again with zero positions; it was
immediately pause/drained and was not resumed. The built runtime started at 2026-08-21T00:31Z, startup
reconciliation completed READY at `2026-08-21T00:32:14.166Z` with zero local or venue-managed positions,
and the desk remains operator-paused, quiescent, and restart-safe. Ledger v7 then recorded its first v2 row:
one BTC paper decision at 2026-08-21T00:32:45.826Z with exact matching identity and no nested duplicate. Its
coverage was 0/8 because it fired before even the 30-second boundary existed; this verifies prospective
persistence, not signal economics. A subsequent live-cache read produced valid 30-second venue and
underlying moves while leaving the unavailable 2-second and not-yet-covered longer windows null. Commit
`f0bc265` passed GitHub CI and deployed as Vercel production deployment
`dpl_5qSddRJUJftpS82thaw9bPUYz8Mg`, READY and aliased to `noodle.money`. Public smoke checks returned
200/200 for home/dashboard, 401 for anonymous ladder access, and the expected authenticated stateless 503;
no trajectory field appeared in the public dashboard payload.

### Quote trajectory and spread collection deployed and running, 2026-08-20

The collection-only generation in
[docs/quote-trajectory-spread-signal-design.md](docs/quote-trajectory-spread-signal-design.md) preserves feed
source timestamps so a cached fallback cannot manufacture a flat path, derives signed underlying and exact
provider/side midpoint direction plus spread widening/narrowing over trailing-60-second and contiguous
cycle-to-date horizons, and stamps the selected observation only on new qualified forecasts and immutable
entry decisions. Four unique observations over 45 seconds are required; a stale latest point, malformed or
crossed book, contract change, or gap over two calculation buckets leaves the feature unavailable rather than
substituting another provider or a zero.

This uses only quotes existing tasks already fetched and adds no poll, scheduler, request, public projection,
policy read, ranking weight, gate, sizing, execution, exit, or promotion path. Any selection or gate candidate
still requires a separate precommitted design and sentinel generation under SPEC §12.5.

**Deployment check, 2026-08-20T04:50–04:54Z.** Live automation paused and drained quiescently; manual
reconciliation passed with 28¢ reserved. The production build passed, the server restarted, and startup
reconciliation reported the local ledger, venue cash, positions, orders, fills, IDs, resting orders, and
reservations in agreement. The operator explicitly resumed live mode with 1,625¢ available and 28¢ reserved.
At the first post-warm-up read, venue history held 112 exact-book samples over 16 source timestamps and oracle
history held eight source-timestamped samples. The production feature calculator returned both trailing and
cycle-to-date quote and underlying features from the live cache; the collector was running with a successful
04:54:27Z cycle and no last error. Two bounded Kalshi read-limit backoffs occurred at startup and recovered.

There was not yet a qualified signal record: all seven predictions had zero currently admissible v22 options,
so the private dashboard and forecast journal correctly carried zero selected observations. This is an
operational verification of source collection and feature calculation, not an economic sample. The main
caveat is candidate sparsity under the narrower v22 entry band; only future qualified calculations stamp the
durable selected observation.

**First durable cohort, 2026-08-20T05:05:57Z.** The forecast journal then held 10 unique qualified
observations from 2026-08-20T05:01:14Z–05:05:30Z: nine SOL and one HYPE. All 10 carried cycle-to-date
underlying direction; eight carried cycle-to-date quote/spread features; five carried both trailing-60-second
features. Missing horizons remained explicitly unavailable under the source coverage rules rather than
becoming flat values. None had resolved, so this verifies prospective persistence only and supplies no
economic result; the greatest caveat is ten highly concentrated observations over four minutes.

**Hosted deployment check, 2026-08-20T05:04Z.** Manual `npx vercel --prod` deployment
`dpl_J5rvqJ6nTtdNcjRNBHvoVEB3vP4u` reached READY and aliased `noodle.money`. The canonical public API
published v22 with +5pp edge and 10–75¢ ask bounds over seven predictions, omitted
`quoteTrajectorySpread`, and reported its stateless collector disabled. Hosted therefore exposes the policy
and sanitized dashboard without acquiring collection, storage, reconciliation, or execution authority.

