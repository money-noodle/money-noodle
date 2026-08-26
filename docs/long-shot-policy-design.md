# Long-shot round-trip policy — design

> **Document type:** Policy design
> **Design status:** Retired
> **Implementation:** Removed
> **Created:** 2026-08-14
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> Draft 1 · 2026-08-14 · **Retired 2026-08-26**
> Product scope and safety doctrine live in [`SPEC.md`](../SPEC.md). This is the preserved historical
> design for a policy that was implemented paper-only and then removed after its precommitted review.
> Final evidence and decision: [`reports/long-shot-v2-final-review-2026-08-26.md`](../reports/long-shot-v2-final-review-2026-08-26.md).
>
> Retirement removed execution, polling, evidence writes, strategy-level allocation, UI/API, Postgres
> replication, and strategy-specific estimation tools. Durable history and the retired ledger identity
> remain; no edge-policy rule or capital ceiling changed.

## 1. What this is

A second policy on the existing `crypto-15m` market, running beside the current edge policy. It buys a
15-minute contract when one side becomes very cheap early in the cycle and sells it into a large upward
excursion before settlement. It is a volatility-harvesting strategy, not a directional one.

Two named approaches, deliberately separated:

| | Entry | Exit | Lane |
|---|---|---|---|
| **(i) round trip** | side's ask ≤ low mark, early in cycle | resting sell at the high mark | **executes** — paper and live |
| **(ii) hold** | identical trigger | settlement | **evidence only** — no orders, no budget |

(i) is the policy. (ii) is the counterfactual arm of (i)'s exit decision, priced from the settled venue
outcome, and is the direct analogue of the existing `action-counterfactual-v1` HOLD arm.

## 2. Why this is a policy, not a model or a market

It trades the same contracts, on the same venue, in the same market. It consumes no `P(UP)`: the trigger
is a venue price and a clock. So the axis being added is a **policy**, and the durable key is `strategyId`,
alongside the existing `marketId` and `executionMode`.

This preserves the 2026-08-13 decision that the forecast model is keyed by market and never by provider or
strategy. One forecast, one collector, one contract registry, one journal; two policies reading them.

Its candidates are disjoint from the edge policy's by construction. Buy policy v17 requires
`P(side) ≥ 55%` with net edge in `[5pp, 35pp]`; a 10¢ ask against a 55% probability is a 45pp edge that the
max-edge ceiling rejects as implausible. No parameter change to v17 could express this policy, and no
candidate can be claimed by both.

**These are not "positive-edge candidates."** §3.7 defines that stream as model calculations passing the
buy policy, and it feeds Brier score, log loss and calibration. Long-shot intents carry no model
probability; recording them there would corrupt the only track record used to judge the model. They are a
separately named intent stream, scored on their own terms.

## 3. Arithmetic

### 3.1 The book identity

Kalshi's two sides share one book: `ask(DOWN) = 100¢ − bid(UP)`, and `ask(UP) + ask(DOWN) > 100¢` always.

Three consequences, all load-bearing:

- **Both sides can never be cheap at once.** A simultaneous double-cheap arbitrage cannot exist.
- **Buying the opposite side cheap is a synthetic exit.** Holding UP bought at 10¢ and buying DOWN at 10¢
  (which requires `bid(UP) = 90¢`) locks the same profit as simply selling UP at 90¢, but ties up capital
  until settlement. Prefer the real exit; retain the synthetic only as a fallback when the sell side of the
  book cannot fill.
- **A same-window opposite-side re-entry is not a special case.** It is the ordinary rule firing again on
  whichever side is now cheap.

### 3.2 Fees

`fee_cents = max(1, ceil(7 × quantity × p × (1 − p)))`, charged on both legs. Two properties matter here
and neither applies to the edge policy:

- **Fees peak at 50¢ and shrink toward both extremes.** Selling at 90¢ costs less than selling at 80¢.
  Selling further out is cheaper as well as more profitable.
- **The 1¢ minimum and the ceiling are a small-order tax.** On a 20¢ ticket the true fee is ~1.1¢ and 2¢ is
  paid. The same trade on a 200¢ ticket breaks even at 10.6% instead of 11.1%.

### 3.3 Break-even, at a 20¢ ticket

See §12.1 for how the ticket is sized. 20¢ is the opening value at the proposed allocation.

| Buy | Sell | Contracts | Net on a win | Touch rate needed | Hold needs |
|---|---|---|---|---|---|
| 5¢ | 90¢ | 3.60 | +301¢ | 6.2% | 5.6% |
| **10¢** | **90¢** | **1.80** | **+140¢** | **12.5%** | **11.1%** |
| 10¢ | 85¢ | 1.80 | +131¢ | 13.2% | 11.1% |
| 15¢ | 85¢ | 1.20 | +80¢ | 20.0% | 16.7% |

The ratio of exit break-even to hold break-even is ~1.1–1.2 and improves at deeper discounts, because
selling at 90¢ after buying at 5¢ forfeits 10% of the payoff while selling at 80¢ after buying at 20¢
forfeits 20% of a far smaller multiple.

**Selling early beats holding whenever the touch rate exceeds the win rate by that ratio.**

> **Corrected 2026-08-17 (§14b).** The original argument here was that this holds *structurally*: every
> contract settling YES passes through 90¢ on its way to 100¢, so every winner is also a toucher. **That is
> false for this market.** These contracts settle on a price comparison at the close, so the final move to
> 100¢ happens *at* settlement rather than through the book. Measured over 1,033 resolved windows with a
> sample inside the last 30 seconds, the winning side was still bid **below 90¢ in 10.0% of cases**, and
> below 10¢ in 0.8%. A contract can trade at 25¢ with seconds left and settle in the money.
>
> The touch rate is therefore *not* strictly greater than the win rate, and about a tenth of winners are
> reachable only by holding. Measurement has since confirmed the direction the correction implies: paired
> on identical triggers, never selling beat the 90¢ exit by +0.088 per $1 (t=1.76). The claim that selling
> early beats holding is **unsupported**, and the exit-versus-hold comparison in §10 is the only thing that
> can settle it.

Near-misses that run up and fall back still favour the touch rate, and by how much remains the open
question; the structural guarantee does not exist.

**These break-even rates are conservative, and deliberately so.** They price a miss as a total loss, which
it is not: with no fallback exit, a position that never reaches the mark simply settles, exactly as the hold
arm does, and at a 10¢ entry it settles in the money about a tenth of the time. The true break-even touch
rate is therefore lower than the table states. The table stands as written because too hard a bar is the
safe direction to be wrong in, but no decision should rest on it — §10's sentinels compare realized return
per $1 staked on identical triggers, which needs no assumption about misses at all.

The cost of selling early is the mirror of the same point: capping a winner at 90¢ forgoes settlement at
100¢, and the contracts that reach 90¢ are exactly the ones most likely to settle in the money. Both
directions are real, which is why this is measured rather than argued.

**Launch marks: buy ≤10¢, sell 90¢.** Break-even 12.5%, roughly 1 in 8.

## 4. What screening established, and what it cannot

Retroactive screening over the forecast journal (2,052 resolved Kalshi cycles, 7 assets, 3.6 days).
Per §12.5 this may filter an idea and may never promote one.

**Established — buy-cheap-and-hold has no edge.** At a 20¢ entry, 119 candidates won 20.2% ± 3.7pp against
a 22.2% break-even. The cheap side wins about exactly what it costs; the market is efficient there and
approach (ii) is very unlikely to be profitable on its own. This is why (ii) collects rather than trades.

**Established — the prior-cycle filter fails in both readings.** "Prior cycle reached the high mark" passes
86–92% of candidates and does not improve the hit rate (14.4% → 12.1% at a 20¢ entry), because every winner
passes through 90¢, making it "did this side win recently" in disguise. "Prior cycle completed the full
round trip" occurs in 0.00–0.39% of cycle-side pairs and passes ~2% of candidates, producing zero
candidates at the 10¢ mark over 3.6 days.

**Not established — anything about the exit.** The journal samples qualifying calculations every 15 seconds
and everything else about once a minute; the median gap is 52 seconds and the median last sample lands 55
seconds before settlement. Winners were observed reaching 80¢ in only 76.6% of cases and 90¢ in 68.4%.

> **Corrected 2026-08-17 (§14b).** Those figures were read as coverage against a "must be 100%" baseline,
> and that baseline is false — see the correction in §3.3. Roughly a tenth of the shortfall is a settlement
> discontinuity no sampling rate can see, not sampling blindness, so 68.4% cannot be converted into a
> 1.36× correction. The like-for-like measurement (dense 1s paths decimated to 15s) puts the blindness at
> **1.00–1.25×** where it can be read at all. Touch rates from screening remain **floors** — that part
> stands — but the floor is much closer to the measured value than these figures implied.

Candidate frequency is a genuine market measurement rather than a trade-conditional one, because the
journal records calculations and carries both sides' asks regardless of whether anything traded. But it is
undercounted for the same reason, and undercounted worst at exactly the deep marks this policy uses, since
an extreme price is when the edge model does not qualify. **~4 candidates/day at the 10¢ mark is a floor.**

**A promising lead, not a result.** The `cycleRegime` label already recorded on every row separated the
outcomes better than either prior-cycle rule — `mean-reverting` windows hit 66.7% (n=3) at a 15¢ entry and
25.0% (n=8) at 20¢ against 7.7% and 14.4% baselines. The sample is far too small to act on and `trending`
also beat baseline at 20¢. It costs nothing to keep recording.

## 5. Lanes and the mirror invariant

The rule layer must not regain an execution-mode parameter; `lib/mirror-invariant.test.ts` asserts its
absence by arity precisely so a paper/live divergence cannot be expressed. This policy is a separate module
with its own rule functions, so the invariant then holds **within** it: the long-shot paper and live lanes
make identical entry and exit decisions and differ only in fill and capital.

Five lanes result:

| Lane | Policy | Money | Answers |
|---|---|---|---|
| edge live / edge paper | v17 | real / simulated | unchanged |
| **long-shot live / long-shot paper** | this | real / simulated | did the round trip pay, and what did execution cost? |
| evaluation | candidates, incl. **(ii)** | none | should anything change? |

Per-**policy** asset exclusion is legitimate; per-**track** exclusion is what the invariant forbids.

## 6. Keying — what forks and what does not

Budget follows the existing chain with one more level of the same shape: **provider → market → policy**,
each a percentage of the level above, summing to ≤100% with any remainder uncommitted. Percentages rather
than fixed amounts, so a policy's ceiling compounds with its wins and contracts in its own drawdown without
manual edits, exactly as market allocations already do against provider equity.

A separate slice is also what makes "is this policy any good?" answerable — return on allocated capital
becomes comparable across policies — and what makes a per-policy loss stop meaningful.

| Forks per policy | Stays global |
|---|---|
| Entry, exit, sizing, execution style | Position / same-window / correlation caps, counted across both books |
| Bankroll, reservations, ledger, P&L | Kill switch, reconciliation barrier, quiescent drain |
| Operator intent (arm/pause), loss stops | Hourly filled-order ceiling, serialized live execution queue |
| Asset exclusions | Provider cash — a slice of the market cap, not a separate pool |

Splitting the budget does not split risk. Exposure caps stay keyed by market and global across providers
and policies, because risk is exposure to the underlying: two policies each holding a full allowance of the
same correlated window would silently multiply intended exposure.

## 7. Entry

1. The selected side's **executable Kalshi ask** is at or below the low mark. Not the midpoint, not the
   opposite side's ask, not a model probability.
2. **Time remaining** is at or above the entry threshold — expressed as time remaining, not time elapsed,
   because what makes a comeback possible is how much clock is left for it. Identical to "first N minutes"
   on a first entry, and correct for re-entries, which time-elapsed is not.

   **The threshold is 600 seconds: the first five minutes**, widened from three after measurement. The
   first hour of live collection suggested the window rather than the price mark was throttling flow —
   cheap sides were common, cheap sides *early* were not — and screening confirmed it. At the 10¢ mark,
   moving from three minutes to five raises candidates from 2.9/day to **15.9/day**, which turns 60
   attempts from roughly three weeks into about four days.

   The surprise is that quality does not pay for it. Bucketed by when the entry appeared, the rate of
   reaching 90¢ is flat from three minutes onward — 4.2% entering at 180–300s, 5.0% at 300–420s, 4.6% at
   420–600s — against a noisy 15% (n=20) at 120–180s. The intuition that a comeback needs more clock is
   not visible in the data out to ten minutes remaining. If flow is still short later, the same evidence
   would support going wider; it does not support going narrower.

   These touch rates remain floors, and all of them sit below the 12.5% break-even. That is the honest
   state of the evidence and the reason the policy is collecting rather than being judged on it.
3. No open long-shot position on the same asset and window (§9).
4. Global exposure caps, provider funding, reconciliation health and the kill switch all pass.
5. **No prior-cycle filter at launch.** Both readings were measured and failed, and at the 10¢ mark the
   candidate flow cannot support a selective filter before there is data to choose one.

**Execution is a price-capped taker IOC at the mark.** Production is maker-only for the edge policy, and
this is a deliberate exception rather than an oversight. The trigger here is *defined* as "the executable
ask reached the low mark," so taking that ask is intrinsic to the strategy rather than a choice of
execution style, and every break-even figure in §3.3 already assumes paying it. A post-only bid at the mark
would cross the ask and be rejected; a bid one tick below would rest and frequently not fill, which defeats
the thesis the same way a fifteen-second exit poll would — the side is cheap precisely because price is
moving away from it.

The primitive is `placeKalshiTakerBuy`, which refuses to submit when the current ask exceeds the approved
cap, so this can never pay more than the mark. Kalshi charges the same fee either way, so the cost of
taking is the spread alone, which the entry mark already bounds.

## 8. Exit

**A one-second poll of the owned side's bid, submitting a reduce-only IOC at the mark when it is reached.**

This was designed as a resting reduce-only GTC limit placed at entry fill, which would have filled on a
spike unattended. **Kalshi refuses that combination.** Verified against the production API on 2026-08-15
with a 0.01-contract probe at 95¢ against a 9¢ bid:

```
400 invalid_order: "reduce_only can only be used with IoC orders"
```

Reduce-only is the invariant that matters most here — a sell that is not capped by the position is a sell
that can open reverse exposure — so it is the resting order that gives way, not the safety property.

The replacement polls, which the original design rejected on the grounds that a round trip inside 90
seconds is invisible to a 15-second poll. That objection was to the *cadence*, not to polling: at one
second a 90-second excursion is sampled about 90 times, and only a sub-second spike is missed. Each tick
costs one request per held contract — the owned-side bid comes from the two YES prices, so no order book is
read — shared through the quote cache with the one-second entry pass.

The exit is polled faster than it strictly needs because the asymmetry favours it: missing the single tick
where a position touches the mark costs that entire trade, while missing an entry costs one candidate out
of many.

Two consequences are worth stating rather than discovering later:

- **The exit now depends on the process being alive.** A resting order would have worked through a crash,
  a restart, or a network partition; a poller does not. An unfilled position simply settles, so the failure
  mode is a missed profit rather than an unbounded loss, but it is a real cost of the change.
- **The reduce-only IOC path already exists and is tested.** `placeKalshiSell` is the same primitive the
  edge policy's standalone exits and switches use, so this adds a poller rather than new venue machinery.

The submitted limit is the mark, so a bid that retreats between observation and submission produces no fill
rather than a worse one; the next tick re-evaluates.

An unfilled position at close simply settles. **There is no fallback exit and no stop-loss.** A mid-window
"sell at any price" would forfeit the thesis, and its absence has a useful structural consequence (§9).

## 9. Re-entry

Multiple round trips per cycle are intended and must not be blocked. The order ledger already supports this
through `:reentry:N` generations.

**Because the only exit is the profit target, the policy is only ever flat after a win.** A losing position
never exits; it is held to settlement. So entry N+1 within a window can only follow a profitable exit from
entry N, and a trending window produces exactly one loss rather than a compounding series. There is no
martingale to defend against.

What must still be forbidden is **a second open position on the same asset and window** — that is averaging
down, and it is the one shape that would compound a loss.

Related: the ticket is computed once per settlement window from equity at window open and stays **fixed**
for every entry in that window. Rolling a round trip's winnings into a second bet in the same window is
compounding inside a single correlated event. Across windows the ticket floats with equity (§12.1), so it
still grows as the policy earns — just never off the profit of the window it is currently trading.

A second entry in a window carries direct evidence that this window whipsaws, which is a fresher and better
version of what the prior-cycle rule was reaching for. Entry generation is tagged on every record so
first-entry and re-entry cohorts stay separable and that hypothesis is testable.

## 10. Approach (ii) — the hold arm

Recorded as an **immutable sentinel at trigger time, not at fill time.** Derived from actual fills it would
inherit every selection bias of (i) — budget exhaustion, cap blocks, maker no-fills — and would measure
"hold, conditional on having successfully bought," which is a flatteringly selected and different question.
Written at decision time it also captures candidates (i) could not take, which is both more and cleaner data.

Each sentinel records the exact contract, side, both sides' books, fees, clock, and the eventual settlement
outcome. Because settlement is authoritative, the hold arm is **exact**, not approximate.

Fill realism is reported as a separate coverage figure rather than folded in: (i) runs in paper and live on
the identical trigger, so real fill evidence accrues alongside at no extra cost.

## 10a. Repairing the hold arm, 2026-08-17 — it was reporting a number it never measured

§10's design is sound and its implementation was silently inert. This section records the defect, the fix,
and a second measurement added beside it. **This changes no rule, no parameter, and no execution path.**

### The defect

`collectLongShotEvidence` returns `{ sentinels, outcomes, observedAt, skipped }`. It never returns
`peakBids`, which is the field `updateHoldSentinelStore` reads to record how high a sentinel's owned-side
bid ever went. So no sentinel has ever carried `peakOwnedSideBidCents` — 0 of 26 in the current cohort.

Everything downstream follows mechanically:

| step | result |
| --- | --- |
| `reachedExitMark(sentinel)` | `(undefined ?? 0) >= 90` — **always false** |
| `roundTripReturn(sentinel)` | always falls back to `holdReturn(sentinel)` |
| `roundTrip` arm | **identical to `hold`, by construction** |
| `advantage` | **identically 0** |
| `roundTrip.rate` | **identically 0%** |

Built against the live store the whole report reads `hold` −100%, `roundTrip` −100%, `advantage` 0. The
dashboard renders that as *"Round trip … reached 0.0%"* and *"Selling early beats holding by +0.0% per $1
staked."*

**A zero that means "never measured" is worse than a gap**, because it is indistinguishable from a measured
null and it is the exact figure this policy exists to determine. It is also the figure §3.3's retracted
structural argument was standing in for, so nothing was checking it.

### The fix, in three parts, shipped separately

**Part 0 — stop asserting the zero.** `HoldSentinelReport` gains `peakObservedSamples`. Where it is zero the
round-trip arm has no input, and the surface reports *unmeasured* rather than a number. This ships alone and
first: it is a live correctness defect, and it must not wait on the measurement that fills the gap.

**Part 1 — record the peaks.** `collectLongShotEvidence` returns `peakBids`, keyed by sentinel id, deriving
the owned-side bid from the shared book as `100¢ − oppositeAsk` — the same expression §3.1 gives and
`longShotEntry` already uses. Two constraints are load-bearing:

- **Strictly after the decision point.** Only sentinels observed on an earlier cycle are updated. Including
  the entry tick would fold the decision quote into the peak and make the arm mildly self-fulfilling.
- **This arm is sampled at the collection cadence, not the exit cadence.** The one-second poll exists to
  sell *open positions*; a sentinel holds nothing to poll. So the sentinel round-trip arm is a **floor**,
  measured at fifteen seconds, and must be labelled as one wherever it is shown. §14b's measurement bounds
  that floor at 1.00–1.25× on the evidence available.

**Part 2 — a second, paired arm over executed orders.** The sentinel arm is unbiased by execution but coarse.
The order ledger is the reverse: selected by what actually filled, but recording real fills, real fees, and
the one-second exit. `buildLongShotReport` gains `exitMinusHold`, computed uniformly over settled orders:

```
settledSide  = order.outcome ?? order.counterfactualHoldOutcome
holdPnlCents = (settledSide === order.side ? order.potentialPayoutCents : 0) − stake
difference   = pnl(order) − holdPnlCents
```

Three properties make this safe rather than fiddly:

- **Never-sold orders yield exactly zero**, because their realized P&L *is* the hold outcome. No branch is
  needed, and a nonzero difference on an unsold order means something upstream is wrong — which a test pins
  as an invariant rather than a case.
- **The stake cancels**: `exit − hold = saleProceeds − settlementPayout`. So §1's two P&L views cannot mix
  in the numerator. Confirmed against the only real sold order: stake 13¢, payout 120¢, proceeds 107¢ →
  `94 − 107 = −13` and `107 − 120 = −13`.
- Two figures are reported, because they answer different questions: **over every settled attempt** ("does
  having the exit rule help?", the decision-relevant one) and **over attempts where the exit fired** ("when
  it fires, is it right?", diagnostic, far smaller n). Both clustered on the settlement window.

Two exclusions are **counted and surfaced, never silently dropped** — a missing counterfactual that reads as
zero would say selling was free:

- `unresolvedCounterfactual` — sold, but neither `outcome` nor `counterfactualHoldOutcome` has resolved yet.
- `partiallyExited` — `exitVenueOrderId` set with status not `sold`. The partial branch of `runLongShotExits`
  reduces the parent's quantity, payout, and stake **and discards the sold portion's proceeds**, so that
  order's P&L record is genuinely incomplete. Live-only today, since paper always exits the whole position,
  and the live lane is unarmed. Recorded here as a known record gap rather than repaired inside this change.

### What the surface must show

- The assertion *"Selling early beats holding by X"* is replaced by a neutral, signed **"Exit vs hold"**. The
  sign can go either way, and on current evidence it leans negative; copy that only reads correctly when the
  answer is positive is a way of not noticing.
- The **paired standard error**, which the surface currently omits. `advantage` is a difference of two
  clustered means shown with no uncertainty at all, while the per-arm errors overstate the noise — pairing
  cancels the window-level variance, and measured on paths it tightened the same comparison from ±0.48 to
  ±0.05.
- **Both arms, labelled and never summed**: triggers *(15s, unbiased by execution)* and executed orders
  *(1s, realized money)*, each with its sample count, so neither is read as corroborating the other.

### An open discrepancy, recorded not resolved

`hold.rate` is 0: none of 26 resolved sentinels settled in the money, and the order ledger agrees at 0 of 24
unsold attempts. §14b's path cohort puts the settle-in-the-money rate for ≤10¢ candidates near 10% (5 of 49).
At p=0.10 a 0-of-26 run is a 6.5% event, so small samples may be the whole story — but the two routes are
measuring the same thing and disagreeing, which §6 says to report rather than reconcile by preference. It
should be settled before either figure is read at the 60-attempt review; a cohort-definition difference and
an outcome-mapping error would both produce exactly this.

## 10b. Repairing trigger capture, 2026-08-19

The v1 collector outlived its original collection-only implementation. `collectLongShotEvidence` still ran
on the 15-second dashboard, stamped every record `executed: false` with “the execution path is not wired in
yet,” and raced the one-second trailing entry path that actually placed paper orders. First-write-wins then
made the stale record immutable. The faster entry path could also fire between dashboard samples, leaving
an execution with no sentinel at all. Under the active 12¢→97¢ policy, nine paper orders existed while only
two sentinels existed, both carrying the obsolete unexecuted reason. That cohort cannot support a paired
review and is not backfilled.

`long-shot-hold-v2` starts a fresh prospective measurement with one authoritative decision point:

- `runLongShot` builds the sentinel inside the paper entry decision from the same quote, sizing,
  generation, fee, and policy version used to build the order. This covers both its regular-cycle caller
  and the faster trailing caller without reconstructing either decision on a different cadence.
- A qualifying paper order is stamped with the sentinel version before it is written to the shared ledger.
  The ledger is made durable first; the sentinel store is then updated. The detached evidence pass
  reconstructs only version-stamped orders, so a failed store write is recovered without admitting old
  fills retrospectively.
- A trigger that clears the entry rule and venue sizing but is refused for strategy headroom is recorded
  `executed: false` with that exact reason. Policy disqualifications remain non-triggers.
- The former 15-second collector no longer creates trigger records. It only reconciles version-stamped
  decision records, observes later peak bids, and resolves settlements.
- v1 rows remain immutable historical evidence. They are excluded from the v2 review rather than rewritten
  to agree with the order ledger.

This changes observation wiring only. Entry marks, trailing, caps, sizing, paper execution, live arming, and
exit behaviour are unchanged.

## 10c. One deterministic entry owner, 2026-08-19

The trigger-capture repair exposed two competing entry callers. The regular 15-second `processCycle` called
`runLongShot` directly on dashboard quotes, while `longShotEntryTick` refreshed at one second, waited for a
fall to stall, and then called the same function. The serialized queue prevented concurrent writes but did
not make the decision deterministic: whichever caller arrived first decided whether trailing applied.
All nine 12¢→97¢ paper orders happened to carry trailing evidence, but nine selected outcomes cannot prove
the bypass inert.

The maintainer chose trailing as mandatory:

- `longShotEntryTick` is the sole caller allowed to enter, for both paper and live.
- `processCycle` still refreshes the dashboard identity set and handles evidence, exits, settlement, and the
  other strategy, but cannot call `runLongShot`.
- The entry poller continues to refresh exact-contract quotes outside the serialized queue. Only a side in
  its `buyable` set after `evaluateTrailingEntry` may reach the paper/live decision.
- `LONG_SHOT_POLICY_SCHEME` advances to v2. Although the intended trailing implementation already existed,
  removing a timing-dependent bypass changes the set of reachable entries and therefore starts new order,
  hold-sentinel, and review cohorts.
- Live remains separately disarmed. This restriction does not grant authority, increase a cap, or change
  sizing and exit behavior.

A source-level invariant test protects sole ownership because the defect was duplicate runtime wiring, not
an error inside the trailing arithmetic.

## 11. Evidence design

The two parameters we know least about are the sell mark and the entry filter. Both are chosen once and
would be expensive to re-litigate, so the recording is designed to avoid committing to either:

- **Maximum bid reached** while each position was open — not merely "did it hit 90¢." One dataset then
  evaluates *every* candidate sell mark retrospectively, and the optimum can be found without re-running.
- **The last three cycles' peak bid for that side**, and whether each had a cheap entry available — so
  every version of the prior-cycle rule, including both measured readings, stays evaluable.
- **The full `cycleRegime` block** at entry, carrying the current lead.
- **This cycle's realized contract path**, at the collector's full cadence.

A contract price-path recorder — both sides' Kalshi bid and ask, every 15 seconds, for every active window
regardless of qualification — is worth building alongside, following the pattern `data/cycle-paths.json`
already uses for the underlying. It is pure observation with no execution authority. Roughly 2 MB/day, so
it must be an append-only journal with rollups from the start, given that forecast storage residency is the
current top priority.

## 12. Risk controls

Concurrency is the wrong primary control here. The edge policy holds few large correlated positions, so
"how many at once" is exactly right for it; this policy's premise is that a small edge appears only across
many independent tries, and capping concurrency attacks the mechanism. **The ticket and the burn rate are
the controls**, and every one of them is expressed in a single unit.

### 12.1 The ticket is the unit of risk

**Ticket = this policy's current equity ÷ 30, floored at 10¢**, recomputed at each settlement window's open
and held fixed within that window.

The ticket is deliberately *not* derived from the edge policy's all-in purchase cap. That cap was sized
around a different policy's three-position limit, and deriving from it creates a hidden dependency: lowering
the edge policy's per-trade size for reasons of its own would silently halve this policy's ticket.

The divisor is the **drought this policy must survive**. At a 12.5% hit rate, 20 consecutive losses occurs
6.9% of the time and 30 occurs 1.8%, so 30 leaves comfortable room to be unlucky without being stopped out
of a working strategy. Expressed this way the parameter is arguable on its merits; "3% of the slice" is not.

Because it floats with current equity, the runway stays at 30 losses whether the policy is up or down.

**The 10¢ floor is not arbitrary.** The `max(1, ceil(...))` fee makes small tickets fee-dominated. At a 10¢
entry and 90¢ exit: a 20¢ ticket and a 10¢ ticket both break even at 12.5%, a 5¢ ticket needs 14.3%, and a
3¢ ticket needs 17.6%. Below 10¢ the fee floor eats the edge being traded, so the policy stops rather than
trading fee-dominated scraps.

### 12.2 The loss stop is derived, not chosen

Those two rules together *are* the stop: the policy halts when equity falls below 300¢, because it can no
longer fund a viable ticket with adequate runway. That is roughly a 50% drawdown of its slice, reached after
about 21 consecutive losses — around 6% likely on bad luck alone.

The existing 25% drawdown stop must not be reused. It is calibrated for the edge policy and would fire here
after five consecutive losses, which at a 12.5% hit rate happens **55%** of the time. Copying it would
strangle the policy with ordinary luck and teach us nothing.

### 12.3 Per settlement window

**No separate dollar cap is required.** Two existing rules already bound it: one open position per
asset/window (§9), and re-entry only after a profitable exit. Maximum loss per asset per window is therefore
exactly one ticket, no matter how many round trips occur.

A concurrency cap across assets is still wanted, but **the edge policy's correlation groups are the wrong
instrument and must not be reused here.**

`cryptoExposureGroup` is a market-cap beta tier — majors (BTC, ETH), layer1-beta (SOL, BNB, HYPE),
alt-beta (the rest). It encodes *directional* correlation: assets that trend together. This policy does not
trade direction, it trades reversal, and the two are measurably different.

Screening separated them. Candidate **arrivals** are strongly correlated — at a 20¢ entry, 41% of settlement
windows carry more than one candidate and some carry six, which is a market-wide move making many cheap
sides cheap at once. Candidate **outcomes** are close to independent: over 103 co-occurring pairs, both
missed 75.7% of the time against a fully-independent prediction of 74.0%, and both reached the target 2.9%
against 2.0%. The trigger is shared; whether each contract then recovers across its own cycle-open reference
is largely idiosyncratic.

Two consequences. The drought runway in §12.1 survives concurrency, because 30 tickets remains roughly 30
independent tries however they are distributed across windows. And group-based rationing would cost far more
than it buys: 18 of 25 multi-candidate windows had at least two candidates sharing a group, concentrated in
`alt-beta` — the high-fluctuation assets this policy most wants, excluded for a directional reason that does
not apply to it.

**At most 3 open positions per settlement window, with no correlation-group restriction.** The count still
earns its place: near-independent is not independent, the finding rests on one measurement with 3 observed
both-hits and undersampled touch detection, and a six-candidate burst would commit 20% of equity to a single
15-minute event. Three bounds the worst case at 10% of equity while binding only in the top ~13% of windows,
and at the 10¢ launch mark would have bound once in 3.6 days.

Maximum loss per settlement window is therefore **3 tickets**. This cap is explicitly provisional — the
path recorder (§11) will measure outcome correlation properly, and if independence holds the cap can rise.

### 12.4 Per day

A **daily net-loss cap of 10 tickets** — one third of the drought runway.

Note this is a loss cap, not a spend or entry cap. A spend cap would throttle the policy exactly when it is
winning and re-entering, which is the opposite of the intent.

At the measured flow of roughly 4–8 entries per day it can barely bind, and that is the point: it is a
circuit breaker against pathological behaviour — a misfiring trigger, or candidate flow far above anything
screening measured — rather than a throttle on ordinary losing. **If it fires, something is wrong and it
deserves a human look**, which is precisely the signal a daily cap should carry.

### 12.5 Sizing the learning budget

Distinguishing "1 in 8" from "1 in 20" — real versus hopeless — takes about 60 trades. Distinguishing
1-in-8 from 1-in-9 would take roughly 2,000, and is not the question being asked. Sixty trades at 20¢ is $12
of turnover; if the policy is half as good as break-even, finding out costs about $6.60. **That is the real
design parameter: budget roughly $7–12 to learn whether this is real**, and do not expect the result to pin
down the exact hit rate.

## 13. Asset exclusions

XRP is currently in `MONEY_NOODLE_EXCLUDED_ASSETS`, removed after clearing −2se on both tracks (live −45.7%
over 41 windows, paper −35.1% over 81). That is evidence about a **directional** policy. Unpredictable
direction is precisely what would make an asset good for a volatility-harvesting one, so the exclusion is
policy-specific and does not bind here. This policy launches with an empty exclusion list.

This is a deliberate partial reversal of a live decision and belongs in the decision log.

## 14. Review and promotion

This policy executes from launch under the sized learning budget rather than accruing sentinel evidence
first. That is a deliberate operator decision, taken with the §12.5 doctrine understood: retroactive
figures may screen but never promote, and the 2026-08-13 DOWN suspension is the standing example of a
retroactive number failing to reproduce a day later.

What that doctrine still governs here: **no parameter of this policy may be changed on retroactive
evidence.** The launch marks are fixed until forward evidence over independent settlement windows says
otherwise, and any change is a versioned, recorded, manual act. The recording in §11 exists so that when
the marks are revisited, the evidence is forward-collected rather than re-derived.

The launch rule opened a first review at **60 resolved round-trip attempts**, reporting touch rate against
the 12.5% break-even, clustered by settlement window, split by entry generation and by regime label.

**Active-v2 review amendment, 2026-08-21.** The operator committed
`long-shot-round-trip-buy12-sell97-win600-v2` through the stricter `long-shot-hold-v2` boundary of **60
independent settlement windows**. The execution report's existing 60-attempt indicator remains a diagnostic
and cannot open or end that review. Marks, entry window, trailing rule, sizing, and cohort identity remain
fixed; no interim economic result tunes or stops collection, and live arming remains false. Ordinary safety
controls retain authority to halt execution. At commitment the cohort had 30 resolved attempts across 13
windows, one hold win, zero target exits, and −763¢ exact realized P&L on 1,135¢ staked; the −59.1% ±40.9pp
clustered standard error was broad enough that completion is evidence collection, not endorsement.

## 14a. First parameter sweep, 2026-08-16 — no configuration clears break-even

> **Retained as the record; its coverage figures are withdrawn by §14b (2026-08-17).** The conclusion below
> stands and was reproduced on better data. The "68.4% where the true figure must be 100%" reasoning at the
> end of this section does not — read §14b before using any correction factor from here.

Run `npm run analyze:long-shot-marks`. Over 757 recorded windows, with the still-falling cohort excluded:

| entry | exit | n | touch | break-even | ratio |
|---|---|---|---|---|---|
| 10¢ | 90¢ | 13 | 7.7% | 10.7% | **0.72** |
| 20¢ | 90¢ | 96 | 14.6% | 21.1% | 0.69 |
| 15¢ | 90¢ | 48 | 10.4% | 16.3% | 0.64 |
| 25¢ | 50¢ | 150 | 27.3% | 47.4% | 0.58 |
| 20¢ | 30¢ | 96 | 32.3% | 67.1% | 0.48 |

**The flatness is the finding, not the best cell.** Every one of the sixteen combinations lands between
0.48 and 0.72: lowering the exit raises the touch rate almost exactly in proportion to raising the
break-even, and widening the entry mark does the same. That is what an efficiently priced book looks like.
It also means further tuning is the wrong response — a sixteen-cell grid containing an exploitable edge
would show it somewhere.

Two things keep this from being a verdict:

- **Every touch rate here is a floor.** Fifteen-second sampling cannot see a spike between samples, and
  winners were observed reaching 90¢ in 68.4% of cases where the true figure must be 100%. Closing the best
  ratio needs 1.39× more touches; the measured coverage shortfall is 1.36×. Uncomfortably close, though
  "around break-even after fees" is not a business either.
- **The best cells have the smallest samples.** The 10¢ rows are n=13; the n=150 row sits at 0.58, and the
  ratio tends to worsen as the sample grows.

The one-second entry polling added the same day is what removes the sampling bias. Re-run this sweep
against paths recorded afterwards before concluding anything. The stall filter is real — still-falling
candidates reached 90¢ 0.9% of the time against 2.6% for stalled ones — but it moves 2.2% to 2.6% against a
12.5% bar, so it belongs in evidence collection rather than being treated as a rescue.

## 14b. Gap sweep, 2026-08-17 — §14a's method is superseded, its conclusion is not

`npm run analyze:long-shot-gaps`, written up in
[reports/long-shot-gap-sweep-2026-08-17.md](../reports/long-shot-gap-sweep-2026-08-17.md).
Over 1,506 windows across 62 hours, asking which **gap** between buy and sell is achieved often enough to
pay, rather than which fixed marks work.

**Three corrections to §14a's method**, each of which changes numbers:

1. **Entry is a band, not a cumulative mark.** "Ask ≤40¢" is dominated by 10¢ entries, so §14a's 20¢ and
   25¢ rows do not describe buying at those prices. Gap sizes are only comparable banded.
2. **Settlement is authoritative**, joined to the resolved `outcome` in the forecast history rather than
   inferred. §14a had no settlement view at all; an intermediate attempt inferred it from the last path
   sample, which is circular against the 90¢ mark.
3. **Misses are graded at settlement, not as total losses.** §3.3 already noted the break-even table is
   conservative for this reason; the return column now measures it instead of noting it.

**§14a's conclusion survives all three.** 131 populated cells span 0.43–0.82 uncorrected. The touch rate
tracks break-even at roughly 0.6–0.8× of it everywhere: narrow gaps are achieved more often in almost exact
proportion to paying less, which is what an efficiently priced book looks like. There is no gap size and no
entry band where this market misprices the round trip.

Two results §14a could not have produced:

- **§14a's coverage correction is withdrawn, and so is this section's first version of it.** Both rested
  on "every contract settling in the money passed through every mark below 100¢ on its way there", which
  is **false for this market**. These contracts settle on a price comparison at the close, so the move to
  100¢ happens *at* settlement rather than through the book: over 1,033 resolved windows with a sample
  inside the last 30 seconds, the winning side was still bid **below 90¢ in 10.0% of cases** and below 10¢
  in 0.8%. "Observed reaching 90¢" therefore conflates sampling blindness with a discontinuity no sampling
  rate can see. §14a's 68.4%/1.36× figure and the 72%/1.39× figure derived here are both retracted.

  The replacement — dense 1s paths decimated to a 15-second grid, which assumes nothing about winners —
  implies **1.00–1.25×** where entry detection is stable (≤20¢, ≤30¢ cohorts) and swings between 1.7× and
  4.3× at ≤10¢, where decimation also changes which candidates qualify. Per AGENTS §6 that instability is
  the reportable result: n=45 windows cannot estimate this. **No correction is applied**, and with none
  applied **not one of the 131 cells clears 1.00** — the best, 6–10¢ entry at 95¢, reaches 0.82.
- **A lower exit mark moves the sold-at-mark rate against return.** Dropping the exit from 90¢ to 20¢
  raises the rate from 8.2% to 26.5%, entirely by selling all five winners in the cohort at ~2× instead of
  letting them settle at ~10×, in exchange for rescuing 8 of 44 losers. Paired on identical triggers,
  **every exit earlier than 90¢ has a negative mean difference**; the only positives are 95¢ (+0.044) and
  never selling (+0.088), both t=1.76 among 17 comparisons. Sold-at-mark rate is not a proxy for return
  here, and §8's "no fallback exit and no stop-loss" gains an empirical argument it previously lacked only
  a structural one for.

**Nothing here promotes anything** (AGENTS §5.5). With the correction withdrawn there is no cell above
break-even to argue about, and the sampling question is smaller than it appeared: the like-for-like
measurement puts 15-second blindness at 1.00–1.25×, not the 1.36–1.39× the retracted method implied. Denser
sampling remains the way to settle it, but it is no longer plausible that it lifts 0.82 above 1.00.

## 15. Open parameters

Everything below the allocation is derived from it, so the **budget slice is the only free judgment call.**

| Parameter | Value | Derivation |
|---|---|---|
| Low mark | 10¢ | operator-selected |
| High mark | 90¢ | break-even 12.5% (§3.3) |
| **Budget slice** | **30% of the `crypto-15m` cap** | **the one free parameter**; 600¢ → 20¢ opening ticket |
| Ticket | equity ÷ 30, floor 10¢ | drought survival; fee floor (§12.1) |
| Loss stop | equity < 300¢ | derived from ticket + floor (§12.2) |
| Open positions per asset/window | 1 | averaging-down guard (§9) |
| Open positions per settlement window | 3, no correlation-group cap | outcomes measured near-independent (§12.3) |
| Max entries per asset/window | 3 | churn and fee control, not risk (§9) |
| Daily net-loss cap | 10 tickets | one third of runway; circuit breaker (§12.4) |
| Entry window | ≥12 min remaining | first ~3 minutes |
| Prior-cycle filter | none | measured; both readings failed (§4) |
| Excluded assets | none | see §13 |

## 15a. Operator-defined analysis bands — design, 2026-08-17

A research surface for evaluating candidate `(entry range, exit)` pairs against recorded data, defined by
the operator in the dashboard. **It promotes nothing, trades nothing, and no module that can move money may
read it.** §5.5 governs: retroactive screening may filter an idea and may never promote one.

### What a band is

A band is one hypothesis, not a grid axis:

```
{ label, entryLowCents, entryHighCents, exitCents }
```

A candidate qualifies for a band when its executable ask first falls inside `(entryLowCents,
entryHighCents]` with at least `minimumSecondsRemaining` on the clock; it pays if the owned-side bid later
reaches `exitCents`. Each band produces exactly one row of measured results.

**Entry bands crossed against a fixed exit ladder was the wrong shape and is rejected.** It produces a
170-cell matrix, which is a fishing expedition by construction, and it makes the exit a second-class
parameter when it is the one this policy most needs to test. A list of N deliberate bands also makes the
multiple-comparison count legible: N is the number of hypotheses, stated on the surface.

### What is stored, and why this shape

Answering an arbitrary band cheaply needs a **band-independent** primitive, because the alternative —
storing results per band — would mean every new band required re-reading months of paths, and
`lib/contract-path.ts` refuses to bake a mark into a stored summary for exactly that reason.

Per `(contract, side)`, at seal: **the first occurrence of each distinct ask, with its offset, paired with
the highest owned-side bid reachable strictly after it.**

```
[contractId, symbol, closesAt, side, settledSide, [[offsetSeconds, askCents, peakBidAfterCents], …]]
```

Any band is then the earliest stored triple whose ask lands in range and whose offset is inside the entry
window, compared against the exit. Carrying the offset keeps `minimumSecondsRemaining` a **query** rather
than a stored assumption — it has already changed once, from 180s to 600s, and §7 says the evidence would
support widening it further.

Offsets are stored only to **600 seconds**, which is the one deliberate limit: every
`minimumSecondsRemaining` of 300 or more stays answerable, and going wider than the first ten minutes would
need re-collection. Measured over 1,541 windows that is **mean 11.25 triples per side, maximum 46, about
7.4 MB at the 45-day retention** — against 9.7 MB to cover the full configurable range and 3.7 MB to
support nothing but today's setting.

**A running-minimum "ladder" was tried first and is wrong.** It records only new lows, but the first ask
inside a band is frequently not a new low — a side at 30¢ that rises to 42¢ enters `(40, 45]` on a rise.
Checked against a direct path scan it disagreed on 55 of 77 triples, worst at high bands (1,090 candidates
against 795). The corrected primitive above reproduces the direct scan on **89 of 89** triples, including
overlapping and non-aligned bands. Any future change to this structure must be re-checked the same way; the
failure is silent and looks like a plausible number.

### Settlement

Resolved from the venue when the window seals, on the path the sentinels already use. Deliberately **not**
the last-sample inference — it agrees 98.9% of the time and was still the construction behind a retracted
conclusion (§14b) — and **not** the sealed forecast shards, which AGENTS §3 forbids reading to answer a
summary question.

### Collection and backfill

The primitive is derived read-only from contract paths and never mutates them. Because it is
band-independent, **saving a band starts no backfill**: the grid recomputes in milliseconds over the stored
pairs. The only backfill is a one-time build of the candidate journal from existing paths, measured at
about 1.5 seconds over the current 1,541 windows. It runs detached, never on a cycle that has money in it,
and never on a stateless host.

### Safety boundaries

The long-shot surface is read-only today; this adds the first write path to it, and what it writes is a
machine for retroactive screening. Three guards, built in rather than bolted on:

- **Naming enforces the gap.** These are *analysis* bands, never entry bands. No module that can price,
  size, gate, or trade may import the store, asserted by a test in the spirit of
  `lib/strategy-isolation.test.ts`, so wiring a good-looking band into `entryMarkCents` breaks the build
  rather than shipping.
- **Every saved configuration is retained and counted.** The surface displays how many band sets have been
  evaluated, because that count is the multiple-comparison denominator. Without it on the face of the
  panel, forty configurations get tried and one gets remembered — which is precisely how a 0.82 cell would
  become a policy change.
- **Stateless hosts neither write nor backfill** (§3), and the panel carries the same "promotes nothing"
  statement as the rest of the evidence surface.

### Reported per band

Candidates, independent settlement windows, touch rate, break-even, ratio, and clustered return per $1
staked with its standard error — returns averaged within a settlement window before being averaged across
windows (§5.1). Ratio is primary; return is the honest figure but carries the wide errors §14b documents.

### Defaults

Overlapping bands are allowed, since they are distinct hypotheses rather than a partition. Bands are capped
at 20, require a label, and validate `1 ≤ entryLow < entryHigh ≤ 99` and `entryHigh < exit ≤ 99`.

## 15b. Approach (iii) — near-money hold, committed 2026-08-18

**A prospective test, committed before the evidence.** The rule is fixed in `NEAR_MONEY_HOLD`
(`lib/near-money-sentinel.ts`) with the date it was written; windows closing at or after that instant are
the only arm that could promote anything, and everything before it is screening (§5.5). Changing any field
is a new `id` and a new cohort, never an edit.

**Where it came from, stated plainly so the bias is on the record.** It was found by sweeping bands in the
dashboard: near-money entries returned −0.020 ± 0.040 per $1 held, the best cell on the board. That is
indistinguishable from zero and consistent with an efficiently priced book minus a ~5% fee drag at a 20¢
ticket, so this is a test of whether anything is there, expecting nothing.

**Rule.** Buy the side whose ask first lands in `(70, 75]` with at least ten minutes left; hold to
settlement. Stops are evaluated as a family — none, −5¢, −10¢, −15¢, −20¢ **below the entry ask** — rather
than one chosen level, for the same reason no entry mark is stored: choosing now would mean re-collecting
to re-choose.

**Why the stop is not "sell if it drops to or below entry".** You buy at the ask and mark against the bid,
and at 70–75¢ the spread is a median 1¢, mean 1.79¢, with 40% at 2¢ or more (measured over 540 entries). A
stop at the entry price is therefore breached the instant the position opens, and would measure the spread
rather than the thesis. Every stop level here sits strictly below the entry bid.

**What it needed from storage.** `CandidateMark` gained `troughBidAfterCents`, the mirror of the peak, so
any stop level stays evaluable — bumping the candidate schema to `v2` and quarantining the `v1` journal,
which is derived from paths and rebuilt in ~105ms. Ordering of trough against peak is deliberately not
recorded: this rule has no take-profit, so which came first cannot change whether the stop fired. **A rule
with both a stop and a target would need more than this.**

**First screening read, 536 positions over 138 windows.** Every stop is worse than holding, monotonically —
the tighter the stop, the worse:

| arm | fires | return per $1 |
|---|---|---|
| hold | — | −0.025 ± 0.035 |
| stop −20¢ | 46% | −0.034 ± 0.023 |
| stop −15¢ | 51% | −0.039 ± 0.021 |
| stop −10¢ | 59% | −0.050 ± 0.019 |
| stop −5¢ | 73% | −0.067 ± 0.016 |

A near-money contract dipping and recovering is ordinary, so a stop converts a temporary drawdown into a
realised loss; it fires on between half and three-quarters of positions. Stops do cut variance — the
standard error falls from 0.035 to 0.016 — but they pay for it in the mean.

**Both biases in the stop's favour.** It assumes a fill at the stop level, and a bid gapping through fills
worse; and it cannot see a dip between samples, which understates how often it fires. A stop that loses
here loses by more than this says.

## 17. Maker-fill experiment — bounded, 2026-08-18

**A bounded instrument for one question, not a permanent lane.** Does a resting order fill on ordinary
trades, or only on the ones about to go against it? Everything else about patient execution on this venue
depends on the answer, and nothing currently recorded can supply it.

### Why the existing measurement cannot answer it

`npm run analyze:maker-fills` found no adverse drift on 15,000–17,000 simulated fills over 1,611 windows —
but it treats a post as filled the moment the ask **touches** it. The mechanism that produces adverse
selection is queue position: a resting order fills when price *sweeps through* its level and is passed over
when price merely brushes it, and sweeps are the adverse case. Touch and sweep are indistinguishable in a
quote-only record at any sampling rate, so that measurement is permissive by construction.

### What already exists

Four of the five pieces are built and in production use for the edge policy's managed maker:

| piece | where |
| --- | --- |
| Full ladder, depth 20 | `fetchKalshiOrderBookNow` (`lib/kalshi-depth.ts`) |
| Size at our price and ahead of it | `selectedSideDepth` (`lib/order-book-depth.ts`) |
| Real executions since a timestamp | `fetchKalshiTradePrintsSince` (`lib/kalshi-market-data.ts`) |
| Queue consumption, with the right rule | `simulatePaperMaker` (`lib/paper-maker-simulation.ts`) |

`simulatePaperMaker` already encodes the distinction this needs: *a selected-side resting bid is consumed
by a taker buying the opposite outcome, and an ask touch alone is deliberately not a fill.* The gap is only
that none of it is recorded for contracts the desk never traded — which is exactly the unbiased sample.

### The load-bearing observation

**Depth snapshots alone cannot answer this.** A level shrinking between samples may mean someone traded
through it or may mean someone cancelled, and those are opposite signals for a resting order.

**Trade prints disambiguate, and they are cumulative.** `fetchKalshiTradePrintsSince` returns every
execution since a timestamp, so traded volume at a price is exact *regardless of sampling cadence*. Only
the depth snapshot is coarse. That is what makes a slow, cheap experiment viable.

### Shape

Bounded rather than continuous: it answers the current question and stops. The collection lane can be
promoted to permanent later if the answer justifies more maker questions.

- **Runs as a standalone script**, never wired into `processCycle`. That is the strongest available
  boundary: it cannot delay, gate, size, price, or trade, because it is not on the path at all. Both
  endpoints it uses are public and unauthenticated.
- **Contracts** come from the active set in `data/contract-paths.json`, which the collector already keeps
  current — market selection is not duplicated.
- **Cadence 60 seconds**, roughly 14 requests a minute across ~7 live contracts. Kalshi publishes no budget
  and sends no `Retry-After`, so the repo's rate limiting is reactive; this starts conservative and stops
  itself on repeated 429s rather than probing for a ceiling.
- **Bounded twice**, by wall-clock duration and by a hard request cap, whichever binds first.
- **Storage** `data/maker-depth-experiment.jsonl`, append-only, one row per contract per sample carrying
  best bid and ask, displayed size at and ahead of the post price, and traded volume by price since the
  previous sample. About 0.6 MB a day.

### What it then answers

The analysis replays hypothetical posts under the real rule — a post at `P` fills only once volume traded
at or through `P` since posting exceeds the size displayed ahead of it — in place of the optimistic touch
rule, and re-reports drift after fill. A negative drift under that rule is adverse selection; a flat one,
measured this way, is the first real evidence that patient execution survives here.

### What it still will not answer

`displayedAhead` is *displayed* size, not private FIFO rank, and the module says so. Hidden size and true
queue position are not in public data at any cadence. This upgrades the finding from **"cannot distinguish
a brush from a sweep"** to **"can distinguish, using a stated proxy for rank"** — a real improvement, and
not certainty. **Nothing here authorizes a market-making strategy**; §5.5 applies unchanged.

## 18. Fine path recording, 2026-08-18 — the range being traded was never recorded finely

**Every trajectory measurement in this repo has been made at fifteen seconds.** That was not a stated
choice; it was an unnoticed consequence of where the fine recorder's trigger sat.

### The gap

`denseWatch` admits a contract only once `cheapest <= entryMarkCents` — a side below the long-shot entry
mark. That happens three to five minutes into a cycle, by which point the book is roughly 9¢/91¢. Measured
across 57 windows carrying a real one-second run, **zero** had the 20–80¢ range inside the fine region. The
range an operator watching the app actually trades has only ever existed at fifteen seconds.

That resolution hides real movement, measured on those same windows: mean 0.69¢ of travel per fifteen-second
block is invisible, about **37% of all price movement**, and **8.7% of blocks conceal a swing of 2¢ or
more** (p99 is 9.5¢).

An attempt to close this with a standalone two-second poller was withdrawn within a minute: seven contracts
every two seconds is ~210 requests a minute, and **the live desk was rate-limited inside thirty seconds**
on the very endpoint being polled. Kalshi's budget is per account and the repo's limiter is per process, so
a second process duplicating the desk's own reads competes with it for real.

### What was done instead

`longShotEntryTick` **already fetches every eligible contract at the entry cadence**, through a shared
quote cache, to make the entry decision. Those quotes were discarded unless the contract happened to be
cheap. They are now recorded at `CONTRACT_PATH_FINE_BUCKET_MS` (two seconds) for every eligible contract.

**This costs no venue request at all.** It records what was already being fetched and thrown away, which is
why it is the only version of this change that does not compete with the desk.

Coverage follows eligibility: `minimumSecondsRemaining` or more left on the clock, so the first five
minutes of a window — which is where the 20–80¢ range lives and where the entry decision is made.

### Storage, and why history is rewritten

Fine sampling is roughly five times the points, a permanent ~130 MB liability at the 45-day retention for a
resolution only recent analysis needs. Compaction therefore **thins windows older than
`CONTRACT_PATH_FINE_RETENTION_DAYS` back to the fifteen-second grid**, keeping one sample per coarse bucket.

Journals are append-only and are not rewritten to change history (AGENTS §3); this rewrites *resolution*,
not content, and restores exactly the sampling density every existing measurement was written against. The
thinned form is **not** byte-identical to a coarsely recorded window: an observation is bucketed when it is
stored, so a fine sample survives at offset 16 where the coarse recorder would have written 15. Offsets
differ by less than one coarse bucket and carry the same information. `lib/contract-path.test.ts` pins the
density, the ordering, and that no sample is ever invented.

### What it does not change

No entry rule, no exit rule, no sizing, no arming. Recording is detached and never awaited on the trading
path, exactly as the coarse recorder is. It adds resolution to an observation lane and nothing else.

## 16. Out of scope

This design changes no rule of the edge policy, adds no venue price to any tradeable probability, grants no
new execution authority to a stateless deployment, does not alter the global exposure caps or the shared
kill switch, reconciliation barrier and drain, and does not modify the model promotion ledger. Approach
(ii) places no order and holds no budget.
