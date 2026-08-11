# Six-hour live run and execution-mode review — 2026-08-11 16:22 UTC

## Decision

**Do not enable pure taker or adaptive live execution. Keep live execution maker-only, and pause live entry before changing execution style.** The run is a forecast/regime failure, not a maker-opportunity failure. Taker execution would have made it materially worse.

## Six-hour live results

Window: approximately 10:22–16:22 UTC.

- 157 live entry intents.
- 72 fills; 59 settled as win/loss, 8 sold by reduce-only exits, and 5 remained open at extraction.
- Settled hold results: 5 wins / 54 losses across 23 settlement windows.
- Exact settled hold P&L: −334.57¢ on 452.57¢ principal (−73.9% capital ROI).
- Eight sold positions contributed +101.92¢ and reduced, but did not erase, the damage.
- Average independent owned-side probability was 36.5%; realized wins were 8.5%, a −28.0pp gap.

The large probability gap and uniformly poor asset results identify model calibration/regime failure. Faster execution cannot repair wrong-side selection.

## Taker counterfactual

### Pure taker on all evaluated live entries

- 115 resolved counterfactual entries across 24 windows.
- 12 wins.
- Hypothetical taker P&L: **−823.00¢**.
- Actual maker P&L on the same intents: −331.95¢.
- Taker minus maker: **−491.05¢**.
- Mean window incremental result: −3.89¢; approximate clustered 95% interval −5.15¢ to −2.64¢.
- Both chronological halves were negative.

### Adaptive taker recommendations

- 13 recommendations during the six-hour window; 9 resolved across 8 windows.
- Resolved recommendations: **0/9 wins**.
- Hypothetical taker P&L: −90.00¢.
- Actual maker P&L: −33.82¢.
- Taker minus maker: **−56.18¢**.
- Approximate clustered incremental interval: −9.19¢ to −3.48¢ per window.

The global report has only 18 resolved taker recommendations, versus the required 50 recommendations and 30 independent windows. The latest chronological fold is a complete failure, depth/slippage coverage remains incomplete, and there are zero actual taker fills. Adaptive promotion fails every relevant stability gate.

## Diagnostic segments

### Direction

| Side | Trades | Wins | Capital ROI | P&L |
|---|---:|---:|---:|---:|
| UP | 32 | 4 | −64.3% | −156.75¢ |
| DOWN | 27 | 1 | −85.2% | −177.82¢ |

DOWN is especially concerning. Across the full maker history, resolved DOWN fills average approximately −16.9% versus +7.6% for UP. DOWN should be considered for temporary shadow-only status, but the whole six-hour regime was bad enough that disabling DOWN alone is insufficient.

### Price

- Below 10¢: 0/14, −98.27¢.
- 10–20¢: 1/16, −87.74¢.
- 20–30¢: 1/15, −82.64¢.
- More expensive entries were less bad, not profitable.

Cheap-contract tails again dominated risk. A temporary 10¢ live floor would have prevented 98.27¢ of this run's loss, but should be evaluated against long-run tail winners before permanent promotion.

### Timing

- Seconds 300–450: 0/12, −96.07¢.
- Seconds 600–780: 0/9, −70.06¢.

This strengthens the late-entry warning, but failures occurred throughout the cycle. A timing cutoff alone would not have fixed the run. The approved 90-second warm-up was not yet active in the running production bundle during this review.

### Claimed edge and quality

- 5–10pp edge: 2/8, −3.39¢ (−5.0%).
- 10–15pp edge: 1/21, −153.87¢.
- 15–20pp edge: 1/18, −117.42¢.
- 20pp+ edge: 1/12, −59.89¢.
- Raising minimum edge or confidence would not have helped. Larger claimed edge was mostly model/venue disagreement caused by model overconfidence.

## Changes most likely to reduce bad entries

1. Add a rolling, clustered live calibration/P&L circuit breaker independent of budget epochs. Stop new entries when recent settled windows show a severe probability-versus-outcome gap or rolling exact loss, even if lifetime P&L remains positive.
2. Add an explicit model-regime quarantine: pause live entries while paper and fixed-snapshot held-out results diagnose whether the basis model is currently miscalibrated.
3. Evaluate DOWN as shadow-only and require fresh positive clustered evidence before restoring it.
4. Evaluate a 10¢ minimum live contract price and final-240-second cutoff as shadow candidates, not immediate permanent rules.
5. Reduce live global and same-window concentration to one during recovery. This reduces correlated loss, though it does not improve forecast accuracy.
6. Preserve maker-only execution, attempt-two disabled, and the successful reduce-only exit paths.

## Operational concern

The existing live-risk status remained allowed because its current epoch and lifetime accounting did not express this rolling six-hour collapse. A short-horizon clustered economic breaker is therefore a higher priority than execution-mode promotion.
