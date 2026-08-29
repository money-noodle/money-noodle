# Maker lifecycle sentinel: short expiry, and whether the taker is what pays

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-28
> **Canonical requirements:** [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260828-02`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> Agreed in prose with the maintainer and accepted on 2026-08-28. This adds an observation-only
> evaluation generation. It changes no entry rule, exit rule, threshold, sizing, capital, operator control,
> venue order body, or production order. Production continues to run the managed maker and its fallback
> exactly as accepted while this observes.

## 1. Why prospectively, and why now

[`early-taker-cutover-review-2026-08-28`](../reports/early-taker-cutover-review-2026-08-28.md) scored the
proposal retrospectively and the answer would not hold still. On the pinned v9 cohort of 38 rested misses,
taking at the two-second poll returned −11.9% held and −13.5% with exits, against a live rule that returned
+1.4%; break-even at the asks paid was 63.7% against a 60.0% median forecast. Widened to every rested miss in
the surrounding 24 hours, the same rule returned **+8.0%** at a 66.7% hit rate against a 59.7% break-even —
and split at the v9 boundary that decomposed into **+54.5% across the earlier thirteen hours at an 88.0% hit
rate and −22.9% across the later eleven at 51.4%**.

One rule, one day, both signs, `t = 0.60` over 41 windows. That is what a regime looks like, not an edge, and
it is precisely the situation [`AGENTS.md`](../AGENTS.md) §5.5 says retroactive screening cannot resolve.
Committed sentinels written at decision time and followed to settlement can.

The instrument also needs no venue change. The managed maker already appends a `management_quote` observation
about every two seconds carrying `filledCount`, `remainingCount`, `selectedBid`, `selectedAsk`, `bestAskDepth`,
and `displayedAhead`. That is the whole input, sampled at exactly the cutover granularity. Adding Kalshi's
optional `expiration_time` companion to the maker order body is a separate, later question that only arises if
an arm is ever promoted.

## 2. Arms

The proposal bundles two changes — a shorter maker life and a taker fallback — so scoring them together
cannot attribute the result to either. The family separates them:

| Arm | Behaviour |
| --- | --- |
| production (control) | The accepted managed maker: twelve-second horizon, ladder walk, then the fallback. Not a candidate; the baseline every candidate is scored against. |
| `maker-expire2s-taker-v1` | Abandons the maker at the first management observation at or after two seconds and takes at the refreshed ask advanced two venue ticks. |
| `maker-expire2s-abandon-v1` | Abandons at the same instant and does **not** take. |

The abandon arm is what makes the result readable: if the taker arm beats production and the abandon arm does
too, the gain was never about crossing the spread. Two candidates against a control hold the Holm bar for the
best arm at `t >= 1.96`; a horizon sweep is a later generation, not more arms here.

## 3. What is recorded, at decision time

For every accepted maker, at the first observation at or after two seconds: whether it had already filled, the
selected-side bid and ask, `bestAskDepth` and `displayedAhead`, the resulting taker limit
`min(0.75, ask + 2 ticks)`, the quantity production sizing functions return at that limit, the charged
whole-cent taker fee, and the settlement outcome once resolved. Sizing, fees, and rounding come from the
production functions so the arithmetic matches the desk, and both money views are reported separately.

Two realism rules the earlier retrospective did not apply, and which will make this instrument's numbers
worse than that review's:

- **A taker arm fills only where recorded depth supports it.** The retrospective assumed the full requested
  quantity filled at the observed ask.
- **An ask above the absolute 75¢ production ceiling cannot be crossed at all**, and the arm records no
  trade rather than a capped one. That was 12 of 72 rested misses in the measured 24 hours.

## 4. Thresholds and coverage

Sixty complete independent settlement windows, at least twenty divergent windows, at least 90% observation
coverage, returns clustered on the settlement window, Holm across the frozen family, and live and paper
reported separately with a sign disagreement blocking the lock.

Coverage is the exposed risk. In the measured interval, **nine of seventy-two rested misses had no usable
venue quote at the two-second poll**, which is roughly 87% — below the 90% bar. A cycle with no quote is
`unavailable` and is never silently treated as a decision not to trade. If coverage does not reach the bar the
instrument reports that it cannot conclude, exactly as the exit sentinel does; improving observation is then
the work, not lowering the threshold.

## 5. What this cannot capture

A two-second expiry in production would change queue dynamics: our own displacement in the book, and how
other participants' orders interact with ours. This sentinel replays decisions against a book our real
twelve-second order was resting in. It measures the decision honestly and cannot measure the market's
reaction to us behaving differently, so even a fully unlocked result is evidence about the decision rule
rather than a forecast of realised fills.

It also inherits the standing caveat that a maker miss is selected by price moving away from the bid, which is
why the posted-price counterfactual in
[`unfilled-entries-2026-08-20`](../reports/unfilled-entries-2026-08-20.md) is not a reachable strategy. The
taker arms avoid that trap by pricing at the observed ask; the abandon arm is unaffected because it buys
nothing.

## 6. Relationship to the accepted execution rule

[`DEC-20260827-02`](../spec/decisions/decision-id-map.json) governs funded execution and is unchanged. A
sentinel is not bound by it in what it may model — that is the point of observation-only — and is entirely
bound by it in what production does while observing. No arm here can reach an order function. If an arm ever
clears its review, promotion is a separate manual, versioned act that would supersede the current rule with a
decision describing what actually shipped.

## 7. Registry and view

A `maker-lifecycle-sentinel-v1` entry joins the sentinel registry, so it appears in the Sentinels view with
its question, arms, thresholds, timeline, and progress without any new UI.

## 8. Tests

Pin arm selection at the two-second boundary over a grid of observation timings including a poll exactly at
two seconds, a maker that filled before it, and a missing quote; that a taker arm records no trade above the
75¢ ceiling and no fill beyond recorded depth; that the abandon arm never prices a purchase; exact taker fee
and rounding including the 1¢ floor; clustering on the settlement window; Holm across the frozen family;
coverage counting an absent quote as unavailable rather than as a decision; strategy isolation; and that no
arm can reach an order function or alter a production order body.
