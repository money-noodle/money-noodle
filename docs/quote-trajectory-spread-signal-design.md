# Quote trajectory and spread signal collection

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-20
> **Canonical requirements:** [`spec/forecasting-and-evidence.md`](../spec/forecasting-and-evidence.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260820-10`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> Status: **approved collection-only implementation**, 2026-08-20. Collection begins when a built runtime
> containing this generation starts; no funded behavior is authorized by this document. A later candidate
> design must predeclare its rule and evidence bar before any collected feature can affect selection,
> gating, or promotion.

## 1. Decision and question

Collect two prospective market-state signals without changing the forecast or either trading lane:

1. whether the underlying and the venue contract are moving up or down, and how consistently; and
2. whether the executable selected-side spread is widening or narrowing, and how consistently.

The first generation is observation only. It adds no request, scheduler, fast watch, order, budget,
selection weight, gate, sizing rule, execution rule, exit rule, or promotion path. It records continuous
features at calculation and entry-decision time so later screening does not have to infer what the desk saw.

The intended progression is deliberately split:

1. collect continuous features prospectively;
2. screen named formulations with their multiple-comparison denominator stated;
3. choose one exact ranking or restrictive-gate candidate;
4. write a separate candidate design fixing its horizon, threshold, population, counterfactual, exits,
   review bar, and deciding statistic;
5. begin immutable first-to-fire sentinel collection only after that commitment; and
6. permit only a manual, versioned policy promotion under `spec/policy-and-track-separation.md` §12.5.

Collection is not a policy candidate and can never make itself promotable.

## 2. Three meanings of direction remain separate

“Direction” is ambiguous unless its price series and orientation are named. V1 retains three distinct
quantities rather than smoothing them into one label.

### 2.1 Underlying direction

The Kraken contract-basis series moves up when the underlying spot price rises. This is provider-independent
forecast context. `cycle-path-store` already records the path and `cycle-regime` already computes absolute
`trendEfficiency`; v1 adds the sign and endpoint move without changing the forecast.

### 2.2 Venue-contract direction

A contract side moves up when that side's own executable midpoint rises. For an UP candidate this generally
agrees with a rising underlying; for a DOWN candidate the same underlying move is adverse. V1 records the
canonical underlying move and the selected-side venue move separately. A later candidate may derive
“aligned with selected side” by negating the underlying value for DOWN, but the durable observation does not
replace the canonical fact with that interpretation.

### 2.3 Exact execution direction

`entry-direction-observation-v1` measures issuance ask to exact pre-submit ask and the first unfilled
management movement. It answers an execution-timing question over seconds. V1 does not replace, pool, or
reinterpret it. The new trailing and cycle features describe the path before the decision; the existing
observation describes what happened after issuance entered the execution path.

A report must always say which of these three it means.

## 3. Existing inputs and request boundary

The required public data is already fetched:

- `recordCyclePathObservations` retains the Kraken cycle path;
- Kalshi and Polymarket dashboard quotes already carry side-specific bid and ask terms;
- `recordVenueHistory` retains a short rolling quote history; and
- `recordContractPaths` retains both Kalshi asks on every active contract, with recent eligible contracts
  sampled from the existing two-second long-shot watch.

No new poller is allowed. The standalone fine-path attempt already demonstrated why: a second process
competed with the funded desk's account-wide venue request budget and rate-limited it within thirty seconds.
V1 may only retain and derive from responses an existing task already obtained.

The ordinary calculation path is the common policy observation clock. The conditional two-second path may
support retrospective diagnostics, but no entry candidate may silently depend on it: its availability is
conditional on a separate strategy and would make the shared edge decision depend on whether that strategy
happened to be watching. Exact pre-submit movement remains in the execution observation described above.

## 4. Source-time identity and freshness

A dashboard timestamp is not proof that a quote was freshly fetched. `cached` can return a prior value after
an upstream failure, and stamping that value with the current calculation time would manufacture a flat
trajectory and narrow its apparent gaps.

V1 therefore carries a source capture timestamp from feed ingest through the rolling history and feature
snapshot:

- cache hits preserve the timestamp of the response that produced the value;
- repeated cached values with the same source timestamp replace or deduplicate; they never become new path
  samples;
- samples are keyed by provider, exact contract id, close time, side, and source timestamp;
- changing contract id or close time resets the path; one settlement window never supplies another;
- the latest source point must be no older than `DATA_FRESHNESS.observationBucketMs` at calculation time;
  otherwise the feature is unavailable, not stale-but-usable; and
- malformed, crossed, non-finite, future-dated, or out-of-range prices make that provider/side feature
  unavailable.

Each horizon uses only the contiguous suffix after the most recent gap greater than two ordinary observation
buckets. This lets collection recover after an outage without bridging it as though the unobserved interval
were a monotone move. Every snapshot retains source start/end times, sample count, coverage, and maximum gap
so later evidence can distinguish a value from its observation quality.

Historical contract paths keep their historical timing meaning. They are useful for screening and coverage
checks but are not relabelled as source-timestamped committed evidence.

## 5. Pure feature definition

The pure feature module operates on time-ordered finite observations and has no forecast, policy, store,
execution-mode, budget, or order dependency.

For values `x[0] ... x[n-1]`:

```text
net change        = x[n-1] - x[0]
path distance     = sum(abs(x[i] - x[i-1]))
signed efficiency = net change / path distance
```

Signed efficiency lies in `[-1, 1]`. Positive means upward, negative means downward, and magnitude describes
how directly the path travelled. If fewer than two usable values exist or path distance is zero within the
price tolerance, efficiency is `null`, not zero. A flat observed path and unavailable directional
information are not the same fact.

V1 computes two declared observation horizons:

| horizon | purpose |
| --- | --- |
| trailing 60 seconds | local quote/underlying movement before an entry decision |
| cycle-to-date contiguous path | broad state since the current 15-minute contract opened, reset after an observation gap |

A usable directional value requires at least four unique source observations spanning at least 45 seconds.
The exact observed coverage is retained; no sample is invented to reach the boundary. These two horizons are
two formulations for any later screening and must be counted as such. A later candidate chooses exactly one
before its sentinel begins.

### 5.1 Underlying fields

For each horizon:

- source start and end timestamps;
- sample count, coverage seconds, and maximum gap seconds;
- start and end Kraken price;
- net change percent from the first observed price;
- path distance percent on the same first-price denominator; and
- signed trend efficiency.

The existing absolute `trendEfficiency`, regime label, sign-flip rate, autocorrelation, range, and volatility
remain unchanged. No existing historical value is rewritten.

### 5.2 Provider/side quote fields

For each provider, exact contract, side, and horizon:

- start and end executable midpoint, in probability units;
- midpoint net change in cents;
- midpoint path distance in cents;
- midpoint signed trend efficiency;
- start and end executable spread;
- spread net change in cents;
- spread path distance in cents; and
- spread signed efficiency.

At each sample:

```text
midpoint = (bid + ask) / 2
spread   = ask - bid
```

The calculation uses the provider's observed bid and ask for the named side. It does not infer a generic
venue probability, blend providers, or assume that another provider's binary book has Kalshi's complement
mechanics. When both UP and DOWN books are available, both are retained and any disagreement remains visible.
A selected entry stamps only its exact provider/side slice plus the canonical underlying slice.

A positive midpoint efficiency means the named side is trending more expensive. A positive spread
efficiency means its spread is widening; a negative value means narrowing. The continuous values are the
evidence. Human labels such as `trending up`, `trending down`, `widening`, and `narrowing` are display
derivations only and cannot become gates without a later versioned threshold.

## 6. Observation schema and persistence

Observation version: `quote-trajectory-spread-observation-v1`.

**Additive extension approved 2026-08-20:** new observations use
`quote-trajectory-spread-observation-v2`, retaining both v1 horizons and adding the eight-window
decision grid defined by `docs/edge-window-consensus-evaluation-design.md` §2. V1 rows remain readable and
are never backfilled. New order writes place the v2 observation once on the owning `PaperOrder` rather than
duplicating it inside `EntryDecisionSnapshot`; the exact decision semantics remain unchanged.

The conceptual snapshot contains:

- version and calculation timestamp;
- exact provider, contract id, side, and close time;
- source timestamps and coverage metadata;
- trailing-60-second and cycle-to-date underlying features; and
- trailing-60-second and cycle-to-date provider/side midpoint and spread features.

Missing remains missing. A restart, source outage, new contract, insufficient path, or legacy row produces an
absent feature with an explicit availability reason where displayed; it never becomes a zero move.

V1 uses three persistence levels:

1. **Rolling source history.** A bounded normalized quote-path cache keeps slightly more than one contract
   duration, deduplicated by source timestamp. It is calculation input, not evidence authority.
2. **Forecast observation.** Every newly persisted production-qualified `TrackedForecast` may carry the
   exact current `bestEntry` provider/side snapshot. This is prospective screening evidence joined later to
   exact settlement. Unqualified-history pruning and legacy rows remain unchanged, so this cannot support a
   future loosening of the base buy rule without a separately designed collection population.
3. **Entry decision.** A new edge order copies the same provider/side snapshot into its immutable
   `EntryDecisionSnapshot`. This ties actual execution and exit results to what was known at issuance, but
   order-only evidence must never be presented as an unbiased signal population because maker fills,
   capital, and portfolio selection are selective.

The complete all-market raw paths remain in their existing observation stores and retention regimes. V1 does
not create another permanent per-tick journal duplicating them. A later committed candidate receives its own
non-pruned append-only sentinel store because promotion evidence must survive raw-path retention and must
record the candidate decision at the time it differs.

Before implementation, the added qualified-row size must be measured against the current sharded forecast
layout. The durable snapshot should avoid redundant display labels and recomputable aliases; storage growth
is not a reason to drop source identity, coverage, or continuous values.

## 7. Policy, model, and mirror boundaries

V1 is venue context, not a forecast factor:

- it cannot enter `modelProbabilityUp`, confidence, calibration replay, or any generated text;
- it cannot change `bestEntry`, `edgeStrength`, `selectPortfolio`, persistence, regime admission, execution
  style, price caps, sizing, exits, or reconciliation;
- `prediction-policy` and money-moving modules may not import an observation store or report;
- the first implementation adds an observation-only dependency test analogous to the existing entry-decision
  observation guard; and
- public/stateless projection may omit the feature and never gains a durable writer.

A future production rule must consume the pure feature value through a versioned policy definition, never by
reading historical storage. The evaluator takes no execution mode, so a promoted entry rule applies
identically to paper and live under the mirror invariant. Provider and market capability still fail closed;
a signal observed on one provider or market unlocks nothing on another.

## 8. Screening discipline

The first read is retrospective screening even though the fields were captured prospectively. It may reject
an idea and nominate a committed candidate; it cannot promote one.

A screening report must:

1. state its read time, policy versions, source coverage, exclusions, and unresolved rows;
2. use the first-to-fire production-qualified decision per `(symbol, side, contract window)` rather than
   repeated updates as independent bets;
3. score every position and cluster uncertainty by `closesAt` across correlated assets;
4. report trailing-60-second and cycle-to-date looks as separate formulations;
5. report underlying direction, selected-side midpoint direction, spread direction, and any combination as
   separate comparisons;
6. compare gating and ranking formulations separately—the former can decline an entry, while the latter
   changes which simultaneous candidate wins;
7. report ask-priced held-to-settlement return beside maker-executable and actual-exit return, never using one
   as a substitute for another;
8. keep live and paper execution results separate because their shared signals are not independent
   confirmation; and
9. state the complete number of thresholds, horizons, combinations, bands, and subgroup looks attempted.

Thresholds are not chosen in this document. Choosing “positive”, “strong trend”, or “material widening” from
the best historical bin creates a screened candidate, not evidence for that threshold.

## 9. Candidate and sentinel phase

Selection and gating answer different counterfactuals and require separate candidate generations.

### 9.1 Restrictive gate candidate

A gate sentinel records every first-to-fire decision that clears the production rule before the proposed
trajectory/spread restriction. It stamps the continuous feature, exact rule result, bid, ask, fee, edge,
contract, side, policy identities, and later exact outcome. Candidate refusal earns zero; candidate admission
uses the same signal-policy outcome as production. Order linkage is reported separately so actual maker fills
and exits do not select the signal cohort.

### 9.2 Ranking candidate

A ranking sentinel records the complete production-feasible choice set at the decision boundary, the
production winner, and the candidate winner under one predeclared scoring formula. Every alternative receives
exact quote terms and settlement. It must score the candidate on every choice set, not only windows where the
new ranking differs or where its alternative later wins.

`portfolio-choice-set-v1` retains production's own ranking and explicitly predeclares no alternative formula;
its meaning is not changed in place. A trajectory/spread ranker starts a new named candidate generation.
Actual live fills for an unissued alternative are unknowable. Any maker-executable comparison must use a
separately identified prospective queue simulation based on observed trade prints, never an ask touch or an
assumed fill.

### 9.3 Candidate commitment

Before either store starts, its design must lock:

- one horizon and exact continuous formula;
- every threshold and tie rule;
- gate versus ranking role;
- first-to-fire population and policy-version scope;
- treatment of insufficient or stale features, which must fail closed;
- production comparator including current exits;
- signal-policy and executable-return measures;
- minimum independent windows and minimum differing windows;
- clustered deciding threshold and drawdown/coverage checks; and
- correction for every candidate in the declared family.

No historical row is backfilled into committed evidence.

## 10. Promotion boundary

Promotion criteria for generalized policy candidates remain an open decision in `spec/open-decisions.md` §13. This collection
must not smuggle in a threshold by calling a diagnostic review “promotable”. Sample count alone never
promotes.

A later promotion requires, at minimum:

- immutable decision-time sentinel evidence under the candidate's own generation;
- enough independent settlement windows and enough windows where it actually changes the decision;
- a predeclared clustered comparison against the live rule, including its exits;
- explicit multiple-comparison correction and source-coverage integrity;
- signal-policy and executable views reported without pooling;
- a written reason and policy-manifest version/history update; and
- manual deployment and recording under the existing quiescent real-money controls.

Walk-forward evaluation or a sentinel result can never change production automatically.

## 11. Failure and integrity behavior

- A stale or missing latest quote yields no feature.
- A crossed or malformed side book yields no feature for that provider/side; another provider is not a
  substitute.
- A contract-id or close-time change starts a fresh path.
- A source-time gap breaks the path rather than being interpolated.
- A zero-distance path retains net change `0` and efficiency `null`.
- If a persisted feature cannot be recomputed from its stamped start/end/path-distance terms within the
  named price tolerance, the row is invalid for analysis.
- Storage failure omits observation evidence and logs; it cannot block a valid production cycle or order.
- Candidate collection failure later blocks an evidence claim, not production execution.

## 12. Required tests

Pure feature tests cover grids and exact boundaries rather than one fixture:

- monotone up, monotone down, oscillating, and flat midpoint paths;
- widening, narrowing, oscillating, and flat spread paths;
- UP and DOWN side orientation without assuming cross-provider complement mechanics;
- trailing horizon cutoff and cycle boundary reset;
- duplicate source timestamp, out-of-order input, future point, stale latest point, and a gap over two
  observation buckets;
- minimum sample/coverage boundary and zero path distance;
- non-finite, out-of-range, crossed, and exact float-edge prices using the named `1e-9` price tolerance;
- cache fallback does not manufacture a new source observation;
- legacy rows and unavailable features remain absent rather than zero;
- persisted selected provider/side identity matches the entry contract; and
- dependency guards, mirror-invariant arity, strategy isolation, and venue-target integrity remain unchanged.

Store tests later pin first-write immutability, settlement-only patches, append replay, owner-only atomic
compaction, corrupt-file quarantine, no backfill, exact-contract resolution, and settlement-window
clustering.

## 13. Implementation map

| Path | Role |
| --- | --- |
| `src/lib/quote-trajectory-spread.ts` | pure normalized samples, horizon extraction, feature calculation, and validation |
| `src/lib/cache.ts` / cached feed envelopes | preserve source capture time and bounded normalized rolling quote history without a new request |
| `src/lib/cycle-regime.ts` / `src/lib/types.ts` | add signed underlying fields and optional observation schema without changing existing regime semantics |
| `src/lib/dashboard.ts` | attach observation-only current features before forecast tracking; no ranking or policy read |
| `src/lib/forecast-tracker.ts` | persist the current production-selected provider/side feature on qualified calculations |
| `src/lib/paper-execution.ts` | copy the same immutable slice onto new edge entry decisions only |
| `src/lib/entry-decision-observation.test.ts` and new feature tests | enforce observation-only imports, exact arithmetic, freshness, and mirror boundaries |
| future candidate design/store | separately versioned gate or ranking sentinel after screening; not part of collection v1 |

## 14. Explicitly unchanged

- No new polling, timer, scheduler, endpoint, or request budget.
- No forecast probability, confidence, factor weight, calibration, or model promotion change.
- No buy-policy, asset/side admission, persistence, regime, spread-level gate, ranking, sizing, execution, exit,
  switch, budget, exposure, loss-stop, reconciliation, pause, or arming change.
- No buy-policy or policy-manifest version bump for observation-only collection.
- No reinterpretation or backfill of historical forecast, contract-path, entry-direction, order, or sentinel
  rows.
- No public/stateless write authority and no path from LLM output into the feature.
- No claim that trend or spread direction is profitable. Existing evidence says trajectory can be real while
  still smaller than taking cost; this design collects the terms needed to test a rule in traded form.
