# Paper execution fidelity v2 design

> **Document type:** Execution design
> **Design status:** Accepted
> **Implementation:** Partial
> **Created:** 2026-08-25
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260825-04`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Status:** approved in prose by the maintainer on 2026-08-25. Phase F1 engineering parity is complete. Phase
> F2's detached implementation is complete and loaded by the persistent worker after READY startup reconciliation
> on 2026-08-25. Its prospective clock began with the first durable decision at 2026-08-25T06:47:41.724Z. The
> written 10-window review passed on 2026-08-25. At the 2026-08-27 100-window review, count and coverage reached
> 163 exact maker pairs across 117 windows with complete timing evidence, but the milestone failed its fixed
> 12-second execution invariant: five control rows consumed post-horizon evidence and two became paper fills. A
> prospective versioned control repair is required before F2 can resume a clean cohort. The 300-pair /
> 30-create-race phase-exit gates remain closed. Phases F3–F4 remain unactivated and require the full preceding
> phase review. This program changes no funded execution,
> buy rule, portfolio rule, live authority, settlement
> outcome, or bankroll accounting by itself.

## 0. Decision

Improve the independent paper execution simulator in four gated phases without using an authoritative live fill to
set a paper result:

1. repair exact-control queue-reset semantics and separate acceptance, accepted-order queue, and contract
   settlement attribution;
2. prospectively evaluate create/acknowledgement latency and a read-after-horizon evidence grace;
3. prospectively evaluate one frozen family of queue-clear candidates only after comparable live acceptance; and
4. validate at most one combined execution generation before any manual paper-model adoption.

The ordinary maker action clock remains six checks over 12 seconds, one every two seconds. Faster polling across the
whole horizon is not approved: live uses the same two-second management cadence, and more public requests do not
reveal private FIFO rank or cancellations. Sub-second observation is confined to the create/acknowledgement race.
A final evidence grace may delay classification but can never extend the order's 12-second execution horizon.

This is a paper-execution fidelity program, not an eighth decision layer. It may collect while base-signal evidence
continues because F1 changes no result and later shadows have no policy or order authority. Any adopted paper
execution generation must be frozen before a downstream execution evaluator uses paper outcomes as its control.
It does not advance, bypass, or reorder the seven-layer serial roadmap.

## 1. Evidence and diagnosis

The fixed review ending `2026-08-25T05:15:00Z` found 161 exact paper/live terminal pairs over 67 settlement windows.
End-to-end agreement was 80.1%, live-fill capture 60.0%, and paper-positive precision 65.9%. That aggregate mixes
three different mechanisms.

Of 14 paper-only fills, ten live attempts lost a post-only acknowledgement race and two reconciled to no accepted
live order. Only two were paper-only after live accepted a comparable maker. Conditional on 125 same-route,
same-quantity accepted live makers, agreement was 84.8%, capture 58.5%, and precision 92.3%: the accepted-order
queue model was conservative and missed fills much more often than it invented them.

The corrected broader held-out queue cohort contained 94 independent accepted-maker windows: 46 both filled, six
paper-only, 22 live-only, and 123 neither, for 85.8% agreement, 67.6% capture, and 88.5% precision. This is enough to
identify candidate mechanisms and not enough to promote one retrospectively.

The same last-day cohort contained 160 paper makers and 787 successful trade-read observations. Every one of the
116 classified maker misses had all six expected reads. Public read latency was 80ms median / 177ms p95; wall time
from the newest consuming print's venue timestamp to its observation was 1.221s median / 2.072s p95 / 3.314s
maximum. That lag combines the intentional cadence, network time, and any publication delay. It does not identify
API publication delay by itself and cannot reveal a print never returned before the terminal read.

The caveat that most threatens every queue conclusion is unchanged: public books do not expose exact private FIFO
rank or cancellations ahead. Exact authenticated queue-position reads remain deferred because they share signed
read capacity with authoritative fill and reconciliation work.

## 2. Measurement classes

| Measure | Class | Authority |
| --- | --- | --- |
| Exact provider/contract/side/close and mirror-pair identity | safety invariant | A mismatch makes the row unavailable. |
| Same maker route and requested quantity for queue comparison | safety invariant | Earlier route/size differences are excluded from queue scoring. |
| Paper bankroll, reservation release, exact reporting P&L, and whole-cent control tie | accounting invariant | Any contradiction blocks the generation regardless of fidelity. |
| Twelve-second maker horizon and issuance cap | capital/risk ceiling and execution invariant | A grace may not extend either. |
| Acceptance and fill/no-fill agreement, capture, precision, quantity, price, and timing error | diagnostic fidelity measures | They can authorize a manual paper-model review, never funded execution. |
| Paper or live return | economic diagnostic | Reported intent-to-treat, but never optimized to select a fill calibration. |

A no-fill is a zero-spend execution outcome, not a losing investment. Contract `won`/`lost`/`invalid` is the later
economic outcome and may not be used to decide whether the simulated order filled.

## 3. Phase F1 — engineering parity and exact attribution

### 3.1 Queue-reset ownership

`queueClearFraction` represents cancellation/FIFO advance before the paper order joins a displayed queue. The
approved v1 calibration design says it applies at every queue join, including after a price-changing amendment.
The implementation applied it only to the initial queue.

F1 applies the pure bounded transformation whenever paper acquires a new displayed-ahead proxy:

- initial acceptance;
- recovery from unavailable initial depth when a later same-price snapshot becomes usable; and
- every price-changing amendment, which loses the old queue and joins the new level.

The active neutral value remains zero. With no calibration store, or with an explicit neutral calibration, every
fill, price, quantity, observation, completion time, and accounting result must be exactly identical. No execution
generation bump is justified for a behaviorally identical control repair. A future non-zero adoption still starts
a fresh generated cohort under `docs/paper-fill-calibration-design.md`.

### 3.2 Attribution boundary

Analysis and future candidate scoring use three separate states:

1. **acceptance:** no live venue order, post-only race, reconciled absence, or accepted order;
2. **accepted-order queue:** both lanes chose maker, requested the same quantity, and live has an accepted venue
   identity; and
3. **economic settlement:** a filled position later sold, won, lost, became invalid, or remained unresolved.

Post-only create races, reconciled-absent intents, route differences, quantity differences, open positions, and
ambiguous pair IDs never enter the queue-calibration denominator. The public performance record and existing
ledger rows remain immutable.

### 3.3 Exit gate

F1 is complete only when:

- a pure arithmetic grid pins zero, positive, cap-edge, non-finite, fractional, and floating-edge queue inputs;
- an explicit neutral calibration and the no-calibration path return exactly equal complete simulations;
- a positive calibration is proven to apply after a price-changing amendment as well as initially;
- the corrected evaluator reports exact accepted/same-route/same-quantity denominators;
- the rolling monitor proves polling coverage and keeps acceptance mismatch separate from queue fidelity;
- typecheck, all tests, and `git diff --check` pass; and
- no production paper order, execution identity, bankroll, public projection, or funded path changes.

Passing F1 authorizes only an F2 implementation proposal. It starts no candidate clock.

## 4. Phase F2 — prospective timing shadows

F2 adds two bounded observation-only candidates. They may share durable identity but have separate availability and
metrics. Neither writes paper status, fills, stake, reservation, or P&L.

### 4.1 Create/acknowledgement shadow

Model the part paper currently omits:

```text
paper intent
  → bounded create delay
  → exact public create quote and fixed passive limit
  → bounded acknowledgement delay
  → exact public acknowledgement quote
  → accepted or post-only race
```

The fixed generation is `paper-execution-timing-shadow-v1`: 400ms from durable observer start to its create quote,
then 250ms from completion of that read to its acknowledgement quote. It makes one attempt; it does not silently
copy live's three-attempt retry chain. These values and the candidate identity are committed before prospective
outcomes are inspected. The candidate uses only public exact-contract quotes. It never reads `venueOrderId`, live
status, or authoritative fills to choose its state. Live acceptance is joined afterward only as the scoring target.

Optional reads have a hard cap of six maker intents per calculation and three requests per assigned intent: two
one-request exact price/range quotes and one final trade-history read. Overflow, public backoff, malformed evidence,
or error is explicit `unavailable`; there is no retry. The continuously saturated upper bound is 18 reads per
calculation (1.2/s across 15 seconds), while the inspected 160-maker day implies 480/day (about 0.006/s). Evidence
starts only after the paper intent/reservation ledger write and is never awaited by paper management. Exhaustion or
error drops evidence rather than delaying paper management, signed order work, reconciliation, or settlement.

### 4.2 Read-after-horizon shadow

Keep the executable horizon exactly 12 seconds, then perform one final public trade-history read after an exact
three-second grace. The simulated order is already expired during the grace.

A recovered print is eligible only when:

- exact provider contract and aggressor side match;
- its venue `created_time` is at or after candidate acceptance and at or before the original `restingUntil`; and
- it is replayed against the limit and queue state that were in force at its venue event time.

A print after `restingUntil` is never a fill. Applying every late print to the final limit merely because it became
visible later is forbidden. Missing final evidence is `unavailable`, not a miss. The shadow retains a bounded
per-print identity/time/price/quantity set sufficient for exact replay; summaries alone remain the public report.

### 4.3 Milestones

- 10 independent windows: exact identity, request-budget, event-time cutoff, and unavailable wiring smoke;
- 100 exact maker-pair windows: at least 95% ordinary-control coverage and a complete explanation of candidate
  unavailability;
- 300 exact maker-pair windows, at least 30 observed live create races, 95% timing-candidate coverage, and no
  measurable production-latency or read-limit effect.

The acceptance confusion matrix reports accepted recall, false acceptance, and false rejection. The grace reports
how many in-horizon prints were first observed after the horizon, their observation lag, and resulting candidate
fill/quantity differences. Return is diagnostic and cannot select timing.

## 5. Phase F3 — prospective queue family

F3 begins only after F2 freezes retained acceptance and evidence-completion mechanics. It evaluates one immutable
family such as neutral control plus 10%, 20%, 30%, and 40% queue-clear fractions. Exact values are written before
activation; changing an arm starts a new family and cohort.

Each arm independently replays paper's bounded public quote, depth, amendment, and trade evidence. A candidate may
shorten displayed queue ahead only when joining that queue. It cannot invent a fill without a qualifying aggressive
print, use ask touch, use a live fill, or retain old queue priority through a price change.

Primary scoring is conditional on exact accepted same-route/same-quantity live makers. Report by independent UTC
settlement window:

- both / paper-only / live-only / neither;
- agreement, live-fill capture, and paper-positive precision;
- filled-quantity and fill-price error;
- unavailable evidence and route/quantity exclusions; and
- a predeclared Holm correction across non-control arms.

Milestones: 300 accepted-maker windows, at least 90% evidence availability for every retained arm, and 100 windows
where at least one candidate differs from control. If divergence is insufficient, record that result rather than
loosening the family after inspection.

## 6. Phase F4 — one combined held-out generation

After F2 and F3 reviews, freeze at most one acceptance model, one evidence-grace rule, and one queue fraction into
an independent combined shadow. Every component maintains causal state from paper evidence after divergence; it
cannot splice in production queue, fill, or outcome state.

Require at least:

- 300 exact-pair independent windows;
- 100 materially different execution outcomes;
- 90% complete required public evidence;
- improved end-to-end disagreement with no material precision, quantity, price, or timing regression;
- exact reporting and whole-cent bankroll-control dry-run ties;
- zero import/read path from live outcomes into the paper decision; and
- a written rollback and public-cohort interpretation.

A successful review permits only a separate manual adoption request. Adoption starts a fresh paper execution
identity, never rewrites v6, and requires build/restart/deployment procedures appropriate to a running worker. It
does not change funded execution. A null review leaves neutral v6 active and is recorded with equal care.

## 7. Files and phase ownership

| Phase | Primary paths |
| --- | --- |
| F1 | `src/lib/paper-fill-calibration.ts`, `src/lib/paper-maker-simulation.ts`, `src/lib/paper-maker-fill.test.ts`, corrected paper analyzers and report |
| F2 | `src/lib/paper-execution-timing-shadow.ts`, `src/lib/paper-execution-timing-shadow-store.ts`, `src/lib/paper-execution-timing-observer.ts`, isolation/pure/store tests, and `scripts/analyze-paper-execution-timing.mjs` |
| F3 | detached queue-family replay/store and held-out analyzer; no paper accounting imports |
| F4 | combined shadow evaluator, immutable review manifest, and only after approval a new execution generation |

Observation stores introduced by F2–F4 remain detached from policy, persistence, portfolio, sizing, budget,
reconciliation, settlement, control, and orders. Stateless hosts have no writer. Archives must include any new
durable tier before activation.

## 8. What this plan does not authorize

- Faster polling throughout the 12-second maker horizon.
- Extending the executable horizon beyond 12 seconds.
- Copying a live acceptance or fill into paper accounting.
- Retrospective calibration from the inspected loss cohort.
- Optimizing a fill model for paper profitability.
- Authenticated queue-position reads without a separately proven request budget.
- Rewriting prior paper rows or pooling execution generations.
- Any live rule, route, retry, capital, safety, reconciliation, or authority change.
