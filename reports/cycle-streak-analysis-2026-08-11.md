# Multi-cycle trend continuation analysis — 2026-08-11

## Question

Does an asset declining for multiple consecutive 15-minute cycles predict another DOWN cycle or a profitable DOWN contract purchase?

## Decision

**Do not change the production model or trading gates.** Consecutive DOWN cycles did not show stable continuation in the retained sample. Keep the feature observation-only and continue prospective collection.

## Dataset and method

- Source: `data/cycle-paths.json`, policy `aligned-15s-observation-only-v1`.
- Assets: BTC, ETH, SOL, BNB, XRP, DOGE, HYPE.
- Retained range: 2026-08-09 13:15 UTC through 2026-08-11 09:30 UTC (about 45 hours).
- 1,006 completed, quality-filtered asset-cycles; 987 had a contiguous prior cycle.
- 143 unique settlement windows. Cross-asset rows sharing a close were treated as correlated; reported confidence intervals use window-balanced rates.
- Quality filter: at least 800 seconds path coverage and 20 observations.
- Direction proxy: final-minute Kraken path average versus the Kraken cycle-open reference. This is a comparable underlying-price diagnostic, **not an authoritative substitute for venue resolution**.
- A streak required exactly contiguous 15-minute cycles for the same asset. Zero-return cycles broke the sign sequence.
- Robustness checks used 700–850 second coverage cutoffs and both final observed price and final-minute mean.

## Directional results

| Condition before target cycle | Asset-cycles | Independent windows | Next DOWN rate | Approx. 95% clustered interval |
|---|---:|---:|---:|---:|
| Unconditional target cycles | 987 | 143 | 50.93% | 45.31–56.56% |
| At least 1 prior DOWN | 511 | 124 | 50.07% | 43.37–56.78% |
| At least 2 prior DOWN | 241 | 96 | 47.93% | 39.38–56.48% |
| At least 3 prior DOWN | 115 | 61 | 52.14% | 40.61–63.66% |
| At least 4 prior DOWN | 59 | 38 | 52.85% | 38.24–67.46% |

Two prior DOWN cycles reduced the next-DOWN rate by about 3 percentage points versus the unconditional rate, but the uncertainty interval is wide and includes both continuation and reversal. Longer streak estimates reverse sign and become less precise. There is no monotonic dose-response relationship.

Across streaks in either direction, continuation after at least two same-direction cycles was 43.98% over 449 asset-cycles and 133 windows (95% interval 37.74–50.22%). This hints at short-horizon reversal, but does not clear a robust significance or profitability gate.

## Magnitude and path shape

Among the 241 targets after at least two DOWN cycles:

| Prior streak subset | Next DOWN rate | 95% interval |
|---|---:|---:|
| Larger cumulative decline (at least median 0.22%) | 49.05% | 37.30–60.81% |
| Smaller cumulative decline | 45.23% | 34.30–56.16% |
| Smoother path (at least median efficiency 0.223) | 48.52% | 37.62–59.41% |
| Choppier path | 51.62% | 40.93–62.31% |

Neither decline magnitude nor smoothness produced a stable continuation split.

## Stability checks

- First chronological half after multi-DOWN: 43.99% next DOWN.
- Second chronological half: 51.56% next DOWN.
- Asset estimates ranged from 33.33% (SOL) to 58.33% (HYPE), all with wide intervals.
- Using final observed price instead of a final-minute average produced approximately 48.7% next DOWN after two prior DOWN cycles.
- Coverage thresholds from 700 through 850 seconds produced approximately 47–49% next DOWN.

The result is therefore robustly **near a coin flip**, but not stable enough to claim either momentum or mean reversion.

## Same-contract Kalshi return check

A fixed snapshot approximately five minutes into each target cycle was joined only when the stored Kalshi DOWN ask, immutable Kalshi contract identity, and matching Kalshi outcome were available.

Coverage is currently small because exact venue-specific provenance begins late in the retained cycle-path range:

- 14 same-contract resolved quote rows across 7 windows.
- DOWN win rate: 50.0%.
- Mean ask-side return after estimated Kalshi fee: −26.19%.
- Five rows across three windows also cleared the production edge/quality policy; all five lost (−100% mean return).

These return cohorts are far too small for inference, but they provide no reason to promote a streak rule.

## Interpretation

Consecutive cycle direction mostly repeats information already represented by the one-hour return and current-cycle basis. Each new contract resets its reference, and any visible streak may already be reflected in the actionable DOWN ask. A raw streak count also ignores move size, volatility, and path shape.

## Next action

1. Keep production probability, entry gates, execution, and sizing unchanged.
2. Add prior-cycle streak, cumulative return, efficiency, and flip-rate to prospective issuance observations only.
3. Re-run after materially more independent windows and exact same-contract Kalshi quote/outcome coverage.
4. Require positive held-out return after fees—not directional accuracy—before considering a bounded tilt.
