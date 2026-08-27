# Maker miss with two bounded positive-edge taker fallbacks

> **Document type:** Execution design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-27
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260827-02`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> Agreed in prose with the maintainer before implementation. This replaces repeated requalifying maker episodes and
> the immediate 30pp taker route. It changes funded execution and durable intent lifecycle, not the shared initial
> buy rule, capital ceilings, exits, reconciliation, or operator authority.

## 1. Sequence

For each strategy/market/asset/side/window logical order, adaptive execution may create at most three intents:

1. one managed post-only maker;
2. after confirmed cancellation and authoritative zero fill, one taker IOC; and
3. after an accepted first IOC authoritatively returns zero fill, one final taker IOC.

Every intent has a distinct collision-resistant client identity, predecessor link, decision snapshot, reservation,
venue identity when accepted, and terminal evidence. A fill or partial fill, policy refusal, rejection, uncertainty,
old generation, or the third intent ends the sequence. Ambiguity retains reservation, suspends, and reconciles; it
never authorizes another order.

## 2. Freshness and authorization

The first taker does not wait for two snapshots or 15 seconds. After the maker terminal row is durable, the worker
forces a live-only dashboard rebuild, rereads trading control/provider budgets, portfolio and exposure state, rate
limits, stop-loss/kill-switch state, and reconciliation readiness, then builds a new intent. The signed order path
refreshes the exact provider contract again immediately before submission.

The second taker repeats both refresh boundaries after the first IOC terminal row is durable. A stale dashboard,
unavailable exact quote, changed side, malformed lattice, failed account guard, or failed policy check withholds it.
No paper accumulation authorizes live. Paper independently applies the same route decision and public exact-quote
checks under its own execution and capital model.

## 3. Price and economic bounds

Let `M` be the maker's final submitted selected-side limit. Each IOC has the structural ceiling:

```text
C = min(1.25 × M, 0.75)
L = floor_to_venue_ladder(min(fresh ask advanced by two current ticks, C))
```

The second limit may exceed the first when its newly refreshed ask rises. Neither attempt submits automatically at
`C`; the ceiling only bounds the current two-tick price. The signed quote must remain marketable at `L`.

The predecessor's latest exact selected-side midpoint is the direction reference. The new midpoint may decline by
at most one current venue tick; a larger decline withholds the fallback. Rising prices are allowed within the caps.

Economic authorization uses the actual requested quantity and the charged whole-cent taker fee at worst submitted
limit `L`, including its 1¢ floor:

```text
quantity × 100 × probability − quantity × 100 × L − charged fee > 0
```

This replaces the ordinary fresh 5pp continuation margin but does not alter the initial buy rule: the maker still
originates only from the shared production admission policy. Quantity and reservation are conservatively bounded at
`C`; unused whole cents are released from authoritative fills.

## 4. Non-changes and failure behavior

Existing per-order all-in sizing, provider allocation, global exposure/correlation limits, hourly filled-order cap,
stop loss, arming, pause/drain, kill switch, reconciliation cadence, and venue capability checks remain authoritative.
The 75¢ production ceiling remains absolute. IOC leaves no resting remainder. Any accepted partial fill becomes the
position acquired and ends fallback. A transport, schema, cancellation, or fill-record ambiguity suspends and
reconciles rather than retrying.

The retired bounded-taker experiment remains retired. This generation uses ordinary full budget and stop-loss rules;
it adds no pilot allocation or loss counter.

## 5. Audit and tests

Orders stamp `maker-then-positive-edge-taker2-fresh2tick-v8`, intent number, logical identity, predecessor, route,
model/policy versions, quote observations, approved maximum, reserved stake, charged fees, fill terms, and terminal
classification. Tests pin lifecycle authority, two-attempt terminality, exact tick movement across tapered ladders,
25%/75¢ ceilings, positive charged-fee arithmetic including the fee floor, midpoint decline tolerance, durable
terminal writes before refresh, route mirroring, identity uniqueness, uncertainty, budget, strategy isolation, and
reconciliation invariants.
