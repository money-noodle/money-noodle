# Walk-forward model candidate review — 2026-08-20

> **Decision: do not promote. Production remains Blend 0.4.** This review changes no forecast parameter,
> buy policy, execution policy, stake, budget, or live authority. It reviews immutable run
> `walk-forward:975:fnv1a-bccfee60` and reruns its checkpoint through production evaluator code.
>
> Reproduce with `npm run analyze:walk-forward-review`.
>
> Durable inputs were read at **2026-08-20T06:36:58Z**: 983 currently available evaluation windows,
> 36 stored checkpoints, the 975-window target run, the forecast shards/open journal, and the shared order
> ledger. The deciding correction is paired uncertainty on each held-out settlement timestamp. Assets in
> one timestamp are not independent trials. The caveat that most threatens the result is more fundamental:
> the scorer fixes the side, ask, fee and venue to production's stored choice and then assumes ask fill and
> hold, so it does not evaluate the complete policy a changed model would actually run.

## 1. The stored result is worth reviewing and is not promotable

The stored five-fold result is reproduced here as history, not restated as current truth:

| held-out result | baseline | candidate |
|---|---:|---:|
| settlement windows | 488 | 488 |
| observations | 2,675 | 2,675 |
| trades | 315 | 323 |
| mean return per window, ask-and-hold | +8.24% | +11.38% |
| Brier | 0.17549 | 0.17235 |
| log loss | 0.52897 | 0.51902 |
| reported maximum drawdown | 8.69 | 7.00 |

The candidate is production except for **basis log-odds weight 0.55 → 0.65** and **slow-tilt scale
1.0 → 0.5**. All five folds selected that same parameter set. Candidate return was positive in 5/5
folds but beat baseline in only 3/5: the first three fold gaps were +6.54pp, +6.50pp and +3.66pp; the
last two were −0.31pp and −0.79pp.

`evaluatePromotionEligibility` already returns false. The sole criterion it currently reports failed is
fold consistency: 3 folds beat baseline against the required 4. That mechanical refusal is correct, but
§§3–7 show that passing 4/5 later would still not make this evaluator decision-grade.

## 2. The immutable run does not reproduce from current durable history

The fresh read rebuilt the same first 975 chronological windows with the same production code and did
**not** recover the stored fingerprint:

- stored: `fnv1a-bccfee60`
- current: `fnv1a-c9e217a4`

The candidate score stayed +11.38% on 323 trades, but baseline moved from 315 trades / +8.24% to 314 /
+8.45%; Brier and log loss also moved in the last digits. The resulting return gap is +2.93pp rather than
+3.14pp.

The likely mechanism is delayed resolution inserting or changing a row inside a historical checkpoint's
fixed-horizon asset/window selection. The run stores only a fingerprint and aggregates, not the ordered
window/row manifest needed to reconstruct what it scored. No durable row was edited for this review, and
this finding does not identify a corrupt row. It establishes that the checkpoint is not a reproducible
analysis artifact after later settlements arrive.

**This independently blocks promotion.** A cited run must retain or regenerate the exact cohort it claims,
not merely remember an unrecoverable hash of it.

## 3. Paired settlement-window uncertainty weakens return and supports accuracy

On the current reconstruction, scored on all 488 held-out timestamps with a zero when an arm did not
trade:

| candidate minus baseline | paired mean | paired SE | mean / SE |
|---|---:|---:|---:|
| ask-and-hold return | **+2.93pp** | **1.56pp** | 1.88 |
| Brier (lower is better) | **−0.00192** | **0.00060** | −3.21 |
| log loss (lower is better) | **−0.00638** | **0.00173** | −3.69 |

The return advantage does not clear two paired standard errors. Brier and log loss do. This is the same
accuracy-versus-profit disagreement seen in the prior Kalshi-weight review, though the candidate here
remains venue-independent: probability scoring improves more convincingly than traded return.

The report's drawdown field also understates the continuous held-out path because `combineScores` takes
the maximum of five fold-local drawdowns, resetting cumulative P&L at every fold boundary. Recomputed
continuously, baseline drawdown is 9.27 normalized stake units and candidate 8.59, versus stored 8.69 and
7.00. Candidate remains directionally lower; the claimed magnitude is not the continuous one.

## 4. Almost all return difference comes from 22 windows

The current reconstruction decomposes the 488 held-out timestamps as follows:

| selection relationship | windows | total candidate-minus-baseline return |
|---|---:|---:|
| same selected trade | 288 | 0.00 |
| different selected trade | **22** | **+13.25** |
| baseline only | 4 | −0.28 |
| candidate only | 13 | +1.33 |
| neither trades | 161 | 0.00 |

Only 39 windows differ at all, and the 22 changed selections supply 92.6% of the total advantage. That is
not an error—the candidate's job is to change choices—but it explains the 1.56pp paired SE and makes those
22 windows the load-bearing cohort. They need auditable decision and execution evidence rather than an
aggregate average.

The top-one-per-window rule does put correlated-asset selection inside each held-out test fold, so the
648-parameter training search is not simply scored in-sample. It does **not** remove the other selection
costs: the evaluator has been inspected at 36 heavily overlapping checkpoints, 10 have displayed
`candidate_passed_review_thresholds`, and the current parameter set's four appearances at checkpoints
900/925/950/975 share almost all their data. Those are repeated looks, not four independent confirmations.

## 5. The baseline is not the policy in force at the run or today

The latest run was generated at 04:31Z while buy policy v21 was active. Its scorer required +5pp edge even
though v21 admitted −5pp, so the baseline was not v21. After v22 activated, +5pp matches again, but the
scorer still hard-codes a 5–97¢ ask band instead of v22's 10–75¢ band. A walk-forward run carries the
evaluator policy version but not the buy-policy value it claims to baseline.

More importantly, `EvaluationRow` retains only production's selected `entrySide`, `entryAsk`,
`entryFeeRate` and `entryVenue`. Candidate probability is recomputed, but side and venue are not. A changed
probability can reject or reorder production's side; it cannot select the opposite side or another exact
venue quote. This is not a full candidate policy replay.

A model review cannot claim to beat production until the baseline is an immutable `BuyPolicy` value and the
candidate regenerates side, venue and cost from all decision-time actionable quotes.

## 6. There is still no execution arm

The 323 current candidate selections overlap any issued live intent in 77 windows and any paper intent in
80—about one quarter. That is **not execution coverage**. Orders exist only where production policy,
persistence, capital and operational state chose to issue them; treating the other three quarters as
unfilled would charge a model candidate for evidence production never attempted to collect, while dropping
them would select the favourable surviving cohort.

The evaluator still assumes:

- immediate fill at the stored ask and fee;
- hold to settlement;
- no persistence, managed-maker queue, IOC depth, route decision or paper fill version;
- no strict-value exit or switch;
- no portfolio capacity, sizing, budget reuse, stop or reconciliation effect.

Therefore +11.38% is a signal-policy ask-and-hold result, not maker-executable return and not a bound on the
funded desk's P&L. A valid execution arm needs prospective, decision-time public book/trade evidence for
**both** baseline and locked candidate intents without allowing the candidate to place an order.

## 7. Replay coverage and what it does not mean

Of 4,967 probability observations in the 975-window checkpoint, 4,597 (92.5%) carry exact issuance replay
and 370 are historical reconstructions. Baseline replay error is effectively zero. The current candidate
uses volatility scale 1, which avoids the weakest raw-input reconstruction path, but the exact/reconstructed
cohorts should still be shown separately before any review gate clears.

Quality inputs are exact on 2,792 observations (56.2%) and absent on 2,175. This missingness does **not**
directly test against the current candidate: it leaves production's confidence formula and 50% quality
threshold unchanged. It does prohibit adding a clock/quality candidate dimension over the whole history;
that candidate may be scored only on the prospectively exact cohort.

## 8. Promotion guard review found one separate integrity omission

`promotionRefusal` compared only seven of the nine `WalkForwardParameters`; it omitted `maximumEdge` and
`minimumSelectedProbability`. A request could therefore have recorded bounds different from the running
model even though the route's stated invariant is deploy-then-record exact identity. This review adds both
keys and regression coverage.

The review also makes evaluator generation an explicit eligibility criterion. Every
`expanding-window-v2-replay` run is monitoring-only, even if a later overlapping checkpoint happens to
clear its numerical gates. Promotion requires the reserved
`expanding-window-v3-policy-complete-prospective` generation, which has no implementation yet. Collection
and v2 evaluation continue; promotion fails closed until the agreed v3 design exists. Neither guard makes
the candidate eligible or changes a model parameter.

## 9. Decision and next design

**Retain Blend 0.4; record no promotion.** The candidate is a credible model-quality hypothesis: one
parameter set won all five training selections, improved paired Brier/log loss, and has appeared at four
successive checkpoints. It is not a decision-grade trading candidate: return misses two paired SE, the
last two folds trail baseline, the run cannot reproduce, the baseline is not the active buy policy, side
and venue cannot change, and no execution arm exists.

Before evaluator v3 is implemented, agree a design covering:

1. **Immutable run cohort:** persist ordered settlement-window and selected-row identities (or an equivalent
   content-addressed manifest) so late resolution cannot rewrite a cited checkpoint.
2. **Policy-complete replay:** stamp the exact `BuyPolicy`; regenerate side, provider and all-in cost from
   both actionable sides rather than inheriting production's choice.
3. **Two result lanes:** paired signal-policy ask-and-hold return and a prospective, versioned simulated
   execution arm using public depth/trades and the production route decision, with no order authority.
4. **Predeclared gates:** paired return lower bound, Brier/log-loss non-regression, candidate/baseline
   coverage, continuous drawdown, exact replay coverage, and fold consistency. Confidence candidates use
   only exact quality-input rows.
5. **One locked candidate and one future review:** stop treating each overlapping 25-window checkpoint as
   fresh confirmation. Lock `(basisWeight=0.65, slowTiltScale=0.5)` as observation-only, collect a new
   prospective cohort, and review once at an agreed independent-window bar.

This report authorizes that design work and the promotion-integrity guards only. Evaluator v2 remains
available for monitoring but cannot support a promotion. This authorizes no model, buy policy, execution,
sizing, stake or live-authority change.
