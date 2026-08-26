# Venue-candidate evaluation design

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Not started
> **Created:** 2026-08-24
> **Canonical requirements:** [`spec/providers-and-market-data.md`](../spec/providers-and-market-data.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260825-08`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Status:** Approved analysis plan, queued strictly after the confirmed-signal final review in
> [`docs/confirmed-signal-evaluation-design.md`](confirmed-signal-evaluation-design.md). No venue-candidate
> observation family is collecting, and this document changes no forecast, buy policy, confirmation, sizing,
> portfolio, execution, capital, reconciliation, or live authority. Its final retained/promoted handoff is the
> prerequisite for the separately approved portfolio-selection program.

## 1. Question

A confirmed signal is still only a claim that an exact provider contract appears underpriced. The venue-candidate
layer must translate that claim into something the provider can actually support without silently mixing capital,
portfolio, execution-route, or account authorization decisions into venue quality.

The primary question is:

> Among exact-provider confirmed signals, which current venue checks independently change a decision, and does
> each changed cohort improve deployable return after quote refresh and fill selection?

The implementation-shortfall question is equally important:

> How much value survives from displayed candidate ask, through exact pre-submit quote and submitted limit, to
> actual or public-evidence simulated fill?

## 2. Current production boundary

For the selected side, current orchestration may:

1. re-run the funded provider's own fee-aware buy rule;
2. apply post-exit cooldown and bounded entry-episode rules;
3. require an enabled, implemented, trade-ready provider;
4. require a positive, ordered bid/ask pair;
5. refuse spread above the general 10-cent ceiling;
6. require at least 30 seconds remaining at construction time;
7. apply reduce-only 0.3× sizing below 30pp issuance edge and full base size at or above it;
8. reserve quantity and taker fees under the all-in cap;
9. require enough reported venue cash for the provisional order;
10. construct route-dependent provisional terms; and
11. rank usable providers by net edge, although current funded live operation is narrowed to one capable provider.

Those are not one kind of decision. This plan separates their ownership before testing economic alternatives.

## 3. Measure classes

### 3.1 Safety and mechanical feasibility

These protect a concrete contradiction or impossible order and are validated with invariants and fault injection:

- implemented and enabled provider/market capability;
- exact provider, provider variant, contract provenance, contract ID, side, market, strategy, and UTC close;
- current contract aligned to the confirmed-signal contract;
- finite positive bid/ask, bid no greater than ask, and valid price lattice;
- explicit quote observation time and hard freshness;
- current clock outside the final construction cutoff;
- venue quantity step and minimum quantity;
- all-in cost including conservative fee reservation fitting the authorized cap;
- sufficient authenticated provider cash at the point that cash becomes authoritative;
- fail-closed handling of absent depth, malformed quote, unsupported provider, or identity mismatch.

A safety control may normally change no decision. Its value is preventing malformed or cross-contract authority,
not improving return.

### 3.2 Economic selectors

These choose or weight an otherwise mechanically feasible candidate and require paired prospective evidence:

- the 10-cent spread ceiling;
- any quote-age ceiling tighter than source freshness for economic reasons;
- any route-specific spread or implementation-shortfall rule;
- provider selection when more than one funded-capable provider exists;
- an expected executable-value objective in place of displayed net-edge ranking.

An economic selector that changes no decision over a mature current cohort is inert and may not be described as a
risk control.

### 3.3 Diagnostics

These are recorded and cannot authorize or refuse in the diagnostic phase:

- candidate ask/bid/spread and their source age;
- exact pre-submit ask/bid/spread;
- submitted limit and quantity;
- ask movement, spread movement, and value lost while processing;
- displayed depth and public trades when available;
- maker touch/fill estimate and cohort identity;
- fill/no-fill, partial fill, average fill price, fee, exit, and terminal outcome;
- cross-provider price disagreement, kept separate by exact contract target;
- every current rejection reason, including simultaneous reasons rather than first reason only.

## 4. Ownership corrections to evaluate

### 4.1 Exact contract identity

A funded candidate must have an exact tradable provider contract and provenance reference. Asset-symbol or URL
fallbacks may remain display conveniences but cannot supply funded identity. Missing identity is a safety failure,
never an economic rejection or a request that the venue should discover the intended contract.

The venue-candidate key continues the confirmed-signal key unchanged:

```text
strategyId
marketId
providerId
providerVariantId
contractRegistryId / exact contractId
symbol
side
closesAt UTC
```

Outcomes, pre-submit quotes, books, orders, and fills must all match that tuple.

### 4.2 Provider-specific policy recheck

Today the provider recheck is load-bearing because production confirmation is provider-agnostic. Once exact-provider
confirmation is frozen, the same calculation becomes a safety/current-price revalidation: it verifies that the
confirmed opportunity still exists on that provider rather than introducing a second independent economic rule.
The attribution lane records whether this recheck ever disagrees and why.

### 4.3 Spread

Malformed spread and economic spread are separate:

- `bid > ask`, non-finite values, or inconsistent arithmetic are safety failures;
- `spread > 10c` is an economic/execution selector.

The diagnostic phase asks whether the 10-cent ceiling binds after the base policy, whether wide spread predicts
settlement value or only maker/IOC execution, and whether absolute spread is meaningful across price bands. No new
threshold is selected from the attribution cohort and promoted on the same data.

### 4.4 Quote age and implementation shortfall

The layer records four distinct prices rather than treating them as one:

```text
confirmed-signal actionable ask
venue-candidate construction ask
exact pre-submit ask
submitted limit / authoritative average fill
```

Implementation shortfall is reported as price, fee-aware value, and expected-dollar change. A forecast can be
correct while operational value disappears before submission; that is a venue/execution finding, not forecast
miscalibration.

### 4.5 Provider ranking

Displayed net edge alone is not an adequate future multi-provider routing objective. A complete objective may need
executable quantity, provider fees, fill probability, adverse-selection cost, funding headroom, and reliability.
Those quantities are not combined until each has a validated definition. With only one funded-capable provider,
provider-ranking economics are explicitly `not evaluable`, not inferred from paper or research providers.

A second funded provider remains fail-closed until its per-market adapter, exact contract target, funding,
reconciliation, fill evidence, and routing objective are separately approved.

## 5. Decisions moved out of this analysis

The following remain recorded for audit but are not tested as venue-attractiveness rules in the first program:

- **0.3× below 30pp sizing:** capital allocation, evaluated in a separate sizing family;
- **provider/account cash and funding headroom:** live authorization after provisional ranking;
- **position and correlation constraints:** portfolio selection;
- **post-exit cooldown and entry-episode count:** execution lifecycle;
- **maker versus IOC route:** execution style;
- **adaptive regime and asset admission:** later policy/authorization controls;
- **reconciliation, operator state, rate limits, and kill switch:** live authorization.

Production may continue to recheck these fail-closed. The ownership correction is conceptual and evaluative until a
separate approved implementation moves code.

## 6. Phase A — exact production attribution

Before freezing economic candidates, prospectively record every exact-provider confirmed signal and the complete
current venue-candidate decision graph.

For every check, record:

- whether it passed;
- whether it independently refused the candidate;
- all simultaneous refusal reasons;
- whether it duplicated an earlier or later refusal;
- whether evidence was unavailable;
- whether final live authorization later disagreed;
- whether the candidate reached exact pre-submit quote, accepted order, partial/full fill, confirmed no-fill,
  rejection, or uncertainty.

The exact-control arm must match production candidate construction and rejection on a pure grid and live-runtime
calculations. This phase can identify inert rules and select a hypothesis for later prospective testing; it cannot
promote or retrospectively validate that hypothesis.

## 7. Phase B — exact venue economics

For each confirmed exact-provider tuple, preserve these separate views:

1. **displayed signal value:** actionable ask plus admission fee at confirmation;
2. **construction value:** quote and all-in economics when the venue candidate is built;
3. **pre-submit value:** exact refreshed quote immediately before the route acts;
4. **submitted value:** approved limit, requested quantity, and reserved fee/cost;
5. **deployable value:** public simulated or authoritative fill/no-fill, actual fee, exit, and terminal outcome.

Signal-level reporting assigns zero to declined candidates and scores every position, clustered by UTC settlement
timestamp. Execution reporting remains a separate lane so fill selection cannot be mistaken for forecast quality.
Exact and unavailable cohorts are always shown separately.

## 8. Phase C — focused prospective family

Only after the attribution report may a follow-up amendment freeze a small economic family. Likely hypotheses,
not approved parameter choices, are:

- production 10-cent spread ceiling;
- no economic spread ceiling while retaining malformed-quote safety;
- a route-specific spread rule;
- an explicit quote-age or implementation-shortfall rule.

The family is selected before its outcomes accrue, starts a new cohort, declares its multiple-comparison cost, and
lets every arm choose its own exact provider/side/time/cost. Sizing and provider-ranking candidates remain separate
families. No diagnostic Phase A/B row becomes promotion evidence for a threshold selected from it.

## 9. Milestones

| Milestone | Requirement | Nominal continuous cadence |
| --- | --- | --- |
| Safety/parity engineering | Fault grid plus 25 live-runtime calculation observations with zero exact-control identity or decision mismatch | Before evidence clock |
| Attribution smoke | 10 independent settlement timestamps; complete decision graph and explicit absence | About 2.5 hours |
| Attribution coverage | 100 closed timestamps; at least 95% exact-provider outcome/decision coverage; every unavailable class explained | About 25 hours |
| Attribution review | 300 closed timestamps and at least 100 windows where a current economic selector independently changes a candidate, or a documented finding that it is inert | At least 75 hours; selector frequency may dominate |
| Focused-family signal readiness | New prospective cohort: 300 closed timestamps, 90% per-arm availability, and 100 materially divergent windows | At least another 75 hours |
| Focused-family execution readiness | 200 execution-scoreable timestamps, 90% public-evidence coverage, and 100 divergent windows | Multi-day to multi-week |
| One corrected review | Signal and execution lanes pass; predeclared family-wise correction applied | Manual, once |

If the attribution phase finds fewer than 100 selector-changing windows, no effect size is manufactured from row
updates or correlated assets. The result is `insufficient selective activity` or `inert`, and the calendar extends
or the candidate is retired.

## 10. Serial placement

This program begins only after the confirmed-signal final review freezes the production confirmation rule. A
confirmation change alters the population, timing, side, and exact quote entering venue attribution; collecting
both unsettled layers concurrently would make neither comparison interpretable.

The serial handoff is:

1. finish and freeze the base signal;
2. finish and freeze the confirmed signal;
3. implement venue safety/parity instrumentation;
4. collect current-rule attribution and exact implementation-shortfall evidence;
5. write the attribution report, including inert and misplaced checks;
6. freeze at most one small prospective venue-economic family;
7. collect separate signal and execution evidence;
8. perform one corrected review;
9. freeze the retained or separately promoted exact venue-candidate definition;
10. only then permit the portfolio-selection parity phase in
    [`docs/portfolio-selection-evaluation-design.md`](portfolio-selection-evaluation-design.md) to start.

Counts and dates never promote automatically. Any change affecting the shared buy rule, confirmation, sizing,
provider capabilities, route, portfolio, funding, or live authorization receives its own version and decision
record rather than being smuggled through a venue-candidate refactor.
