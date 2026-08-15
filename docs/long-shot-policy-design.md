# Long-shot round-trip policy — design

> Draft 1 · 2026-08-14 · Status: proposed, not implemented
> Product scope and safety doctrine live in [`SPEC.md`](../SPEC.md). This document designs one new
> trading policy and the evidence lane beside it. It changes no rule of the existing policy.

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

**Selling early beats holding whenever the touch rate exceeds the win rate by that ratio.** It very likely
does, and the reason is structural: every contract that settles YES passes through 90¢ on its way to 100¢,
so **every winner is also a toucher**, plus every near-miss that ran up and fell back. The touch rate is
strictly greater than the win rate. By how much is the open question.

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
seconds before settlement. The measurement is provably blind: winners were observed reaching 80¢ in only
76.6% of cases and 90¢ in 68.4%, where both must be 100%. A transient spike lasting under a minute is
missed far more often than that. **Every touch rate produced by screening is a floor.**

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

**A two-second poll of the owned side's bid, submitting a reduce-only IOC at the mark when it is reached.**

This was designed as a resting reduce-only GTC limit placed at entry fill, which would have filled on a
spike unattended. **Kalshi refuses that combination.** Verified against the production API on 2026-08-15
with a 0.01-contract probe at 95¢ against a 9¢ bid:

```
400 invalid_order: "reduce_only can only be used with IoC orders"
```

Reduce-only is the invariant that matters most here — a sell that is not capped by the position is a sell
that can open reverse exposure — so it is the resting order that gives way, not the safety property.

The replacement polls, which the original design rejected on the grounds that a round trip inside 90
seconds is invisible to a 15-second poll. That objection was to the *cadence*, not to polling: at two
seconds, a 90-second excursion is sampled roughly 45 times, and only a spike lasting under two seconds is
missed. Paper maker management already runs on exactly this cadence, so it is a proven load rather than a
new one, and at most three open positions means at most three quote reads per tick.

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

First review at **60 resolved round-trip attempts**, reporting touch rate against the 12.5% break-even,
clustered by settlement window, split by entry generation and by regime label.

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

## 16. Out of scope

This design changes no rule of the edge policy, adds no venue price to any tradeable probability, grants no
new execution authority to a stateless deployment, does not alter the global exposure caps or the shared
kill switch, reconciliation barrier and drain, and does not modify the model promotion ledger. Approach
(ii) places no order and holds no budget.
