# Strict-value exit versus hold review — 2026-08-27

## Question and fixed inputs

What would have happened if profitable positions sold by production `strict-value-v1` had instead remained open to exact settlement, and is current prospective evidence strong enough to stop those early sales?

The fixed read ended at **2026-08-28T01:56:16.579Z** and used:

- 5,418 hydrated execution orders from the v9 execution ledger;
- `npm run analyze:strict-value-hold` with `ANALYSIS_THROUGH=2026-08-28T01:56:16.579Z`;
- `npm run analyze:positive-edge-current`, recalculated at `2026-08-28T01:54:42.824Z` from 5,418 orders and 81,180 forecasts;
- `npm run analyze:exit-sentinel-coverage`, recalculated at `2026-08-28T01:54:37.254Z` from 21,344 immutable v2 events and 354 sentinels; and
- the authenticated `exit-policy-sentinel-v2` report read in the same session.

The direct counterfactual retains every actual non-switch strict-value sale and replaces only its exact exit P&L with the already recorded authoritative hold-to-settlement P&L. Positions production held are unchanged and therefore contribute zero incremental cash. Two rows belonging to the separate switch mechanism are excluded.

Exact reporting cents are used throughout. Equal-window normalized means cluster positions on `closesAt`; correlated positions in one settlement window are not independent trials.

The main limitation is portfolio displacement: holding preserves the position and stake until close, so it may suppress a later entry that production funded with released cash or capacity. This review neither credits nor charges such later reuse. The active and trailing-day cohorts have also been inspected sequentially after the exit concern became visible.

## 1. Which sell rule is active

Profit reversal remains withheld. The production sale under review is `strict-value-v1`: one fresh observation sells reduce-only when executable net cash exceeds uncertainty-adjusted optimistic hold value by at least 1¢. It is not a conventional fixed take-profit rule, but in the active-buy cohort all 87 comparable live sales were profitable at exit, so “stop selling positions that are good” is operationally equivalent to disabling this strict-value exit for the observed cohort.

## 2. Exact effect on actual profitable sales

| Cohort | Exits / windows | Profitable at exit | Hold better / exit better | Exit P&L | Hold P&L | Hold − exit | Clustered hold improvement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current execution v9 · live | 9 / 9 | 9 | 8 / 1 | 193.73¢ | 212.26¢ | **+18.53¢** | +4.84% ±20.99pp |
| Active buy v22 · live | 87 / 80 | 87 | 83 / 4 | 3,325.8594¢ | 3,609.94¢ | **+284.0806¢** | **+12.08% ±5.24pp** |
| Fixed trailing 24h · live | 14 / 13 | 14 | 12 / 2 | 297.2381¢ | 290.58¢ | **−6.6581¢** | −2.77% ±19.42pp |
| Active buy v22 · paper | 68 / 64 | 68 | 63 / 5 | 2,206.643¢ | 2,497¢ | **+290.357¢** | +13.03% ±7.02pp |
| Current period · paper | 5 / 5 | 5 | 2 / 3 | 102.695¢ | −1¢ | **−103.695¢** | −85.92% ±38.09pp |
| Lifetime · live | 181 / 166 | 180 | 161 / 20 | 10,997.8342¢ | 10,393.3¢ | **−604.5342¢** | +0.31% ±5.60pp |

The current v9 live result has the hypothesized direction but almost no precision. Eight exits surrendered 54.4238¢ that exact settlement would have paid; one BNB DOWN exit prevented 35.8938¢ of additional loss. Net hold improvement was 18.53¢.

The active-v22 live cohort is materially larger and favors holding: the 83 eventual winners surrendered 456.6687¢, while four exits that later lost saved 172.5881¢. Holding every comparable strict exit is therefore +284.0806¢ on raw exact cash. Active-v22 paper has the same aggregate direction.

The fixed trailing day and current-period paper reverse that conclusion. In the trailing live day, two saved losses were worth 79.5238¢ versus 72.8657¢ surrendered by twelve eventual winners, leaving holding 6.6581¢ worse. Current-period paper had three saved losses worth 107.45¢ and only 3.755¢ of foregone upside. A few loss saves dominate many small winner costs.

Lifetime history shows the same tail mechanism more strongly. Twenty eventual losers saved 2,665.5808¢, more than the 2,061.0466¢ surrendered across 161 eventual winners. Disabling strict exit over the lifetime book would have lost 604.5342¢ despite holding beating exit much more often. The clustered lifetime mean is indistinguishable from zero because those rare saves are large and uneven across windows.

## 3. Complete-position replay and threshold alternatives

The current-policy replay scores every path-bearing position, not only positions production sold. Under active buy v22:

- live hold improves production by 284.0806¢ across 355 positions and 271 windows, with +2.98% ±1.22pp clustered incremental return;
- paper hold improves production by 290.357¢ across 363 positions and 286 windows, with +2.72% ±1.40pp;
- live 5¢ and 10¢ margin replays improve raw cash by 423.8726¢ and 451.2676¢; but
- paper 5¢ and 10¢ margins reduce raw cash by 69.338¢ and 52.427¢.

Seven related margins plus hold were replayed after the problem was known. The apparently best live 10¢ row is not promotion evidence, and live replay assumes an observed bid would fill a counterfactual reduce-only IOC. The paper sign disagreement rules out treating the live optimum as robust.

## 4. Prospective collection and current locks

Prospective collection is active under `exit-policy-sentinel-v2`, started `2026-08-24T17:08:03.205Z`. It records every newly filled position, production outcome, a hold benchmark, and four frozen first-to-fire candidates:

- strict-value margin 3¢;
- strict-value margin 5¢;
- two-observation confirmation at the current 1¢ margin; and
- trailing 50% arm / 35% giveback.

For the current v9 live generation the authenticated report contains 22 positions, 21 resolved, and 18 complete across 16 windows. Complete-path coverage is **85.71%**, and hold differs from production in nine windows. Hold is +18.53¢ and +0.72% ±11.07pp versus production.

Current paper contains 40 positions, 39 resolved, and 35 complete across 30 windows. Coverage is **89.74%**, and hold differs in ten windows. Hold is **−76.267¢** and −5.95% ±6.39pp. Every candidate's current live incremental cash is positive, while every corresponding paper value is negative.

No review lock is open:

- both tracks remain below the required 90% complete-path coverage;
- neither has 60 complete independent windows;
- hold has only nine live and ten paper divergent windows, below 20; and
- live/paper signs disagree.

More importantly, every currently incomplete path is a loser: three live and four paper. V2 records a fresh zero executable bid as generic unavailable, preferentially excluding positions whose owned side converges to zero. This outcome selection was diagnosed on 2026-08-26. V2 remains diagnostic even if its numerical counts later cross a threshold. The proposed reasoned v3 cycle was not implemented.

## 5. Finding and decision boundary

**Finding:** the concern is real. Under active buy v22, strict value sold 87 profitable live positions, 83 of which later settled on the owned side. Holding those actual sales would add 284.0806¢ exact; the complete-position replay also favors hold on live and paper point estimates.

**Counterevidence:** strict value is tail insurance. The four active-v22 live reversals saved 172.5881¢; rare reversals made exit better by 604.5342¢ over lifetime. The fixed trailing day and current-period paper favor retaining the exit. Current v9 has only nine live exit windows, and the prospective v2 cohort has track-sign disagreement plus outcome-selected missing paths.

**What this authorizes:** prioritize a new prospective, reasoned exit-sentinel generation with an explicit frozen `hold-no-strict-value` candidate, and continue reporting exact hold versus production. It does not yet support claiming that disabling the exit is safer or more profitable. A production change would deliberately exchange rare large loss saves for frequent small winner gains and would also retain capital/exposure until settlement; that downside and displacement must be bounded in an accepted design before any manual versioned promotion.

No policy, threshold, control, capital, or live behavior changed from this review. Nothing here is financial advice.
