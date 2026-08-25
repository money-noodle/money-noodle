# Money Noodle - Implementation Status

> Living status document. Updated 2026-08-25.
> Product requirements and architecture decisions live in [SPEC.md](SPEC.md).
>
> **Operational-state warning:** this document records dated snapshots; it is not a live interlock or the
> authority for whether funded execution is running. Before any operational action, read the authenticated
> Automation surface and `data/trading-control.json`. At the latest operational snapshot, the control record
> updated at 2026-08-25T08:37:07.009Z was active / `live`, revision 6,635, with 2,094¢ available, zero
> reserved, and operator intent active. The dynamic Kalshi exchange-index wire repair was loaded through a
> quiescent pause/drain and built-worker restart; startup reconciliation completed READY before explicit Resume.
> Periodic reconciliation remained READY at 2026-08-25T09:06:57.213Z. No natural eligible intent appeared during
> the first 30-minute watch, so accepted-wire runtime confirmation remains pending. That state may change after
> publication.

## Executive Summary

Money Noodle is operational as a local research dashboard, continuous paper shadow trader, public paper-track-record publisher, and environment-gated, explicitly armable live Kalshi trader. Core UP/YES and DOWN/NO entry, managed maker execution, paper maker mirroring, signed Kalshi reconciliation, quiescent pause/drain, loss gates, budget epochs, provider permissions, contract provenance, target integrity, standalone reduce-only exits, protected switching, model evaluation, and immutable promotion accounting are implemented.

The **repeated-episode order-identity defect found on 2026-08-20 was mechanically repaired and its known ledger damage corrected on 2026-08-21**. New live episode IDs retain collision-resistant identity through every create retry; reconciliation no longer fuzzy-matches truncated legacy IDs and blocks one venue order from owning multiple local entries. Ledger v9 preserves the HYPE before/after correction and trading control preserves the +54¢ whole-cent audit event. V9 retains every identity/control/money row in the shared account ledger while hydrating heavy immutable terminal evidence from verified content-addressed batches on demand. Separately, current economic evidence does not justify stake expansion, unconditional taker execution, an automatic entry relaxation, queue-aware live gates, or adding a second live venue. The shared buy rule remains **v22** — a 2026-08-20 operator narrowing to a +5pp edge floor and a 10–75¢ price band, not an evidence promotion. Live execution identity is now `maker-high30-requalify3-fresh1c-idv2-v6`; episode policy, sizing, and routes are unchanged.

A 2026-08-21 mirror review found that paper v4 first attempts were useful but its generation check suppressed every episode after episode 1. The defect was repaired under `paper-managed-execution-route-ioc-requalify3-v5`, with exact prospective four-cell pairing and bounded public trade/queue evidence; neutral calibration then advanced current paper execution to `paper-managed-execution-route-ioc-requalify3-calibrated-v6`. The closed v4 sample matched route and quantity 69/69 and fill/no-fill 79.7%, but captured only 62.5% of fills among 61 accepted paired live makers. Each generation remains separate and no history was rewritten. Paper does not feed funded execution, so no live order rule changed.

A second policy runs on the same market — the long-shot round trip, detailed in the roadmap below. Its current 12¢→97¢/600s cohort is paper-only; live arming is false. The parameters were selected from a retrospective sweep and therefore define a new collection cohort rather than evidence-backed promotion. It relaxes none of the edge policy's constraints and changes no edge rule.

| Area | Status |
| --- | --- |
| Dashboard and public paper track record | Functional locally and hosted; bounded summary/full-report split implemented. Managed Postgres access recovered and durable production projections returned 200 after the 2026-08-22 deployment. |
| Forecast and performance tracking | Collection is implemented; the 2026-08-22 interleaved-writer corruption was repaired into checksum-valid, content-addressed v3 after restoring 88 qualified archived rows. Automatic v3 seals and a 138-file independent Scaleway restore passed on 2026-08-24; aggregate economic conclusions still require recalculation. |
| Live execution | Kalshi live-capable; repeated-episode and external-position ownership are repaired. Event-order bodies now use validated exact-market exchange identity instead of stale index 0; the built runtime is active/READY, with first natural accepted-wire confirmation pending. |
| Paper execution | Continuous under neutral v6; exact prospective pairing is collecting. F1 is complete and F2 began at 2026-08-25T06:47:41.724Z; its first two-window smoke passed below the 10-window gate. |
| Model evaluation | Evaluator v2 remains barred from promotion and production remains Blend 0.4. Phase 2 prospective `forecast-candidate-registry-v1` collection is active locally from 2026-08-25T03:17:17.456Z; it has no promotion or order authority. Exact-provider confirmed-signal evaluation is queued after the base final review, followed strictly by venue-candidate, portfolio-selection, live-authorization, and attempt/outcome evaluation. Automatic evaluator-v2 checkpoints remain retired from the worker. |
| Provider expansion | Registry, permissions, variants, and budgets implemented; only Kalshi is live-capable |
| Operational safety | Collision-resistant bounded live IDs, exact reconciliation ownership, quiescent drain, account reconciliation, kill switch, and budget/risk ceilings are implemented. Runtime readiness and operator state must be read from the live control surfaces named above, not inferred from this table. |

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

A 30-minute natural-opportunity watch through 09:07Z found zero post-resume reservations. This was not an authority
block: the adaptive regime gate was open and allowed entries, with 369/12 resolved policy windows, +20.7pp weighted
recent fee-aware edge, and only 0.5% estimated negative-return probability versus 99% required to pause. The live-
skip journal instead recorded `none`: no current positive-edge binary buy qualified. The latest seven dashboard
markets were all `WATCH`. Therefore the source/wire correction and fail-closed tests are complete, but the first
natural accepted order carrying durable `venueExchangeIndex` remains the runtime confirmation gate; no artificial
funded test was sent.

Production source deployment `dpl_DdSaB76cS6iKZoqgdeKDWBMinyf7` completed READY and was aliased to
`https://noodle.money`; the homepage, compact paper-performance summary, and paper-budget endpoints returned HTTP
200. Hosted remains stateless and has no funded wire authority.

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

### Long-shot v2 will complete its untouched 60-window paper cohort, 2026-08-21

The operator chose continued prospective collection rather than resource-based suspension. The authoritative
review boundary is 60 independent settlement windows under `long-shot-hold-v2`, not the execution report's
legacy 60-attempt indicator. Until then, `long-shot-round-trip-buy12-sell97-win600-v2` remains unchanged at
12¢ entry, 97¢ exit, and at least 600 seconds remaining: no mark, trailing, sizing, gate, or cohort-identity
change; no interim promotion, tuning, or economic stop; and long-shot live arming remains false. Ordinary
safety controls retain authority to halt execution.

The authenticated worker read at `2026-08-21T05:35:31.983Z` had 30 resolved paper attempts across 13
independent windows, one hold win, zero target exits, and −763¢ exact realized P&L on 1,135¢ staked. Hold
and round-trip were both −59.1% ±40.9pp clustered standard error because the exit had never fired. The
interval remains broad, so this is not formal refutation; continuing collection records the agreed evidence
boundary and is not an endorsement of the strategy. Paper equity was 1,482¢ with no reservation, while the
separately gated live lane had zero v2 attempts and remained disarmed.

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

## Current Verified Snapshot — 2026-08-22

Read interval: economic totals `2026-08-22T05:31:47Z..05:32:51Z`; operational control through
`2026-08-22T07:17:00.533Z`; repaired storage reverified live after the storage restart at approximately 06:31Z;
residency observations continued through 07:22Z. This remains a bounded
multi-file snapshot rather than an atomic account image. Exact reporting and whole-cent control remain
separate views. Dated findings elsewhere in this document are history and must not be substituted for this
snapshot.

- **Funded control:** operator-paused / `live`, operator intent `paused`, 2,285¢ available, 0¢ reserved, and
  +285¢ current-epoch whole-cent P&L on a 2,000¢ start. The pause withdrew intent, drained the serialized
  queue, and passed authoritative Kalshi reconciliation with zero working transactions; the process was
  restart-safe before it stopped at `2026-08-22T06:04:01Z`. Rebuilt workers passed startup reconciliation,
  including the latest start at approximately 07:16Z, and funded automation has not been resumed.
- **Forecast storage is repaired and structurally verified.** The failed v2 layout contained 11,247 stale
  pending copies of terminal rows and had been sealed by independently bundled module-local writers. The
  owning repair restored 88 qualified archived rows, canonicalized 2,892 same-ID terminal payload copies,
  applied the existing unqualified retention once, and installed content-addressed v3. After the restored
  pending rows resolved, an owning-compactor pass exercised the final incorporated-journal watermark and
  installed generation `55b4a6c63a3c20cc208617be`. A fresh verifier passed with zero errors over 70,837
  rows: 70,802 terminal, 35 open, 15 shards, and zero journal events; all 50,837 qualified rows were
  resolved. The corrupt v2 directory and journal remain quarantined. The unrecoverable-risk interval
  between the archived 03:58Z journal tail and surviving 05:22Z journal head
  means aggregate conclusions must be recalculated rather than inherited. See
  [the incident report](reports/forecast-storage-integrity-repair-2026-08-22.md).
- **Edge ledger lifetime, exact reporting view:** live −631.44¢ on 35,416.85¢ over 716 settled entries and
  469 settlement windows; paper −3,402.12¢ on 57,107¢ over 1,118 entries and 602 windows. The separate edge
  paper bankroll control was 7,158¢ available / −2,842¢ realized on a 10,000¢ start; corrections and
  whole-cent control boundaries mean it must not be presented as the exact order-sum view.
- **Long-shot v2 paper cohort:** 50 resolved attempts across 26 independent windows, −114.64¢ exact P&L on
  1,902¢ staked. Execution recorded two `won` settlements and four target sales; the paired hold sentinels
  recorded six in-the-money settlements and four paths touching 97¢. It remains only 26/60 through its
  authoritative review boundary, and retrospective parameter selection remains the dominant caveat.
  Long-shot v2 has no live attempts and its live arming remains false.
- **Current identities:** buy policy v22; live execution
  `maker-high30-requalify3-fresh1c-idv2-v6`; paper execution
  `paper-managed-execution-route-ioc-requalify3-calibrated-v6`; long-shot
  `long-shot-round-trip-buy12-sell97-win600-v2`. No paper calibration store existed, so paper remained on
  neutral `queueClearFraction = 0`.
- **Latest stored walk-forward checkpoint:** `walk-forward:1150:fnv1a-8edd29bb`, generated
  `2026-08-22T03:31:28.252Z`. Its candidate returned 14.27% against baseline 12.11% over 575 test windows,
  was positive 5/5 folds and beat baseline 3/5. The stored evaluator called that a passed review threshold,
  but evaluator v2 is monitoring-only, its cohort can drift after late resolution, and production remained
  Blend 0.4 with no promotion.
- **Prospective portfolio choice sets are collecting:** the fresh analyzer replayed 410 records across 152
  resolved windows with zero integrity failures and no missing post-boundary live edge order. All 410 chose
  the same contract as production, so the required 20 differing-choice windows remain at zero and no
  ranking claim is available.
- **Process residency is improved but not closed.** The bounded forecast reader, projection backoff, and
  process-global provenance/cycle caches removed confirmed full-history churn. At least seven emitted execution
  bundles share one serializer and committed snapshot; isolated mutation clones and the atomic commit boundary
  remain. The approved v9 migration then retained every control/money row while moving heavy immutable evidence
  for 3,548 of 3,794 rows into content-addressed batches, reducing the hot ledger from 36.35 MB to 6.26 MB.
  Fixed route latency is now bounded and native structured-clone samples fell from 3.11% pre-v9 to 0.08% in the
  measured v9 interval. Physical footprint still reached 2.8 GiB / 3.1 GiB peak while JSON parse occupied 6.14%
  of main-thread samples; large append-only observational journals remain the measured next source and cannot
  be hand-truncated. See [the v9 report](reports/execution-ledger-v9-migration-2026-08-22.md),
  [the v9 design](docs/execution-ledger-v9-design.md), and
  [the ownership design](docs/execution-ledger-runtime-design.md).

### Repository-health review recorded, 2026-08-20

A codebase review (not an economic measurement) of the whole tree as committed, reporting the things that
will cost the most if deferred rather than a list of defects. None blocks the desk; none was changed in the
review itself.

- **The working tree fails its own gate.** As of the review the uncommitted `components/dashboard.tsx` WIP
  references an undefined `exiting` at lines 306–316, so `npm run typecheck` fails; a freshly checked-out
  `HEAD` typechecks clean and `npm test` passes 118 files / 978 tests. There is no CI, so nothing enforces
  typecheck-and-tests-green on the way out of a commit. `npm run dev` must not serve the departing state while
the WIP is uncommitted.
- **`lib/paper-execution.ts` is a 3,233-line orchestrator** importing ~40 modules (edge and long-shot
  strategies, mirror/live, trailing entries, managed makers, target exits, hold sentinels, calendar
evaluation, dense watch). `types.ts` is 2,076 lines and `forecast-tracker.ts` 724. This is the highest
single file of every behavior change; splitting is the largest future structural cost and should happen
uphill across the existing store/register seams only after a design doc, never as drive-by repair.
- **Atomic-write `.tmp` orphans collect.** `data/` and `.cache/` held seven `${target}.${pid}.${rand}.tmp`
  files whose writing PIDs are all dead and whose rename targets all exist (mtimes 3–6 days old). They are
  atomic-write leftovers, never evidence, so removing them is not a ledger edit; a startup sweep should do
  this automatically rather than by hand each time. `data/` is ~740 MB and `.next` ~2.6 GB locally.
- **No linter or CI.** `package.json` had only `typecheck` and `test`; no formatter config exists. The code
  already reads cleanly, so the value is cheap enforcement, not a reformat.
- **`SPEC.md` (175 KB) and `STATUS.md` (137 KB) are near the navigability limit.** The repo already split
  docs/ and reports/; picking a split threshold for the two living truth files now is cheaper than when they
  finish growing past the comfortable diff range.
- **Single-factor session auth is the only public-internet gate.** `lib/auth.ts` issues 14-day HMAC sessions
  with no rotation; that is deliberate for a single operator, but the login throttle design (per-IP lockout
  weaker on stateless hosts, the fixed delay treated as the guarantee) is the boundary to revisit if this
  ever grows more than one principal.

Follow-ups agreed with the maintainer and now landed as separate work (see the next subsection): CI
running typecheck/test/lint, an ESLint config, and a startup sweep for stale atomic-write `.tmp` files.
This entry is the measurement; those changes are recorded below.

### CI, ESLint, and stale-`.tmp` sweep shipped, 2026-08-20

The three follow-ups from the repository-health review above are now in place:

- **CI** (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, and
  `npm run build` on push to `main` and every pull request. There was no CI before, so the tree could
  depart and still look committed.
- **ESLint** (`eslint.config.mjs`, Next 16 flat-config `eslint-config-next/core-web-vitals` + `typescript`;
  no `next lint`; lint runs via `npm run lint`). The codebase predates three stricter React-19 rules, so
  `react-hooks/set-state-in-effect`, `react-hooks/purity`, and test `no-explicit-any` are whitelisted to
  warnings rather than risks-turned-errors while the money-path components are refactored deliberately;
  they stay visible on every run. `no-unused-vars` honours the codebase's underscore ignore convention.
  As introduced, lint is **0 errors / 37 warnings** across the tree; two genuine findings
  (`@next/next/no-assign-module-variable` in a test, `react/no-unescaped-entities`) were fixed rather than
  silenced.
- **Stale `.tmp` sweep** (`cleanupStaleTmpFiles` in `lib/local-data-archive.ts`). Atomic-write temps are
  `${target}.<pid>.<rand>.tmp` then `rename`; a crashed writer leaves an orphan that is never evidence, but
  none of them was ever reclaimed automatically. The sweep reclaims one only when it is past
  `STALE_TMP_MS` (60 s) **and** its rename target already exists, so a temp can never be the sole copy of a
  durable file. It runs fire-and-forget in the Node-only `instrumentation.node.ts` startup module (never on
  an Edge or stateless host) and via `npm run cleanup:stale-tmp`. Seven accrued orphans (5 under `data/`, 2
  under `.cache/`) were reclaimed in this change; a new `lib/local-data-archive.test.ts` describe block pins the
  reclaim rules over a grid of pinned-clock cases, including an absent optional root.

Typecheck, lint (0 errors / 37 warnings), 118 test files / 983 tests, and a warning-free production build
passed before activation. The built local runtime then activated these changes after a quiescent drain.
Startup reconciliation completed READY at `2026-08-20T23:33:34.362Z` with zero local or venue-managed open
positions, automation remained manually paused, and the startup/explicit cleanup checks left zero temp
files. Hosted deployment `dpl_HJ3bPFwwzDgv8926nPPjtqU3DBMA` from commit `9c6e45a` reached READY at
`noodle.money`; the production build emitted no Edge runtime warnings, and public/stateless smoke checks returned the expected 200/401/503 boundaries.

### Recent strict-value exits cost upside in a small fixed slice; no policy change, 2026-08-20

A fresh 2026-08-20T23:26Z reload of 3,059 durable orders found 10 non-switch live `strict-value-v1` exits
attempted in the fixed 18-hour interval ending 23:14Z, across 10 independent settlement windows. Every one
would have settled in the money if held. Exit-minus-hold was −33.1¢ total and −3.3¢ ±1.5 per clustered
window (`t = −2.23`); the nine paper exits covered eight windows and were also negative. Full non-switch live
history remained +855¢, but only `t ≈ 1.07` across 96 windows because 16 large reversal saves offset
foregone upside on 88 hold-would-win exits. The interval is small, selected by recency, gives no redeployment
credit, and does not authorize an exit-policy change. Full method and caveats:
[reports/exit-cost-vs-save-2026-08-20.md](reports/exit-cost-vs-save-2026-08-20.md).

### Rested maker misses had favorable hold outcomes but do not authorize higher bids, 2026-08-20

A current reload of the fixed `2026-08-20T05:24Z..23:24Z` live edge cohort separated 62 unfilled rows into
55 actual rested maker misses, five post-only create rejections, and two taker cap refusals. The 55 rested
misses resolved across 32 independent windows: 36 would win, with a hypothetical +50.0% aggregate
hold-to-settlement return at their posted prices and a +52.8% ±16.7% clustered mean (`t = 3.15`). That is
not a reachable fill strategy: the cohort is selected by the price path failing to trade through the queue.
Against always-UP on the same rows, the model-selected side added only +5.7pp ±5.7pp (`t = 1.00`), and
contemporaneous filled entries won less often, in the expected adverse-selection direction. The fixed recent
regime, conditional-on-no-fill bias, and omitted causal fill path dominate the nominal result. No bid, cap,
route, or attempt policy changes. Full method:
[reports/unfilled-entries-2026-08-20.md](reports/unfilled-entries-2026-08-20.md).

### Forecast rollup policy attribution repaired, 2026-08-20

`forecast-rollup-v1` omitted buy-policy identity from its compact missed-buy counterfactual. The direct
summary filtered rows to `BUY_POLICY_VERSION`; the rollup merge did not, so after v22 activated it combined
363 sealed v21 candidates with v22's eight current candidates and reported 371 candidates / 77 windows
instead of 8 / 4. Every other field reconciled, which is why ordinary storage health remained green while
`npm run verify:forecast-storage` failed the complete field-by-field gate.

`forecast-rollup-v2` stamps `policyVersion` on each counterfactual asset/window, includes it in the merge
key, and filters to the active policy before nearest-snapshot and best-per-window selection. Existing
untagged v1 counterfactual columns are excluded rather than guessed; all of their policy-independent
statistics remain readable. The verifier now fails explicitly if a legacy rollup contains an active-policy
resolved row, where exclusion would under-report rather than repair attribution.

At the **2026-08-20T06:08Z** read, the 12 indexed sealed shards contained zero v22 rows; all v22 rows were
in the open snapshot/journal, where direct and v2 rollup paths independently reproduced 8 candidates / 4
windows. The repaired read-only verifier passed over **67,346 rows**: 62,997 sealed, 4,349 current open and
17,492 journal events, with zero errors. No shard, rollup, index or journal was rewritten; the owning
forecast compactor will emit v2 rollups at its next normal seal. The main caveat is that these counts are a
point-in-time read of an advancing journal. Design: [docs/forecast-storage-design.md](docs/forecast-storage-design.md) §4.1.

**Deployment check, 2026-08-20T06:13–06:16Z.** Automation paused and drained quiescently; manual
reconciliation passed with one settlement-pending 28¢ position and restart-safe state. The production build
passed, the worker restarted, and startup reconciliation passed against 5,428.79¢ venue cash with 0¢
reserved, zero venue-managed positions, zero recovered fills and zero resting cancellations. The operator
explicitly resumed live mode with 1,738¢ available. The authenticated Performance route then reported the
active-policy missed-buy cohort alone — 11 candidates / 5 windows as the journal advanced — and no degraded
storage state. A fresh read-only verifier passed over **67,439 rows**: 62,997 sealed and 4,442 current open,
with 17,930 journal events and zero differences between direct and rollup summaries. RSS was about 593 MB
after that full-history verification and Performance read; RSS is not retained heap and this single
post-restart observation does not close the separate residency review.

**Hosted deployment check, 2026-08-20T06:17Z.** Manual production deployment
`dpl_BWFuwFrd2ExLtny9FCZK9mRvhFMg` reached READY and was aliased to `noodle.money`. The canonical public
API published v22 over seven predictions, served the durable sanitized paper projection, omitted private
policy-model state, and reported its stateless collector disabled. Forecast shard repair remains
worker-local; the hosted runtime gained no storage write, collection, reconciliation or execution authority.

### Latest walk-forward candidate reviewed; no promotion, 2026-08-20

Full review: [reports/walk-forward-model-candidate-review-2026-08-20.md](reports/walk-forward-model-candidate-review-2026-08-20.md).
Reproduce with `npm run analyze:walk-forward-review`. Production remains Blend 0.4; no promotion ledger
entry, forecast parameter, buy policy, execution policy, sizing, stake or live authority changed.

The stored 975-window run reported candidate +11.38% against baseline +8.24% over 488 held-out settlement
windows, with one parameter set selected in 5/5 folds. It improved Brier/log loss overall and was positive
5/5, but beat baseline only 3/5. The fresh production-code reconstruction did not reproduce the immutable
fingerprint (`fnv1a-bccfee60` → `fnv1a-c9e217a4`): baseline moved to +8.45% on 314 rather than 315 trades,
while candidate stayed +11.38% on 323. Delayed resolution can therefore change a historical checkpoint
whose ordered row/window manifest is not retained.

Paired on every settlement timestamp, current candidate-minus-baseline ask-and-hold return was **+2.93pp
±1.56pp standard error over 488 windows**; it does not clear two SE. Window-clustered Brier improved by
0.00192 ±0.00060 and log loss by 0.00638 ±0.00173. Only 39 windows changed trade coverage or selection;
22 different-selection windows supplied 92.6% of the return advantage. Continuous held-out drawdown was
8.59 normalized stake units against baseline 9.27; the stored 7.00/8.69 values reset at fold boundaries.

The evaluator still cannot referee promotion. It fixes production's selected side, ask, fee and venue;
hard-codes the old 5–97¢ band rather than v22's 10–75¢; assumes ask fill and hold; and has no persistence,
route, maker/IOC fill, exit, portfolio, sizing or budget arm. Only 77 of 323 candidate selections overlap
any live intent and 80 any paper intent, a production-selected subset that cannot stand in for execution.
The 648-parameter search is nested inside held-out folds, but 36 overlapping checkpoint reviews (10 passes)
remain repeated looks rather than independent confirmation.

Probability replay is exact for 4,597/4,967 observations; 370 are reconstructed. Quality inputs are exact
for 2,792 and absent for 2,175. Missing quality inputs do not directly invalidate this candidate—it leaves
the confidence formula and threshold fixed—but prohibit a whole-history quality candidate. Separately,
`promotionRefusal` omitted `maximumEdge` and `minimumSelectedProbability` from its deploy-then-record
identity check; both are now included, tested, and active. Eligibility also
refuses every `expanding-window-v2-replay` run as monitoring-only and reserves
`expanding-window-v3-policy-complete-prospective` for the agreed replacement. Collection and v2 evaluation
continue while promotion fails closed. Next is an evaluator-v3 design with a frozen cohort manifest,
policy-complete side/provider replay, separate prospective execution simulation, paired predeclared gates
and one locked future review—not promotion.

Activated in the local production runtime at **2026-08-20T15:57:00Z** after a quiescent drain and passing
startup reconciliation. PID 88223 resumed live automation with 1,632¢ available, 0¢ reserved, no local or
venue-managed open position, and the 15-second collector running successfully. The authenticated
performance route reported 1,007 resolved evaluation windows, next checkpoint 1,025, and the v2-generation
eligibility failure. Hosted deployment `dpl_HKfLWAkwkB18eU7y5XMycBLQNxgd` reached READY and was aliased to
`https://noodle.money`; its collector remained disabled and it gained no storage-write, reconciliation or
execution authority.

### Mirror fidelity and skip attribution, 2026-08-20

Three changes from the 2026-08-20 divergence review. Full design and the falsification test in
[docs/mirror-fidelity-and-skip-attribution-design.md](docs/mirror-fidelity-and-skip-attribution-design.md).
**No entry rule, threshold, size or gate moved**; buy policy stays v22 and `lib/mirror-invariant.test.ts`
still asserts the rule layer takes no execution mode.

**1. Live skips are durable (`live-skip-v1`).** SPEC §12.8 step 2, previously unimplemented — the ledger
kept `lastLiveSkip`, one overwritten slot. Every gate in `runLive` now names its own class (`stop`,
`operator`, `environment`, `reconciliation`, `rate_limit`, `budget`, `funding`, `exposure`, `portfolio`,
`persistence`, `regime`, `staleness`, `none`) and writes an episode to `data/live-skips.journal.jsonl`.
A classifier over the existing free-text reasons was rejected: a new gate would silently inherit whichever
pattern matched. Records fold consecutive identical cycles into one episode, so 2026-08-19's six-hour risk
stop is one row with a cycle count and its settlement windows rather than ~1,440 rows. Operator intent
separates a system `stop` from an `operator` pause. `windowsWithheldBy(records, 'stop')` joined to the
paper book on `closesAt` is the number that previously required reconstructing from the control audit.
The three withholds inside the switch path journal too, under class `fill` — §12.3 decomposes
`paper − live` into fill, limit and stop drag, so a reduce-only exit that did not fill is fill drag and
not a ranking decision. The one `lastLiveSkip` line reporting a *completed* switch is deliberately not
journalled; it is a status line, not a withhold.
No execution authority; a failed write is logged and dropped rather than stalling a cycle.

**2. The paper exit has a fill model (`paper-ioc-exit-depth-v1`).** It previously set `status = 'sold'`
unconditionally — 106 of 106 attempts completed, against live's 50 of 87 (57.5%). **The agreed design
changed before implementation:** `placeKalshiSell` sends `immediate_or_cancel` with `post_only: false`
and returns `liquidityRole: 'taker'`, so the exit never rests and cannot be modelled by the resting-maker
print loop. It is now a single sweep of displayed depth at or above `decision.executableBid`, with
partial fills and a no-fill that retains the position exactly as live does, neither automatically
retried. Deliberately conservative: displayed size only, one instant, no price improvement, no market
impact.

Both new taker paths distinguish missing evidence from a genuine no-fill: the order-book fetch is
allowed to fail silently, and sweeping an absent book would have recorded a data outage as an
`ioc_no_fill` — and, on the exit, stranded the position, since `standaloneExitAttemptedAt` disables
retry permanently. The entry returns its reservation and marks the attempt `rejected`; the exit defers
without stamping. This mirrors the maker simulation's existing `evidenceComplete` posture.

**Expect the published paper track record to fall.** Live's 37 exit no-fills retained positions that
returned +55.5% (25 won, 12 lost), so live's failures to exit were profitable and paper was clipping the
same winners at a worse price. The old number was optimistic; the direction of the correction is right
and its magnitude is not predicted. The 106 already-recorded costless exits stay in the ledger as
evidence of what the v3 simulator did — `paperExitFillVersion` keeps the cohorts unpooled.

**3. Paper takes the route live takes (`paper-managed-execution-route-ioc-v4`).** SPEC §12.2 specifies
the mirror as an independent simulation with "the same versioned episode boundary and route decision";
the route half was never implemented, so all 556 paper edge orders were makers against live's 15 takers
and the high-edge IOC route the v4/v5 execution change was about had no mirror. `runPaper` now calls the
same `evaluateEntryExecutionPolicy` and branches, refreshing the exact contract and re-checking the
one-cent cap and taker authorization before sweeping depth. `post_only_race` stays unmirrorable — it has
no meaning for an order that never rests. The version bump resets the paper execution cohort.

**Deliberately not done: paper still ignores live's risk stops, hourly ceiling and reconciliation gate.**
Per §12.3 that channel must stay open — paper's value there is measuring what the stop cost, and making
the tracks symmetric would delete the measurement. What was missing was the label, which (1) supplies.

New: `lib/live-skip.ts`, `lib/live-skip-store.ts`, `lib/ioc-fill-model.ts` and their tests.
`npm run typecheck` and `npm test` (964 tests, 117 files) pass.

**Two defects found in review before deploy, both fixed.** (a) Three withholds inside the switch path
bypassed the journal entirely, leaving that path with the single-slot problem this change removes; fixing
them exposed a missing class, since §12.3 decomposes `paper − live` into fill, limit and stop drag and
there was no `fill`. (b) Both new taker paths recorded *missing evidence* as a genuine no-fill. The
order-book fetch is allowed to fail silently, so a data outage would have been logged as an
`ioc_no_fill`, biasing downward the exact fill rate this change exists to measure — and on the exit it
would have stranded the position, because `standaloneExitAttemptedAt` disables retry permanently.

**Deployment check, 2026-08-20T06:00–06:03Z.** The desk was allowed to go quiet rather than paused: a
manual pause sets `operatorIntent: paused` and per §4 never auto-resumes, so draining would have left
the desk off pending a manual resume. The one open live position, `live:HYPE:UP:2026-08-20T06:00:00Z:episode:2`
at 29¢, settled `won` at +24.38¢, leaving 0¢ reserved and nothing open, working, uncertain or
exit-pending. The production build passed and the local server restarted under `npm run start`. Startup
reconciliation passed against 0¢ reserved with 0 fill states recovered and 0 managed remainders canceled;
the desk stayed `active`/`live` with operator intent `active` and 1,766¢ available, so no resume was
required. The skip journal began writing on the first live cycle and folded 5 events into 2 episodes —
a four-cycle `none` run and a `persistence` episode — which is the attribution surface working on real
cycles rather than in a test. Commit `fbbe10b` is pushed; `npx vercel --prod` is Ready and the hosted
root returns its login redirect. No paper order had been created at the first post-restart read, so this
verifies build, restart, reconciliation and the journal — **not** the exit fill model, the taker route,
or any economics.

### Entry admission narrowed to buy policy v22, 2026-08-20

`MIN_NET_EDGE` returns to **+5pp** (from −5pp at v20) and the price band narrows to **10–75¢** (from
5–97¢). Nothing else moved: side floor, quality floor, persistence, warm-up, late cutoff, execution
policy `maker-high30-requalify3-fresh1c-v5`, sizing, and exits are unchanged. Both tracks changed at
once — the rule layer takes no execution mode, so the mirror invariant holds by construction.

**This is an operator narrowing, not an evidence promotion, and it reverses v20 on evidence that still
reproduces.** Full corrected review:
[reports/entry-admission-v22-review-2026-08-20.md](reports/entry-admission-v22-review-2026-08-20.md);
reproduce with `npm run analyze:entry-admission-v22`. At the 2026-08-20T05:00:49Z read of 66,728
forecasts / 66,651 resolved, exact-provider first-to-fire replay found **3,941 v21 versus 3,373 v22
positions**: zero added and **568 omitted**, a 14.4% reduction. The omitted cohort returned **+26.1%
±7.6 over 238 settlement timestamps**; v22's surviving cohort returned +19.2% ±2.3 over 837.

This corrects the original uncertainty: the previously stated **±3.8pp belonged to the edge-floor
subgroup**, not the whole omitted cohort's settlement-window-clustered standard error. Scored on every
v21 position, with omissions earning zero and later v22 first fires retained, v22 changes ask-priced
return by **−3.7pp ±1.3pp** and bounded payout edge by **−1.09pp ±0.31pp**. Price-first exclusive
attribution is 487 edge-floor positions (+21.3% ±3.8), 72 above 75¢ (+8.1% ±5.2), and nine below 10¢
(+173.2% ±185.9). The edge-floor population v20 cited remains positive and is not treated as refuted.

**The caveat that most threatens this:** every figure is retrospective and ask-priced with no
persistence, maker-fill selection, portfolio capacity, sizing, exits, or budget reuse. Ask-priced return
is an upper bound this book has never realized, and concentrating capital on fewer higher-conviction
tickets remains the stated reason for accepting the reduction — a judgment about execution reality,
not a result the replay produced. The corrected replay weakens rather than supports the economic case
for v22; it cannot reverse the operator decision automatically.

Both band ends now bind. The former 97¢ ceiling refused no row the expected-value gate had not already
refused, so under §5.7 it was not a control; at 75¢ it is one. `maximumNetEdge()` remains disarmed at
1, leaving the 10¢ floor as the only gate bounding the documented above-35pp calibration inversion.

V22 activated in the built local runtime at **2026-08-20T04:50:15Z** during the quiescent deployment
recorded in the trajectory-collection section above. Startup reconciliation passed and live mode was
explicitly resumed. Source, policy manifest history, SPEC §3.7 and its decision log, the reproducible
analysis, and affected tests are updated; the runtime publishes v22.

### XRP exclusion re-evaluated; current evidence is null, 2026-08-20

Full review:
[reports/xrp-exclusion-review-2026-08-20.md](reports/xrp-exclusion-review-2026-08-20.md); reproduce with
`npm run analyze:xrp-exclusion`. At the 2026-08-20T00:01:37Z read of 2,730 orders / 65,854 resolved
forecasts, the original executed-loss result reproduced exactly: live **−45.7% ±21.5 over 41 fills/windows**
and paper **−35.1% ±13.0 over 85 fills / 81 windows**. Those rows ended under legacy through v13/v14 and
do not measure v21/v5.

A reconstruction of the current v21 first-to-fire rule found XRP **+1.0% ±12.5 over 59 decisions/windows**
from 2026-08-19T00:42Z–23:57Z, versus non-XRP **+9.7% ±5.9 over 364 decisions / 83 settlement
timestamps**; the paired XRP-minus-peer difference was **−12.1pp ±12.8 over 58 common windows**. Fifty-
eight of 59 XRP decisions were below 30pp and would use the reduced ticket; they returned +2.7% ±12.6.
This is ask-priced, less than one day, reconstructs persistence from bounded forecast history, and contains no
current-policy XRP execution, so it establishes neither harm nor value.

The prospective choice journal held three unique resolved XRP candidates across 17 issued-order records.
Only one had completed persistence; it lost, but the portfolio independently blocked it for negative adjusted
expected contribution. Removing only the asset gate would have changed zero recorded selections in this tiny,
conditional sample. No blocker or buy-policy change was made. Removal would be an explicit bounded operator
experiment requiring a new shared buy-policy version and manifest history, not an evidence promotion.

### Requalifying maker episodes deployed live, 2026-08-19

The maintainer found that v4's `maker missed · sequence ended` state was too broad: one authoritative
zero-fill locked the asset/side for the rest of its settlement window even when the signal subsequently
earned the entry checks again. The approved v5 design does **not** require the signal to become
nonqualifying. Instead, each maker miss resets execution qualification at `makerCompletedAt`; two new
qualifying snapshots spanning 15 seconds, both strictly after completion, may authorize the next episode.
See [docs/requalifying-entry-episodes-design.md](docs/requalifying-entry-episodes-design.md).

`maker-high30-requalify3-fresh1c-v5` permits at most three episodes per asset/side/window. Every episode
reruns reduce-only sizing, current maker/high-edge routing, exact quote, portfolio, funding, exposure,
live-risk, and reconciliation gates. Any fill, working or uncertain state, rejection, stale-policy order,
taker refusal/no-fill, or episode 3 ends rearming. Later IDs are durable `:episode:2` / `:episode:3` rows;
historical `:retry:` rows cannot open v5 authority. Paper uses the same post-completion boundary under
`paper-managed-maker-requalify3-v3` while retaining independent simulated fills.

This is an explicit execution decision, not a measured promotion. At the decision read, v4 had only four
live attempts: one fill and three maker zero-fills; because v4 prohibited later episodes, it supplied no
prospective episode-2 outcome sample. The main unresolved risk is repeated exposure to the same
continuously qualified but adversely selected signal. Fresh persistence, the three-episode ceiling,
unchanged reduced sizing, and stop-on-any-fill semantics bound the first generation. Source, tests, policy
manifest, dashboard labels, SPEC, and design records are updated.

**Deployment check, 2026-08-19T23:43–23:46Z.** Automation was manually paused and drained. Manual
reconciliation recovered one fill, agreed one local/venue-managed position, canceled no resting remainder,
and reported restart-safe with 28¢ reserved. The production build passed, the local server restarted under
`npm run start`, and startup reconciliation passed against 5,520.32¢ venue cash with 0¢ reserved, one local
settlement-pending position, zero venue-managed positions, zero recovered fills, and zero canceled resting
orders. The authenticated manifest published v5, the read model published the three-episode ceiling, and the
operator explicitly resumed live mode with no blockers and 1,905¢ available. No v5 live or paper order had
fired at the first post-resume read, so this verifies build, policy identity, restart, and reconciliation—not
episode-2 routing or economics. Hosted verification caught that the stateless deployment's absent execution-
mode setting described the safe maker-only default and published one episode despite the v5 identity. The
production Vercel environment now carries `MONEY_NOODLE_ENTRY_EXECUTION_MODE=adaptive` as a fifth,
display-only setting; the final canonical read published adaptive mode and three episodes. Stateless runtime
intersection still grants no collection, ledger writes, reconciliation, or order authority.

### High-edge execution, direction observation, and reduce-only sizing deployed live, 2026-08-19

Full 2026-08-19T22:43:38Z durable-data review in
[reports/execution-direction-sizing-review-2026-08-19.md](reports/execution-direction-sizing-review-2026-08-19.md);
reproduce with `npm run analyze:execution-direction-sizing`. The supplied realized-edge shape reproduced:
30pp+ returned +46.2% ±46.9 live over 18 rows / 17 windows and +56.3% ±45.4 paper over 29 / 25. It is
not ready to lever: the three largest positive rows exceed each track's total high-edge profit, and each
standard error is about as large as its point estimate.

The prior 0.3×–3× proportional-sizing result does **not** reproduce on executed money. It raises modeled
capital about 76% while clustered realized return remains negative and nearly unchanged. The maintainer
instead approved an explicit restrictive deployment on retrospective evidence:
`entry-sizing-reduce30-below-edge30-v1` commits 0.3× of each track's current base ticket below 30pp and 1×
at 30pp+, with no arbitrary minimum and no upsizing. `maker-high30-one-attempt-fresh1c-v4` gives every
logical sequence one attempt: below 30pp one managed maker whose zero-fill ends the sequence; at 30pp+ one
IOC only if an immediate exact quote still clears 30pp fresh taker edge, 10pp persistence median, 65%
quality, 2¢ spread, and the existing 1¢ movement and safety gates. The old random-fill maker comparison no
longer gates high-edge taking. Design and stated departure:
[docs/high-edge-execution-reduced-sizing-design.md](docs/high-edge-execution-reduced-sizing-design.md).

Exact-quote direction explains many misses but does not yet supply a production rule. The
2026-08-19T23:19:35Z rerun read 2,723 orders / 65,381 resolved forecasts: across 77 live attempts / 36
windows and 208 paper attempts / 60 windows, favorable one-cent moves filled 31.7% live / 18.3% paper while
adverse moves filled 63.6% / 68.9%. Refusing adverse pre-submit movement improves live +12.6pp ±8.2 but
paper only +0.3pp ±7.1 and drops 6 live and 22 paper winning fills. The post-deployment rows are not an
independent validation cohort, and the direction result remains track-discordant. `entry-direction-observation-v1`
now stamps the pre-submit and first-unfilled-management direction plus the fixed refusal/cancel candidates,
but production never reads them.

**Deployment check, 2026-08-19T23:08–23:14Z.** Automation was manually paused and drained; reconciliation
passed with 0¢ reserved, zero local/venue positions, and zero resting orders canceled. The built production
server restarted, startup reconciliation passed against 5,541.96¢ venue cash with zero recovered fills, and
the operator explicitly resumed live mode. The first v4 runtime trace was SOL UP at 3.7pp issuance edge: the
100¢ base sized to a 30¢ reservation, one maker filled 0.54 contracts for 28.62¢ exact all-in spend, and the
order stamped both v4 execution and direction evidence. After a final current-source build, a second
quiescent restart reconciled that one open position exactly against 5,513.34¢ venue cash and 29¢ local
reservation, with zero recovered fills or resting orders; live mode was explicitly resumed with no blockers.
At the 2026-08-19T23:17:34Z follow-up, that first order had settled DOWN for an exact −28.62¢, and a
second v4 trace (BTC UP, 4.7pp issuance edge) completed its single 30¢-cap maker attempt unfilled. Live mode
remained active with 0¢ reserved and 1,836¢ available. These are two attempts in two settlement windows and
verify routing, sizing, settlement, and terminal zero-fill wiring only; they do not estimate economics.

### Winner-preserving loss screen: no production filter qualifies, 2026-08-19

Full 2026-08-19T22:20Z durable-data review in
[reports/winner-preserving-loss-filter-review-2026-08-19.md](reports/winner-preserving-loss-filter-review-2026-08-19.md);
reproduce with `npm run analyze:winner-preserving-filters`. At that read, v21's first
qualified population remained positive at **+12.0% ±5.1 over 591 decisions / 84 windows**, while its 42
live fills over 26 windows were **−31.6% ±19.8** ask-priced and held. Tightening entry is not the supported
response.

The predeclared 2pp maker-spike restriction is the lead, not a promotion. Retrospectively across v21 it
improves the all-attempt mean by +13.8pp ±7.2 live and +3.9pp ±5.9 paper, but refuses **6 live and 13 paper
winning fills** at the report read. On the 2026-08-19T23:19:35Z rerun, its prospective cohort had refused
five losing fills and zero winning fills across the two tracks, but only over **1 resolved live window and
13 paper windows**, far below the locked 60-window / 20-differing-window review requirement. The greatest
threat is the tiny, repeatedly observed prospective cohort; the 2¢ spread restriction also disagrees by
track. This screen authorizes no additional buy, execution, sizing, exit, or live-authority change.

The separate paper-only long-shot ledger now has 42 settled attempts in 28 windows, zero `won` statuses,
and −754.27¢ exact P&L on 940¢. Its latest settled 12¢→97¢ predecessor cohort is 0/9 over five windows;
the derived v2 cohort has no settled order. Retiring that lane is an operator choice about research value,
not a live-risk action.

### Eleven ideas screened; sizing was the one worth further evaluation, 2026-08-19

Full measurement in [reports/edge-buy-opportunities-2026-08-19.md](reports/edge-buy-opportunities-2026-08-19.md).
Method was the admitted population — first qualifying calculation per `(symbol, closesAt, side)`, at the
recorded ask, held to settlement, window-clustered, under the live v21 bounds. The harness returned
**+20.8% ±5.2 over 671 windows** against `analyze:loss-decomposition`'s +20.9% for v19, which was the
control. About **thirty-three comparisons** were evaluated; **no policy, gate, execution, sizing, or
calibration change was authorized by any of it.**

**Subsequent correction:** the proposed 0.3×–3× proportional arm did not reproduce on realized executed
money; it increased modeled capital about 76% while clustered returns remained negative and nearly
unchanged. It is superseded and must not be implemented. Production later adopted the separately approved,
reduce-only `entry-sizing-reduce30-below-edge30-v1`, with no multiplier above 1. Dollar-denominated account,
window, and correlation-group ceilings remain mandatory before any future proposal above 1×; they are not
an authorization to revive proportional upsizing. See
[reports/execution-direction-sizing-review-2026-08-19.md](reports/execution-direction-sizing-review-2026-08-19.md)
and [docs/high-edge-execution-reduced-sizing-design.md](docs/high-edge-execution-reduced-sizing-design.md).

- **Sizing appeared to be the largest lever on the admitted population and changed no admission.**
  Identical 3,078 decisions, only the weight: flat +18.6% per $1, capped 0.3×–3× edge-proportional
  **+28.9%**, better on **9 of 9 days**, with the ten highest-edge rows contributing **4.0%** of the
  profit. Below a 35pp edge it was +19.9% against +14.8%. The desk already ranked by
  `expectedProfitCents` ≈ `edge / cost` and then committed the same dollar to every winner. This read
  described position-count exposure caps as the sole blocker; the subsequent realized-money correction
  above established that execution evidence is also a blocker and superseded the proposal:
  [docs/edge-proportional-sizing-design.md](docs/edge-proportional-sizing-design.md).
- **The edge spike separates realized money out-of-sample, and the committed sentinel says it is not a
  forecast effect.** On v19+ orders — chosen after the threshold was set — live fresh +0.2% against spiked
  −22.2%, paper −6.7% against −16.9%; both tracks agree that **spike ≥ 5pp** is the bad cohort (live
  −37.7% on 3,558¢, paper −51.6% on 3,223¢). But 296 graded `edge-spike-sentinel-v1` records, at the ask
  and held, give **+1.9pp, t = 0.12** at 2pp. Fill rates barely differ by spike (43–59%) while the maker
  discount is **larger** on spiked orders, 5.30¢ against 4.55¢ — a better price with a worse outcome.
  Reading: the spike belongs in the **execution** layer, not the entry gate. Re-arming the gate is not
  supported and is not proposed.
- **`volatilityRatio` is clean on the gate and does not survive the ledger.** Admitted: +19.4% at
  VR 0.00–0.20 falling monotonically to **+1.4%** above 0.72, holding inside every edge band. Realized,
  from the field already stamped on 605 of 995 v17+ orders: the **middle** band 0.38–0.72 is the worst on
  both tracks (−27.3% live, −26.7% paper) and refusing VR ≥ 0.72 recovers nothing. **Fourth reversal of
  this shape** — clean on admitted rows, absent on filled ones.
- **The 0.55 calibration weight is too much shrinkage, and correcting it loses money.** Fitting the
  log-odds weight on 54,576 replayable rows gives β̂ = 0.738 pooled, 0.69–0.77 leave-one-day-out on
  **11 of 11 days**, day-clustered 0.62 ± 0.10. But re-running admission at β = 0.74 admits 3,523
  decisions at +18.2% against 3,078 at +20.8%, and β = 1.0 gives +15.5%. `settlementAverageEstimate`
  unmodified gives +16.1%. **The 0.55 weight is not calibration, it is selectivity.** Null result.
  Recorded beside it: β varies with time remaining (0.63 at T < 60 s, 0.78 at 120–240 s), which is the
  `effectiveSeconds = T − 30` approximation and the absent oracle-basis variance floor, not noise.
- **Smaller readings.** Late entries pay (+44.2% at 30–60 s, +59.5% at 60–120 s, against +18.4% at
  420–900 s). Contradicting the venue's direction wins 51.5% but returns +23.0%, while agreeing wins
  71.2% and returns +16.3% — the "win rate is the wrong statistic" lesson again. Price 0.80–0.90 is dead
  (−0.0%, n=47). Confidence is **not monotone** in return, so `edgeStrength` has no support as a ranking
  key. Asset exclusion still disagrees between tracks and stays unsupported.

**Shipped with it: `entry-decision-v2`.** `entryDecision` now records `edgeSpike` and the numeric
`cycleRegime` features, both already computed at decision time and previously discarded at the order
boundary — which is why §3 above could be checked against realized money and §4's trend-efficiency
result could not. Reporting-only; `lib/entry-decision-observation.test.ts` asserts no pricing, sizing,
gating, or execution module reads them, that features are cloned rather than aliased, and that v1 rows
keep the fields **absent** rather than defaulted. No behaviour changes and `BUY_POLICY_VERSION` is
untouched.

### Maker/exit depth follow-up: reporting fixed; sentinel design proposed, 2026-08-19

The outcome-conditioned maker review found active v3 losers filled materially more often than winners, while
the nine then-current v21 live strict-value exits all sold eventual winners. Full dated evidence and its
small-cohort caveats are in
[reports/maker-adverse-selection-and-exit-depth-2026-08-19.md](reports/maker-adverse-selection-and-exit-depth-2026-08-19.md).
The maintainer chose to keep live running unchanged. No entry, execution, sizing, or exit policy changed.

`buildMakerFillReport` now excludes rows stamped `executedStyle: taker` before venue submission assigns a
`liquidityRole`; those refusals no longer inflate maker submissions or depress maker acceptance. Accepted
maker fills and returns were unaffected. A regression test covers the pre-submission refusal and preserves
its actual-taker attribution.

The approved prospective evaluation-only design is implemented in
[docs/positive-edge-execution-exit-sentinel-design.md](docs/positive-edge-execution-exit-sentinel-design.md).
It precommits two restrictive maker candidates and four exit candidates, keeps their append-only stores and
track-separated evidence separate, requires complete first-to-fire cohorts, and cannot place or influence
an order. Maker records begin only after durable issued intents; exit records begin at the first prospective
filled-position observation and continue from fresh public data after production sells. Reports are exposed
only by the authenticated stateful performance route. Existing orders are never backfilled. Collection has
not started in the currently running process; its prospective timestamp is created on the first cycle after
a built restart/deploy.

### Contract selection: the named leak was a comparator artefact, corrected 2026-08-19

The first correction to `scripts/analyze-contract-selection.mjs` fixed its ranking key and removed
opposite-side contamination, but still compared an issued order with every contract that had qualified at
some earlier or later point. Those alternatives had not passed the decision-time persistence, classified
regime, re-entry cooldown, retry, active-exposure, or sizing checks. Its **−20.2pp** ranking gap is withdrawn.

The script now starts at each issued v17-v19 live order snapshot, reconstructs those checks, sizes with
production `estimatePaperFill`, ranks with production `selectPortfolio` under the historical 3/2/1 caps,
and clusters paired chosen-versus-replay-preferred differences on settlement window. Read at
**2026-08-19T16:12:53Z**: 346/354 order snapshots replayed; 339 passed the positive control that the
reconstructed portfolio admitted the order production demonstrably placed. On those 339 snapshots over
**232 independent windows**, replay chose the same contract **331 times**. Chosen returned −5.5%, replay
−4.6%; paired difference **−0.9pp ±2.7pp (95%)**. V19 alone was −2.1pp ±4.1pp over 44 windows. The eight
different-choice snapshots read −38.9pp ±88.8pp and are too sparse to carry a claim.

**Current conclusion:** no measured ranking defect. The older loss-decomposition stage remains a real gap
between all admitted rows and the ordered cohort, but it is not a decision-time choice comparison and must
be called **ordered-cohort selection**, not contract selection. Historical alternatives remain partly
reconstructed because failed dashboard observations and `portfolioDecisions` were not durably journaled;
a future ranking claim requires prospective committed choice sets. Full correction:
[reports/edge-buy-opportunities-2026-08-19.md](reports/edge-buy-opportunities-2026-08-19.md) §8.

### Prospective portfolio choice sets: implemented and collecting

`portfolio-choice-set-v1` replaces favourable historical reconstruction with one immutable record after
each durable positive-edge live intent. It stamps the production candidate set, persistence/retry/cooldown
state, classified regime, effective runtime caps, account-wide exposures, production sizing/rank, drain
skips, and issued order, then resolves every exact Kalshi contract. The pre-registered report scores every
record, clusters on settlement window, opens diagnostics at 30 resolved windows, and requires 60 overall
plus 20 differing-choice windows before any differing-choice claim. No result can reach execution or
promote a policy. Design: [docs/portfolio-choice-set-journal-design.md](docs/portfolio-choice-set-journal-design.md).
Run `npm run analyze:portfolio-choice-sets`.

The initial deployment boundary was **0 records / 0 windows** and no historical order was backfilled.
At the fresh **2026-08-25T04:35:52Z** replay, collection held **852 records**, 851 scoreable, across **323
independent windows**, with one unresolved record, zero integrity failures, and zero missing post-boundary live edge
orders. Issued and production-preferred choices matched in all 851 scoreable records and both returned +17.4%, so
the paired difference was 0.0pp and the 20-differing-window review remains locked. This proves conditional issuance
integrity; because v1 records only issued orders, it does not test the economic ranking formula, no-order cycles,
or downstream unused capacity. The separately queued full-cycle portfolio plan starts a new prospective generation
only after venue candidacy freezes.

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

### Long-shot: there is no exit mark that works, 2026-08-18

Full measurement in [reports/long-shot-roundtrip-2026-08-18.md](reports/long-shot-roundtrip-2026-08-18.md);
`npm run analyze:long-shot-roundtrip`. Opened on the premise that the long shot needs a better entry gate.
**The entry gate is not where the loss is.**

- **A contract that prints a 90¢ bid has essentially already won.** Spike-and-lose is ~1% of entries in
  every band (0 of 77, 1 of 474, 3 of 549, 4 of 664, 14 of 1,074). The mark is not harvesting a reversal.
- **The 90¢ mark reaches fewer contracts than holding wins**, by 1.3–5.9 points in every band, because
  these settle on a close-price comparison and a winner need never trade near 90¢.
- **The retrace population is real but sits at 30–50¢**, where the payoff multiple cannot cover break-even.
  No cell in the grid clears break-even except 0–10¢/≥600s at 90¢ (10.4% against 10.1%) — the same cell
  where the mark loses to holding.
- **Holding alone** falls monotonically with entry price: +16.8% ±72.3 at 0–10¢/≥600s (9 winners in 77),
  +3.1% at 0–10¢/≥300s, then −3.7%, −5.3%, −8.9%.
- Realized paper ledger: −309¢ on 493¢, **0 of 33 settled in the money**. Three `sold` rows are
  strict-value exits from the since-scoped bug; the three live entries were manual tests at a higher entry
  price to prove the mechanism executes, not policy execution.

**Open decision for the maintainer:** removing the mark is a policy version bump that changes what the
strategy is — without a mark, `long-shot-round-trip` is not a round trip. Removing it does not make the
strategy positive; it stops one measured leak.

### Long-shot hold sentinel — not ready, and one day carries every winner, 2026-08-18

Full review in [reports/long-shot-hold-sentinel-2026-08-18.md](reports/long-shot-hold-sentinel-2026-08-18.md).
`long-shot-hold-v1` has **38 windows with a recorded peak against its bar of 60**, not the 64 a naive count
of the store suggests.

- **`peakOwnedSideBidCents` was not written before 2026-08-18.** It is absent on 26 of 64 records, and a
  naive comparison reads the absence as "did not touch". Anything computed from the earlier cohort is
  silently wrong rather than missing — the same class of bug the 2026-08-17 filter screen hit with
  `cycleRegime.regime`.
- The store pools three configurations. Only `buy10-sell90-win600-v1` has a sample (64); the two 40¢ arms
  hold 2 records each and should be retired or fixed.
- On the covered day: touched the 90¢ mark **6 of 38 (15.8%)** against a **10.6%** break-even; sell-at-mark
  **+64.0% ±111.7**, hold +55.3% ±115.8. Positive, and unmeasurable at this width.
- **All six in-the-money settlements fall on 2026-08-18**; the three prior days are 0 of 26. Not explained
  by volatility — 08-17 was the most volatile of the four days (0.149% mean local 15m against 0.129%) and
  produced zero winners in 18 records.
- The peak distribution is bimodal: median 14¢, p75 31¢, p90 99.2¢. Eight of 38 peaked above 50¢, six above
  90¢, almost nothing between.

This configuration was also the **only cell above break-even** in the 2026-08-18 retroactive sweep across
2,131 paths (10¢/90¢ ratio 1.12, 10¢/70¢ 1.03; every other entry band 0.68–0.85). Two routes agreed it was
marginally positive; neither had the sample to establish it.

**Current update, 2026-08-19:** the configured marks are 12¢→97¢/600s. The deterministic entry-owner fix
advances the active derived policy to `long-shot-round-trip-buy12-sell97-win600-v2`; the prior v1 order and
10¢→90¢ sentinel cohorts are historical. `long-shot-hold-v1` ended with nine 12¢→97¢ paper executions but only two sentinel
records, both falsely stamped unexecuted with the obsolete collection-only reason. Those rows remain
immutable and are excluded. `long-shot-hold-v2` starts a fresh zero-window cohort: `runLongShot` now stamps
the exact paper decision, persists the order first, and writes the sentinel; the detached pass only recovers
version-stamped decisions, observes later peaks, and settles outcomes. No prior fill is backfilled. The
parameter change came from a 50-cell retrospective sweep and therefore nominates a paper collection cohort;
it is not prospective promotion evidence. The worker restarted on hold capture at 2026-08-19T04:53Z and
on deterministic entry ownership at 2026-08-19T05:17Z; both startup reconciliations passed with 0¢
reserved, zero recovered fills, and zero managed remainders canceled. The initial
hold-v2/order-policy-v2 cohort is zero by design until the next prospective trigger. The
one-second refreshed trailing poll is now the sole paper/live entry owner; the regular 15-second cycle can
no longer bypass `evaluateTrailingEntry`. See `docs/long-shot-policy-design.md` §§10b–10c.

### v21 — promote the persistence candidate, and take the ask, 2026-08-19

`buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21`. Two changes,
shipped together on purpose.

**Persistence 3-over-30s to 2-over-15s.** The **first entry change made on prospectively committed
evidence** rather than a retroactive screen — the bar SPEC 12.5 sets and the one the withdrawn v14 DOWN
suspension failed. `persistence-two-consecutive-v1` holds **553 resolved incremental settlement windows at
+13.2% +/-8.4** per $1 at the ask, with the value concentrated in the **227 production never took at all
(+23.5% +/-13.0)** rather than the half it reached a median 17 seconds later (+6.5% +/-11.1, noise).

Recorded as a departure: under 706's version-scoping only the v19 cohort formally counted — 92 windows,
+16.0% +/-19.9 — and this promotes on the pooled figure.

What it fixes is bigger than the entry rule. A single non-qualifying snapshot resets the streak to zero, so
at the collector's ~17s cadence one blip cost ~51 seconds of re-earning. Measured over 12 hours,
**115 of 205 admitted decisions never persisted at all.**

**Historical v3 execution discrepancy, superseded later on 2026-08-19 by v4.** The audit found
`MONEY_NOODLE_ENTRY_EXECUTION_MODE=taker` still applied the same recommendation as `adaptive`, while local
threshold overrides had relaxed most of the six gates. The maintainer chose adaptive rather than
unconditional taking. Attempt 1 now takes only at ≥15pp current edge, ≥10pp persistence median, ≥65%
quality, ≤2¢ selected-side spread, ≥30 comparable accepted maker samples, and ≥2pp estimated advantage over
maker capture; otherwise it uses managed maker. The 2¢ ceiling limits the cost of immediacy and is not
claimed to predict maker fills. The separate 10¢ spread ceiling rejects the entry entirely.

One authoritative attempt-1 maker zero-fill may open one capped taker fallback for that exact
asset/side/window/generation. There is no fixed cooldown: two new qualifying observations strictly after
maker completion must span 15 seconds. Attempt 2 retains the four absolute edge, median, quality, and 2¢
spread gates, waives only sample count and comparative advantage, and ends the sequence whether filled or
unfilled. Every other sequence starts adaptive attempt 1 anew. Paper remains its independent managed-maker
lane. Immediate and fallback takers now tolerate at most 1.0¢ of selected-side ask movement from issuance,
while re-running the applicable gates on the fresh quote and reserving quantity plus fees at the worst
permitted price. The cap never exceeds 97¢. Reporting separately labels pre-submit quote movement, accepted
IOC no-fill, and rested maker no-fill without rewriting historical rows. `ENTRY_EXECUTION_POLICY_VERSION` is
`maker-taker-adaptive-one-miss-slippage1c-v3`; design and audit requirements are in
`docs/adaptive-entry-fallback-design.md`.

**Deployment check, 2026-08-19T02:53Z:** the worker was stopped with active operator intent preserved,
restarted on the new configuration, and startup reconciliation passed with 0¢ reserved, zero recovered
fills, and zero managed remainders canceled. The first v2 live intent was one operational smoke sample only:
ETH DOWN attempt 1 retained maker because current edge was 2.9pp, persistence median 3.4pp, and estimated
taker advantage 0.4pp; it authoritatively completed unfilled. Its signal then reset rather than manufacturing
a fallback from stale observations. This n=1 trace verifies wiring, not economics.

**v3 deployment check, 2026-08-19T03:23Z:** the bounded-quote worker restarted with active operator intent
preserved; startup reconciliation again passed with 0¢ reserved, zero recovered fills, and zero managed
remainders canceled. No v3 live order had fired at the first post-start read, so only startup and build/test
integrity—not order economics or the one-cent path—had runtime evidence at that point.

**Execution-state display corrected, 2026-08-19.** The edge panel had hardcoded the retired three-snapshot
denominator and displayed attempt ceilings as progress (`1/2 no fill`). The authenticated read model now
publishes the active `productionSignalPersistence` snapshot count/span. The primary panel shows only
execution-confirmed signals and current-window attempts; base-edge signals awaiting confirmation are hidden
behind a secondary control. Labels state what happens next—fresh fallback evidence, checks pending,
eligible awaiting execution, or sequence ended—while the two-attempt ceiling remains audit detail. The
worker restarted on this read-model change at 2026-08-19T03:38Z; startup reconciliation passed with 0¢
reserved, zero recovered fills, and zero managed remainders canceled.

**Environment surface cleaned, 2026-08-19.** `.env.local` was reduced from 84 assignments to 52 without
changing any retained value. Removed entries were blank/default-only research and Polymarket configuration,
credentials for read-only account connectors belonging to planned/unimplemented providers, and five archive values equal to code
defaults; funded authority, caps, risk gates, reconciliation, active strategy policy, projection, auth, and
archive credentials remain explicit. `.env.example` now marks optional providers as commented examples and
matches current 9/6/3 portfolio defaults plus the disabled net-edge ceiling. The linked Vercel project was
reduced from 21 variables to the four the hosted app read at that point: canonical URL, auth password/secret,
and its dedicated database URL. No deployment was triggered then. The later v5 deployment added a fifth,
non-authority execution-mode value so the public manifest describes the funded desk's adaptive policy rather
than the code's safe maker-only default.

The earlier v21 sentence "every accepted decision fills at the ask" remains false and withdrawn. A capped
IOC can also finish unfilled when the quote moves beyond its approved ask.

| v19 arm | live | paper |
| --- | --- | --- |
| A as traded | -13.1% +/-17.8 | -24.6% +/-13.7 |
| A2 same fills, held | -7.6% +/-19.3 | -21.8% +/-16.3 |
| B take ask, filled only | -14.3% +/-18.0 | -32.9% +/-13.9 |
| **C take ask, every decision** | **-3.7% +/-13.4** | **-1.8% +/-13.5** |

**This reverses [take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md), and the reason is a
changed constraint, not changed data.** That report set arm C aside because it "assumes capacity the
hourly order ceiling and budget would not have given". The same evening raised positions 3 to 9,
same-window 2 to 6, per-group 1 to 3, and made `runLive` drain its ranked queue. That capacity now exists.

Stated plainly: paying the spread **costs** ~7pp on trades the maker would have filled anyway (arm B
-14.3% against A2 -7.6%). Taking wins only by converting the other half — the half the maker was adversely
selected out of. Capital deployed roughly doubles. **Arm C is the best arm measured, not a profitable one:
still negative per dollar.**

The rationale for shipping the two halves together assumed the desk would take every ask. Current code does
not implement that assumption. At the 2026-08-19T01:44:04Z read, 13 live v21 orders were labelled taker and
only 4 filled; 5 were labelled maker and 2 filled. The sample is too small to judge economics, but enough to
show that neither unconditional taking nor 100% fills occurred.

**Three volume multipliers are confirmed** — v20's wider gate, 9/6/3 caps, and the drain loop. The claimed
fourth multiplier, 100% fills, is withdrawn. `npm run analyze:execution-gap` remains the monitor after its
persistence requirements are selected by stamped policy version; the old script still applied 3-over-30 to
v21 and undercounted executable decisions.

### Portfolio caps raised to 9 / 6 / 3, 2026-08-18

`DEFAULT_MAX_OPEN_POSITIONS` 3 → **9**, `maximumSameWindow` 2 → **6**, `maximumSameGroupPerWindow`
1 → **3** (`lib/portfolio-policy.ts`).

**The caps, not the gate, were refusing the volume.** Across 632 settlement windows there were 1,633
decisions the desk could actually have executed — admitted *and* persisting three snapshots over 30s — and
the 2-per-window / 1-per-group limits admitted only 992 of them. Candidates do not all present at once, so
a three-slot desk fills with the first arrivals rather than the best of the window: it held no live
position 75% of the time and still passed over executable decisions at 15–31pp, the band that returns
+44% per $1.

| per window | per group | capturable | vs today |
| --- | --- | --- | --- |
| 2 | 1 | 992 | baseline |
| 3 | 2 | 1,297 | +31% |
| **6** | **3** | **1,560** | **+57%** |
| 9 | 3 | 1,569 | +58% |

Per-window capture saturates at 6 — nine slots per window would catch nine more decisions out of 1,633 —
so the total cap of 9 is what buys headroom across overlapping settlement times, not the per-window one.

**Stacking has been the better cohort for this strategy**, which is why this is a raise:

| | single-position windows | multi-position windows | sharing a correlation group |
| --- | --- | --- | --- |
| live | −5.7% on 207 | **+2.3% on 352** | **+19.3% on 80** |
| paper | −22.6% on 126 | +0.6% on 82 | **+22.9% on 19** |

Of 155 multi-position live windows, 61 were mixed, 73 all-lost, 21 all-won — outcomes are correlated but
not lockstep. **This is the opposite of the long-shot policy**, where stacked windows lost together 7 times
in 9; long-shot buys sides that got cheap *because* the underlying moved, so its stacked positions are one
directional bet repeated. The evidence does not transfer between the two strategies and should not be
quoted across them.

**Caveats.** The stacking cohorts are selection-biased: the desk only holds 2+ when it found 2+ good
candidates, which may itself mark favourable conditions. Same-group cohorts are n=80 live, n=19 paper.
Exposure rises from roughly 21% to 64% of the edge policy's allocation when fully committed — 9 positions
at $1 per trade against $14 — so this is the number that bites if the correlated-outcome result is bias.

Tests moved with it: `portfolio-policy.test.ts` and `global-exposure-caps.test.ts` now state their limits
explicitly or derive fixtures from the constants, so they pin the mechanism rather than a policy number.

### Live execution drains its queue instead of placing one order per cycle, 2026-08-18

**The binding constraint on concurrency was never the position cap or the entry gate — it was the loop.**
`runLive` took `selected.find(...)`: one order per cycle, by construction, while `runPaper` had always
looped its whole portfolio selection.

Measured over the whole ledger before the change: live held **no position 75% of the time** (one 15%, two
8%, three 1%), and reached its three-position cap on **3 of 348** orders, while the gate admitted a median
of three simultaneous decisions. v20's extra admissions could not express themselves — candidates queued
behind a one-per-cycle door and their windows closed underneath them. It also explains the contract
selection leak: the better-ranked alternatives the desk "passed over" had been admitted a median of 95
seconds and were still waiting their turn.

`runLive` now drains the ranked selection up to `maximumOpenPositions()`. **Every ceiling is re-read per
placement**, which is the whole safety argument: a cycle can now commit real money three times where it
committed once.

- hourly filled-order limit, re-counted before each placement
- funding headroom and the live stake ceiling, re-read as each order consumes them
- `makerRetryDecision` and execution eligibility, per candidate
- **exposure created earlier in the same cycle** — `portfolioAdmitsAdditional`, pinned by
  `lib/live-concurrency.test.ts`. `portfolioDecisions` is computed before anything is placed, so orders 2
  and 3 could not otherwise see orders 1 and 2. Correlation limits were never load-bearing on live while it
  placed one order per cycle; now they are the only thing stopping three copies of one bet in a window.
  The long-shot policy demonstrated that failure the same evening — three DOWN positions on three assets in
  one window, all lost together — because it has no correlation limit at all.

No entry-rule change and no `BUY_POLICY_VERSION` bump: this is execution, which SPEC §12.3 permits to
differ between tracks. The mirror invariant is untouched.

**Historical maker retry review.** Live attempts were raised 1 → 2 on 2026-08-18 despite negative evidence:
second maker attempts measured −11.6% under 60s after the miss (n=35), −63.0% at 60–180s (n=6), and −17.7%
beyond 180s (n=9), against −2.0% for first attempts. That operator decision is superseded for adaptive live
execution: attempt 2 is no longer another maker order and the unsupported fixed 30-second delay is removed.
The old result does not validate the new taker fallback—it measured maker retries—but it does reject citing
30 seconds as an evidence-backed duration.

51% of historical live maker orders went unfilled, so misses remain the larger volume constraint. Adaptive
v2 addresses one exact sequence after fresh post-miss evidence; draining the ranked queue still addresses
volume by taking the next different contract.

### v20 — admit substantially more entries, 2026-08-18, by operator decision

`buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-v20`, manifest entry in
`lib/policy-manifest.ts`. Three bounds moved at once:

| bound | v19 | v20 | the increment it admits |
| --- | --- | --- | --- |
| `MIN_NET_EDGE` | 5pp | **−5pp** | 402 decisions, +17.5% ±6.5 |
| `MAX_NET_EDGE` | 35pp | **disarmed (1)** | 18 decisions, +144% ±141 |
| `EXECUTION_LATE_CUTOFF_MS` | 120s | **30s** | 248 decisions, +19.8% ±12.0, 8/8 days |

Combined: **686 additional decisions at +32.4% ±10.5 per window, +20.2% stake-weighted, positive on 8 of
8 days**, against a live rule admitting 2,227 at +17.2%. 537 of the 686 are ordinary 50–85¢ contracts
carrying 73% of the profit, with the per-window and stake-weighted views agreeing to within a point, and
the best ten decisions are only 11% of the total — it is neither a weighting artefact nor tail-driven.

**Why this was judged additive rather than substitutional at the time.** The original
`analyze:contract-selection` reported the desk at its 3-position cap on 0 of 67 v19 orders and 3 of 348
since v17. The 2026-08-19 decision-state correction withdraws that script as authority for historical
capacity because it had treated created orders as exposure without replaying terminal state. The policy
change remains historical; its capacity rationale now requires the same authoritative exposure replay as
any future claim.

**What the evidence does not cover, recorded plainly:**

- Under the durability proxy the same increment falls from +20.2% to **+10.3% ±10.8**.
- Every figure is at the ask, held to settlement. Production rests a maker order, fills about half the
  time, and those fills are adversely selected. Nothing here measures what these entries would fill at.
- The 30-second cutoff carries an operational risk the measurement cannot see: no time to reprice, no
  retry inside 120s (`MAKER_RETRY_LATE_CUTOFF_MS` is unchanged), and no time to exit. Exit availability in
  that band is 64% against 82% for the population.
- Eight days, one venue, one strategy; the edge-floor increment exists on three of those days.

Every safety control remains in force — environment gating, typed-confirmation arming, the per-trade
all-in cap, rate limits, kill switch, reduce-only exits, and reconciliation before execution. Reversible
by restoring the three constants; the ceiling alone re-arms with `MONEY_NOODLE_MAX_NET_EDGE=0.35`.

**A consequence to expect:** the price ceiling now binds. With a −5pp floor the expected-value test no
longer refuses expensive contracts before `MAX_ENTRY_PRICE` does, which reverses a property
`lib/paper-execution.test.ts` had pinned since v9.

### Why the edge policy loses — v19 decomposed, 2026-08-18

`npm run analyze:loss-decomposition` now covers v19, and a loader bug had been hiding it: the script read
sealed shards and `open.json` only, `open.json` is rewritten just on compaction and was **7 hours stale**,
and resolution arrives as a journal patch. It reported **zero rows for v19** while the desk traded it.
Fixed with a shared journal-aware loader, `scripts/lib/forecast-history.mjs`; v17 and v18 are unchanged.

| era, live | gate | realized | ordered-cohort selection | fill selection | exits |
| --- | --- | --- | --- | --- | --- |
| v17 | +14.4% | −2.9% | −15.7 | −19.4 | +14.6 |
| v18 | +13.5% | −11.8% | −26.0 | −16.2 | +18.0 |
| **v19** | **+20.9%** | −9.7% | **−21.8** | **−8.4** | **−2.9** |

The gate was at its best reading yet and fill selection more than halved. The −21.8pp stage is the gap
between the admitted and ordered cohorts; it does **not** identify a ranking decision. The corrected
snapshot replay later found chosen minus production-preferred at −0.9pp ±2.7pp (95%) over 232 v17-v19
windows, so the earlier `analyze:contract-selection` explanation and its passed-over alternative figures
are withdrawn. What makes the ordered cohort differ remains unidentified.

### Missed entries — the selection gates are not what keeps volume out, 2026-08-18

Full measurement in [reports/missed-entry-review-2026-08-18.md](reports/missed-entry-review-2026-08-18.md);
`npm run analyze:missed-entries`. It asks whether the desk should be admitting more buys, judged the way an
operator watching the app judges it — could this have been sold at a positive exit?

- **"Sellable at a profit" barely selects.** 81% of live-rule entries with a recorded path were sellable at
  a profit after entry, and so were **60% of the ones that expired worthless**.
- **No relaxation of the edge floor, edge ceiling, price band, quality floor, or selected-side floor
  produces an increment that beats the live rule** (+16.7% ±4.5 per $1 over 1,970 decisions in 1,803
  windows). The edge-floor increments match it; both side-probability increments are negative, −13.3%
  ±12.9 at a 50% floor, independently confirming the v13 restoration.
- **`MIN_ESTIMATE_QUALITY` and the price band are inert**: relaxing either admits **zero** additional
  decisions across 3,017 windows. AGENTS §5.7 — do not describe them as risk controls.
- **The venue price is calibrated from 30¢ up**, so there is no price band to harvest; below 30¢ it costs
  19–27¢ on the dollar.
- **Capacity binds first.** The live rule already admits a median of 3 and a mean of 3.6 simultaneous
  decisions per settlement time against `DEFAULT_MAX_OPEN_POSITIONS` = 3. A looser gate changes which trade
  is taken, not how many.
- **The gate that costs volume is signal persistence**, and §6 below is where that is measured.

Fill-optimistic throughout: entries are bought at the recorded ask. Three to five days, Kalshi only.

### CLOSED AS AN ENTRY CANDIDATE: `persistence-two-consecutive-v1` is production in v21

The committed sentinel of SPEC §706 records, at decision time, every entry two qualifying observations over
15s would have taken that production's three over 30s did not. At the 2026-08-18T20:33:05Z read it holds
**553 resolved incremental settlement windows against the 100 it was locked for**, returning **+13.2% ±8.4
per $1** at the ask, positive on all 5 days. The value is concentrated where production never caught up at
all — **+23.5% ±13.0 over 224 windows** — while the half production reached a median 17s later is
indistinguishable from noise.

v21 promoted it by operator decision on the pooled figure, with the version-scoping departure recorded in
the manifest. At the 2026-08-19 read the current cohort held 28 intents and **0 incremental intents** because
the candidate and production rule are now identical. The entry-policy experiment is closed. Its detached
maker observer still runs, but `buildPersistenceCandidateReport` summarizes observed fills over incremental
intents and consequently displays zero current observations; continuing that request load needs a newly
stated measurement or retirement.

The three blockers that existed before the operator promotion were:

1. **~~The maker benchmark could not answer the fill question~~ — instrumented 2026-08-18.** The recorded
   benchmark is `bid-priced return × modelled fill probability`: it prices the fill as a random draw the
   adverse-selection evidence refutes, and as a positive scaling it can never disagree with the ask
   benchmark. Intents now also carry a resting post simulated against observed trade prints, and the
   report gives **return conditional on an observed fill**. See the section below.
2. **SPEC §706 scopes evidence to the active buy-policy version.** Under that rule only the v19 cohort
   counts: 92 windows, +16.0% ±19.9 — below both the bar and significance.
3. Promotion is a manual act recorded in an immutable ledger.

### Observed maker fills on the persistence sentinel, shipped 2026-08-18; retired 2026-08-19

Design and retirement decision in
[docs/maker-post-observation-design.md](docs/maker-post-observation-design.md).
`persistence-two-consecutive-v1` recorded, per intent, whether the resting entry production would have
placed **actually would have filled**, simulated against observed trade prints.

- **What was wrong.** `makerExpectedProfitPerContract` = bid-priced settlement return × modelled fill
  probability. That prices the fill as a random draw, which the desk's own −19pp adverse-selection finding
  refutes; and being a positive scaling it can never disagree with the ask benchmark beside it. On the v19
  cohort the modelled probability ran 43–70% with a mean of 50.8%, so the tile was the bid return times
  roughly one half. It was also labelled "Maker-touch benchmark", which it never was — touch is
  `touchProbability`, documented in `lib/maker-fill-model.ts` as *inverted* against real fill rates.
- **What it did.** One order-book snapshot at post time (depth is not historical), the reprice ladder
  reconstructed from the **2-second contract path**, and one trade-print fetch after the 12-second managed
  horizon — two venue requests per intent. A post fills only when volume traded at or through its price
  exceeds the size displayed ahead of it (`lib/maker-depth-experiment.ts`), never on a touch. Both arms
  are scored: the ladder production actually walks, and a static post as a conservative floor.
- **Retirement.** Approval at 2026-08-19T04:15Z found 76 v21 intents and zero incremental intents. Shutdown
  waited for an open funded position to settle; the final 2026-08-19T04:35Z store had 80 v21 intents, all
  already production-eligible at candidate time, and no unresolved intent. The runtime
  `persistenceCandidateCycle` trigger and detached maker observer are removed. Existing evidence and report
  code remain read-only.
- **The recorded fields are untouched.** `makerExpectedProfitPerContract` and `makerFillProbability` stay
  exactly as written — the store is committed evidence — and are simply no longer reported as the maker
  benchmark. The report gains return **conditional on an observed fill**, plus the bid-priced return with
  no fill assumption applied at all.
- **Backfill: 16 intents, labelled separately and never pooled.** Of 103 intents with 60-second depth
  coverage, the bid had already moved on 87, so only 16 could be posted at the price production would have
  chosen. Those 16 score the static arm only and their fills are an **upper bound** — one 60-second print
  window against a 12-second horizon, with taker direction already discarded by that sampler.
- The live observer accumulated 12 v19 intents and 20 v20 intents before promotion. In the final store it
  had attached observations to 49 of 80 v21 intents—17 simulated fills and 32 misses—but none were
  incremental, so the active-policy observed-fill panel was empty by construction. This is not evidence
  about a persistence alternative and collection has stopped.
- The worker restarted at 2026-08-19T04:34Z. Startup reconciliation passed with 0¢ reserved, zero recovered
  fills, and zero managed remainders canceled; active operator intent was preserved.

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
  ordered-cohort selection, not window selection or a demonstrated ranking effect.
- **Ordered-cohort selection is a real narrowing**: −15.7pp live, −11.8pp paper. The 2026-08-19
  decision-state replay showed it is not evidence of a ranking defect.
- **Fill selection is half its reputation**: −19.4pp conditional against −44.5pp standalone. Every prior
  reading of this policy used the inflated figure, which double-counts ordered-cohort selection.
- **The maker discount helps** (+3.4pp), confirming that switching to taking would forfeit it.
- **The exit rule is the desk's strongest component** (+14.6pp live, +17.8pp paper). Execution is not
  uniformly the problem — one part of it is carrying the rest.

One identified leak remains—fill selection—and one unexplained admitted-to-ordered cohort gap. A ranking
change does not address the latter on current evidence.

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

### Entry fee semantics resolved without changing admission, 2026-08-19

The original plan and measurements are in [docs/entry-gate-fee-design.md](docs/entry-gate-fee-design.md).
Its proposed one-constant maker flip assumed maker-only production; adaptive execution invalidated that
premise because one admitted candidate may later rest or take.

The behaviour-neutral resolution is explicit by layer:

- `ENTRY_ADMISSION_FEE_ROLE` remains `'taker'`. Shared `netEdge` means immediate-execution admission edge,
  conservative for a later maker and correct for a later taker. It takes no execution mode and preserves
  the mirror invariant.
- `entryExecutionDecision` passes `'taker'` for current taker edge and `'maker'` for maker edge. Neither can
  be changed accidentally by a future admission-policy decision.
- Ask counterfactuals use the taker role and maker counterfactuals use the maker role. The dynamic
  `buildMakerShadow` report no longer charges its hypothetical resting fill a phantom taker fee.
- `venueFeeCents` and `venueFeeRate` still derive from the shared schedule. Charged whole cents retain the
  adverse rounding and 1¢ taker floor; continuous expected-value rates do not import them.
- `calendar-effects-v1` and the retired persistence store keep their stamped taker-role convention. Their
  maker-labelled durable fields require a new collection version during the collector audit; existing rows
  are not reinterpreted or silently blended.

No candidate, persistence state, ranking, size, or funded execution changes. The worker restarted on the
semantic split at 2026-08-19T05:28Z; startup reconciliation passed with 0¢ reserved, zero recovered fills,
and zero managed remainders canceled. Flipping admission to maker remains a separate policy proposal
requiring a fresh replay under current thresholds, a buy-policy version and manifest history. The earlier
1% volume estimate was measured under obsolete thresholds and is not a current impact estimate.

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
- Source policy `maker-high30-requalify3-fresh1c-idv2-v6` permits up to three separately requalified episodes: a managed post-only maker below 30pp issuance edge, or a capped fresh-quote IOC evaluation at 30pp+. After an authoritative maker zero-fill, the next episode requires two new post-completion snapshots over 15 seconds; no nonqualifying gap is required. Maker execution supports UP/YES and DOWN/NO with passive repricing, cancellation confirmation polling, fill/fee reconciliation, exact sub-cent accounting, collision-resistant bounded client IDs, and one-to-one reconciliation ownership. The funded worker is running v6 after a quiescent restart and authoritative startup reconciliation.
- Paper execution uses `paper-managed-execution-route-ioc-requalify3-calibrated-v6` for the same route decision, repaired three-episode boundary, neutral queue calibration, and relative `entry-sizing-reduce30-below-edge30-v1` sizing while retaining independent fills. A shared pure state machine chooses the refreshed initial passive limit and all progressive reprices. Paper polls independently every two seconds while live management runs concurrently, keeps live's issuance-sized quantity, and requires opposite-outcome public taker prints to consume displayed queue-ahead volume; ask touch alone is telemetry, not a fill. Incomplete terminal trade evidence is excluded rather than scored as a miss. Exact prospective pair IDs and bounded queue-consumption evidence are reporting-only. Portfolio/correlation/funding limits and its separate bankroll remain unchanged.
- Contemporaneous paper intents receive a separate `matched-live-fill-shadow-v1` overlay when live fills authoritatively. It is capped at observed live and requested paper quantity and records exact live price/fee terms, but cannot alter the independent paper status, budget, P&L, or public track record. The maker report exposes matched, both-filled, and live-only counts without blending the lanes.
- Explicit live arming, environment opt-in, kill switch, pause/resume, per-trade cap, order-rate cap, budget allocation, loss stops, and automatic safety suspension on ambiguous failures.
- Pause is a quiescent drain: withdraw intent, serialize behind execution, cancel/confirm managed remainders, reconcile authoritatively, and report restart-safe only when no working or uncertain transaction remains.
- Startup and periodic reconciliation read venue orders, fills, positions, resting orders, and cash before live execution. Managed remainders are canceled/confirmed; contradictory state fails closed. Prior partial reduce-only exits are included when validating original entry fills, so reconciliation does not replay the same exit or compare full acquisition history against only the open remainder. The fill-cost ceiling is the `reservedStakeCents` authorization captured at issuance, so repricing a reporting-only shadow field cannot move a fail-closed safety threshold.
- Operator intent is separated from operational state. Manual pause/kill/config changes never auto-resume; system suspensions may guarded-auto-resume only after authoritative reconciliation and normal readiness checks pass.
- Side-aware standalone reduce-only exits and protected live switching are implemented. Sell paths cannot create reverse exposure; partial/uncertain exits stop and reconcile rather than auto-chasing.
- Budget epochs, peak-equity drawdown accounting, current-epoch/lifetime P&L separation, and explicit stake-expansion criteria are implemented. The automation panel and the budget dialog date each track's figures with the moment its funding opened, from one shared formatter, and report the bankroll reset count beside it. Paper's original bankroll predates funding stamping and holds no opening timestamp, so it is anchored to its first trade (2026-08-08T21:12:37.137Z), labelled as a first trade rather than a funding; a reset dates itself from that point on.

### Data, Public Projection, and Policy Identity

- Atomic JSON writes for cache, forecast history, provider settings, budget control, execution ledger, promotion ledger, and evaluation history.
- Forecast history is sharded under v3: a journal-backed hot open set, immutable content-addressed daily shards and rollups, and one index published last. Only the collector mutates it under a process-global queue and process-lifetime filesystem lease. The legacy and corrupt v2 snapshots are retained and are no longer on any read path.
- A local-only Scaleway Object Storage archive is enabled against private bucket `money-noodle-archive-857bea21`. A detached nice-priority worker runs every 24 hours, stores gzip-compressed content-addressed blobs, verifies every new upload by full read-back SHA-256 and byte count, refuses files that change during capture, and writes a manifest only after the set passes. The 2026-08-24 expanded manifest covered 138 files / 1,436,922,799 source bytes, including frozen corrupt/superseded derivatives; a complete independent restore and both owner semantic verifiers passed. This phase performs no durable local deletion and never runs on Vercel. Remote-primary eviction remains blocked because the bucket has no Object Lock or second replica and no tier catalog is active.
- Optional Postgres public paper projection is implemented with migrations:
  - [001_public_paper_projection.sql](/Users/raiphairow/code/money/db/migrations/001_public_paper_projection.sql)
  - [002_public_paper_performance.sql](/Users/raiphairow/code/money/db/migrations/002_public_paper_performance.sql)
- Hosted/stateless reads can serve replicated public paper budget and performance without live credentials or execution authority.
- Hosted/stateless market calculations now use the same seven-second pre-expiry lead as the persistent server prefetch: the browser requests again eight seconds after the prior request completes, while the hard 15-second display and execution expiry remains unchanged. Stateful execution and collector cadence remain unchanged.
- Provider registry covers Polymarket, Kalshi, Crypto.com, ForecastEx, and Robinhood with per-market research/paper/live capability boundaries. New providers fail closed.
- Provider permissions are authoritative and separate for research, paper, and live. Budget venue fields are compatibility projections only.
- Per-provider budgets and per-market percentage allocations are implemented; market/global exposure caps remain global so budget splitting cannot multiply correlated exposure.
- Active policy manifest and read-only Policy view expose current forecast, buy, execution, exit, switch, regime, and provider-variant versions.
- Immutable model promotion/rollback ledger and authenticated `/api/model/promotion` write route are implemented. The route records decisions only while authenticated, same-origin, paused, quiescent, restart-safe, and with zero reserved budget. It cannot change compile-time model parameters.

## Current Priorities

1. **Monitor bounded-taker-pilot-v1 to its compiled terminal boundary.** Inspect actual treatment submissions,
   fills, exact fees, cap accounting, and reconciliation without changing the 25/75 assignment or any threshold.
   The first treatment correctly refused a 21¢ pre-submit move and produced no signed IOC; actual treatment-fill
   evidence remains zero. V1 can authorize only a separately designed fresh efficacy generation.
2. **Accumulate untouched exit-policy-sentinel-v2 evidence.** Keep the four precommitted arms fixed and production
   on `strict-value-v1`. Do not review before 60 resolved independent windows, 20 divergent windows, 90% explicit
   evaluator-cycle coverage, Holm-corrected positive evidence, and same-sign live/paper results; live replay
   remains optimistic and cannot alone establish executable IOC transfer.
3. **Provision durable remote-primary protection and implement the tier catalog before local eviction.** The
   138-file archive and complete restore passed, but the current bucket has no Object Lock and no independent
   replica. Add enforceable retention or a second bucket, then implement dry-run-first owner allowlisting and
   verified hydration; do not retire frozen legacy/corrupt evidence yet.
4. **Observe execution-ledger v9 and design observational-journal compaction separately.** The measured
   terminal-ledger clone is removed: the hot account ledger retains all control/money rows and immutable heavy
   evidence hydrates on demand. Automatic evidence compaction remains off until longer observation and a separate
   activation decision; the independent restore passed on 2026-08-24. Native v9 sampling still finds substantial JSON parsing in the contract-path,
   calendar, exit, portfolio, and maker journals; each needs its own checksum/generation/concurrency/crash-window
   design before changing its owning store.
5. **Run due evaluator-v2 checkpoint 1,300 only during planned paused/stopped maintenance, then design evaluator
   v3 before any model promotion.** Freeze cohorts and replay the complete policy and execution boundary;
   evaluator v2 remains monitoring-only and offline-only.
6. **Complete the untouched long-shot v2 60-window paper cohort.** No interim tuning or live arming.
7. **Accumulate exact v7 paper/live mirror evidence.** Keep v6 and every paper calibration/execution generation separate.
8. **Continue first-organic-switch verification.** Preserve reduce-only semantics.
9. **Then address provider visibility, alerts, restore testing, dependency pinning, and auth hardening.**

## Detailed Roadmap and Historical Delivery Record

### Forecast storage — v3 repaired; automatic seal and independent restore verified

The original migration trigger was ~396 MB retained heap, roughly 40 MB/day growth, and 6–11 second startup.
The migration met its clean-start target on 2026-08-16. On 2026-08-22, independently bundled dashboard
writers were proven to have separate module-local queues and caches; their interleaved seals corrupted v2 and
lost at least 88 qualified rows from local artifacts. The archive-backed owning repair installed
content-addressed v3 and the verifier is green again. The subsequent 2.43 GiB observation led to a native
profile and bounded public-history repair, then process-global provenance/cycle-path caches. Those changes
removed confirmed churn but production still peaked near 3 GiB; the shared execution ledger is the next
measured whole-file path and requires a separate money-path ownership design.

This section previously read "a 15-second system cannot keep full-history parse/stringify in the request or collector path." That premise was wrong and is worth recording as wrong, because it is what turned this into a fire drill. The parse costs ~1.2 s once per process; the ~10 s blocks were quadratic grouping in `summarizePerformance`. Sharding is still the right answer, but for memory rather than for blocking.

Started 2026-08-14:

- Added `lib/forecast-storage.ts` and `scripts/verify-forecast-storage.ts`.
- `npm run verify:forecast-storage` began as the migration gate over the legacy snapshot and journal. On 2026-08-19 that path returned `ok: true` over 52,417 rows and 10 planned shards while the active index held 58,360 rows across 12 shards, exposing that it no longer verified production storage. It now detects the active layout and checks indexed shard/rollup hashes and counts, terminal/open separation, duplicate identities, journal replay, and the direct full-history summary against the stored-rollup-plus-current-open summary. The first corrected run passed over 58,756 current rows, 57,728 sealed rows, 1,028 current open rows, 12 shards, and 1,820 journal events. `--write` refuses an active layout because only `sealForecastStorage` under the forecast write lock may mutate it.
- The gate compares the whole summary field by field, not eight counters: exact for anything countable, and a `1e-12 × max(1, |left|, |right|)` combined absolute/relative tolerance for float aggregates, because IEEE addition is not associative and a different row order legitimately moves the last digits. The absolute floor prevents last-bit noise near zero from becoming a false relative failure. Byte-identical output is not an achievable bar.
- Passing the gate required giving every reported ordering and tie-sensitive selection a total order by `id`. Ties are the ordinary case here, so `timeline`, both streaks, the per-cycle representative row, `recent`, grouped sorts, and the missed-buy selections previously could depend on durable row order. The missed-buy gate now uses the compact persisted provenance reference directly and covers an asset/window split across shards, including a globally nearest snapshot that contributes no candidate.
- A verified `--write` run over 49,703 live rows emitted `forecast-storage-v2`: 79 open rows, 49,624 terminal rows across 8 shards, and 6.6 MB of sufficient-statistic rollups standing in for roughly 190 MB of history. Both shard rows and rollups have indexed SHA-256 checksums, and the verification path now consumes the exact rollup objects that are written rather than rebuilding them invisibly from rows. The older 14 MB / 3,082-row open artifact was a symptom of event-loop starvation; resolution has caught up.
- **V3 incident repair, 2026-08-22.** V2's caller-held lock was module-local, while Next produced three writer copies; a stale seal could omit another copy's journal events and truncate them. V2 also overwrote active filenames before publishing its index, so a crash could invalidate the prior generation. V3 permits only `background-collector` to import calculation mutation, shares a process-global queue, holds a process-lifetime filesystem lease, compacts from reloaded durable state, uses immutable content-addressed artifacts, verifies them after write, and publishes `index.json` last. The repair restored 88 archived qualified rows and moved every corrupt source to `.corrupt-*`; the first v3 gate passed over 70,837 rows with zero errors. The dominant caveat is an evidence gap whose losing-writer-only rows cannot be enumerated. See the dated incident report rather than treating 88 as a complete loss count.
- Off-machine archive and restore verification passed on 2026-08-24: the expanded stable-source manifest held 138 files / 1,436,922,799 source bytes, restored byte-exactly, and passed the full forecast and v9 execution-ledger verifiers. Dedicated application credentials retain object read/write and bucket-read permissions but no object-delete or bucket-write permission. Rolling local deletion remains disabled until Object Lock/enforceable retention or an independent replica and the owner-aware tier catalog exist. See `reports/object-storage-restore-and-disk-reclamation-2026-08-24.md`.

Plan:

1. ~~Build `summarize(sealedRollups, openRows)` beside the current function, both running and compared under the existing gate on live data, with nothing switching over.~~ **Done.** `summarizeFromRollups` in `lib/forecast-rollup.ts` reproduces the full summary under the gate over the 49,703-row live history, in 134 ms against 624 ms, from 6.6 MB of rollups standing in for roughly 190 MB of rows. Both paths run on every gate run and nothing has switched over. The merge depends on no property of the layout: it sorts ordered columns, merges cycles/windows by key, and globally re-selects the missed-buy snapshot per asset/window. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §4.1.
2. ~~Switch the reader.~~ **Done 2026-08-16, and measured.** `readForecasts()` returns the open set; sealed shards load lazily for the evaluator and the on-demand reports. Retained heap to serve the hot set fell from **426 MB to 17 MB** (RSS 493 MB to 70 MB): 1,549 open rows plus nine shard rollups standing in for 50,713 sealed rows. `/api/dashboard` warms in ~1 s and then serves in ~12 ms. The summary is unchanged, produced by `summarizeFromStorage` as sealed statistics plus the open rows, which the gate proves field-by-field against the direct scan.

   The switch is gated on `index.json`: absent or version-mismatched, every path falls back to reading whole history exactly as before, so it reverts by deleting one file. Sealing now also clears the journal — without that the next read replays events for rows already inside a shard and double-counts every lifetime figure.
3. Keep retention policy unchanged during the migration; this is a storage-layout change, not evidence deletion.

Rollups must come before sharding, not after. Every cycle `updateTracking` reads the whole array and the cached summary scans all of it every 60 seconds, so switching the reader while the summary still needs sealed rows would either keep the archive resident anyway or re-read the history every minute. The residency win is gated on the summary no longer needing sealed rows.

The worker boundary previously listed here is deferred indefinitely. It relocates work without reducing residency, which is not what binds. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §5.

The migration's done criteria were: retained heap and startup time measurably drop, forecast scoring match
pre-migration output under the gate, 15-second collection remain fresh through restart, and the dashboard
report degraded rollup state explicitly. All four had met as of 2026-08-16. The 2026-08-22 integrity failure
reopens the scoring/health gate; it does not rewrite the earlier clean-start measurement.
`/api/performance` carries `forecastStorage`, and the signed Performance dialog shows an explicit
incomplete-figures notice when a shard rollup cannot be read.

Current follow-ups:

- **Automatic v3 seal and independent restore passed.** Restored generations generated at
  `2026-08-23T17:03:39.476Z` and `2026-08-24T13:38:01.496Z` passed the complete direct-versus-rollup verifier;
  the latter held 73,680 sealed rows in 17 shards plus 1,137 current rows after journal replay. The corrupt v2
  artifacts and frozen legacy snapshot remain preserved because passing restore does not itself authorize
  eviction. Design: [docs/forecast-storage-generation-repair-design.md](docs/forecast-storage-generation-repair-design.md);
  restore report: [reports/object-storage-restore-and-disk-reclamation-2026-08-24.md](reports/object-storage-restore-and-disk-reclamation-2026-08-24.md).
- **Execution-ledger v9 is active; observational residency remains open.** Seven emitted execution bundles
  share one serializer and committed snapshot; mutation clones, commit-boundary publication, failed-write
  invalidation, detached scoped reads, and a global pause barrier remain tested. V9 reduced the 3,794-row hot
  ledger from 36.35 MB to 6.26 MB without deleting evidence, and fixed polling no longer hydrates immutable
  batches. Structured-clone samples fell materially, while large append-only observational journals still
  produce parse/GC spikes and require separate owning-store designs. Measurements and caveats:
  [reports/execution-ledger-v9-migration-2026-08-22.md](reports/execution-ledger-v9-migration-2026-08-22.md);
  designs: [docs/execution-ledger-runtime-design.md](docs/execution-ledger-runtime-design.md) and
  [docs/execution-ledger-v9-design.md](docs/execution-ledger-v9-design.md).
- **Payload split** (design §7 item 2, agreed separately): the freshness badge should judge only market data,
  so no future slow subsystem can blank the trading view.
- **Do not retire the legacy snapshot while verification fails.** `data/forecast-history.json` is the frozen
  coexistence copy and must remain untouched until the sharded layout verifies again and an independent
  restore/evaluator pass succeeds.

### Long-shot round trip — implementation complete; v2 evidence collection open

Started 2026-08-14. A second policy on `crypto-15m`, running beside the edge policy. The launch cohort
bought a side whose executable ask reached 10¢ with at least ten minutes left and sold through a one-second
reduce-only IOC poll at 90¢. **The active local cohort changed on 2026-08-18 to 12¢→97¢/600s, paper only.**
That change was selected from a 50-cell retrospective fine-path sweep, so it starts a new forward collection
cohort and is not evidence-backed promotion. Design and launch arithmetic are in
[docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md);
SPEC §12.10 and the 2026-08-14 decision-log entries carry the decisions.

Implementation is complete under an explicit operator decision and bounded learning budget: 30% of the
`crypto-15m` cap, a 20¢ opening ticket, and a derived halt at 300¢ of policy equity. Economic review is now
locked to 60 independent settlement windows under hold-v2; attempt count is diagnostic only.

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

Paper-enabled and running as of 2026-08-15; the separate live flag is currently false. Entry is a price-capped taker IOC at the mark — an explicit exception
to maker-only production execution, because the trigger is defined as the ask reaching the mark. Every
account-wide protection still applies unchanged: kill switch, live arming, the reconciliation barrier, the
drain, and the shared hourly filled-order ceiling.

Funded at 30% of the Kalshi `crypto-15m` cap: 600¢, a 20¢ ticket, halting below 300¢. `npm run fund:long-shot`
reports and re-applies it, refusing unless automation is paused with nothing reserved or open.

Current state at `2026-08-22T05:32:51Z`: paper v2 had 50 resolved attempts across 26 independent windows,
−114.64¢ exact P&L on 1,902¢ staked, two `won` settlements and four target sales. Hold-v2 had 50 paired
resolved sentinels in the same 26 windows, six in-the-money settlements and four paths touching 97¢. This
is progress toward the locked 60-window review, not an interim decision. **The long-shot live lane remains
blocked by its own per-strategy arming flag** because `MONEY_NOODLE_LONG_SHOT_LIVE_ENABLED` is unset; it has
zero v2 live attempts even though the account-wide edge desk was active/live at the snapshot. Distinguishing
those controls is what prevents a paper research policy from inheriting funded authority.

**Historical launch cohort as of 2026-08-17:** 25 resolved paper attempts under
`long-shot-round-trip-buy10-sell90-win600-v1`, of which 1 sold at the mark, against the 60
`LONG_SHOT_REVIEW_ATTEMPTS` required before a first review. That cohort was superseded before reaching its
bar and must not be pooled with 12¢→97¢. The three `sold` rows in the earlier
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

Evidence stance: **stop tuning; treat 12¢→97¢ as a fresh paper cohort.** Nothing measured authorized the
parameter change. On the current 2-second retrospective sweep the selected cell held 149 entries, ratio
0.83, sell-at-mark +9.0% ±46.3pp and hold +11.5% ±47.3pp; it was one of 50 screened configurations. Only
forward records under its derived version may answer whether anything survives selection, and the current
hold-sentinel capture gap must be closed first.

**Revisit triggers.** The dense-path trigger has arrived: on 2026-08-19
`npm run analyze:long-shot-fine-marks` covered 562 settled fine windows at a mean 266 samples each. Finer
sampling raised touch rates but did not produce a promotable mark; the only displayed ratio above one had
an interval spanning zero and trailed hold. The active first-review trigger is **60 independent settlement windows at one policy version** under
`long-shot-hold-v2`. The execution report's legacy `LONG_SHOT_REVIEW_ATTEMPTS = 60` indicator is diagnostic
only and cannot unlock the economic review. The 12¢→97¢ v1 execution cohort had 9 attempts in 5 windows at
the repair read and remains superseded by mandatory-trailing v2; invalid hold-v1 records stay excluded. The
2026-08-21 operator decision above commits the untouched order-policy-v2/hold-v2 cohort through its 60-window
boundary without arming live or changing parameters on an interim result.

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

**The bounded maker-fill experiment stopped and its persisted sample cannot answer the question**
(2026-08-19 review in [reports/open-experiment-status-2026-08-19.md](reports/open-experiment-status-2026-08-19.md)).
It collected 10,448 rows over 447 asset-contract windows and 64 settlement windows during 16.6 hours on
2026-08-18. The standalone process is no longer running.

The intended fill rule in `lib/maker-depth-experiment.ts` is sound: a post fills only after traded volume at
or through its price exceeds size displayed ahead at posting. The recorded schema is not sufficient to
apply it. `fetchKalshiTradePrintsSince` returns `takerSide`, but `scripts/experiment-maker-depth.ts` discards
that field and persists every print on both outcome scales. Only an opposite-outcome taker consumes a
selected-side resting bid, so one print can be credited as queue progress on both sides. The resulting fill
rate is an upper bound and post-fill drift is not decision-grade. Its package command and historical
backfill command were removed on 2026-08-19, and both scripts now fail closed if invoked directly. Any new
depth measurement needs an agreed prospective schema carrying taker direction; displayed queue would still
remain a proxy for private FIFO rank. **Nothing here authorizes a market-making strategy.**

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

Implementation is done; economic review means 60 independent settlement windows—not 60 attempts—are
reportable for one untouched hold-v2/order-policy-v2 cohort, clustered by settlement window.

### Walk-forward model review — evaluator v3 required

The evaluator and promotion ledger exist, but promotion criteria still need to become decision-grade.

The 2026-08-20 review of `walk-forward:975:fnv1a-bccfee60` establishes that adding thresholds to the
existing score is not enough. Its cohort fingerprint no longer reproduces after later settlements; its
baseline is not the buy policy active at generation or v22 today; and a candidate cannot change the stored
production-selected side, provider or cost. Full findings and paired uncertainty:
[reports/walk-forward-model-candidate-review-2026-08-20.md](reports/walk-forward-model-candidate-review-2026-08-20.md).

Design evaluator v3 before coding it:

- Freeze every cited run's ordered settlement-window and selected-row cohort in a content-addressed
  manifest so late resolution cannot rewrite an immutable checkpoint.
- Replay one explicit `BuyPolicy` and regenerate side, provider and all-in cost from every decision-time
  actionable quote; never inherit production's selected side.
- Report paired, window-clustered signal-policy return separately from a prospective simulated-execution
  lane using versioned route, depth and trade evidence. The candidate lane receives no order authority.
- Predeclare gates for return lower bound, Brier/log-loss non-regression, coverage, continuous drawdown,
  replay coverage and fold consistency. Score quality candidates only on exact confidence-input rows.
- Treat 25-window checkpoints as monitoring, not repeated promotion attempts. Lock the reviewed
  `(basisWeight=0.65, slowTiltScale=0.5)` candidate for one future prospective cohort and one review at an
  agreed independent-window bar.

Until that implementation exists, v2 continues to collect and report monitoring checkpoints but
`evaluatePromotionEligibility` refuses its evaluator generation before considering its numerical gates.

Current stance: Blend 0.4 retained. The stored 1,150-window checkpoint generated
`2026-08-22T03:31:28.252Z` crossed evaluator v2's mechanical review threshold: candidate 14.27% against
baseline 12.11% over 575 test windows, positive 5/5 folds and better in 3/5. It still cannot promote: v2
inherits an incomplete policy/execution boundary, the cohort fingerprint can move after late resolution,
and overlapping checkpoints are repeated looks. No production parameter or promotion ledger changed.

### Profit-reversal exit policy — prospective evidence open

Strict value exits and the 75% profit-reversal lock are measured separately. Strict value remains executable. `profit-reversal-75-v1` is already withheld from execution by default on its own negative evidence; arming and high-water observations continue so the counterfactual remains prospective. The local environment explicitly keeps it disabled.

Remaining work:

- Keep collecting complete position paths so HOLD arms are no longer approximate.
- Re-run exit policy reports after enough new armed downturns under the current implementation.
- Require a separate manual evidence review before `MONEY_NOODLE_PROFIT_REVERSAL_EXIT=true` may restore execution or before a replacement reduce-only rule is introduced.
- Preserve strict reduce-only semantics: exits reduce only existing exposure and never become opposite-side buys.

The small historical live cohort supports conservative withholding, not permanent refutation or a replacement rule.

### Maker queue/depth evidence — collection open

Instrumentation and the queue-aware paper simulator are implemented; the next step is held-out evidence, not live execution changes. Before this deployment, same-signal paper/live maker agreement was only 29.7% across 37 paired attempts (19 live-only fills and 7 paper-only fills), which is the baseline the new independent and matched-live lanes must improve on prospectively. The first post-deployment review has only 2 matched intents.

Remaining work:

- Segment fill and return by displayed-ahead proxy, imbalance, repricing path, resting duration, profit state, probability deterioration, asset, side, and time remaining.
- Compare accepted filled orders with accepted no-fills by settlement window.
- Measure independent-paper/live agreement and disagreements against the separately stored matched-live overlay; never substitute the selected live fill for the independent paper result.
- Keep v2/v3/v4/v5 paper cohorts separate from neutral
  `paper-managed-execution-route-ioc-requalify3-calibrated-v6`; recalibrate only after enough complete
  prospective `entry-execution-mirror-pair-v1` live/paper pairs exist in one exact execution generation.
- Current execution identity is `maker-high30-requalify3-fresh1c-idv2-v6` with
  `entry-sizing-reduce30-below-edge30-v1`. Below
  30pp each qualified episode is a reduced-size managed maker; at 30pp+ it is one full-base capped IOC only
  after the exact refreshed quote re-clears every absolute gate. A maker zero-fill may requalify up to the
  three-episode ceiling, but there is no taker fallback. Historical v3/v4 rows retain their execution stamps
  and must not be pooled with v5 or v6; v6 retains v5 economics but changes live wire identity and reconciliation ownership.
- The pre-decision shadow had shown no discrimination: over 618 stamped orders on 2026-08-18, 74 were
  taker-flagged but all executed maker; flagged and unflagged fill rates were 51% and 50%, and fill-selection
  gaps were −11.2pp and −13.1pp. That evidence did not authorize v4 or v5; both 2026-08-19 changes are
  explicit operator decisions, not claimed promotions.
- A wholesale switch to taking remains only the counterfactual in
  [reports/take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md). It is not the deployed policy.

Forbidden for now: depth-aware sizing, any multiplier above 1, more than three entry episodes, rearming
without fresh post-completion persistence, rearming after any fill or taker result, taker fallback after a
maker miss, direction-based production cancellation, bypassing any fresh high-edge gate, or queue-aware live
gates.

### Organic live switch and exit verification — open

The switch engine, reconciliation matcher, partial-exit handling, replacement withholding, and switch-versus-hold accounting are implemented and tested. A real organic switch has still not been economically verified end to end.

When it occurs naturally, verify:

- Reduce-only exit order side/action.
- Venue fills, fees, remaining quantity, and reservation release.
- Replacement withholding after zero or partial exit.
- Replacement submission only after a complete confirmed exit.
- Switch-versus-hold and standalone exit counterfactual accounting.

Never force a live switch just to exercise the path.

### Provider variant and policy visibility — open

The provider registry foundation is in place. The next useful work is observability and clean attribution before new execution adapters.

Remaining work:

- Add dashboard, performance, open-order, and decision-history filters for live/paper, provider, provider variant, market, and policy version.
- Move static policy manifest details into a durable model/policy registry with historical parameter diffs, dataset fingerprints, and audited promotion/rollback lineage.
- Add per-(provider, market) policy overrides for thresholds, sizing, and execution style.
- Defer candidate-set funding/ranking changes until there is a second live-capable provider, because it cannot change behavior before then.
- Add any new provider read/paper-first behind official API verification, operator eligibility, and explicit capabilities. No scraping path may imply live capability.

### Secondary work after safety and evidence

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
