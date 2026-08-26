# Live opportunity decision flow

> **Document type:** Reference
> **Design status:** Reference
> **Implementation:** Not applicable
> **Created:** 2026-08-24
> **Canonical requirements:** [`spec/forecasting-and-evidence.md`](../spec/forecasting-and-evidence.md), [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** None — no accepted product decision
> **Design index:** [`docs/README.md`](README.md)

This is the shortest practical introduction to how Money Noodle turns one market observation into a funded
entry attempt. It describes the current `edge-binary-buy` path in decision order and gives each stage one name.
It is intentionally simpler than the implementation and [`SPEC.md`](../SPEC.md).

Code remains authoritative for behavior. The policy manifest records what has been live, and `SPEC.md` records
decisions and why. Start from this document when orienting or refining the path, then follow the cited symbols
before changing it.

`edge-binary-buy` is the only active strategy. `long-shot-round-trip` remains registered only as a retired
historical ledger identity; it has no trigger, lifecycle, allocation, or product surface. See
[`src/lib/strategy-registry.ts`](../src/lib/strategy-registry.ts) and the preserved
[`docs/long-shot-policy-design.md`](long-shot-policy-design.md).

## The seven states

Use these names consistently in code, UI, and discussion:

1. **Market observation** — aligned source data exists for an asset and contract window.
2. **Base signal** — one enabled venue/side clears the shared forecast and buy policy on this snapshot.
3. **Confirmed signal** — the base signal has survived the production maturity and persistence checks.
4. **Venue candidate** — the funded venue's own quote, readiness, sizing, and market-structure checks pass.
5. **Portfolio selection** — the candidate wins a provisional slot under account exposure constraints.
6. **Live authorization** — current operational, risk, reconciliation, funding, and rate gates all pass.
7. **Attempt and outcome** — a durable intent becomes a refusal, rejection, confirmed no-fill, partial/full fill,
   or uncertain state; acquired exposure later becomes sold, won, lost, invalid, or remains unresolved.

A state does not imply the next one. In particular, a base signal is research output, not permission to trade,
and a portfolio selection is provisional until the live authorization checks run.

## Decisions in runtime order

### 1. Market data and forecast — `src/lib/dashboard.ts`, `src/lib/forecast-model.ts`

1. Fetch bounded-cache market, oracle, volatility, price, and context inputs.
2. Keep only a current funded-venue contract aligned to the canonical contract window; reject a cached contract
   from another window.
3. Build venue-independent `P(UP)` from contract basis, realized volatility, time remaining, and bounded slow
   tilts. Set `P(DOWN) = 1 - P(UP)`.
4. Compute estimate confidence from source availability and forecast-input quality. Venue prices may appear in a
   separate research comparison, but they do not enter the probability used to claim tradable edge.

Output: a **market observation** (`Prediction`).

### 2. Shared buy policy — `src/lib/prediction-policy.ts`

5. For every enabled live quote, price UP/YES and DOWN/NO from their own actionable asks.
6. Compute fee-aware value as `P(side) - ask - admission fee`. Admission uses immediate-execution fee economics
   before a later component chooses maker or taker execution.
7. Remove options outside the active price, selected-side probability, side-control, and maximum-edge rules.
8. Choose the remaining option with the highest net edge as `bestEntry`.
9. Require the active minimum net edge and estimate quality.

Output: a **base signal** (`qualifiesAsBuyEdge`). This pure rule layer takes no execution mode, so live and paper
make the same entry-policy decision for the same snapshot (`SPEC.md` §12.3).

### 3. Confirmation and regime evidence — `updateSignalPersistence`, `src/lib/signal-persistence.ts`

10. Record the selected side once per fresh dashboard calculation. A failed current observation resets the
    streak; replaying one timestamp cannot manufacture confirmation.
11. Require the active warm-up, observation count/span, latest-observation age, median edge, quality, and final
    entry cutoff.
12. Attach the per-cycle path classification and update the account-wide adaptive regime gate from its separate
    current-policy evidence.

Output: a **confirmed signal** when persistence is eligible. The adaptive regime gate remains a later account-wide
entry authorization rather than part of the pure buy policy. The approved exact-provider debounce/dwell evaluation
is queued behind the base-signal program in
[`docs/confirmed-signal-evaluation-design.md`](confirmed-signal-evaluation-design.md); it is not collecting or
changing production yet.

### 4. Funded-venue and provisional portfolio evaluation — `updatePortfolioDecisions`, `buildOrder`

13. Require the selected side to clear the funded venue's own buy rule; an edge available only elsewhere cannot
    authorize an order there.
14. Apply re-entry cooldown and bounded entry-episode rules.
15. Require a trade-ready funded-venue connector, a valid bid/ask, acceptable spread and remaining time, enough
    cash, and enough all-in stake for the venue's minimum quantity.
16. Build a provisional sized order and route, then rank candidates by expected dollar contribution under open-
    position, same-window, same-asset, and correlation-group constraints.

Output: a **venue candidate** and, for winners, a provisional **portfolio selection**. This pass supports the
operator read model; it does not itself authorize funded execution. The approved safety/ownership, gate-attribution,
and implementation-shortfall review is queued after the confirmed-signal final review in
[`docs/venue-candidate-evaluation-design.md`](venue-candidate-evaluation-design.md); it is not collecting or
changing production yet. After that layer freezes, the separate full-cycle greedy-fidelity, reranking, and
stateful-shadow plan in
[`docs/portfolio-selection-evaluation-design.md`](portfolio-selection-evaluation-design.md) evaluates provisional
portfolio selection. The existing issued-order choice-set journal remains a narrower integrity sentinel.

### 5. Account-wide live gates — `runLive`

17. In order, require the environment opt-in, provider live permission, reconciliation READY state, active
    operator control, live mode, passing economic risk breakers, an open adaptive regime gate, a fresh dashboard
    calculation, and hourly rate headroom.
18. Evaluate a protected reduce-only replacement before adding exposure when an existing position competes for
    the slot.
19. Apply asset admission and per-candidate cycle classification, then retain only candidates whose retry,
    confirmation, and provisional portfolio state still pass.

Output: candidates that may proceed to per-order **live authorization**. The approved complete-manifest,
concurrency-fault, authority-age, funding-ownership, and guarded-recovery review is queued after portfolio selection
freezes in [`docs/live-authorization-evaluation-design.md`](live-authorization-evaluation-design.md). It is not
collecting or changing production yet.

### 6. Final per-order authorization and routing — `runLive`, `src/lib/entry-execution-policy.ts`

20. Before each placement, recount positions and rate usage, reapply correlation limits, and calculate current
    provider/market funding headroom. Earlier placements in the same cycle are included.
21. Rebuild the order at that actual funding ceiling. Recheck venue policy, readiness, quote shape, spread, time,
    quantity, cash, and all-in sizing; then verify unique durable client identity.
22. Choose the production route. Ordinary entries use managed maker execution; only a route with explicit
    authority may use a capped IOC. Any active bounded execution experiment applies its own assignment and hard
    ceilings without changing the shared buy rule.
23. For a taker route, reserve against the worst permitted quote movement and require the refreshed quote to
    clear the active venue buy rule again.

Output: an operationally **authorized live order**.

### 7. Durable intent and venue outcome — `executePreparedLiveBuy`, `src/lib/live-orders.ts`

24. Write the complete intent and decision evidence to the shared ledger before a signed venue request.
25. Reserve whole-cent budget, then submit either the bounded managed-maker lifecycle or a marketable IOC limit.
26. Record authoritative partial/full fills and release unused reservation; return the full reservation after a
    confirmed no-fill or pre-submit refusal.
27. If venue state is ambiguous, retain the reservation, mark the order uncertain, suspend the desk, and require
    authoritative reconciliation.
28. Keep the execution outcome separate from the later position outcome: only acquired quantity may be reduced or
    settled, and exact venue P&L remains distinct from whole-cent budget control.

Output: an **attempt and outcome**. Only an authoritative fill creates funded exposure. The approved normalized-
lifecycle, fault/recovery, accounting, partial-fill, implementation-shortfall, and intent-to-treat review is queued
after live authorization freezes in
[`docs/attempt-outcome-evaluation-design.md`](attempt-outcome-evaluation-design.md). It is not collecting or
changing production yet.

## Important current implementation details

These details explain behavior that can be surprising during refinement:

- Signal persistence is keyed by asset, side, and window and currently records the global `bestEntry` edge. It is
  not keyed by provider, even though funded execution later rechecks the funded venue.
- Provisional portfolio decisions are computed before asset admission, per-cycle classified-regime admission,
  and the account-wide live gates. The authoritative `runLive` path applies those checks later.
- Provider/market funding is applied after provisional portfolio ranking. The final order is rebuilt at actual
  spendable headroom before placement.
- Paper creates independent intent and fill evidence from the same shared buy decision. It does not grant live
  authority and its bankroll cannot fund a live order.
- UI calculations and badges are read models. They can describe base signals, confirmation, provisional
  portfolio state, and attempts, but only the server-side execution path can authorize money movement.

## Refinement rules

When changing this path:

1. Name which of the seven states owns the decision.
2. Keep forecast, shared buy policy, execution style, portfolio/capital, and operational safety as separate
   responsibilities.
3. Preserve the live/paper mirror invariant in the shared policy; differences belong only to execution and
   capital.
4. Make server-side state authoritative. Client components may explain a decision but must not recreate funded
   authority.
5. Fail closed on missing identity, stale evidence, malformed quotes, insufficient funds, or ambiguous venue
   state.
6. Update this introduction when a decision moves between owners or a state changes meaning. Update `SPEC.md`
   and its decision log only when the product decision itself changes.

The master milestone-gated serial plan across all seven states, from base signal through attempt and outcome, is
[`docs/forecast-model-and-evaluator-v3-design.md`](forecast-model-and-evaluator-v3-design.md).
