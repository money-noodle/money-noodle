# Where the edge policy's money is, and is not — a screen of eleven ideas

> Measurement review, 2026-08-19. **No policy change is made or authorized here.** Everything below is
> retroactive screening, which under AGENTS §5.5 may filter an idea and may never promote one. §9 lists
> what this does and does not support.
>
> Every figure is one read of the durable files on 2026-08-19. The ledger is written by a running
> collector, so a re-run will not reproduce these counts exactly.
>
> Two things were changed in the repo alongside this report and are described in §7 and §8:
> `entry-decision-v2` now records the edge spike and the numeric cycle-regime features. The first
> `scripts/analyze-contract-selection.mjs` ranking-key correction was itself superseded by the full
> decision-state correction in §8.

## Method

The unit is the **admitted population**: the first qualifying calculation for each
`(symbol, closesAt, side)`, priced at the recorded Kalshi ask for that side and held to settlement.
This is the population the 2026-08-18 edge-magnitude report established as the right one — it is
unbiased by what the desk chose to order or managed to fill, and the three reversals that report
records all came from measuring the filled orders instead.

Gate applied: the live v21 bounds — price 5–97¢, selected-side probability ≥ 0.55, net edge ≥ −5pp,
estimate quality ≥ 0.5, 90 s warm-up, 30 s late cutoff — with the taker fee `0.07·p·(1−p)`. Returns are
per $1 committed, `payout/cost − 1`, clustered on the settlement window. Realized figures come from
`data/paper-orders.json` and use the exact `actualPnlCents`/`actualStakeCents` view, not the whole-cent
budget view.

**Control.** This harness returns **+20.8% ±5.2 per $1 over 671 settlement windows and 3,078
decisions**, against `analyze:loss-decomposition`'s +20.9% for the v19 gate. It is reading what the
desk reads.

**Multiple-comparison denominator.** Roughly ten segmentations of the admitted population, eight
ranking keys, five spike thresholds, five calibration weights, and five sizing weightings were
evaluated — about thirty-three comparisons. One t above 2 among that many is not evidence, and the
sections below say for each result whether a group moves together or a single cell does.

---

## 1. Sizing is the largest measured lever, and it changes no gate — worth the effort

Identical 3,078 decisions, identical admission rule, identical rows. Only the **weight** changes:

| weighting | return per $1 committed |
| --- | --- |
| flat stake (production) | **+18.6%** |
| stake ∝ net edge | +38.3% |
| full Kelly | +30.1% |
| stake ∝ √edge | +27.4% |
| **capped 0.3×–3× of base, pivot 8pp edge** | **+28.9%** |

- Capped sizing beats flat on **9 of 9 days**, by +2.4pp to +24.8pp. Not one day disagrees.
- **Not tail-driven.** The ten highest-edge rows contribute **4.0%** of the capped-sizing profit.
- Restricting to `netEdge < 35pp` — the cohort a re-armed `MAX_NET_EDGE` would leave — the advantage
  shrinks but survives: **+19.9% against +14.8%**. Below 25pp it is +17.3% against +13.5%.

The mechanism is already established in this repo. `reports/edge-magnitude-2026-08-18.md` measured
return per $1 rising from +11.6% at 5–10pp edge to +44.0% at 25–35pp while the win rate *falls*. The
desk already knows this: `expectedProfitCents` = `potentialPayoutCents × p − stakeCents`, which at a
fixed stake is `edge / cost` — return on capital. It **ranks** by that number and then hands every
winner the same dollar. Ranking and sizing disagree, and sizing is the one that determines P&L.

**Why this is not a free change, and why it is a design question rather than a patch.** Variable stake
destroys the implicit dollar ceiling that `DEFAULT_MAX_OPEN_POSITIONS = 9` currently provides. AGENTS
§4 requires exposure and correlation caps to be global and counted across the whole account; at a flat
$1 ticket a position count *is* a dollar cap, and at 0.3–3× it is not. The caps have to become
dollar-denominated before the sizing rule can exist. It also amplifies the sign of the book, and the
book is currently negative. Design note: `docs/edge-proportional-sizing-design.md`.

## 2. The edge spike separates realized money out-of-sample — but the committed sentinel says it is not a forecast effect

The 2pp edge-spike gate was disarmed at v19 by operator decision, on evidence the manifest itself
records as thin (t = 0.43 over 52 sentinels). Scoring the order ledger on **v19/v20/v21 only** — the
threshold was chosen on v17 data, so this cohort is out of sample:

| track | fresh (spike < 2pp) | spiked (≥ 2pp) |
| --- | --- | --- |
| live | +0.2% (n=44, 3,731¢) | **−22.2%** (n=19, 1,620¢) |
| paper | −6.7% (n=57, 4,802¢) | **−16.9%** (n=23, 1,850¢) |

Split finer over the full v17+ ledger, the band both tracks agree on is **5pp**, not 2pp:

| spike band | live realized | paper realized |
| --- | --- | --- |
| below median (< 0) | −8.0% (n=49) | +5.3% (n=65) |
| 0–1pp | +12.8% (n=96) | −19.1% (n=100) |
| 1–2pp | +35.4% (n=17) | +8.0% (n=25) |
| 2–5pp | −49.9% (n=18) | +3.4% (n=23) |
| **5pp +** | **−37.7%** (n=32, 3,558¢) | **−51.6%** (n=31, 3,223¢) |

**And the committed sentinel disagrees.** Grading all 296 resolvable `edge-spike-sentinel-v1` records
at their recorded ask, held to settlement, clustered by window, the 2pp gap is **+1.9pp, t = 0.12**
(v19+ only: +3.3pp, t = 0.15). Of five thresholds tried only 3pp is large — +28.7pp, t = 1.71 — and
picking it is threshold-shopping across the same five cells.

**The disagreement is the finding, and it relocates the effect.** The sentinel prices
buy-at-the-ask-and-hold. The ledger includes the maker fill and the exit. So the spike does not predict
whether the side settles right; it predicts what happens to a *resting order placed while the quote is
moving*. Two supporting details point the same way: fill rates barely differ by spike (43–59%), and the
**maker discount is larger on spiked orders — 5.30¢ against 4.55¢**. A bigger discount with a worse
outcome is the signature of being run over, not of getting a bargain.

This points the same way as the same-day
[maker-adverse-selection-and-exit-depth-2026-08-19.md](maker-adverse-selection-and-exit-depth-2026-08-19.md),
which finds the maker result to be a selection mechanism rather than a losing cohort. The two were
measured independently and should be read together; neither identifies a validated replacement.

That is the same sentence `lib/edge-spike-policy.ts` already writes in its header — "a resting passive
limit below that then fills only if the move continues, so the entry signal and the fill selection are
the same event seen twice" — except the sentinel now says the entry half is null and the fill half is
where the money is.

**What this suggests, and does not.** It does not support re-arming the entry gate: the committed
prospective arm, which is the only evidence SPEC §12.5 would accept, is flat. It suggests the spike
belongs in the **execution** layer as "do not rest passively into a running quote", which SPEC §12.3
permits without touching the mirror invariant. Settling that needs the fill outcome and exit path
recorded beside the spike, which §7 is the prerequisite for.

## 3. `volatilityRatio` is clean on the gate and does not survive the ledger — a reversal, recorded

`volatilityRatio` is our σ divided by the σ the venue price implies (`lib/dashboard.ts`). On the
admitted population it is one of the cleanest gradients in this dataset:

| VR band | n | win | return per $1 | days positive |
| --- | --- | --- | --- | --- |
| 0.00–0.20 | 685 | 70.1% | +19.4% ±6.9 | 9/9 |
| 0.20–0.38 | 349 | 64.8% | +14.5% ±11.2 | 7/9 |
| 0.38–0.72 | 336 | 62.8% | +10.3% ±10.4 | 5/9 |
| **0.72 +** | 344 | **52.6%** | **+1.4% ±11.9** | 6/9 |

It is **not net edge in disguise** — it holds inside every edge band. In the −5..10pp band the top VR
tercile returns −0.5% against +16.3% for the bottom. And it has a mechanism stated in the code:
`lib/basis-model.ts` says volatility is the only input on which our estimate may legitimately differ
from the venue's, so when VR is high we and the venue already agree on σ and the claimed edge is the
model asserting a *directional* view it has no standing to hold.

**It does not replicate on realized money.** `basis.volatilityRatio` is stamped on 605 of 995 v17+
orders, so this is checkable directly:

| VR band | live realized | paper realized |
| --- | --- | --- |
| 0.00–0.20 | +13.5% (n=45) | +5.1% (n=54) |
| 0.20–0.38 | −1.7% (n=27) | −9.1% (n=25) |
| **0.38–0.72** | **−27.3%** (n=30) | **−26.7%** (n=34) |
| 0.72 + | −1.3% (n=24) | −10.6% (n=31) |

The worst band is the **middle** one, on both tracks, and refusing VR ≥ 0.72 recovers nothing: live
goes from −4.6% to −5.0%. Fill rates are flat across VR (39–52%), so execution does not explain it
either. Either the ledger cells are noise at n ≈ 30 or the gradient does not survive contact with
execution; three or four days cannot referee between those. **Do not act on this**, and note that it is
the fourth reversal of this shape in this repo — an effect that is clean on the admitted population and
absent on the filled one.

## 4. Trend efficiency at its ceiling is dead volume — and is not yet checkable against money

`cycleRegime.trendEfficiency` ≥ 0.99 — a move that is a straight line, `slope ÷ range` at its
maximum — returns **+7.7% ±8.3 over 590 decisions (6/9 days)** against **+24.2% ±6.0** for everything
below it. That agrees in direction with `reports/swing-trading-2026-08-18.md`, which found monotone
mean reversion in trend efficiency surviving on a single consistent price series (t = 3.52 bid-only).

The joint arm `volatilityRatio < 0.72 AND trendEfficiency < 0.99` keeps 2,176 of 3,078 decisions at
**+26.9% ±6.1** against the +20.8% ±5.2 baseline, and improves on **9 of 9 days**; the 902 it drops
return +5.0% ±7.3.

**It cannot be checked against realized money at all**, because `trendEfficiency` was not recorded on
the order. Only the coarse `cycleRegime.regime` label reached the ledger, and that label disagrees
between tracks: refusing `trending` costs live money (the dropped arm returned −1.7% against −5.7% for
what was kept) while saving paper money (−21.5% dropped against −6.8% kept). Given §3, the reasonable
prior is that this does not survive execution either. §7 is what makes the question answerable.

## 5. The 0.55 calibration weight is measurably too much shrinkage — and correcting it loses money

Production's traded probability replays exactly as `sigmoid(0.55·logit(basisProbability) + slowTilt)`,
clamped to [0.03, 0.97]. Fitting that weight by logistic regression on **54,576 replayable resolved
rows**:

- pooled MLE **β̂ = 0.738** against production's 0.55;
- **leave-one-day-out β in 0.69–0.77 on 11 of 11 days**, out of sample;
- out-of-sample Brier 0.1992 → 0.1966, log loss 0.5835 → 0.5776;
- unclamped rows only, β̂ = 0.741, so it is not an artefact of the [0.05, 0.95] basis clamp;
- **day-clustered, mean β = 0.62 ± 0.10** — per-day estimates run 0.02 to 1.01 — so production's 0.55
  sits inside the interval. Suggestive at the pooled level, not established at this desk's bar.

**Raising it loses money.** Re-running admission on the same rows with only the weight changed:

| probability | decisions admitted | return per $1 |
| --- | --- | --- |
| **production, β = 0.55** | 3,078 | **+20.8% ±5.2** |
| β = 0.65 | 3,296 | +19.4% ±5.1 |
| β = 0.74 (the fitted value) | 3,523 | +18.2% ±4.9 |
| β = 1.00 (no shrinkage) | 3,945 | +15.5% ±4.7 |
| β = 0.74 with the fitted −0.17 intercept | 3,471 | +15.9% ±4.8 |
| `settlementAverageEstimate`, unmodified | 3,958 | +16.1% ±4.7 |

The honest reading: **the 0.55 weight is not calibration, it is selectivity.** Being systematically
under-confident refuses the marginal trade, and the marginal trade is worse than the average one. Do
not "fix" the calibration without first replacing the selectivity it is silently providing. This is a
null result and is reported as one (AGENTS §5.6).

Two structured residuals worth recording rather than acting on:

- **A stable negative intercept** (−0.14 to −0.22 on 9 of 11 days): outcomes ran below the basis
  probability across this sample. Fitting it is a directional bet on eleven days, and this repo has
  already withdrawn one side-specific suspension built that way.
- **β varies with time remaining** — 0.63 at T < 60 s, 0.72 at 60–120 s, 0.78 at 120–240 s, 0.74 at
  420–900 s. That pattern is a **known misspecification**, not noise. Production uses
  `effectiveSeconds = T − 30`, while the exact variance of the settlement average is `σ²(T − 2W/3)` for
  T ≥ W and `σ²r³/(3W²)` once the window is partly observed — **both already implemented in
  `lib/settlement-average.ts`** and both never allowed to trade. At T = 45 s production's σ is 1.33×
  too large. Separately, there is no variance floor for Kraken-versus-venue-oracle basis risk even
  though `targetComparison.oracleAligned` is `false`, so what bounds certainty near close is something
  the model does not model. A variance floor is one parameter and is mechanism-first rather than
  fitted — but note that the whole-estimator swap above already measures *worse*, so this is a research
  question, not a queued change.

## 6. Six smaller readings

- **Late entries pay.** First admission at 30–60 s remaining returns **+44.2% ±35.2** and at 60–120 s
  **+59.5% ±37.6**, against +18.4% ±5.3 at 420–900 s. v20's cutoff move from 120 s to 30 s is
  confirmed on this population. Both cells are small (n = 113, 161).
- **Contradicting the venue is where the value is, not agreeing with it.** Splitting on whether the
  venue's implied direction matches the basis: agreement wins **71.2%** and returns +16.3% ±4.4;
  disagreement wins **51.5%** and returns **+23.0% ±7.8**. Both 9/9 days. This is the repo's own "win
  rate is the wrong statistic across price levels" lesson appearing again in a new place.
- **Price 0.80–0.90 is dead volume**: 47 decisions, −0.0% ±13.3, at an 85.1% win rate.
- **Confidence is not monotone in return** (quartiles +21.4%, +13.9%, +9.0%, +34.7%). `edgeStrength =
  netEdge × confidence` therefore has no measured support even as the live drain-order pre-sort, and §8
  shows it makes almost no difference in practice.
- **Asset exclusion remains unsupported.** BNB and DOGE are the weakest admitted assets (+7.5%, +8.5%)
  and the worst on paper realized (−23.7% combined), but on **live** realized they are better than the
  rest (−3.2% against −6.0%). The tracks disagree; leave `lib/asset-exclusion.ts` alone.
- **Hour of day**: 16:00–20:00 UTC settlement is strongest (+42.1% on 8/8 days, then +51.2%);
  06:00–08:00 (+5.4%) and 14:00–16:00 (+6.2%) weakest. Twelve cells, and this dimension has already
  been reported twice in this repo. Treat as known, not new.
- **Exits.** `strict-value-v1` is still the desk's strongest component: live +10.5% ±10.2 (t = 1.02,
  +892¢), paper +21.7% ±8.6 (t = 2.53, +3,391¢). `exit-at-armed-peak` reads −54% live and −92% paper,
  which says value sits between the peak and the exit — but that arm is a best-case bound by
  construction and no rule can hit it.

## 7. Shipped with this report: `entry-decision-v2`

Sections 2, 3, and 4 all end at the same wall — the quantity that separates the *gate* population is
not recorded on the *order*, so it cannot be scored against realized money. `entryDecision` now records
two things the desk already computed at decision time and discarded:

- `edgeSpike` — the firing edge minus its persistence median, recorded whether or not the ceiling is
  armed, because a disarmed gate is exactly the state in which the measurement is the only thing that
  could ever justify re-arming it;
- `cycleRegime` — the numeric features (`trendEfficiency`, `localVolatilityPerSecond`, `signFlipRate`,
  `lagOneAutocorrelation`, `rangePercent`) behind the coarse label the order already carried.

Both are reporting-only. `lib/entry-decision-observation.test.ts` asserts that no module on a pricing,
sizing, gating, or execution path reads them, that the features are cloned rather than aliased, and
that a v1 row keeps the fields **absent** rather than defaulted — the failure mode the long-shot hold
sentinel hit when `peakOwnedSideBidCents` was read as "did not touch" on 26 records that predated it.

No behaviour changes: no candidate, persistence state, ranking, size, or execution decision reads a new
field, and `BUY_POLICY_VERSION` is untouched.

## 8. Corrected after this report: the named contract-selection leak was a comparator artefact

The first correction shipped with this report fixed the ranking key and removed same-asset opposite-side
contamination, but it did **not** fix the choice set. It still compared an issued order with every contract
that had qualified at some earlier or later point in the settlement window. Those alternatives had not
necessarily passed decision-time persistence, classified regime, re-entry cooldown, retry state, active
exposure, or production sizing. The reported **−20.2pp RANKING gap and −21.9pp TIMING gap are withdrawn.**

`npm run analyze:contract-selection` now begins at each issued v17-v19 live order snapshot and:

1. uses the exact order snapshot for the chosen contract;
2. reconstructs issuance-near alternatives under the stamped policy's 3-over-30 persistence and v18 spike
   ceiling, classified regime, XRP exclusion, 60-second re-entry cooldown, and one-attempt live state;
3. reconstructs authoritative active reservations/positions at that instant;
4. sizes every candidate through production `estimatePaperFill` at the snapshot's all-in ceiling;
5. ranks through production `selectPortfolio` under the historical 3/2/1 caps; and
6. compares paired choices, averaging repeated snapshots inside their settlement window before estimating
   uncertainty.

Read at **2026-08-19T16:12:53Z**, from 63,506 forecasts and 2,676 order rows. Outcomes are venue-specific
Kalshi resolutions; approximately comparable Polymarket outcomes are never substituted:

| cohort | snapshots passing positive control | independent windows | same choice | chosen | replay preferred | paired difference (95%) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **v17-v19** | **339** | **232** | **331** | −5.5% | −4.6% | **−0.9pp ±2.7pp** |
| v17 | 197 | 136 | 192 | −1.6% | −1.3% | −0.3pp ±4.3pp |
| v18 | 73 | 52 | 71 | −18.4% | −16.9% | −1.4pp ±2.8pp |
| v19 | 69 | 44 | 68 | −2.2% | −0.1% | −2.1pp ±4.1pp |

The positive control is load-bearing: production demonstrably placed the chosen order, so a reconstructed
portfolio that refuses it cannot estimate a ranking effect. The script replayed 346 of 354 snapshots; 339
passed that control. In those, production and replay selected the same contract **97.6%** of the time. The
eight different-choice snapshots show a noisy −38.9pp ±88.8pp difference and carry no conclusion.

**Finding:** there is no measured ranking defect. The old loss-decomposition stage remains a real narrowing
from all admitted rows to the ordered cohort, but it is not a decision-time choice comparison. Its correct
name is **ordered-cohort selection**, and what causes that cohort difference remains unknown.

This is still not an exact historical replay: forecast history omits some failed observations and
`portfolioDecisions` is overwritten rather than journaled. That is why later policies fail closed here—their
runtime cap overrides were not stamped—and why any future ranking claim needs a prospectively committed
choice set. The correction authorizes no production change.

## 9. What this authorizes

**Nothing, and specifically no gate, execution, sizing, or calibration change.** Three of these ideas
were measured and failed: the volatility ratio (§3) does not survive the ledger, the calibration
correction (§5) loses money, and asset exclusion (§6) disagrees between tracks. Two are recorded as
open with a stated next step: the edge spike as an *execution* signal (§2) and trend efficiency (§4),
both of which are now recordable because of §7 and neither of which has a prospective arm yet.

One is worth real effort and is a design question first: **sizing** (§1). It is the only result here
that is monotone, 9/9 days, mechanism-first, robust to removing its tail, and unchanged by every
admission question above — because it changes no admission at all. Its blocker is not evidence, it is
that global exposure caps stop being caps when the ticket varies.

### What would change these answers

- **§1** would be settled by a walk-forward arm that scores the sizing rule rather than the gate, with
  a dollar-denominated exposure cap in place. It would be refuted by the capped arm failing to beat
  flat once the entry rule's own drawdown is charged against it.
- **§2** would be settled by an `edge-spike-sentinel` carrying the fill outcome and the exit path, so
  the sentinel and ledger arms answer the same question. It would be refuted by the spike–fill
  relationship disappearing once fill rate is controlled per price band.
- **§3 and §4** would be settled by a prospective arm over the `entry-decision-v2` fields, once enough
  windows have accumulated to compare the admitted gradient against the realized one on the same rows.

## Caveats

- Nine to eleven days, one venue, one market, one strategy. Every realized cell in §2 and §3 sits
  between n = 17 and n = 100.
- The admitted population is priced at the first qualifying calculation; the desk decides at a different
  instant, so the two are not sampled at the same moment.
- Returns at the ask held to settlement ignore the exits, which `analyze:loss-decomposition` prices at
  +14.6pp under v17 and −2.9pp under v19.
- Live and paper are one policy on the same signals in the same windows. Where both appear they are
  agreement, not corroboration.
- Roughly thirty-three comparisons were evaluated. §1 and §8 are the only results carried by a
  monotone or complete-sweep pattern rather than by a single cell.
