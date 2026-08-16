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

## 5. The exit is the whole result, and it is invisible

A position closed before settlement is recorded `sold` and **never receives an `outcome`** — resolution
only runs on positions still held. So no report the desk produces can score the exit, despite it
touching 27% of live fills under the current policy and 47% of paper fills. This review could only
score it by recovering settlement outcomes from forecast history and joining by contract window.

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

## 6. What this authorizes

Nothing automatic. In order of value:

1. **Record settlement outcome on exited positions.** Currently unmeasurable in production; this review
   had to reconstruct it offline. Until the desk can score its own exits, the component carrying the
   entire result is the one component nobody can see. Backfillable for all 249 historical exits.
2. **Score the exit as a first-class report**, on the held-to-settlement counterfactual above, with the
   right-rate and the contribution reported separately so the asymmetry stays visible.
3. **Do not tune entry thresholds on this evidence.** They are flat. Changes there are noise-chasing.
4. **Do not act on per-asset results.** They do not survive window clustering.

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
