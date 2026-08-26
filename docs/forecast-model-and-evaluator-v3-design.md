# Forecast model boundary and evaluator v3 design

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Partial
> **Created:** 2026-08-24
> **Canonical requirements:** [`spec/forecasting-and-evidence.md`](../spec/forecasting-and-evidence.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260825-10`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Status:** Phase 1 implemented on 2026-08-24. Phase 2 prospective collection activated locally at
> 2026-08-25T03:17:17.456Z. Its written 10-window wiring review passed on 2026-08-25. The fixed 100-window coverage
> review passed on 2026-08-26 with 11,303 closed rows across 104 closed windows, 95.34% same-funded-provider outcome
> coverage, a complete available six-arm family, and zero production replay error; all 527 unscoreable rows lacked
> funded-provider contract provenance at issuance. This was coverage-only and neither ranked candidates nor opened
> Phase 3. The 300-window phase-exit gate remains closed. Confirmed-signal, venue-candidate, portfolio-selection,
> live-authorization, and attempt-and-outcome reviews are approved next in strict layer order. A separate
> paper-execution fidelity workstream began exact-control Phase F1 on 2026-08-25; it does not advance a decision
> layer and must freeze its
> execution generation before any serial execution-evidence phase uses paper as a control. Every later phase remains
> observation-only and must clear its milestone review before the next phase is activated. This design changes no
> production forecast, buy policy, execution, capital, accounting, or live authority by itself.

## 1. Decision

The current contract-basis forecast is a useful production control, but its implementation is assembled inside
`buildPrediction` while candidate replay reconstructs part of the same calculation elsewhere. That makes a
candidate easy to score under a formula, side, venue, cost, or policy that production did not actually use. The
monitoring-only evaluator v2 has exhibited all of those failures and cannot support promotion.

Implement the base-signal improvement plan in six gated phases, then evaluate the confirmed-signal layer in four
strictly serial phases, exact-provider venue candidacy in four more, portfolio selection in four, live
authorization in four, and attempt/outcome lifecycle in four final phases:

1. extract one pure, versioned forecast-model boundary while proving production equivalence;
2. commit prospective candidate outputs with no order authority;
3. collect reproducible volatility, jump, settlement, and oracle-uncertainty inputs;
4. implement immutable, policy-complete evaluator v3 for the base buy decision;
5. add a separate prospective simulated-execution lane while holding production confirmation fixed;
6. perform one predeclared base-signal review after both evidence lanes mature;
7. implement and parity-test the exact-provider five-arm confirmation family;
8. collect its prospective signal lane;
9. shadow-execute at most one locked confirmation candidate;
10. perform one corrected confirmation review;
11. classify and parity-test venue-candidate safety, economic, capital, and diagnostic checks;
12. collect current-rule venue attribution and implementation-shortfall evidence;
13. freeze and prospectively score at most one small venue-economic family;
14. perform one corrected venue-candidate review;
15. implement full-cycle portfolio attribution and prove exact production-control parity;
16. compare greedy fidelity, control activity, and downstream reranking without changing production;
17. freeze and prospectively shadow at most one small stateful portfolio family;
18. perform one corrected portfolio-selection review;
19. implement complete authorization manifests and prove exact production-control parity;
20. fault-test concurrency and attribute current authority without changing production;
21. freeze and validate at most one focused fail-closed authorization generation;
22. perform one final live-authorization reliability review;
23. implement a normalized attempt/outcome lifecycle projection and prove exact production-control parity;
24. fault-test recovery/accounting and attribute the current execution funnel without changing production;
25. freeze and prospectively validate at most one focused safety/accounting or economic lifecycle generation; and
26. perform one final attempt-and-outcome review.

No phase automatically starts the next, changes production, or grants promotion eligibility. Evaluator v2 remains
monitoring-only history and is never rewritten into v3 evidence.

The parallel paper-simulator repair is governed by
[`docs/paper-execution-fidelity-v2-design.md`](paper-execution-fidelity-v2-design.md): F1 exact-control parity,
F2 prospective create/acknowledgement and read-after-horizon timing shadows, F3 one prospective queue family, and
F4 one combined held-out generation. It may not change the paper execution identity during a serial execution
cohort; the retained or separately adopted generation must be frozen before Base Phase 5.

## 2. Boundaries

- The production probability remains venue-independent. Event-contract prices are costs and benchmarks, not
  forecast inputs.
- The shared buy-policy mirror remains unchanged: paper and live receive the same production probability and pure
  entry decision.
- Candidate definitions and evidence have no imports into forecast selection, persistence, sizing, portfolio,
  routing, budgets, reconciliation, orders, exits, or settlement. Later portfolio, authorization, and lifecycle
  evaluators observe production decisions and outcomes, but their stores and reports likewise have no policy,
  accounting, or money-path authority.
- Every candidate is immutable and versioned. Changing a parameter starts a new candidate identity and cohort.
- UTC settlement timestamps are the unit of independence. Asset rows sharing a close are one correlated window.
- Retroactive screening may reject an idea and may never promote one. Promotion requires prospectively committed
  decision evidence, the complete production comparison, and a separate manual act.
- The funded worker does not run CPU-heavy evaluation. V3 follows the existing stopped-worker/offline boundary in
  [`docs/offline-walk-forward-evaluation-design.md`](offline-walk-forward-evaluation-design.md).

## 3. Phase 1 — pure production forecast model

### 3.1 Shape

Add a pure model module with:

```ts
interface ForecastModelSpec {
  version: string;
  basisLogOddsWeight: number;
  slowTermScale: number;
  slowTiltScale: number;
  maximumSlowTiltLogOdds: number;
  temperature: number;
  probabilityFloor: number;
  probabilityCeiling: number;
}

interface ForecastModelInput {
  basisProbabilityUp?: number;
  slowTerms: Array<{ id: string; baseLogOdds: number }>;
}
```

The result exposes the basis contribution, raw and bounded slow tilt, per-term post-cap contributions, total log
odds, and final probability. `evaluateForecastBasis` retains the current driftless basis calculation behind the
same model boundary. `PRODUCTION_FORECAST_MODEL` contains the exact constants production runs today.

`buildPrediction` continues to own data acquisition, factor explanations, confidence, venue comparison, and the
UI shape. It delegates the venue-independent probability arithmetic to the pure model. Candidate replay consumes
the same probability combiner rather than maintaining a second implementation.

### 3.2 Equivalence gate

Phase 1 is complete only when:

- a grid spanning positive/negative/flat basis, remaining-time, volatility, slow-term, and cap boundaries matches
  the frozen pre-extraction formula within `1e-12`;
- existing exact calibration replay remains within `1e-12`;
- the full typecheck and test suite pass;
- `MODEL_VERSION`, buy-policy version, policy manifest, and every execution version remain unchanged;
- no durable file or production runtime migration is required.

**Timeline:** completed in the 2026-08-24 design change. The extraction passed the `1e-12` grid, exact replay,
typecheck, full test suite, and production build gates without changing a production version. This is an
engineering-equivalence milestone, not an evidence milestone.

## 4. Phase 2 — prospective candidate decisions

### 4.1 Initial candidate family

The registry begins observation-only with:

1. exact production control;
2. the previously locked calibration hypothesis: basis log-odds weight `0.65`, slow-tilt scale `0.5`;
3. exact settlement-average mechanics with every other production input fixed;
4. basis only, with slow directional terms at zero;
5. basis plus the shortest-horizon intraday term only;
6. all current slow terms at half strength.

This is one declared family. Individual good rows do not escape the family-wise multiple-comparison cost. No
candidate is promotable merely because it is listed or collecting.

### 4.2 Decision evidence

At each prospective evaluator opportunity, commit:

- observation and contract-window identity;
- production model, candidate model, and buy-policy versions;
- exact production replay input or an explicit unavailable reason;
- production and candidate probabilities;
- both actionable sides on the funded provider, fee schedule identity, and exact contract provenance;
- the side, price, fee-aware edge, and qualify/refuse result each arm independently chooses;
- eventual outcome from that same provider contract.

Candidate evidence is appended before the outcome is known. Candidate absence is explicit and remains in the
denominator.

### 4.3 Milestones

- **Activation smoke check:** first 10 independent windows; require exact identity, no missing arm, and exact
  production replay. This checks wiring only and reports no efficacy.
- **Coverage review:** 100 independent windows; require at least 95% scoreable production-control coverage and
  explain every unavailable class. Candidate returns remain descriptive.
- **Phase exit:** 300 independent windows with at least 90% coverage for every candidate retained for v3 and no
  evidence that candidate collection changed production latency or output. Only then may Phase 3 activation be
  approved.

At a nominal continuous 15-minute market cadence, 100 settlement timestamps are about 25 hours and 300 about 75
hours. Outages, unavailable inputs, and incomplete outcomes extend the calendar; elapsed time never substitutes
for the window count.

**Coverage review:** the 100-window gate passed at 2026-08-26T05:27:33.326Z with 104 closed windows and 95.34%
scoreable production-control coverage. The complete unavailable class was 527 rows without funded-provider contract
provenance at issuance; no row with that provenance lacked its eventual same-provider outcome. See
[`reports/forecast-candidate-phase2-100-window-coverage-review-2026-08-26.md`](../reports/forecast-candidate-phase2-100-window-coverage-review-2026-08-26.md).
The review changed no production version and did not activate Phase 3.

**Activation:** `forecast-candidate-registry-v1` began at 2026-08-25T03:17:17.456Z. Its first open window carried
the complete six-arm family on 8/8 issuance rows with maximum production replay error 0. This is activation wiring,
not the 10-window smoke milestone and not candidate-performance evidence.

## 5. Phase 3 — volatility and model-uncertainty inputs

### 5.1 Prospective inputs

Collect enough bounded information to reproduce, rather than infer later:

- the production equal-weight realized-volatility estimate;
- predeclared short and long exponentially weighted estimates;
- short/long volatility disagreement;
- largest standardized return and bounded jump diagnostics;
- exact settlement-window method and duration;
- observed-versus-unobserved settlement-window state;
- same-series reference/current identity;
- venue-oracle tracking difference when an authoritative comparable value exists;
- a content hash over any bounded raw return vector needed for exact replay.

Do not select an EWMA half-life, jump threshold, or oracle variance floor after viewing candidate outcomes. The
candidate family and multiple-comparison denominator are written before scoring.

### 5.2 Milestones

- **Input integrity:** 100 independent windows with exact content-hash replay and no non-finite model input.
- **Availability:** at least 95% of production-control windows have all required volatility inputs; oracle-specific
  measures report their own denominator and may not make the whole row appear complete.
- **Stability:** candidate calculations fit inside the offline/observation budget and add no funded-worker stall.
- **Phase exit:** 300 independent windows of complete predeclared volatility evidence. A written review may retire
  clearly broken models but may not select a production winner. Then Phase 4 may be approved.

With continuous collection, the nominal lower-bound calendar is again about 25 hours for integrity and 75 hours
for phase exit; source availability is the controlling caveat.

## 6. Phase 4 — evaluator v3

### 6.1 Required corrections

V3 must:

1. publish a content-addressed ordered cohort manifest so a cited run remains reproducible after later outcome
   patches or retention changes;
2. stamp the exact production forecast and buy-policy values;
3. regenerate each arm's selected side and funded-provider cost from both actionable asks;
4. run the shared base buy-policy semantics rather than hard-coded stale bounds, while holding production
   confirmation fixed and outside this base-signal comparison;
5. score every settlement timestamp, assigning zero to an arm that declines a position instead of dropping it;
6. report paired signal-policy return, Brier score, log loss, coverage, and contiguous drawdown;
7. show exact and unavailable cohorts separately;
8. perform one locked review rather than treating overlapping checkpoints as independent confirmation;
9. remain offline and mechanically promotion-ineligible until Phase 5 is complete.

The first provider-complete generation may be narrowed to the sole funded-capable provider. A future generation
with multiple funded providers must regenerate provider selection and funding feasibility rather than inheriting
that narrowing.

### 6.2 Milestones

- **Synthetic parity:** a grid proves the V3 production arm reaches the same side/qualify result as production for
  every tested input.
- **Historical diagnostic:** V3 may replay historical exact rows to find defects, but labels the result
  retrospective and non-promotable.
- **Prospective readiness:** at least 300 post-activation independent windows, 90% scoreable coverage, and 100
  windows where the locked candidate and production make materially different probability or entry decisions.
- **Phase exit:** immutable-manifest reproduction from a clean restore plus paired-metric review. V3 remains
  non-promotable; passing authorizes Phase 5 collection only.

Three hundred windows are nominally 75 hours, but the 100-divergence requirement is expected to control the
calendar and may take substantially longer.

## 7. Phase 5 — prospective simulated execution

Signal-policy return assumes an immediate ask fill and hold. It is not funded P&L. Phase 5 adds a separate lane
that gives both production and the locked candidate comparable public execution evidence without order authority.
Both probability arms pass through the same current production confirmation rule; changing confirmation here would
make the base-signal effect unidentifiable.

For each arm, commit the versioned production-persistence state, route decision, issuance quote, displayed depth/trades,
simulated maker or IOC result, fees, and terminal outcome. Missing public evidence produces `unavailable`, never a
manufactured fill or miss. Baseline and candidate simulations cannot read live fill outcomes.

### Milestones

- **Mirror parity:** first 25 opportunities where the production shadow matches production side, route, issuance
  quantity, and cap exactly; any mismatch blocks collection.
- **Evidence coverage:** at least 90% scoreable execution evidence over 100 independent eligible windows.
- **Divergence:** at least 100 independent windows where candidate and production differ in selection, route, or
  deployable result.
- **Phase exit:** at least 200 independent execution-scoreable windows, all generation identities exact, and no
  candidate import reachable from the live order graph. Then the one final review may be scheduled.

Two hundred windows are nominally 50 hours only if an execution opportunity exists every settlement timestamp;
in practice eligibility and divergence will make this a multi-day or multi-week milestone.

## 8. Phase 6 — one predeclared review

The review occurs once after all earlier gates pass. It reports, separately:

- signal-policy ask-and-hold return;
- simulated-execution return and coverage;
- paired Brier and log-loss differences;
- continuous drawdown;
- candidate-only, production-only, same-choice, and different-choice windows;
- exact-versus-unavailable cohorts;
- the complete family-wise multiple-comparison correction.

Minimum review population is the stricter of the prior milestones: at least 500 prospective independent signal
windows, 200 execution-scoreable windows, and 100 divergent windows. Promotion review additionally requires the
candidate's paired signal and execution return lower bounds to exceed production by the predeclared material
margin, Brier/log loss non-regression, positive continuous-return and cash views, and every existing safety and
promotion-integrity check. The material return margin remains 2 percentage points unless a later approved design
changes it before outcomes are inspected.

Reaching a date or count never changes production automatically. A successful review only makes a separate,
written, typed-confirmation manual promotion request permissible. A null result retires or continues the
candidate with equal documentation.

At a theoretical 15-minute cadence, 500 windows are about 125 hours. Coverage, opportunity frequency, divergence,
and untouched outcome resolution make one to several weeks the realistic planning range; these are planning
estimates, not evidence substitutes or delivery promises.

Phase 6 ends with an explicit handoff: either deploy and freeze the promoted base-signal version, or record that
production was retained. Confirmed-signal evidence cannot begin before that boundary because a changed base signal
changes which observations are eligible to confirm.

## 9. Phases 7–10 — confirmed-signal evaluation, in series

The approved next decision layer is
[`docs/confirmed-signal-evaluation-design.md`](confirmed-signal-evaluation-design.md). It starts only after the
Phase 6 base-signal handoff and does not collect concurrently with an unsettled probability/admission candidate.

### Phase 7 — engineering and exact-control parity

Implement the separate append-only observation lane and five frozen arms: exact production, provider-specific
production timing, provider-specific first-pass, provider-specific three-consecutive-over-30-seconds, and
provider-specific current-plus-one-of-the-prior-two. Exact provider contract, side, market, strategy, and outcome
identity are safety invariants; cross-provider evidence is diagnostic only.

**Exit:** pure-grid parity plus 25 live-runtime calculation observations (no orders) with zero exact-production
state or eligibility mismatch. This is an engineering gate and starts no economic clock.

### Phase 8 — prospective confirmation signal lane

Collect the complete family on every distinct fresh calculation. Hold the production base signal, 90-second
warm-up, final 30-second cutoff, freshness, fees, and all other policy values fixed.

**Milestones:** 10 independent windows for wiring, 100 closed windows with at least 95% exact-provider outcome
coverage, then 300 closed windows with at least 90% per-arm availability and at least 100 materially divergent
windows. Ten, 100, and 300 timestamps are nominally 2.5, 25, and 75 hours; divergence and outages extend them.

### Phase 9 — one locked confirmation execution shadow

After the corrected five-arm signal review, lock at most one confirmation candidate. Compare it with production
under equivalent public maker/IOC, fee, exit, and terminal evidence. Missing depth or trades are unavailable, not a
fill assumption.

**Exit:** 200 execution-scoreable windows, at least 90% public-evidence coverage, 100 divergent windows, exact
provider/outcome identity, and no candidate import reachable from the live order graph. Opportunity frequency is
expected to make this multi-day or multi-week.

### Phase 10 — one corrected confirmation review

Report signal and simulated-execution return separately; paired candidate-only, production-only, same-choice, and
different-choice windows; delay cost; unavailable classes; and the predeclared Holm correction across four
production comparisons. Counts only open manual review. A successful result permits a separate policy design and
manual promotion request; a null result is recorded and production remains unchanged.

## 10. Phases 11–14 — venue-candidate evaluation, in series

The approved third decision-layer plan is
[`docs/venue-candidate-evaluation-design.md`](venue-candidate-evaluation-design.md). It starts only after the
confirmed-signal final review freezes an exact-provider confirmation rule. It asks which venue checks actually
select a cohort and whether displayed value survives quote refresh, submitted limit, fill selection, fees, and
exit.

### Phase 11 — ownership, safety, and exact-control parity

Classify each current check as safety/mechanical feasibility, economic selection, capital/portfolio, execution
lifecycle, live authorization, or diagnostic. Strengthen the observation contract around exact provider variant,
contract provenance, side, close, quote time, lattice, and same-provider outcome. Record—not yet change—misplaced
ownership such as sizing, cash, cooldown, route, and portfolio state.

**Exit:** fault grid plus 25 live-runtime calculation observations with zero production identity, candidate-build,
or rejection mismatch. No economic clock starts before parity.

### Phase 12 — current-rule attribution and implementation shortfall

Prospectively record every exact-provider confirmed signal through construction quote, exact pre-submit quote,
submitted limit, public simulated or authoritative fill/no-fill, fees, exit, and terminal outcome. Attribute every
current refusal, all simultaneous reasons, duplicate gates, unavailable evidence, and disagreement with later live
authorization.

**Milestones:** 10-window wiring; 100 closed windows with at least 95% exact-provider coverage; then 300 closed
windows and 100 windows where a current economic selector independently changes a candidate, or a written finding
that the selector is inert/insufficiently active. This diagnostic cohort may select a hypothesis and may never
promote the threshold selected from it.

### Phase 13 — focused prospective venue family

After the attribution report, write an amendment freezing a small new-outcome family. Candidate areas may include
the 10-cent economic spread ceiling, route-specific spread, or explicit quote-age/implementation-shortfall rules;
none is preselected by this roadmap. Sizing and future multi-provider ranking remain separate families.

**Exit:** a new prospective cohort with 300 closed signal windows, 90% per-arm availability, 100 materially
divergent windows, then 200 execution-scoreable windows with 90% public-evidence coverage and 100 divergent
windows. Signal and execution results remain separate.

### Phase 14 — one corrected venue review

Report displayed, construction, pre-submit, submitted, and deployable value without smoothing their disagreement;
apply the predeclared family-wise correction; and record inert, misplaced, null, or positive findings equally. A
successful result permits only a separate ownership/policy design and manual promotion request. Phase 14 ends by
freezing the retained or promoted exact venue-candidate definition before portfolio evidence begins.

## 11. Phases 15–18 — portfolio-selection evaluation, in series

The approved fourth decision-layer plan is
[`docs/portfolio-selection-evaluation-design.md`](portfolio-selection-evaluation-design.md). It starts only after
the venue-candidate final review. The existing issued-order `portfolio-choice-set-v1` lane continues as an
integrity sentinel; it does not record no-order calculations and cannot become evidence for a later ranking family.

### Phase 15 — full-cycle ownership and exact-control parity

Classify hard exposure ceilings as safety/risk controls, ranking and penalties as economic selectors, and exact
optimization, side/size-aware exposure, downstream skips, and capacity opportunity cost as diagnostics. Add a
separate observation-only record for every fresh calculation where an exact venue candidate reaches portfolio
consideration, including no-order results and complete later-gate state.

**Exit:** fault/tie/boundary grid plus 25 live-runtime portfolio calculations with zero production score, rank,
selected-set, or reason mismatch; then 10-window wiring and 100 closed windows with at least 95% complete
portfolio-decision/outcome coverage and complete issued-intent ledger coverage.

### Phase 16 — stated-objective and orchestration attribution

Compare production greedy selection with exhaustive subset optimization under production's exact objective,
eligibility-before-selection reconstruction, reranking after a downstream skip, and a hard-ceiling-only diagnostic.
All alternatives use only state available at the calculation; hindsight best-of-window remains an upper-bound
diagnostic. Measure effective-cap and penalty bind rates, redundant controls, objective gaps, and viable candidates
left unused after provisional winners disappear.

**Exit:** 300 closed windows and at least 100 windows with an exact-solver, eligibility-order, downstream-rerank,
or independently binding-selector difference, or a written inert/insufficient-activity finding. This cohort may
select a later hypothesis and may never promote it.

### Phase 17 — focused stateful portfolio family

After the attribution report, write an amendment freezing at most one small family. Candidate areas may include
exact versus greedy optimization, eligibility ordering/reranking, independently active soft penalties, side/size-
aware exposure, or a causal capacity-reservation price; none is selected by this roadmap. Hold upstream signals,
venue candidacy, sizing, routes, fees, exits, and authorization fixed.

Every arm maintains its own causal shadow positions and capacity from a common initial state; it cannot reuse
production exposure after choices diverge. Keep ask-and-hold signal return separate from public-evidence simulated
execution and fill/no-fill state.

**Exit:** a new cohort with 300 closed signal windows, 90% per-arm availability, and 100 materially divergent
windows, then 200 execution-scoreable windows with 90% public-evidence coverage and 100 divergent windows.

### Phase 18 — one corrected portfolio review

Score every position with zero for an omitted candidate and cluster by UTC settlement timestamp. Report signal and
deployable return, capacity utilization, no-order rescue, occupied stake, cash return, continuous drawdown,
exact/unavailable cohorts, and the predeclared family-wise correction. A successful result permits only a separate
policy/ownership request. Loosening a hard exposure ceiling additionally requires its own capital and downside
approval; this review cannot authorize it. Phase 18 ends by freezing the retained or promoted portfolio definition
before live-authorization evidence begins.

## 12. Phases 19–22 — live-authorization evaluation, in series

The approved fifth decision-layer plan is
[`docs/live-authorization-evaluation-design.md`](live-authorization-evaluation-design.md). It starts only after the
portfolio final review. Existing `live-skip-v1` remains a first-blocker episode journal; it cannot prove simultaneous
authority or supply candidate evidence for a later authorization generation.

### Phase 19 — complete manifest and exact-control parity

Classify environment/operator/capability/reconciliation/identity/wire checks as safety authority, funding and loss
limits as capital/risk ceilings, late regime/persistence/route checks as economic or lifecycle ownership, and all
simultaneous results plus clocks/revisions as diagnostics. Add one detached manifest for every portfolio-selected
exact candidate, including no-intent outcomes.

**Exit:** pure boundary/fault grid plus 25 live-runtime portfolio-selected calculations with zero first-blocker,
authority-vector, order-term, reservation, or disposition mismatch; then 10-window wiring and 100 closed windows
with 95% complete authority/outcome coverage and 100% durable-intent/reservation coverage.

### Phase 20 — fault, concurrency, and current-rule attribution

Fault-test pause, kill, reconciliation fences, stale READY state, provider/budget revision, strategy funding,
duplicate identity, malformed wire terms, lost responses, crash boundaries, partial/overfill, cancellation, and
guarded recovery. Record every simultaneous blocker, effective limit, authority age, ownership seam, and availability
cost without relaxing production.

**Exit:** every declared fault passes plus at least 1,000 deterministic seeded schedules across each critical
pause/reconciliation/reservation race; then 300 closed windows and 100 windows where an authority independently
blocks or differs from first-blocker reporting, or a written inert/insufficient-activity finding. This cohort may
identify one fail-closed repair and cannot promote a loosening.

### Phase 21 — one focused authorization generation

After the attribution report, write an amendment freezing at most one generation: one proven fail-closed repair,
authorization fencing generation, bounded reconciliation-readiness lease, strategy-funding ownership correction,
or exact production control when no repair is justified. Capital-ceiling, economic-policy, and execution-style
changes remain separate programs.

**Exit:** a new cohort with 300 closed windows, 100 portfolio-selected authorization opportunities, 95% complete
manifests, 100% issued-intent/reservation coverage, the complete fault matrix, and seven continuous days at the
configured reconciliation cadence without an unexplained authority gap.

### Phase 22 — one final authorization review

Report fault correctness, complete-manifest coverage, simultaneous/first blockers, authority age, cash/reservation/
allocation agreement, pause/drain/suspension/recovery transitions, and availability separately. A safety repair
succeeds by closing its fault, not by increasing return. A successful result permits only a separate versioned
ownership/rollout request; no capital or authority loosening is authorized. Freeze the retained or separately
repaired authorization generation before attempt/outcome evidence begins.

## 13. Phases 23–26 — attempt-and-outcome evaluation, in series

The approved final decision-layer plan is
[`docs/attempt-outcome-evaluation-design.md`](attempt-outcome-evaluation-design.md). It starts only after the
live-authorization final review. Existing order rows, execution observations, budget audits, and reconciliation
audits remain authoritative for their current fields; a new detached lifecycle projection does not replace the
shared order or money ledger.

### Phase 23 — normalized lifecycle and exact-control parity

Project current behavior into orthogonal intent, venue-order, position, and cash states. Type reservation refusal,
pre-submit refusal, post-only create rejection, accepted maker/IOC zero-fill, partial/full fill, uncertainty,
recovery, sale, settlement, and invalidity without inferring a prospective state from mutable prose. Append detached
transition evidence keyed by exact order, provider contract, budget, and reconciliation identity.

**Exit:** pure valid/impossible-state grid plus 25 terminal live-runtime controls with zero state, disposition,
identity, quantity, or money mismatch; then 10 closed authorized-intent timestamps for wiring and 100 closed
authorized-intent timestamps with at least 95% diagnostic-transition coverage and 100% coverage of every applicable
accepted-order, fill, reservation, release, position, and settlement event.

### Phase 24 — fault, recovery, accounting, and current attribution

Fault every boundary from durable intent through reservation, submission, acceptance, fill, cancellation,
reconciliation, exit, and settlement. Include response loss, delayed visibility, duplicate/out-of-order/partial/
over fills, amendment chains, cancellation races, ownership collisions, exact money edges, invalid/delayed outcomes,
and process crashes. Report the complete funnel and intent-to-treat economics without changing production.

**Exit:** every declared fault passes plus at least 1,000 deterministic seeded schedules per critical submit/
accept/fill/cancel/reconcile/settle race; then 300 closed authorized-intent timestamps and 100 windows with a
nontrivial refusal, rejection, accepted zero-fill, partial fill, uncertainty/recovery, or early exit—or a written
insufficient-activity finding. Exact and whole-cent views must each tie independently.

### Phase 25 — one focused lifecycle generation

After attribution, write an amendment freezing at most one mutually exclusive generation: one lifecycle/provenance,
recovery/ownership/cancellation/settlement, or accounting repair; one focused post-authorization economic management
family; or exact production control if no change is justified. A repair uses invariant and fault evidence. An
economic family uses independent causal shadow management and complete intent-to-treat scoring; it cannot read the
production fill to choose its path.

**Exit for safety/accounting:** a new 300-window authorized-intent cohort, 95% complete diagnostics, 100% critical
ownership/money coverage, repeated targeted fault/seeded-race gates, and seven continuous days without an
unexplained lifecycle/accounting gap. **Exit for economics:** a new 300-window authorized-intent cohort with 100
materially divergent windows, then 200 execution-scoreable windows with 90% required public-evidence coverage and
100 divergent windows. Only one exit path applies.

### Phase 26 — one final attempt-and-outcome review

Report lifecycle completeness, ownership/recovery correctness, exact and whole-cent account ties, stage-specific
latency, partial/full/no-fill cohorts, implementation shortfall, fill selection, complete intent-to-treat return,
legacy/unavailable evidence, and rollback. A safety/accounting repair succeeds by closing its fault; an economic
family must clear its predeclared paired execution and downside tests. Any production schema, lifecycle, retry,
management, reconciliation, settlement, or accounting change remains a separate manual proposal.

## 13A. Parallel paper-execution fidelity workstream

The approved execution-simulator plan is
[`docs/paper-execution-fidelity-v2-design.md`](paper-execution-fidelity-v2-design.md). It is not Phase 27 and does
not follow or bypass the serial opportunity-decision layers. Its purpose is to make later public execution evidence
a better independent approximation of live while preserving the mirror invariant and paper accounting.

| Fidelity stage | Gate | Advancement |
| --- | --- | --- |
| F1 — exact-control parity | queue-reset grid, explicit-neutral versus absent-calibration simulation equality, corrected lifecycle denominators, typecheck/tests | permits an F2 implementation proposal only |
| F2 — timing shadows | 300 exact maker-pair windows, 30 live create races, 95% coverage, no request/latency effect | freezes retained acceptance and final-evidence mechanics |
| F3 — accepted-order queue family | 300 accepted-maker windows, 90% per-arm availability, 100 divergent windows, declared correction | locks at most one queue candidate |
| F4 — combined held-out generation | 300 exact-pair windows, 100 divergent outcomes, accounting ties, fidelity/non-regression and isolation gates | permits a separate manual paper-generation adoption request or a recorded null |

F1 changes no result under the active neutral calibration. F2–F4 are detached shadows until a separate manual
adoption. Two-second ordinary management remains fixed; only create/acknowledgement receives sub-second study, and
a read-after-horizon grace may recover event-time-bounded evidence without extending the 12-second order horizon.
If this workstream is still unsettled when Base Phase 5 becomes otherwise ready, Phase 5 must either freeze and cite
the retained v6 control for its whole cohort or wait; it may not blend paper execution generations.

## 14. Overall serial timeline

| Serial stage | Earliest evidence gate | Planning duration after activation | Advancement |
| --- | --- | --- | --- |
| Base Phase 2 — current six-arm collection | 300 closed windows, 90% per-arm availability | About 75 hours; nominally around 2026-08-28T06:15Z from the current activation | Written review may authorize base Phase 3 only |
| Base Phase 3 — uncertainty inputs | 300 complete windows | At least another 75 hours | Written input review may authorize V3 |
| Base Phase 4 — immutable V3 signal lane | 300 windows plus 100 divergent | At least 75 hours; divergence likely controls | Authorizes execution shadow only |
| Base Phase 5 — execution shadow | 200 scoreable plus 100 divergent | Multi-day to multi-week | Authorizes one base review |
| Base Phase 6 — final base review | 500 signal, 200 execution, 100 divergent | One to several weeks overall | Freeze promoted or retained base version |
| Confirmation Phase 7 — engineering | Grid plus 25 exact-control observations | Engineering-dependent | Starts confirmation evidence only after parity |
| Confirmation Phase 8 — five-arm signal lane | 300 closed plus 100 divergent | At least 75 hours; divergence may control | Lock at most one candidate |
| Confirmation Phase 9 — execution shadow | 200 scoreable plus 100 divergent | Multi-day to multi-week | Authorizes one confirmation review |
| Confirmation Phase 10 — final review | Both lanes and Holm correction complete | Manual, once | Freeze promoted or retained confirmation |
| Venue Phase 11 — ownership/safety parity | Fault grid plus 25 exact-control observations | Engineering-dependent | Starts attribution only after parity |
| Venue Phase 12 — current-rule attribution | 300 closed plus 100 selector-changing, or documented inertness | At least 75 hours; selector frequency may dominate | Freezes at most one new-outcome family |
| Venue Phase 13 — focused family | 300 signal, 200 execution, and 100 divergent | At least 75 hours plus multi-day/week execution | Authorizes one venue review |
| Venue Phase 14 — final review | Both lanes and declared correction complete | Manual, once | Freeze retained/promoted venue definition; separate request or null |
| Portfolio Phase 15 — full-cycle parity/coverage | Grid plus 25 exact-control observations; then 100 closed at 95% coverage | Engineering-dependent plus at least 25 hours | Starts objective attribution only after parity/coverage |
| Portfolio Phase 16 — objective/orchestration attribution | 300 closed plus 100 selector/solver/rerank differences, or documented inertness | At least 75 hours; divergence may control | Freezes at most one new-outcome family |
| Portfolio Phase 17 — stateful focused family | 300 signal, 200 execution, and 100 divergent | At least 75 hours plus multi-day/week execution | Authorizes one portfolio review |
| Portfolio Phase 18 — final review | Both lanes, cash/downside checks, and declared correction complete | Manual, once | Freeze retained/promoted portfolio definition; separate request or null |
| Authorization Phase 19 — manifest parity/coverage | Grid plus 25 exact controls; then 100 closed at 95% coverage and 100% intent/reservation coverage | Engineering-dependent plus at least 25 hours | Starts fault/attribution only after parity |
| Authorization Phase 20 — fault/current attribution | Complete fault matrix and seeded races; 300 closed plus 100 authority differences or documented inertness | Engineering-dependent plus at least 75 hours | Freezes at most one fail-closed generation |
| Authorization Phase 21 — focused generation | 300 closed, 100 authorization opportunities, complete intent coverage, and seven continuous cadence days | At least seven days; opportunity frequency may extend it | Authorizes one reliability review |
| Authorization Phase 22 — final review | Fault, manifest, cash/reservation, recovery, availability, and rollback checks complete | Manual, once | Freeze retained/repaired authorization; separate request or null |
| Attempt Phase 23 — lifecycle parity/coverage | Grid plus 25 terminal controls; then 100 closed authorized-intent windows at 95% diagnostic and 100% critical money/ownership coverage | Engineering-dependent; authorized-intent frequency controls | Starts fault/attribution only after parity |
| Attempt Phase 24 — fault/current attribution | Complete fault matrix and seeded races; 300 closed authorized-intent windows plus 100 nontrivial paths or documented insufficient activity | Engineering-dependent plus multi-day/week collection | Freezes at most one focused lifecycle generation |
| Attempt Phase 25 — focused generation | Safety/accounting: 300 closed, complete critical coverage, repeated faults, seven continuous days; economic: 300 closed/100 divergent plus 200 scoreable/100 divergent | At least seven days or multi-day to multi-week, by selected class | Authorizes one final lifecycle review |
| Attempt Phase 26 — final review | Lifecycle, account tie, intent-to-treat, correction/downside, availability, and rollback checks complete | Manual, once | Separate versioned implementation request or documented null |

Only the current Base Phase 2 row has a calendar estimate. Later rows begin after the preceding written gate and
engineering activation, so their durations may not be added to claim a delivery date. Under uninterrupted data and
immediate approvals the arithmetic lower bound is measured in weeks, not days; realistic divergence and execution
coverage can extend it further. The confirmation clock explicitly does **not** start at the current three-day
base-signal checkpoint, the venue clock does not start until confirmation's final retained/promoted handoff, and
the portfolio clock does not start until venue candidacy is frozen. The authorization clock does not start until
portfolio selection is frozen, and the attempt/outcome clock does not start until authorization is frozen.

## 15. Storage and operational design

### 15.1 Phase 2 activation schema

Phase 2 uses the existing forecast history as its owning store rather than adding a second journal with duplicate
observation and contract identities. `candidateEvaluation` is written once inside the forecast's issuance `upsert`:

- registry, production-model, provider-registry, and buy-policy versions;
- the active maximum-edge and DOWN-control values;
- production confidence inherited by this probability-only family;
- all six available/unavailable candidate decisions, their probabilities, funded-capable best quote, admitted
  entry, fee-aware edge, and exact shared-policy qualification result.

The existing forecast journal is append-only, its owning compactor alone seals or truncates it, and the local-data
archive already includes it. Existing idempotent resolution patches add venue-specific outcomes without changing
`candidateEvaluation`; consequently decision and outcome remain temporally separate even though they share one
forecast identity. No schema migration or history rewrite occurs, and rows written before activation remain
explicitly absent from the prospective cohort.

This choice avoids a second writer, queue, compactor, resolver, archive tier, and contract-provenance copy on the
15-second collector path. It also means Phase 2 evidence follows the forecast history retention policy. Phase 4
must therefore freeze its selected ordered rows and checksums into its own immutable run manifest before citing a
cohort.

Candidate calculation is synchronous and CPU-bounded before the one existing forecast append. The funded decision
and order modules are protected by an isolation invariant and contain no candidate import or `candidateEvaluation`
read. A candidate calculation failure fails the advisory forecast append; it cannot alter the already-built
production prediction, and forecast persistence remains advisory to execution as before.

### 15.2 Phase 3 and later additions

Before raw volatility vectors, V3 manifests, or later layer journals activate:

- bounded feature vectors are content-addressed and referenced rather than duplicated per candidate;
- a V3 run manifest includes ordered forecast/content identities and checksums;
- the full-cycle portfolio generation is separate from immutable `portfolio-choice-set-v1`, records no-order
  calculations explicitly, and has one owning append/compaction path;
- portfolio shadow arms keep independent causal state and never write the production exposure, ledger, or budget;
- authorization manifests store no secret material, remain detached, and cannot be read by control, budget,
  reconciliation, policy, or order paths;
- attempt/outcome transition evidence references authoritative ledger revisions and venue identities but never
  becomes a second order, position, reservation, settlement, or cash ledger;
- normalized lifecycle corrections append a superseding observation, preserve explicit gaps, and cannot be read by
  order management, retry, exit, budget, reconciliation, settlement, or policy paths;
- stateless hosts expose no writer and never evaluate;
- archive manifests include every new durable tier before activation.

No candidate store may share a budget or order authority with the funded ledger. Observation absence is explicit;
it never authorizes a production action.

## 16. Validation and documentation

Every phase requires typecheck and the full test suite. A phase touching the Next.js runtime also requires a
production build before activation. Structural activation updates `STATUS.md`; a changed production decision
updates `SPEC.md`, its decision log, the model version, and immutable promotion history together. Analysis reports
state date, independent-window count, exclusions, correction, exact-versus-unavailable coverage, and the caveat
that most threatens the result.
