# Maker adverse selection first; strict-value exit second — 2026-08-19

> **No production change.** This follow-up goes below the aggregate P&L in
> `positive-edge-execution-review-2026-08-19.md`. The maker result is a selection mechanism, not merely a
> losing cohort. The current exit result is a model-versus-market failure: the rule sold nine positions
> because executable cash exceeded the model's optimistic value, and all nine later settled on the side it
> sold. Neither finding yet identifies a validated replacement.

## Inputs, method, and most threatening caveat

Reloaded at **2026-08-19T07:09:28Z**: 2,552 order rows and 61,715 forecasts. Reproduce with
`npm run analyze:positive-edge-current`; the named take-the-ask, loss-decomposition, exit-counterfactual,
and 26-rule exit-alternative analyses were rerun in the same session.

Maker attempts are restricted to accepted live orders stamped `executedStyle: maker`; outcomes are joined
from authoritative settlement. Fill rates conditional on winner/loser answer which eventual outcomes the
queue admits. Filled "discount" is issuance ask minus authoritative fill; no-fill "discount" is issuance
ask minus final submitted post, because there is no fill. They describe different terminal facts and are
shown only to identify the path, not as a causal estimate.

Exit comparisons use exact actual P&L and authoritative hold outcomes. The margin replay tests seven
predeclared alternatives (1, 2, 3, 5, 10, 20, 50¢) on every position with a recorded path, first trigger
winning. Paper replay is exact to its simulator. Live replay optimistically assumes an executable-bid
observation fills; it cannot authorize a live change. Means and standard errors are clustered by settlement
timestamp.

The most threatening caveat remains the current sample: v3 has 25 accepted maker outcomes and nine live
settlement windows; v21 strict exit has nine exits in seven windows. The feature comparisons below are
multiple looks at the same positions.

# Part I — Maker adverse selection

## 1. Outcome conditions whether the post fills

| Maker cohort | Accepted with outcome | Fill rate if side later wins | Fill rate if side later loses | Loser/winner fill ratio |
| --- | ---: | ---: | ---: | ---: |
| Instrumented lifetime | 668 | 46.1% | 61.1% | 1.33× |
| v21 | 38 | 39.3% | 50.0% | 1.27× |
| Active execution v3 | 25 | **27.8%** | **71.4%** | **2.57×** |

This is the direct mechanism. Under v3, a decision that eventually loses is more than twice as likely to
fill as one that eventually wins. The venue is not randomly accepting half the selected positions: the
resting post fills when price moves toward it, which is movement against the purchased side.

The current paired-window production report reaches the same answer without conditioning across different
windows: v3 filled-minus-no-fill return is −112.9pp ±34.5pp over five paired windows, and its win-rate gap
is −60.0pp ±24.5pp. The v21 versions are −110.1pp ±28.3pp and −50.0pp ±22.4pp over six windows. The paired
sample is tiny but the lifetime direction and prior eras agree.

## 2. The "discount" is the adverse move

| v3 accepted maker outcome | Filled (n=10) | No fill (n=15) |
| --- | ---: | ---: |
| Eventual wins | 5 | 13 |
| Issuance ask | 61.8¢ | 58.5¢ |
| Fill/final-post discount from issuance ask | **5.0¢** | 0.7¢ |
| Issuance spread | **3.3¢** | 1.6¢ |
| Current edge above persistence median | 4.4pp | 3.3pp |
| Quote volatility | 1.01¢/s | 1.41¢/s |
| Seconds remaining | 507s | 511s |

The five-cent improvement is not free price alpha. It appears when the market has moved materially against
the side after issuance. At an average 61.8¢ ask, winning half of the filled positions is still losing
because a loss forfeits the whole stake while a win earns much less than one stake. V3 maker fills therefore
lost −272.36¢ on 888.26¢ despite winning 5/10.

Wider issuance spreads and larger edge spikes appear in the fill cohort, so there may be observable warning
features. But they do not yet define a solution:

- only 25 accepted v3 outcomes support several simultaneous feature comparisons;
- quote volatility moves the opposite way from a simple "fast market is bad" story;
- splitting current fills on the 2¢ spread ceiling or the previous edge-spike threshold does not produce a
  stable profitable remainder across live and paper;
- a fill-derived discount cannot gate the order that precedes it.

The current execution policy already sends only a selected strict-gate subset to taker, and all four v3
taker selections were blocked before venue acceptance by the bounded fresh-quote/slippage check. Thus
"take the warnings" has no actual fill evidence yet. Taking every position remains contradicted by the
capacity-corrected historical control: it gives up the maker discount on all orders and mainly increases
capital deployed, not return per dollar.

## 3. What would distinguish remedies

Three materially different hypotheses remain:

1. **Queue remedy:** post less aggressively or decline wide/spiking maker conditions. This sacrifices fill
   rate and must beat a zero-return no-fill, not merely improve filled ROI.
2. **Selective taker remedy:** cross only when absolute edge remains after fresh quote, spread, fee, and
   slippage. V3 is instrumented for this but has zero fills.
3. **Selection remedy — withdrawn as a measured leak later the same day.** The first correction still
   compared orders with alternatives that had not passed the same decision-time state. Replaying
   persistence, regime, cooldown/retry, active exposure, production sizing, and historical caps leaves
   chosen minus replay-preferred at −0.9pp ±2.7pp (95%) over 232 v17-v19 windows, with the same choice in
   331 of 339 positive-control snapshots. Ranking is not a measured remedy.

The evidence supports collecting the two execution arms, not choosing one. Any future portfolio comparison must
score every eligible position, assign the first action that would fire, include no-deployment as zero cash,
and cluster by settlement window.

## Reporting issue found

`buildMakerFillReport` excluded orders only when `liquidityRole === 'taker'`. A taker refused before venue
submission has no liquidity role, so the four v3 taker refusals were included in the maker
`submittedAttempts` and lowered its displayed acceptance rate. Accepted-maker, fill, and paired-return
figures were unaffected. The reporting correction in the same working change also excludes rows stamped
`entryExecutionDecision.executedStyle === 'taker'`, with a regression test covering a pre-submission
refusal before role assignment.

# Part II — Why strict-value exit reversed

## 4. What fired in v21

Strict value sells when net executable cash is at least 1¢ above **optimistic model hold value**—owned-side
probability plus its uncertainty buffer—not when a stop-loss or take-profit level is reached.

The nine v21 live exits had:

- 7 independent settlement windows;
- **9/9 counterfactual hold winners**;
- **0/9 exits beating hold**;
- median trigger margin 6.44¢, mean 11.08¢;
- mean 307 seconds remaining;
- −266.15¢ exact incremental value versus holding, −35.3% ±6.5pp per window.

This is not a one-cent numerical-edge problem. Every trigger-margin band lost:

| Cash above optimistic model value | Exits | Beat hold | Exact incremental cash |
| --- | ---: | ---: | ---: |
| 0–5¢ | 4 | 0 | −160.07¢ |
| 5–10¢ | 2 | 0 | −40.83¢ |
| 10¢+ | 3 | 0 | −65.24¢ |

At trigger time the executable bids ranged roughly 68–98¢ while owned-side model probabilities were about
57–84%. The rule did exactly what it says: trust executable market cash over a lower model valuation. The
settlements say the market was right and the model was too low on this selected cohort. One position was
sold for a small realized loss; the other eight locked gains but surrendered larger winning payouts.

Paper shows the same raw direction—15/18 hold winners, only 3/18 exits beating hold, −368.24¢ total—but its
equal-window normalized mean is +25.6% ±40.3pp because stake and exits per window differ. That disagreement
must remain visible; neither aggregation may replace the other.

## 5. Does raising the 1¢ margin fix it?

Not as a stable lifetime rule. The path replay gives several attractive current-policy cells, but the
tracks and eras disagree.

### Current v21 replay

| Margin | Live replay P&L | Live incremental vs actual | Paper exact P&L | Paper incremental vs actual |
| --- | ---: | ---: | ---: | ---: |
| 1¢ | −215.42¢ | −96.92¢ | +111.76¢ | baseline |
| 3¢ | −38.45¢ | +80.05¢ | +265.72¢ | +153.96¢ |
| 5¢ | +0.47¢ | +118.97¢ | +216.42¢ | +104.66¢ |
| 10¢ | +169.24¢ | +287.74¢ | +465.00¢ | +353.24¢ |
| Hold | +147.65¢ | +266.15¢ | +480.00¢ | +368.24¢ |

The live replay is optimistic and does not reproduce production at 1¢ because it assumes every observed
bid fills; production IOC exits may not. Paper reproduces the 1¢ baseline exactly. In paper, 2–10¢ margins
all improve raw cash, but hold is still best. Its clustered comparison disagrees with raw cash: 3¢ is
+4.7% ±2.7pp versus actual, 10¢ +4.4% ±6.3pp, while hold is −9.9% ±14.3pp. Small correlated windows and
weighting explain the disagreement.

### Lifetime replay

- Live's optimistic replay still prefers **1¢** in raw cash; 10¢ and higher are worse than production.
- Paper's exact replay peaks at **5¢**, +447.71¢ and +2.0% ±1.0pp versus production over 179 windows.
- Seven margins were examined. A best cell near two standard errors is expected under multiple comparison,
  and live does not confirm it.

Therefore the current reversal is not evidence for changing `STRICT_EXIT_MIN_GAIN_CENTS` to a number found
in this sweep. It is evidence that the rule's model valuation has become unreliable in exactly the cohort
where the market bids strongly for the owned side.

## 6. The deeper exit question

There are at least three different candidate responses, and they solve different failures:

1. **Require a larger value margin.** The paper replay tests this; lifetime live disagreement remains.
2. **Require confirmation over time.** This addresses a transient model dip, but can give back executable
   cash and needs exact bid-path scoring.
3. **Use a market-profit/trailing condition in addition to model value.** The 26-rule replay has take-profit
   positive in 5/8 and trailing positive in 5/5, but the best individual t is only about 2 after 26 tests.
   It motivates a committed sentinel, not activation.

A proper prospective exit sentinel should stamp, at every production observation, first-to-fire outcomes
for current strict value, 3¢/5¢ margins, one-confirmation delay, and one predeclared trailing formulation.
It must follow every position to settlement, count independent windows, report exact versus optimistic fills,
and compare each arm against the live rule—not against doing nothing. Until that exists, disabling strict
value from seven v21 windows would be the same retroactive promotion discipline this project forbids.

## Conclusions

- **Maker first:** adverse selection is currently real at the outcome level. V3 losers fill 71.4% of the
  time versus 27.8% for winners. No tested pre-entry split yet isolates a robust remedy.
- **Exit second:** v21 strict value is selling model-undervalued winners, not stopping losses. Raising the
  margin looks attractive in current paper replay but does not survive lifetime live/paper comparison.
- **Authorized:** repair maker reporting and build the approved prospective, version-stamped execution and
  exit sentinels. Both are implemented in the same working change under
  `docs/positive-edge-execution-exit-sentinel-design.md`; collection begins only after the next built
  restart/deploy and no historical row is backfilled. No gate, execution, or exit policy changes are
  authorized.
