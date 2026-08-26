# Maker-restriction v1 fixed review — 2026-08-26

> **Finding:** neither frozen maker restriction cleared its precommitted promotion gates. The 2¢ spread arm reached
> the live divergence count and had positive exact cash differences and positive clustered point estimates on both
> tracks, but neither track survived the two-arm one-sided Holm correction and every one-sided 95% lower bound
> remained below zero. The 2pp spike arm additionally had only 14 divergent live windows and lost incremental exact
> cash on paper. Production maker execution, paper execution, sizing, capital, and policy remain unchanged.

## Question and fixed read

Does either prospective `maker-restriction-sentinel-v1` arm satisfy every lock in
[`docs/positive-edge-execution-exit-sentinel-design.md`](../docs/positive-edge-execution-exit-sentinel-design.md)
§6: at least 60 resolved windows, at least 20 divergent windows, at least 90% scoreable coverage, positive exact
cash difference, positive clustered candidate-minus-production return, one-sided Holm significance across the two
frozen arms, and simultaneous positive live/paper eligibility?

The review reran:

```bash
npm run analyze:maker-restrictions
```

The read completed at **2026-08-26T07:13:14.557Z** with audit-input SHA-256
`73693c56d8968600d0ddeeb078d63ee280b50e62143e43e3df61fb9d4aeb8682`. The prospective sentinel began at
**2026-08-19T15:50:10.470Z**. It was scoped exactly to buy policy
`buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22`, live execution
`maker-high30-requalify3-fresh1c-bounded-taker-pilot-v7`, and paper execution
`paper-managed-execution-route-ioc-requalify3-calibrated-v6`.

Every issued production maker attempt remained in the denominator. A production no-fill spent and returned zero; a
candidate refusal also spent and returned zero. Candidate arms inherited the authoritative production result only
when they admitted the attempt. No arm received a replacement trade, capital-reuse benefit, or hypothetical taker
fill. Returns were averaged within UTC `closesAt` before standard error, and the one-sided family-wise alpha was
0.05 with Holm step-down correction separately on each track.

The caveat that most threatens transfer is execution fidelity: paper materially undercaptures accepted live maker
fills, and live/paper share the same signals rather than providing independent replications. The restriction test
also deliberately assigns no value to capital freed by refusal, so it answers whether declining these attempts
improves the existing book—not whether a separate portfolio policy could reuse the money well.

## Production controls

| Track | Attempts | Windows | Fills | Zero deployment | Exact deployed | Exact P&L | Return on deployed stake | Mean return across all attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Live | 181 | 102 | 83 | 98 | 2,179.06¢ | −459.1661¢ | −21.07% | −10.24% |
| Paper | 707 | 288 | 205 | 502 | 5,458¢ | −934.8310¢ | −17.13% | −9.28% |

All 181 live and 707 paper records were resolved and scoreable; there were no missing order links or unscorable
records. Live and paper totals remain separate because their fills and bankroll semantics differ.

## Candidate economics

| Track / candidate | Divergent attempts / windows | Fills | Exact P&L | Exact cash difference | Incremental clustered return ± SE | One-sided 95% lower bound | One-sided p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Live · spread ≤2¢ | 24 / **20** | 71 | −301.4585¢ | **+157.7076¢** | **+3.95pp ±2.58pp** | −0.30pp | 0.0631 |
| Paper · spread ≤2¢ | 87 / **70** | 171 | −682.7790¢ | **+252.0520¢** | **+1.71pp ±1.20pp** | −0.26pp | 0.0763 |
| Live · spike <2pp | 15 / **14** | 80 | −364.4161¢ | +94.7500¢ | +1.72pp ±1.12pp | −0.12pp | 0.0621 |
| Paper · spike <2pp | 103 / **81** | 184 | −1,272.8130¢ | **−337.9820¢** | +0.09pp ±1.10pp | −1.72pp | 0.4689 |

The spread arm moved in the same favorable direction on both tracks and reduced the exact loss, but a smaller loss
is not enough to promote. Both clustered intervals still crossed zero. The paper spike arm exposed a load-bearing
disagreement: its equal-window mean was slightly positive while exact aggregate cash was materially worse, because
stake and attempts were not equal across windows. The lock requires both views to be positive, so the disagreement
fails closed.

## Holm correction and gate disposition

Live ordered the spike arm first at `p=0.0621`; it failed the first Holm threshold `0.025`, so the step-down family
rejected no hypothesis. Paper ordered the spread arm first at `p=0.0763`; it likewise failed `0.025`. No later arm
can pass after the first ordered test fails.

| Candidate / track | ≥60 windows | ≥20 divergent | ≥90% coverage | Positive exact cash | Positive clustered mean | Holm significant | Joint review unlocked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Spread · live | yes | yes | yes | yes | yes | **no** | **no** |
| Spread · paper | yes | yes | yes | yes | yes | **no** | **no** |
| Spike · live | yes | **no** | yes | yes | yes | **no** | **no** |
| Spike · paper | yes | yes | yes | **no** | yes | **no** | **no** |

Thus both joint `reviewUnlocked` values remained false. Counts opened this fixed review; they did not waive the cash,
uncertainty, multiplicity, or simultaneous-track requirements in
[`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md) §12.5.

## Fill-selection diagnostic

Production maker fills continued to select losing outcomes more often than winning outcomes:

| Track | Winning attempts filled | Losing attempts filled | Loser-minus-winner fill rate |
| --- | ---: | ---: | ---: |
| Live | 31 / 93 (33.33%) | 52 / 88 (59.09%) | +25.76pp |
| Paper | 69 / 398 (17.34%) | 136 / 309 (44.01%) | +26.68pp |

This supports the previously observed adverse-selection mechanism, but it does not identify a statistically cleared
issuance restriction. Actual taker evidence remains a separate execution cohort; no taker assumption enters these
arms. The bounded taker pilot remains closed under
[`reports/bounded-taker-pilot-v1-closure-2026-08-25.md`](bounded-taker-pilot-v1-closure-2026-08-25.md).

## Decision and what would change it

No maker restriction is reviewable or promotable from this fixed read. Keep the current maker route and both
sentinels unchanged; do not tune the 2¢ or 2pp thresholds, combine them after seeing outcomes, expand stakes, alter
paper calibration, or transfer the result into a taker policy.

Additional untouched prospective evidence could narrow the clustered intervals, but a later review must still apply
the complete simultaneous live/paper cash, coverage, divergence, and family-wise correction. Repeatedly checking the
same cohort after each outcome cannot itself create promotion authority. Any revised threshold, candidate family, or
sequential-review rule requires a new precommitted generation before its outcomes are inspected.
