# Edge policy review: the gate is fine and the desk is not getting it

> Measurement review, 2026-08-17, covering `buy-binary-edge-net5to35-quality50-owned55-price5to97-v17`
> from its activation at 2026-08-14T01:05:00Z. **No policy change is made here**; §6 lists what this
> does and does not authorize.
>
> Reproduce with `npm run analyze:entry-realization`, `npm run analyze:edge-gates`,
> `npm run analyze:execution-value`, `npm run analyze:exit-counterfactuals`, and
> `npm run analyze:exit-alternatives`.
>
> **Every figure is one read of the durable files at 2026-08-17T07:17:38Z.** The ledger is written by a
> running collector, so a re-run will not reproduce these counts exactly; it moved by one settled paper
> entry during the drafting of this report. Ledger figures are settled entries only (`won`, `lost`,
> `sold`). `analyze:execution-value` counts filled entries including still-open positions and therefore
> reports slightly different totals for the same cohort — 112 live entries and −503c against the 110 and
> −565c used here. Neither is wrong; they are different populations.

## Summary

The 2026-08-16 review closed by naming an open question: the gate's counterfactual said +21.4% while
the desk realized roughly nothing, and fill selection accounted for at most 3.4 points of it. With one
more day the question is answerable and the answer has moved.

**The gate is not the problem and the market has not deteriorated.** Restricted to the v17 era, the rows
the gate admits still win 58.8% and return **+14.9% [+8.9, +21.0]** over 892 settlement windows, against
+15.4% for the era before it. Nothing about the signal got worse.

**The realized book under v17 is negative on both tracks.** Live is **−565c on 13,185c (−4.3%)** over 110
settled entries; paper is **−1,458c on 15,550c (−9.4%)** over 117. On the same ledger, entries under the
retired policies returned +570c on 8,457c. Lifetime P&L is no longer a flattering aggregate hiding a
loss — v17 now carries the majority of live stake and is the losing part.

The gap between +14.9% and −4.3% decomposes into two things, and neither is the entry threshold:

| step | live | paper | credible? |
| --- | --- | --- | --- |
| windows passed over beat windows ordered | +16.1% ±17.5 (t=1.80) | +23.0% ±16.6 (t=2.72) | paper only |
| **fills lose to no-fills, in win rate** | **−19.2pp ±14.3 (t=−2.63)** | **−20.3pp ±12.4 (t=−3.21)** | **both tracks** |
| **edge above its persistence median loses** | **+46.0% ±35.0 (t=2.57)** | +23.4% ±33.1 (t=1.38) | **live; direction on both** |

The last two are one mechanism seen twice, and §3 argues they are the same thing.

## 1. The correction that decides this review

**Live and paper are one policy on the same signals in the same windows.** Since v17 they are a mirror by
construction (`src/lib/mirror-invariant.test.ts`), so pooling the two tracks counts every decision twice and
halves every standard error. The 477 v17 orders are **228 unique `(symbol, closesAt, side)` decisions**.
Every cross-track figure below is deduplicated to those, preferring the live record; per-track figures
appear beside them so that agreement is visible as agreement and not silently spent as corroboration.
It is not corroboration, for exactly the reason it is not independent.

Intervals remain clustered on the settlement window, as in the 2026-08-16 review. Win-rate differences
between *order* cohorts are quoted unclustered and labelled: the desk places at most about one order per
contract-window — 206 live v17 orders across 203 distinct contract-windows, counted minutes after the
snapshot — so there the row and the cluster are very nearly the same unit.

## 2. Fill selection is the leak, and the previous review's figure was era-pooled

The 2026-08-16 review reported live filled entries at 30.8% against 34.1% unfilled, called the 3.4-point
gap unestablished, and concluded "fills are not the leak". That figure pools every policy era in the
ledger. Split by the era stamped on each order:

| policy era | filled | unfilled | gap |
| --- | --- | --- | --- |
| pre-versioned (to 2026-08-11) | 305 @ 25.6% | 341 @ 26.4% | −0.8pp ±6.8 |
| v12 | 36 @ 44.4% | 24 @ 50.0% | −5.6pp ±25.8 |
| v13 | 28 @ 39.3% | 37 @ 43.2% | −4.0pp ±24.1 |
| **v17, live** | **101 @ 44.6%** | **80 @ 63.7%** | **−19.2pp ±14.3, t = −2.63** |
| **v17, paper** | **106 @ 42.5%** | **137 @ 62.8%** | **−20.3pp ±12.4, t = −3.21** |

The mechanism is not subtle. The desk rests a passive limit and captures a **−3.96c** mean discount
against the issuance ask on live (−4.06c paper). A resting buy fills when someone sells into it. On a
binary contract with minutes to run, four cents of adverse move is information, so *getting the better
price* and *being wrong* are very close to the same event. The discount is not free money; it is the
price of being selected.

Two honest limits on reading the table as "this is new". The pre-versioned era won only ~26% overall, so
a −19pp gap could not have been expressed there without going to 7%; and v12/v13 have intervals wide
enough to contain −20pp comfortably. What is established is that the gap is credible under v17 on both
tracks. That it was absent before is **not** established.

## 3. The desk is firing on edge spikes, and a spike is an adverse move in progress

`signalEligibility` (`src/lib/signal-persistence.ts`) already computes `medianNetEdge` over the qualifying
snapshots and stamps it on every entry decision. Nothing reads it as a gate. Comparing the edge the desk
fired on against its own persistence median, over the 228 deduplicated decisions:

| cohort | decisions | win | return, window-clustered |
| --- | --- | --- | --- |
| edge within 2pp of its persistence median | 155 | 58.7% | **+13.2% ±15.7** |
| edge 2pp or more above it | 50 | 34.0% | **−26.1% ±29.7** |
| difference | | 24.7pp ±15.2 (t=3.18) | +39.3% ±33.6 (t=2.30) |

Restricted to positions that actually filled, the spiked cohort wins **20.0%** and returns −53.1%.
The fresh cohort's win rate, 58.7%, is the gate counterfactual's 58.8% — the freshly-priced decisions
realize exactly what the gate promises, and the spiked ones destroy it.

The mechanism is the point. An edge that has just jumped above its own recent level is a price that has
just moved; the direction it moved is against the side that the jump makes look cheap. That is the same
sentence as §2 written from the signal side rather than the execution side, which is why the two
compound: filled **and** spiked wins 20.0%.

**What keeps this above noise.** Five decision-time dimensions were swept before this one separated —
the spike, the persistence median level, the recorded cycle regime, the qualifying-snapshot count, and
seconds remaining. Only the spike moved. At roughly twenty cells looked at, the best is expected to
reach about t = 2.2 under a null, so t = 2.30 is not what carries this. What carries it is that the
direction repeats **within every net-edge band** and on **6 of 6 assets** (a clean sweep has probability
1.6% under no effect), and that a mechanism was available before the cut was made.

In realized cents, the cut splits the v17 book almost exactly along the line between its result and the
counterfactual's:

| | as traded | edge fresh (kept) | edge spiked (dropped) |
| --- | --- | --- | --- |
| live | −565c on 13,185c = −4.3% | **+1,486c on 9,099c = +16.3%** | −2,051c on 4,086c = −50.2% |
| paper | −1,458c on 15,550c = −9.4% | −200c on 11,397c = −1.8% | −1,258c on 4,153c = −30.3% |

Under a third of stake (31% live, 27% paper) produced all of the loss, and the live remainder returns
+16.3% — which is the counterfactual's +14.9%, arrived at. Paper's remainder only reaches −1.8%, and
that disagreement between the tracks is not explained here.

**What it does not clear.** Three days. The 0.02 threshold was chosen after looking at the bins, and the
table above is that same threshold scored on the same data that chose it — it is an illustration of
magnitude, not an out-of-sample result, and it must not be read as "the desk would have made +1,486c".
Paper's own clustered interval spans zero (t = 1.38). This is retroactive screening, and under §5.5 of
the agent rules retroactive screening promotes nothing.

## 4. Window selection: real on paper, not established on live

Of the admitted windows, the ones the desk ordered returned +3.7% ±14.7 (live) while the ones it was
active for and passed over returned +19.7% ±9.5 — a selection cost of +16.1% ±17.5, t = 1.80. Paper's
version clears two standard errors (+23.0% ±16.6, t = 2.72) but shares live's signals, so it is one
observation, not two.

The useful negative here: windows where the desk placed **no** order at that close at all — downtime,
budget, the hourly ceiling — returned +15.6% ±9.2, statistically the population mean. **Downtime is not
selecting anything.** Whatever is happening is in ranking among simultaneous candidates, not in the
desk being switched off, and that narrows where to look.

## 5. Exits

### 5.1 Strict value still carries the book

| arm | n | windows | incremental | t | total | on 2026-08-16 |
| --- | --- | --- | --- | --- | --- | --- |
| live · EXIT vs HOLD · `strict-value-v1` | 57 | 53 | +15.3% ±13.7 | 1.12 | +915c | +9.4% ±13.9 |
| paper · EXIT vs HOLD · `strict-value-v1` | 160 | 118 | +29.3% ±10.4 | 2.81 | +3,865c | +28.9% ±10.9 |

Live improved and still does not clear two standard errors; paper is essentially where it was.

Without exits the live book would be −623c instead of +67c lifetime, and paper −4,922c instead of
−1,448c. The asymmetry the 2026-08-16 review insisted on stating is unchanged and still the thing to
protect: pooling both exit policies, the exit was right on **13 of 65** live exits (20.0%) and 69 of 191
paper exits (36.1%) and profitable anyway, because it gives up a little often and avoids a total loss
occasionally. A rule that fires less does not obviously help. Those hit rates are the pooled exit
cohort from `analyze:execution-value`, not `strict-value-v1` alone; the per-policy split above is the
authoritative one for attributing the money.

### 5.2 The profit-reversal accumulation plan cannot execute

The 2026-08-16 review said `profit-reversal-75-v1` should "go to the evaluation lane if it stays
credibly negative past ~25 windows". It sits at **9 exits across 8 windows**, unchanged, at −192.9%
±81.5. It cannot move: `profitReversalExitEnabled()` is false, so the rule records armed downturns and
never sells, and the EXIT-vs-HOLD arm only accrues on decisions that executed. The 9 exits are historical
residue from when it was armed.

**Waiting for 25 windows is waiting for something that cannot arrive.** The decision has to be made on
the 9, or the counterfactual has to be scored on withheld arms rather than executed ones. Meanwhile
`exit-at-armed-peak` — positions that armed the lock and were never sold — sits at −59.0% ±28.4 over 40
positions, t = −2.08, −1,192c, against the 993c the 2026-08-16 review reported. That arm is negative by
construction (the peak is the best exit the cohort could conceivably have taken), so only its magnitude
informs.

### 5.3 The trailing-stop family now moves together

Twenty-six alternatives replayed over 207 recorded position paths — 133 held to settlement (29 won, 104
lost) and 74 sold by the live rule, which together earned −2,266c on 25,114c — scored on every position
with the live rule running alongside, first to fire winning:

| family | rules | mean vs today | positive | best |
| --- | --- | --- | --- | --- |
| take-profit | 8 | +4.1% | 4/8 | +5%: +2,025c, t = 1.68 |
| **trailing** | **5** | **+1.2%** | **5/5** | arm+25% give20%: +568c |
| profit-reversal | 3 | −0.3% | 1/3 | — |
| time flatten | 6 | −3.2% | 3/6 | — |
| stop-loss | 4 | −8.8% | **0/4** | — |

Trailing was 2/5 positive on 2026-08-16 and is now 5/5. Individually every t is weak (0.06 to 1.03), so
no single trailing rule is evidence. The group direction is the interesting part, and one property makes
it worth naming: the low-give variants **barely pre-empt strict value** — `arm+50% give20%` adds +530c
while front-running 2 of 74 strict-value sales, `arm+50% give35%` adds +400c front-running 1.

That is a direct answer to the question §9.1 of the 2026-08-16 review left open — whether anything can
reach the losing positions that were once profitable *without* spoiling the sales strict value makes.
(That review put the share of total-loss positions once up 5% or more at 43% on 2026-08-16; the figure
printed by `analyze:exit-alternatives` is a fixed string in the script rather than a recomputed value,
so it is quoted here with its date and not treated as current.) Take-profit cannot reach them cleanly:
+5% looks worth +5,130c on held positions and is worth +2,025c after pre-empting 68 of 74 strict-value
sales. A high-arm, tight-give trail is the shape that can, because it only engages on positions that
already ran.

Stop-loss is unchanged and remains the firmest negative in the review: 0/4, family mean −8.8%, t = −2.03
at −60%. Cutting a losing binary early is the wrong instinct.

## 6. What this authorizes

Nothing automatic, and no policy version changes here. In order of value:

1. **Treat signal freshness as the first candidate for the evaluation lane.** `medianNetEdge` is already
   at every decision, so a `netEdge − medianNetEdge` gate needs no new plumbing. It must go in as a
   committed prospective sentinel written at decision time, per §5.5 — the cohort here was screened
   retroactively and cannot promote itself. Note the walk-forward evaluator cannot express it (item 6).
2. **Re-open maker execution on the v17 evidence.** The standing position is that maker stays until
   maker/taker shadows pass strict held-out gates, and this review does not overturn it — but the
   premise that fills are not the leak was measured across pooled eras and does not survive the split.
   The −4c discount is being paid for in selection. This authorizes measuring, not switching.
3. **Decide `profit-reversal-75-v1` on the evidence that exists, or change how it accrues.** The stated
   25-window bar is unreachable while the rule is withheld (§5.2).
4. **Do not tune entry thresholds.** They are flat, and the v17-era cohort re-confirms it. The gate is
   admitting a +14.9% population; the loss is downstream.
5. **Do not act on per-asset results**, including the per-asset spike sweep in §3. Six assets at 4 to 46
   decisions each is a direction check, not a per-asset measurement, and the 2026-08-16 review already
   showed that per-asset apparent significance does not survive window clustering.
6. **The walk-forward baseline is not the production policy, and its objective is the wrong quantity.**
   Two separate defects, both in `src/lib/walk-forward.ts`:
   - `WalkForwardParameters` carries `minimumEdge` and `minimumQuality` but no maximum edge and no
     selected-side floor, so `PRODUCTION_BASELINE_PARAMETERS` cannot express `MAX_NET_EDGE` (v15) or
     `MIN_SELECTED_SIDE_PROBABILITY` (v13). A candidate is being compared against a gate the desk does
     not run — and the 2026-08-16 gate sweep scored that missing side floor at −5.1pp when removed,
     making it one of the two load-bearing components.
   - `selectedTrade` scores `(outcome === entrySide ? 1 : 0) − (entryAsk + entryFeeRate)`: bought at the
     ask, held to settlement. That is precisely the fill-optimistic, exit-blind counterfactual this
     review shows is off by ~19pp of win rate on the cohort maker execution actually captures, and which
     omits the exit that is carrying the entire realized result. **A candidate can clear every promotion
     threshold on that objective and still lose money**, which makes hardening the promotion gates
     (STATUS.md §3) a prerequisite to any promotion rather than a parallel task.

## 7. What this review cannot say

It cannot say the spike effect is real. It can say it is the only decision-time dimension of five that
separated, that it repeats within every edge band and on every asset, that it has a mechanism, and that
it is three days old with a threshold chosen after the fact.

It cannot attribute the v17 fill gap to any specific change. Several things moved together on
2026-08-14 — the mirror alignment, paper maker execution, the bounded-retry alignment, and v17 itself —
and the earlier eras are too small or too low-base-rate to serve as a control.

It cannot separate "the ranking picks worse candidates" from "the ranking picks candidates that are
worse to execute". §4 establishes there is a selection cost among simultaneous candidates and does not
identify it; §3 offers a hypothesis that would explain it, since ranking by `edgeStrength` — net edge
scaled by confidence (`src/lib/prediction-policy.ts`) — mechanically prefers the largest edge available in
the cycle, and §3 says the largest edge is disproportionately the freshly-spiked one.

Sample sizes remain thin everywhere it matters: 110 live and 117 paper settled entries under v17, 207
position paths, 3 days. Every figure here should be re-read against a week.

## Correction, 2026-08-17: paper's P&L figures are distorted by a phantom fee

**Every paper P&L figure in this report is overstated as a loss, and every comparison drawn between the
two tracks' P&L is contaminated.** The win-rate findings are not — §2's fill selection and §3's edge spike
never touch fees, and both stand exactly as written.

Paper is charged a taker fee on maker fills that live does not pay. Across every live fill, grouped by
the liquidity role Kalshi itself reported, maker fills (497 of them) carry a mean fee of 0.000c and taker
fills (5) carry 0.682c. Live reads the real fee from the venue and releases the unused reserve; paper
recomputes the conservative taker reserve and keeps it.

Under v17 paper paid 635c of entry fees across 119 settled entries — 4.04% of stake — against live's 0c:

| | as this report states it | like-for-like with live |
| --- | --- | --- |
| paper, all settled v17 entries | −1,299c on 15,729c = −8.26% | **−664c = −4.22%** |
| paper, the 76 decisions live also filled | −5.56% | **−1.39%**, against live's −2.98% |

So the summary's "paper is −1,458c on 15,550c (−9.4%)" should be read as roughly **−4.2%**, and the claim
that paper does worse than live inverts on the shared subset. The §3 realized-cents table's paper row is
inflated the same way; its live row and every win rate are unaffected.

This is not merely a reporting artefact — the reserved fee shrinks paper's position sizing and feeds
`evaluateExitPolicy` through both cost basis and assumed exit fee, so paper has been making different sell
decisions. Cause, blast radius and the fix are in
[docs/paper-maker-fee-design.md](../docs/paper-maker-fee-design.md). No figure above has been edited; this
correction is additive, per the rule that a superseded measurement is never deleted.

## Addendum, 2026-08-17: what was actually done

Recorded here rather than by editing §6, because the decision differed from the recommendation and the
difference is the interesting part.

§6 item 1 recommended a sentinel **only**, on the grounds that retroactive screening promotes nothing.
The operator decision was to ship the gate as **v18** *and* run the sentinel, on an explicit asymmetry:
declining ~30% of stake costs roughly nothing while the book realizes −4.3%, and not declining it costs
~680c/day against 1,705c available if the effect is real. That is a different justification from
"the evidence cleared a bar", and `src/lib/policy-manifest.ts` states it as such.

The rest of §6 is unchanged and unactioned. Two things this addendum should not be read as saying:

- **The evidence did not get stronger.** Nothing was re-measured. The threshold is still post-hoc, the
  sample is still three days, and paper's clustered interval still spans zero.
- **This is not a precedent for shipping on retroactive screening.** It is a bet whose downside is
  bounded by the book already being negative, with a rollback criterion written before the fact and a
  sentinel that accrues whether or not anyone remembers to look. Change either of those conditions and
  the reasoning does not carry.

Design and the accepted regime-gate warm-up cost: [docs/edge-spike-sentinel-design.md](../docs/edge-spike-sentinel-design.md).
