# Forecast model boundary and evaluator v3 design

> **Status:** Phase 1 implemented on 2026-08-24. Phase 2 prospective collection activated locally at
> 2026-08-25T03:17:17.456Z. Later phases are approved as an ordered research plan, but each remains
> observation-only and must clear its milestone review before the next phase is activated. This design changes no
> production forecast, buy policy, execution, capital, or live authority by itself.

## 1. Decision

The current contract-basis forecast is a useful production control, but its implementation is assembled inside
`buildPrediction` while candidate replay reconstructs part of the same calculation elsewhere. That makes a
candidate easy to score under a formula, side, venue, cost, or policy that production did not actually use. The
monitoring-only evaluator v2 has exhibited all of those failures and cannot support promotion.

Implement the base-signal improvement plan in six gated phases, then evaluate the confirmed-signal layer in four
strictly serial phases:

1. extract one pure, versioned forecast-model boundary while proving production equivalence;
2. commit prospective candidate outputs with no order authority;
3. collect reproducible volatility, jump, settlement, and oracle-uncertainty inputs;
4. implement immutable, policy-complete evaluator v3 for the base buy decision;
5. add a separate prospective simulated-execution lane while holding production confirmation fixed;
6. perform one predeclared base-signal review after both evidence lanes mature;
7. implement and parity-test the exact-provider five-arm confirmation family;
8. collect its prospective signal lane;
9. shadow-execute at most one locked confirmation candidate;
10. perform one corrected confirmation review.

No phase automatically starts the next, changes production, or grants promotion eligibility. Evaluator v2 remains
monitoring-only history and is never rewritten into v3 evidence.

## 2. Boundaries

- The production probability remains venue-independent. Event-contract prices are costs and benchmarks, not
  forecast inputs.
- The shared buy-policy mirror remains unchanged: paper and live receive the same production probability and pure
  entry decision.
- Candidate definitions and evidence have no imports into forecast selection, persistence, sizing, portfolio,
  routing, budgets, reconciliation, or orders.
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

## 10. Overall serial timeline

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
| Confirmation Phase 10 — final review | Both lanes and Holm correction complete | Manual, once | Separate promotion request or documented null |

Only the current Base Phase 2 row has a calendar estimate. Later rows begin after the preceding written gate and
engineering activation, so their durations may not be added to claim a delivery date. Under uninterrupted data and
immediate approvals the arithmetic lower bound is measured in weeks, not days; realistic divergence and execution
coverage can extend it further. The confirmation clock explicitly does **not** start at the current three-day
base-signal checkpoint.

## 11. Storage and operational design

### 11.1 Phase 2 activation schema

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

### 11.2 Phase 3 and later additions

Before raw volatility vectors or V3 manifests activate:

- bounded feature vectors are content-addressed and referenced rather than duplicated per candidate;
- a V3 run manifest includes ordered forecast/content identities and checksums;
- stateless hosts expose no writer and never evaluate;
- archive manifests include every new durable tier before activation.

No candidate store may share a budget or order authority with the funded ledger. Observation absence is explicit;
it never authorizes a production action.

## 12. Validation and documentation

Every phase requires typecheck and the full test suite. A phase touching the Next.js runtime also requires a
production build before activation. Structural activation updates `STATUS.md`; a changed production decision
updates `SPEC.md`, its decision log, the model version, and immutable promotion history together. Analysis reports
state date, independent-window count, exclusions, correction, exact-versus-unavailable coverage, and the caveat
that most threatens the result.
