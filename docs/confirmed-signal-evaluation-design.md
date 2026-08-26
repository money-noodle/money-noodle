# Confirmed-signal evaluation design

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Not started
> **Created:** 2026-08-24
> **Canonical requirements:** [`spec/forecasting-and-evidence.md`](../spec/forecasting-and-evidence.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260825-09`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Status:** Approved design, queued behind completion of the base-signal program in
> [`docs/forecast-model-and-evaluator-v3-design.md`](forecast-model-and-evaluator-v3-design.md). No confirmed-signal
> candidate is collecting, and no production confirmation, forecast, buy policy, execution, capital, or live
> authority changes in this document.

## 1. Question

Production currently confirms a base signal with two qualifying observations spanning 15 seconds, a strict reset
on a failed current observation, a 90-second cycle warm-up, freshness checks, and a final 30-second entry cutoff.
The evidence that replaced three-over-30 seconds with two-over-15 seconds showed that the older rule was too
restrictive under its dated ask-and-hold cohort. It did not establish that waiting for a second observation beats
acting on the first.

The primary question is:

> Does information gained by waiting for confirmation improve deployable return enough to pay for delay, quote
> movement, disappeared opportunities, and execution selection?

A second question removes an implementation ambiguity:

> Does provider-agnostic persistence ever let evidence from one provider contract mature an opportunity on
> another provider contract?

## 2. Measure classes

Every condition is declared as exactly one class.

### Economic selectors

These are allowed to choose a different cohort and must beat production on paired prospective evidence:

- first observation versus waiting;
- two versus three observations;
- strict consecutive reset versus a noise-tolerant two-of-three rule;
- provider-agnostic versus exact-provider confirmation identity.

An economic selector that changes no decision over a mature current-policy cohort is inert. It may not be
presented as a risk control; retain it only if reclassified and justified as a safety assertion.

### Safety invariants

These protect a named failure mode rather than claiming economic value:

- exact strategy, market, provider, contract-provenance, asset, side, and settlement-window identity;
- valid UTC timestamps and an unexpired contract;
- fresh calculation and quote evidence;
- duplicate calculation suppression;
- no confirmation through a missing, malformed, stale, or target-mismatched observation;
- outcome from the same provider contract whose ask created the candidate.

A safety invariant may be normally inert. Its validation is a fault-injection or invariant test, not a return
comparison.

### Diagnostics

These are recorded and cannot authorize or refuse a candidate:

- forecast-probability movement;
- provider ask, spread, fee, and fee-aware-edge movement;
- edge relative to its recent median;
- cross-provider disagreement;
- reason a current observation failed;
- time from first base signal to each arm's eligibility;
- entry-price movement caused by waiting;
- whether a stricter arm later caught up.

The currently disarmed edge-spike ceiling remains diagnostic. Any future use motivated by maker adverse selection
belongs first in execution evaluation, not silently in forecast or confirmation.

## 3. Provider and contract identity

An actionable confirmation state is keyed by:

```text
strategyId
marketId
providerId
contractRegistryId / exact contractId
symbol
side
closesAt UTC
```

No observation from another provider, contract fingerprint, side, market, or close may increment or preserve that
state. Provider-specific outcomes are never substituted or pooled. If a future market has multiple funded-capable
providers, report each provider cohort separately before any account-level portfolio comparison.

Cross-provider prices may remain diagnostics. If they are proposed as predictive information, that is a versioned
forecast-model candidate with target-comparability evidence; it is not confirmation. This preserves the rule that
venue price is an execution cost and benchmark unless an approved model explicitly treats a separately identified
market signal as an input.

## 4. Frozen first family

The family contains one exact production control, one identity bridge, and three materially different timing
rules. Four comparisons against production carry one declared Holm family-wise correction.

### Arm 1 — `production-global-2consecutive15-v1`

Exact running production behavior:

- global `bestEntry` supplies side and edge;
- current provider-agnostic persistence key;
- two consecutive qualifying observations over at least 15 seconds;
- strict reset, warm-up, cutoff, freshness, current quality/median rechecks, and active spike state unchanged.

The prospective lane must match the running production eligibility result on every observed input before any
other arm is interpreted.

### Arm 2 — `venue-2consecutive15-v1`

The same timing algorithm with exact provider-contract-side state. Its difference from Arm 1 isolates identity;
it does not change count, span, or reset behavior.

### Arm 3 — `venue-first-pass-v1`

The first fresh venue-specific base signal after the shared warm-up and before the shared cutoff is eligible. All
safety checks and the active base policy still apply.

### Arm 4 — `venue-3consecutive30-v1`

Three consecutive fresh venue-specific base signals spanning at least 30 seconds. Any available current policy
failure resets the run.

### Arm 5 — `venue-2of3-30-v1`

The current observation must pass. At least one of the preceding two distinct 15-second observations must also
pass, with at least 15 seconds between counted passes. One genuine, available economic failure may be tolerated:

```text
pass -> fail -> pass = eligible
```

An unavailable, stale, malformed, duplicate, or identity-mismatched observation is not the tolerated failure; it
breaks the sequence fail closed.

## 5. Inputs held fixed

The first family changes only provider identity and debounce/dwell behavior. Every arm holds fixed:

- production forecast and estimate quality;
- active buy-policy version, side rules, price bounds, fee schedule, and edge floor;
- 90-second cycle warm-up;
- final 30-second entry cutoff;
- 30-second maximum evidence age;
- funded-capable provider narrowing;
- asset admission excluded from this signal-level comparison;
- no portfolio, capital, account readiness, rate, regime, fill, or exit assumption in the signal lane.

Warm-up and late cutoff receive separate later ablations only after this family is reviewed. Changing them in the
same family would make debounce value unidentifiable.

The primary comparison covers the first entry episode only. Fresh persistence after an authoritative maker miss is
an execution/retry question and is not mixed into this cohort.

## 6. Observation semantics

At each distinct fresh collector calculation, evaluate both sides independently for every funded-capable exact
provider contract. Each tuple receives one status:

- `pass`: exact provider/side clears the current base policy;
- `economic-fail`: evidence is complete but the current base policy refuses it;
- `unavailable`: required quote, provenance, target, or freshness evidence is absent;
- `invalid`: evidence is malformed or contradictory.

Only `economic-fail` can occupy the one tolerated slot in Arm 5. Duplicate calculations do not create a slot.
Unavailable and invalid evidence clear or break every candidate sequence and are reported separately from economic
failure.

Every arm selects its own first eligible exact provider/side/cost. It never inherits production's selected side,
provider, ask, or decision time.

## 7. Prospective evidence store

Forecast history cannot reconstruct this family exactly: qualifying calculations are retained more densely than
nonqualifying ones, so an unrecorded 15-second failure could falsely preserve a historical streak. There is no
retroactive backfill.

Before activation, implement an observation-only append journal with:

- one compact event per distinct collector calculation containing every evaluated tuple and explicit absence;
- immutable registry, forecast, buy-policy, provider-registry, contract-provenance, and fee-role identities;
- exact probability, confidence, bid/ask, fee, net edge, base status, and reason;
- every arm's pre/post state, eligibility, and first-fire decision;
- a bounded current-state snapshot rebuilt from the journal after restart;
- atomic compaction owned only by that store;
- archive/restore coverage before activation.

The writer has its own queue and no budget, order, promotion, or reconciliation authority. Its result is never
awaited by production execution. A source invariant prevents candidate state from being imported or read by the
forecast, buy policy, production persistence, portfolio, sizing, budget, reconciliation, or order modules.

Exact outcomes are joined by provider contract identity. Missing exact outcomes remain unavailable rather than
being inferred from another provider.

## 8. Scoring

### Signal-policy lane

Score every arm-selected position, grouped by independent UTC settlement timestamp:

- payout-minus-all-in-cost per contract;
- return on all-in cost, reported separately rather than mixed with payout-basis value;
- ask-and-hold result with zero for an arm that declines a position;
- paired candidate-minus-production window return;
- Brier and log loss at the arm's actual decision time;
- coverage and unavailable classes;
- decision delay and ask/fee movement while waiting;
- candidate-only, production-only, same-choice, and different-choice windows;
- winners forgone and losses avoided, as counts beside—not substitutes for—return.

The family is scored on every position, first-to-fire per arm. No surviving-cohort or filled-order selection may
stand in for the full signal comparison.

### Execution lane

Signal results cannot promote a confirmation change. A later prospective shadow applies comparable production
routing to baseline and the locked confirmation candidate and records public depth/trades, maker/IOC outcome,
partial/no-fill, fees, exits, and terminal return. Missing evidence is unavailable, never a manufactured fill.

## 9. Milestones

| Milestone | Requirement | Nominal continuous cadence |
| --- | --- | --- |
| Engineering parity | Pure-grid and first 25 live-runtime calculation observations (no orders) match exact production control on identity, state, and eligibility | Before evidence clock |
| Wiring smoke | 10 independent settlement timestamps; complete five-arm family; zero production mismatches | About 2.5 hours |
| Coverage audit | 100 closed timestamps; at least 95% complete exact-provider outcome coverage; every unavailable class explained | About 25 hours |
| Signal review readiness | 300 closed timestamps, at least 90% per-arm availability, and at least 100 windows where an alternative differs materially from production | At least 75 hours; divergence may dominate |
| Execution review readiness | 200 execution-scoreable timestamps, at least 90% public-evidence coverage, and at least 100 divergent windows | Multi-day to multi-week |
| One final review | Signal and execution populations both pass; four production comparisons use the predeclared Holm correction | Manual, once |

Counts permit review or the next collection stage only. They never change production automatically. Promotion
would require a separate model/policy version, manifest history, immutable evidence citation, and typed manual
act.

## 10. Serial placement in the overall program

This work does not begin while the base-signal program is still choosing and validating the probability/admission
candidate. It is queued after the base-signal final review because changing probability changes which snapshots
qualify and would invalidate a simultaneous confirmation cohort.

The serial order is:

1. finish base-signal candidate collection, uncertainty inputs, evaluator-v3 signal lane, execution shadow, and
   one base-signal review;
2. freeze the production base signal that the confirmation family will consume;
3. implement and parity-test this confirmed-signal store;
4. collect and review the five-arm signal family;
5. lock at most one confirmation candidate for prospective simulated execution;
6. perform one corrected final review;
7. freeze the promoted or retained production confirmation rule;
8. only then hand off to [`docs/venue-candidate-evaluation-design.md`](venue-candidate-evaluation-design.md).

If the base-signal review changes production, confirmation starts only after that version is deployed and its exact
control parity passes. If the base-signal review retains production, the same boundary is recorded as an explicit
null-result handoff before confirmation activation. Venue attribution likewise waits for the confirmation handoff,
because a changed confirmation rule changes the population, timing, side, and quote entering venue candidacy.
