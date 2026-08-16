# Edge policy: where the margin actually is

> Measurement review, 2026-08-16. No policy change is made here; §6 lists what this would authorize.
> Reproduce with `npm run analyze:edge-gates` and `npm run analyze:execution-value`.

## Summary

The entry gate is not where the money is. Every threshold in it was swept and they are all
approximately equivalent. The exit policy — which the desk cannot currently see, because an exited
position never receives a settlement outcome — is carrying the entire result on both tracks.

Without exits, live would be **−292c** instead of +607c and paper **−3,799c** instead of −550c.
The exit contributed **+899c live and +3,249c paper** against holding the same positions to settlement.
The desk's whole-ledger realized P&L is +57c. The exits are worth seventy times that.

## 1. A statistical correction that changes conclusions

Intervals must be clustered on the settlement window. The desk issues a forecast every few seconds, so
one fifteen-minute window contributes a median of 3 qualifying rows, p90 of 11, and up to 43 — all
sharing a single coin flip. Scoring them as independent trials shrinks every interval by roughly the
square root of that multiplicity and manufactures significance.

Scored per row, six of seven assets came out "significant" and BNB read as a confirmed loser at
−9.4% [−14.1, −4.6]. Scored per window BNB is +5.9% [−5.6, +17.4] and nothing separates the assets.
The per-row version was wrong, and acting on it would have removed a fifth of the desk's volume for
no reason. Every figure in this report and in both scripts is window-clustered.

## 2. The entry gate is flat

Held to settlement, within all other current gates, over 1,810 windows:

| lever | best band | worst band | spread |
| --- | --- | --- | --- |
| net edge | 0.25–0.35: +22.2% | 0.10–0.15: +8.6% | all overlap |
| entry price | 0.20–0.40: +18.1% | 0.60–0.80: +11.0% | all overlap |
| side probability | 0.60–0.65: +19.8% | 0.55–0.60: +11.8% | all overlap |
| estimate quality | 0.70–0.80: +13.7% | 0.60–0.70: +14.5% | none |
| seconds remaining | 600–900: +16.9% | 0–120: +13.1% | all overlap |
| side | UP +15.9% | DOWN +9.2% | overlap |

Raising `MIN_ENTRY_PRICE` was the most promising candidate and it does nothing: the gate already
excludes cheap contracts, because `sideProbability >= 0.55` and `netEdge < 0.35` jointly bound price
from below. Only 1 of 8,837 qualifying rows priced under 0.20. Sweeping the floor from 0.05 to 0.65
moves return from +14.8% to +9.2% while discarding 79% of volume — strictly worse.

**Selecting the largest net edge in a window is the best selection rule tested**, not the worst:
+21.4% [+16.4, +26.5] against +9.3% for the smallest edge and +15.9% for the median moment. The
winner's-curse hypothesis — that firing at peak estimated edge fires at peak model error — does not
reproduce.

## 2a. Does the gate help? Yes — and half of it is inert

Gating is worth roughly double, held to settlement and window-clustered:

| cohort | rows | windows | win% | return |
| --- | --- | --- | --- | --- |
| no gate at all — every chosen side | 41,183 | 3,658 | 42.2% | +6.8% [+2.9, +10.7] |
| **full gate (v17)** | 8,837 | 1,810 | 57.4% | **+14.8% [+10.4, +19.2]** |

Leaving each component out in turn shows where that comes from:

| gate without… | rows | return | worth |
| --- | --- | --- | --- |
| `netEdge` 0.05–0.35 | 18,776 | +10.3% | **−4.5pp** |
| `sideProbability >= 0.55` | 30,828 | +9.7% | **−5.1pp** |
| `confidence >= 0.5` | 8,837 | +14.8% | nothing |
| `price 0.05–0.97` | 8,837 | +14.8% | nothing |

`netEdge` and `sideProbability` are both load-bearing and complementary — each alone yields about
+10%, together +14.8%. **`confidence` and `price` are inert**: removing either changes not one row of
the admitted set, because every row already satisfies them (only 54 of 41,183 rows price outside
0.05–0.97, and none of those survive the other gates). They are not hurting; they are simply not
protecting anything, and should not be mistaken for risk controls that are doing work.

The *tracking* `qualified` flag is a different thing again and constrains trading not at all: the full
gate is a strict subset of it, so no gate-qualifying row is ever untracked.

## 3. Calibration by price, which bounds how far the gate may be loosened

Across all 41,183 resolved rows with a chosen side, the model is overconfident on cheap contracts and
roughly calibrated on mid-priced ones:

| entry price | model says | actually won | gap |
| --- | --- | --- | --- |
| 0.02–0.10 | 27.5% | 6.9% | −20.6 |
| 0.10–0.20 | 35.4% | 16.0% | −19.4 |
| 0.20–0.30 | 43.6% | 24.9% | −18.7 |
| 0.30–0.40 | 50.5% | 34.1% | −16.4 |
| 0.40–0.50 | 57.4% | 48.2% | −9.2 |
| 0.50–0.60 | 63.4% | 61.0% | −2.4 |
| 0.60–0.75 | 66.2% | 71.4% | +5.3 |
| 0.75–0.98 | 72.6% | 85.0% | +12.4 |

This is not an argument for a change, because the gate already keeps mean entry price at 0.501. It is
a standing constraint: any future proposal to widen the gate downward is proposing to trade the region
where the model is most wrong, and needs to answer this table first.

## 4. Fills are not the leak

Live filled entries won 30.8% [26.5, 35.1] of the time against 34.1% [29.8, 38.5] for entries that
never filled. The gap is 3.4 points, the intervals overlap, and maker entry captured a −1.17c mean
discount against the issuance ask. Resting is roughly paying for itself.

Paper shows a 29.3-point gap with non-overlapping intervals, which looks alarming but is most likely an
artefact of the simulated fill model rather than a market fact — paper requires opposite-outcome public
taker prints to consume displayed queue-ahead volume, and only 12.7% of paper entries go unfilled
against 51.5% live. The two fill populations are not comparable. Worth a look, not worth acting on.

## 5. The exit is the whole result

> **Correction.** An earlier revision of this section claimed the exit was invisible and unmeasurable,
> on the grounds that a `sold` order never receives an `outcome`. That is true of the `outcome` field and
> false of the conclusion. `updateSoldCounterfactuals` already records `counterfactualHoldOutcome` and
> `counterfactualHoldPnlCents` on every exit — 249 of 249 edge-policy exits have them — and
> `buildActionCounterfactuals` already scores an authoritative EXIT-vs-HOLD arm, split by exit policy
> and clustered by settlement window. The offline reconstruction below was unnecessary; it agrees with
> the production figures to within the switch incumbents it excluded. What was actually missing is
> narrower, and is §5.1.

Scored against simply holding the same position to settlement:

| | live | paper |
| --- | --- | --- |
| exited positions with a recoverable outcome | 56 of 62 | 177 of 187 |
| exited for | +4,460c | +8,821c |
| holding would have paid | +3,561c | +5,572c |
| **exit contributed** | **+899c** | **+3,249c** |
| exit beat holding | 13/56 (23.2%) | 65/177 (36.7%) |
| would have won anyway | 76.8% | 62.1% |

The shape matters more than the total. **The exit is wrong most of the time and profitable anyway**: it
gives up a small amount of remaining upside often, and avoids a total loss of stake occasionally. That
is insurance, and its expected value is positive here. The intuitive improvement — "it's only right a
quarter of the time, make it fire less" — would remove the payoff. Anyone tuning this needs the
asymmetry in front of them.

### 5.1 What the aggregate hid: the two exit policies disagree

Pooling the exits was the mistake this table corrects. Production already splits them, and split, they
point opposite ways:

| arm | live | paper |
| --- | --- | --- |
| EXIT vs HOLD · `strict-value-v1` | +763c, +9.4% ±13.9 | +3,627c, **+28.9% ±10.9, credible** |
| EXIT vs HOLD · `profit-reversal-75-v1` | −130c, **−192.9% ±81.5, credible** | −83c, −10.1% ±29.3 |

`strict-value-v1` is carrying the result. `profit-reversal-75-v1` is the only arm on either track that
clears two standard errors *against* the action taken — it is credibly destroying value on live, on 9
decisions across 8 windows. Nine decisions is thin, and the paper arm for the same policy is negative
but not credible, so this is a flag rather than a verdict.

It also sits in tension with the `exit-at-armed-peak` arm, which says live positions that armed the
profit lock and were never sold gave up 993c against selling at their peak. One arm says the reversal
exit fires badly; the other says not firing it also costs. Both are thin and neither is actionable yet.

### 5.2 What was actually missing: how often, as distinct from how much

Every arm reported magnitude and no frequency. That is the one number needed to keep the asymmetry from
being tuned away: `strict-value-v1` is right on a minority of its firings and profitable regardless, and
a reader seeing only "+28.9%" has no way to know that making it fire less would destroy the arm.

Added in this change: `decisionsBeatingAlternative` and `hitRate` on every arm, computed per decision
rather than per window — the mean answers "what did this earn", the hit rate answers "of the times it
fired, how often was it right", and those are different questions. Surfaced in the performance dialog
beside the per-stake mean with the asymmetry stated in the caption.

## 6. What this authorizes

Nothing automatic. In order of value:

1. **Watch `profit-reversal-75-v1`.** It is the only credibly negative arm on either track (§5.1). Nine
   live decisions is too thin to retire a policy on, and the `exit-at-armed-peak` arm argues the other
   way, so this is a thing to accumulate evidence on rather than switch off today. If it stays credibly
   negative past ~25 windows it should go to the evaluation lane.
2. **Do not tune entry thresholds on this evidence.** They are flat (§2). Changes there are
   noise-chasing.
3. **Do not act on per-asset results.** They do not survive window clustering (§1).
4. **Do not remove the two inert gate components** — `confidence >= 0.5` and `price 0.05-0.97` exclude
   essentially nothing (§2a), so removing them changes no behaviour and loses a backstop that costs
   nothing. Worth knowing they are not protecting anything, not worth a change.

## 7. What this review cannot say

The counterfactual in §2 is fill-optimistic: it assumes every admitted candidate is bought at the
recorded ask, and the desk fills roughly half its live entries. The gap between the +21.4% counterfactual
and the ~0% the current policy realizes is **not explained** by anything measured here — fills account
for at most 3.4 points, and selection timing improves rather than degrades the result. That gap is the
open question this review leaves behind.

Sample sizes are also thin where it matters most. The current policy (v17) has 92 live and 96 paper
filled entries over three days; 46% of the lifetime live ledger was traded under retired policies whose
windows the current gate would not even qualify. Lifetime P&L is therefore not a measurement of the
policy now running, in either direction.

## 8. Time of day: tested, and there is nothing there

The hypothesis was that Kalshi's retail flow follows the US working day — people betting before work and
after dinner — and that the book is priced worse when that flow dominates. It is a reasonable mechanism
and it does not appear in the data. Blocks were fixed from the hypothesis before any return was looked
at; the clock is US Eastern, because that is where the flow would be.

| block (ET) | windows | win% | return |
| --- | --- | --- | --- |
| overnight 00–06 | 448 | 51.8% | +10.5% [+1.4, +19.5] |
| pre-work 06–09 | 217 | 63.3% | +9.8% [−3.0, +22.6] |
| work morning 09–12 | 260 | 58.6% | +16.8% [+5.6, +28.1] |
| work afternoon 12–17 | 356 | 59.7% | +19.9% [+9.7, +30.1] |
| after work 17–21 | 312 | 57.7% | +19.1% [+8.7, +29.4] |
| late evening 21–24 | 217 | 58.5% | +11.7% [−1.0, +24.4] |

The widest gap between any two blocks is 10.1% ± 8.3, or 1.2 standard errors — and it is the widest of
six, so even two standard errors would be the wrong bar. Weekday (+16.2%) against weekend (+11.1%) and
working hours (+17.2%) against everything else (+15.8%) are likewise indistinguishable.

**The test that settles it.** Counting how many hours clear two standard errors *against zero* is the
wrong test, and it looks encouraging: five of twenty-four do, headed by 06:00 at +41.9% and 13:00 at
+35.1%. But the population's overall mean is already +14.8%, so on a large enough sample most hours
would clear zero regardless of any clock effect — that count measures the desk's overall edge and the
number of looks taken, not clustering. Cochran's Q compares each cell against the *grand mean* instead:

| cells | Q | df | expected under no effect | z |
| --- | --- | --- | --- | --- |
| 6 blocks | 3.4 | 5 | ≈5 | −0.34 |
| 24 hours | 32.3 | 23 | ≈23 | +1.32 |
| live ledger blocks | 7.6 | 5 | ≈5 | +0.92 |
| paper ledger blocks | 6.4 | 5 | ≈5 | +0.61 |

Every one of them is at or below what independent cells with these error bars produce anyway. There is
no hour of the day, and no part of the working week, where this desk trades measurably better.

That includes the realized ledger, whose block returns *look* dramatic — live runs from −51.6% in the
work morning to +69.9% pre-work — and are entirely noise at 60–130 orders per block. Two traps in
reading that table: live and paper agreeing in sign is not corroboration, because they trade the same
signals on the same windows at the same times; and order timing is confounded with policy era, since the
desk was paused, resumed and repolicied throughout, so which hours carry which policy version is not
random.

Reproduce with `npm run analyze:trading-clock`. If the hypothesis is worth revisiting it needs a longer
history — nine days gives roughly nine daily observations per hour, and a real effect smaller than about
15 percentage points could not be detected here either way.

## 9. Alternative exit rules: 26 tested, none better

`strict-value-v1` sells when executable cash exceeds the model's own optimistic hold value. Twenty-six
alternatives were replayed over recorded position paths — every filled position stores a
`positionObservations` path of executable bid, net liquidation, owned-side probability and seconds
remaining, which is enough to ask what a different rule would have done without re-running the desk.
Reproduce with `npm run analyze:exit-alternatives`.

**Nothing beat it.** The best candidate is a +5% take-profit at +979c, t = 1.18, out of 26 candidates —
under a null of no effect the best of 26 is expected to reach roughly t = 2.3, so this is comfortably
inside noise.

| family | rules | mean vs today | positive |
| --- | --- | --- | --- |
| take-profit | 8 | +2.0% | 4/8 |
| trailing stop | 5 | −0.2% | 2/5 |
| profit-reversal | 3 | −1.8% | 0/3 |
| time-based flatten | 6 | −8.1% | 0/6 |
| stop-loss | 4 | **−13.1%** | 0/4 |

### 9.1 The trap this nearly walked into

Scored only against positions currently held to settlement, a +5% take-profit looks worth **+3,699c**.
Scored properly it is worth **+979c**. The difference is pre-emption: the same trigger fires on 59 of the
64 positions `strict-value-v1` sells, and sells them for less. A candidate has to beat the live rule, not
beat doing nothing, and a held-only population silently excludes every sale the candidate would spoil.

The held-only view also produced a clean monotonic gradient — the earlier you sell, the better, all the
way down to +2% — which read as a strong mechanical finding and was an artefact of that same exclusion.

The underlying fact is real and worth keeping: **43% of the positions that settled as a total loss were
at some point up 5% or more.** Those 35 positions carried 4,423c of stake and returned nothing. The
naive fix does not survive contact with the sales it would spoil, but the money is genuinely sitting
there, and a rule that could reach it *without* front-running strict-value would be worth having. That
rule would have to condition on something other than profit level, since profit level is exactly what
strict-value is already reacting to.

### 9.2 Two clear negatives worth keeping

**Stop-loss is actively harmful** — all four thresholds negative, family mean −13.1%, down to t = −2.29
at −60%. Cutting a losing binary early is the wrong instinct: a position that is down has not lost, and
these recover often enough that realising the loss costs more than carrying it. This is the one family
where the evidence points somewhere with any force, and it points at *not* doing it.

**Time-based flattening is harmful** — all six variants negative, family mean −8.1%. Closing out near
expiry to avoid carrying binary risk into settlement gives up more than it protects.

**Profit-reversal is negative at every arm level tested** (+50%, +75%, +100%), which independently
corroborates the existing decision to withhold `profit-reversal-75-v1` from execution.

### 9.3 What would make this measurable

Position paths only begin 2026-08-14, so this rests on 173 positions over three days — 109 held and 64
sold. That is thin for 26 candidates. Nothing here justifies a change to the exit; the useful output is
the two negatives in §9.2 and the pre-emption correction in §9.1, both of which constrain future
proposals rather than motivating one.
