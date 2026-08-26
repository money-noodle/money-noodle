# Missed entries, 2026-08-18 — the gate is not what is keeping volume out; persistence is

> **No policy change is made or authorized here.** It answers an operator question directly: are there
> buys the desk refuses that it should be making, judged by whether they could have been sold at a
> positive exit?
>
> Reproduce with `npm run analyze:missed-entries`. **Every figure is one read of the durable files at
> 2026-08-18T20:33:05Z**, written by a running collector, so a re-run will not reproduce these counts
> exactly.

## Summary

1. **"Could have been sold at a profit" barely selects anything.** Of the live rule's entries with a
   recorded price path, 81% were sellable at a profit at some point after entry — and so were **60% of the
   ones that expired worthless**. A rule that admits on that basis keeps most of the losses.
2. **No relaxation of the edge, price, or quality gates produces trades that beat the live rule.** Every
   increment either matches it, or is negative. Lowering the selected-side floor is the worst of them, at
   −13.3% ±12.9 over 333 decisions — independent confirmation of the v13 restoration.
3. **Two gates are inert.** Relaxing `MIN_ESTIMATE_QUALITY` to 40% or the price band to 2–99¢ admits
   **zero** additional decisions in 3,017 windows. They are not risk controls (AGENTS §5.7).
4. **The gate that costs volume is signal persistence**, and it is already under prospective measurement.
   The committed sentinel `persistence-two-consecutive-v1` (SPEC §706) has **553 resolved incremental
   settlement windows against the 100 it was locked for**, returning **+13.2% ±8.4 per dollar** at the ask.
   Its first review is due and has not happened.
5. **The desk is at capacity before any of this matters.** The live rule already admits a median of 3 and a
   mean of 3.6 simultaneous decisions per settlement time against `DEFAULT_MAX_OPEN_POSITIONS` of 3. Above
   that count a looser gate changes *which* trade is taken, not how many.

## Method

Every recorded calculation, both sides, Kalshi only: 3,017 resolved settlement windows over 8 days, 30,872
calculations, 1,443 of those windows with a recorded 15-second price path (2-second from 2026-08-18).
Entries are the first calculation the arm's own rule admits, bought at the recorded ask. Decisions are one
per `(symbol, window, side)`. Intervals are clustered on the settlement window (AGENTS §5.1).

Two corrections decide the numbers.

**Cohorts are whole candidate rules, not "rows failing gate X".** A cohort defined by which gate refuses it
has its entry time chosen by that definition, so slicing it afterwards by price re-selects the entry and the
parts stop summing to the whole. An earlier pass of this measurement did exactly that and produced a
"negative-edge contracts return +6.9%" result whose price bands each read ≈0 — the aggregate exceeded every
one of its parts. That version is withdrawn; nothing from it appears below.

**An arm is judged on its *increment*** — the decisions it admits that the live rule never admits anywhere
in that window — **and the increment must beat the live rule** (AGENTS §5.4), not beat zero.

## 1. The premise: a profitable exit was nearly always available

806 live-rule entries with a recorded path:

| settled | n | a profitable exit existed after entry |
|---|---|---|
| in the money | 461 | 97% |
| worthless | 345 | **60%** |

Availability does separate winners from losers. It is nowhere near strong enough to select on: three in
five total losses were green at some point first. This is the capped-gain, uncapped-loss shape measured
directly in [swing-trading-2026-08-18.md](swing-trading-2026-08-18.md) §1, where selling into a swing that
happens 64–81% of the time still lost 0.15 per $1 against simply holding.

Every arm below therefore reports exit availability, and is decided on return per dollar.

## 2. Relaxing the selection gates

Increment only — decisions the live rule never admits in that window. Held to settlement, at the ask.

| relaxation | n | windows | return/$1 | stake-weighted | days + | with `strict-value-v1` replayed |
|---|---|---|---|---|---|---|
| edge floor 3pp | 30 | 30 | +7.3% ±30.3 | +7.6% | 3/3 | −0.6% ±20.6 |
| edge floor 0pp | 116 | 116 | +18.3% ±13.7 | +17.9% | 3/3 | +7.9% ±9.3 |
| edge floor −5pp | 292 | 282 | +19.3% ±7.6 | +17.6% | 3/3 | +6.4% ±4.9 |
| edge ceiling 45pp | 9 | 9 | +109.6% ±137.2 | +104.5% | 4/4 | — |
| edge ceiling off | 17 | 17 | +115.7% ±138.1 | +116.5% | 3/5 | −13.3% ±170.0 |
| side probability 52.5% | 164 | 162 | −10.4% ±18.3 | −11.1% | 1/5 | −18.4% ±22.8 |
| **side probability 50%** | 333 | 322 | **−13.3% ±12.9** | −11.9% | 1/5 | −22.5% ±13.6 |
| quality 40% | **0** | | | | | |
| price band 2–99¢ | **0** | | | | | |
| late cutoff 30s | 215 | 213 | +21.0% ±12.8 | +19.8% | 8/8 | +28.9% ±22.8 |
| warmup 30s | 125 | 125 | −5.6% ±16.9 | −4.1% | 5/8 | −17.7% ±23.0 |

The live rule's own admitted population over the same windows is **+16.7% ±4.5 per $1** (1,970 decisions,
1,803 windows, stake-weighted +14.3%, positive on 7 of 8 days).

**The edge floor.** Dropping it to 0pp or −5pp admits contracts at a mean 61–65¢ that return about what the
live rule returns. That is the whole result: the increment *matches* the live rule and does not beat it, and
under the durability control in §3 it falls to +6.7% ±11.3 while the live rule falls to +7.5% ±7.0 — still
matching, still not beating. With capacity already binding (§5), admitting trades that merely match is a
strictly worse portfolio than picking better among the ones already admitted.

**The edge ceiling.** 9 and 17 decisions with intervals of ±137pp. Nothing can be concluded. This is the
same cohort [edge-magnitude-2026-08-18.md](edge-magnitude-2026-08-18.md) found to be the most profitable
band on the *admitted* population, and the same one the `MAX_NET_EDGE` comment in `src/lib/prediction-policy.ts`
refuses on a calibration inversion measured over 218 windows. This measurement is far too small to move
that; it is reported because a silently omitted arm is worse than a wide one.

**The selected-side floor.** Both relaxations are negative on both aggregations and positive on 1 day of 5.
`MIN_SIDE_PROBABILITY`'s 55% floor was restored at v13 on prospective monitoring of exactly this cohort;
this is an independent confirmation and closes the question for now.

**Quality and the price band are inert.** Zero incremental decisions. Under AGENTS §5.7 they should not be
described as risk controls in any user-facing surface: removing either changes no admitted row, because the
expected-value test binds first — which is what the `MIN_ENTRY_PRICE` comment already predicted for price,
now measured.

## 3. The timing gates, where the volume actually is

Persistence cannot be replayed from the forecast history: production wants three qualifying dashboard
snapshots spanning 30s and the dashboard refreshes every few seconds, while the history records a
calculation every 34s at the median (44% of gaps fall inside the 30s span). Demanding three *recorded*
calculations is therefore a much stricter gate — roughly 110s of continuous qualification. It is reported
below as an upper bound on the cost of demanding durability, never as a replay.

| arm | n | return/$1 | stake-weighted | days + |
|---|---|---|---|---|
| warmup + late cutoff, as run | 1,970 | +16.7% ±4.5 | +14.3% | 7/8 |
| no execution window | 2,345 | +16.7% ±4.1 | +13.9% | 8/8 |
| **+ durability proxy** | **784** | **+7.5% ±7.0** | +9.0% | 5/8 |
| durability, no execution window | 894 | +6.9% ±6.6 | +7.8% | 5/8 |

Restricted to entries taken 90–300s into the window, so that the looser arm cannot win by entering earlier
at a price nearer 50¢: **+17.7% ±6.9 without the durability proxy against +3.5% ±12.3 with it.** The effect
is not entry timing.

Entry time is nonetheless strong on its own — live rule, no execution window:

| entered | n | return/$1 | days + |
|---|---|---|---|
| 0–90s | 390 | +5.9% ±9.8 | 4/8 |
| **90–300s** | 641 | **+22.9% ±8.0** | 8/8 |
| 300–500s | 509 | +12.6% ±8.8 | 6/8 |
| 500–700s | 394 | +8.5% ±10.2 | 5/8 |
| 700–780s | 175 | +22.0% ±16.0 | 7/8 |
| 780–900s (refused by the cutoff) | 236 | +19.5% ±12.1 | 8/8 |

The 90-second warmup is doing real work: the band it excludes is the weakest one, and relaxing it to 30s
produces a negative increment. The 120-second late cutoff excludes the 780–900s band, which reads +19.5%
±12.1 and is positive on 8 of 8 days. **That is not a recommendation to move it.** The cutoff is an
execution-feasibility commitment (SPEC §171, §194), a resting maker order placed with under two minutes to
run has no time to reprice or to exit, and exit availability in that band drops to 58%. It is recorded here
as the one refused cohort whose held-to-settlement return is not explained away.

## 4. The venue price is well calibrated, so there is no cheap band to harvest

One observation per contract-side per window, taken at least 300s in:

| ask band | n | all-in cost | model says | realized | return/$1 |
|---|---|---|---|---|---|
| 0–10¢ | 163 | 6.7 | 22.7 | 4.9 ±3.3 | −27.1% |
| 10–20¢ | 259 | 16.2 | 31.0 | 13.1 ±4.1 | −19.1% |
| 20–30¢ | 507 | 26.1 | 36.8 | 21.1 ±3.6 | −19.1% |
| 30–40¢ | 709 | 36.6 | 43.2 | 35.0 ±3.5 | −4.5% |
| 40–50¢ | 1,154 | 46.7 | 48.8 | 42.8 ±2.9 | −8.2% |
| 50–60¢ | 1,297 | 55.9 | 49.9 | 54.4 ±2.7 | −2.8% |
| 60–70¢ | 839 | 65.8 | 55.5 | 61.1 ±3.3 | −7.1% |
| 70–80¢ | 563 | 75.7 | 62.3 | 76.2 ±3.5 | +0.7% |
| 80–90¢ | 340 | 84.9 | 66.6 | 84.7 ±3.8 | −0.3% |
| 90–100¢ | 203 | 94.0 | 76.3 | 94.1 ±3.2 | +0.1% |

From 30¢ up the venue's ask is its realized frequency to within the spread, and below 30¢ it is
expensive — buying favourites indiscriminately does not pay, and buying below 30¢ loses 19–27¢ on the
dollar. The model reads systematically *below* the price above 60¢ and *above* it below 40¢, which is the shape
`MAX_NET_EDGE` exists to blunt.

This matters for §2: an increment of expensive, low-edge contracts cannot be earning a price-level premium,
because there is no price-level premium to earn.

## 5. Capacity, which bounds everything above

The live rule admits **1,970 decisions across 550 settlement times — a median of 3 and a mean of 3.6
simultaneously**, against `DEFAULT_MAX_OPEN_POSITIONS` = 3 (`src/lib/portfolio-policy.ts`), and a live rate cap
besides. Volume is not gate-limited; it is position-limited and fill-limited.

The consequence is that the question "what else should we admit?" is second-order.
[loss-decomposition-2026-08-18.md](loss-decomposition-2026-08-18.md) measured contract selection *within a
window the desk was already trading* at **−15.7pp live and −11.8pp paper** — the desk picking badly among
candidates it has already admitted. No relaxation in §2 offers anything close to that, and any relaxation
makes that choice harder by enlarging the set to choose from.

## 6. The measurement that is already running and is overdue

`persistence-two-consecutive-v1` (SPEC §706) admits after two consecutive qualifying observations spanning
15s against production's three spanning 30, holding every other rule fixed, and records its intent at
decision time. Its incremental intents — the ones production was not eligible for — are exactly "purchases
the desk did not make", captured prospectively rather than screened retroactively, which is the only kind
of evidence that can promote anything (AGENTS §5.5).

| cohort | n | windows | return/$1 at the ask |
|---|---|---|---|
| all incremental intents | 561 | 553 | **+13.2% ±8.4** (t=3.08) |
| production never became eligible | 227 | 224 | **+23.5% ±13.0** (t=3.55) |
| production caught up later | 334 | 330 | +6.5% ±11.1 (t=1.14) |
| under v17 | 336 | 334 | +15.8% ±11.3 |
| under v18 | 130 | 127 | +4.6% ±16.3 |
| under v19 | 95 | 92 | +16.0% ±19.9 |

Positive on all 5 days it has run (+13.5%, +13.6%, +25.5%, +4.9%, +10.1%).

The split matters. Where production caught up — median 17s later, p90 94s — the candidate is buying the
same trade earlier, and that half is not distinguishable from noise. **The value is concentrated in the
227 intents production never took at all**, which is the same conclusion the durability proxy reached in §3
by an entirely different route.

**It is not promotable as it stands**, for three reasons stated in order of force:

- **The fill question is unanswered.** These are ask prices held to settlement. The desk rests a maker
  order, fills about half the time, and its fills are adversely selected by roughly −19pp
  ([loss-decomposition-2026-08-18.md](loss-decomposition-2026-08-18.md)). The sentinel does carry a
  prospective maker benchmark, populated on 608 of 609 intents — but it computes
  `bid-priced return × modelled fill probability`, which prices the fill as a random draw and, being a
  positive scaling, can never disagree with the ask benchmark beside it.
  **Corrected 2026-08-18, hours after publication.** An earlier version of this line said the benchmark
  was "populated on 1 of 608 intents". That read `makerTouchStatus`, a field no code in this repo writes,
  present on one stray record. The pipeline was not broken; the arithmetic was. Observed-fill
  instrumentation was built the same day — see docs/maker-post-observation-design.md.
- **The scoping rule bites.** SPEC §706 scopes evidence to the active production buy-policy version and
  resets on a policy change. Under that rule only the v19 cohort counts: **92 windows, +16.0% ±19.9**, below
  both the 100-window bar and significance. The pooled +13.2% crosses three policy versions.
- Promotion is a manual act recorded in an immutable ledger (AGENTS §7), and this file does not perform one.

## Caveats, worst first

- **Everything here is fill-optimistic.** Every entry is bought at the recorded ask. What survives that bias
  is the ranking between arms and the sign, not the level — the same caveat that stands over
  `analyze:edge-gates`, and the reason §6's headline is not an expected return.
- **The durability proxy is an upper bound, not a replay.** It demands ~110s of continuous qualification
  where production demands 30s.
- **Three to five days for the increments.** The edge-floor increments exist only from 2026-08-16 (Kalshi
  two-sided asks are recorded from then); the sentinel spans 2026-08-14 to 2026-08-18.
- **Eleven relaxations were scored on two aggregations and three exit treatments.** One arm above t=2 is
  expected from noise at this width. The results that carry weight are the ones where a group moves
  together (both side-probability arms negative; both edge-floor arms matching rather than beating) and the
  one that was committed in advance (§6).
- Fees are continuous rates, not the whole-cent charge with its 1¢ floor, equally across arms.
- The exit replay carries the model probability forward from the last calculation and fills exactly at the
  observed bid, which flatters every exit arm.
- Kalshi only; one strategy; settlement joined from the resolved forecast history.

## What this authorizes

Nothing, by itself. What it recommends, in order:

1. **~~Fix the maker-touch instrumentation~~ — done 2026-08-18.** Each intent now carries a simulated
   resting post scored against observed trade prints (`maker-post-observed-v1`), and the report gives the
   return conditional on an observed fill. The cohort starts at zero and accrues from the next collector
   restart; only 16 intents could be backfilled from the 60-second sampler, because the bid had already
   moved on 87 of the 103 with coverage.
2. **Run the sentinel's first review** once that is recorded and the v19 cohort clears 100 windows. It is
   the only path in this file that could authorize admitting more trades.
3. **Leave the edge, price, quality, and side-probability gates where they are.** No increment beats the
   live rule, and two of those gates never bind at all.
4. **Spend the effort on contract selection instead**, where −15.7pp is already measured and no new
   admissions are required to collect it.
