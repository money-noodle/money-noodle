# Time-of-day analysis — 2026-08-11

## Question

Has Money Noodle's model or executed strategy performed better during particular times of day?

## Scope and method

- Local display timezone: America/Los_Angeles (PDT, UTC−7 during this sample).
- Durable order range: 2026-08-08 21:12 UTC through 2026-08-11 16:56 UTC—less than three complete days.
- Live actual results: 305 filled terminal entries across 153 settlement windows.
- Paper actual results: 598 terminal entries across 224 windows.
- Forecast diagnostic: one snapshot nearest five minutes remaining per asset/window, 1,637 forecasts across 235 windows.
- Four-hour bands were used to limit multiple-comparison noise. Returns were also balanced by settlement window because assets closing together are correlated.
- Executed results include intentional standalone exits at their actual realized P&L. “Profitable trade” means positive actual P&L, including sold positions.

## Actual execution by local time

| PDT band | UTC band | Live windows | Live capital ROI | Live P&L | Paper windows | Paper capital ROI | Paper P&L |
|---|---|---:|---:|---:|---:|---:|---:|
| 00–04 | 07–11 | 41 | +3.3% | +21.70¢ | 48 | −7.6% | −117.78¢ |
| 04–08 | 11–15 | 25 | **−41.7%** | **−189.85¢** | 46 | **−18.5%** | **−269.66¢** |
| 08–12 | 15–19 | 30 | **−27.9%** | **−142.35¢** | 38 | **−38.3%** | **−394.25¢** |
| 12–16 | 19–23 | 13 | +63.4% | +115.59¢ | 23 | −1.7% | −7.00¢ |
| 16–20 | 23–03 | 19 | +12.2% | +33.66¢ | 29 | +32.5% | +1,109.00¢ |
| 20–24 | 03–07 | 25 | +47.7% | +149.89¢ | 40 | +9.9% | +83.00¢ |

The large paper gain from 16–20 PDT is tail-concentrated: its window-balanced mean return was −6.4% despite positive capital ROI. Likewise, live gains from 12–24 PDT have wide clustered intervals and small day counts.

## Independent forecast quality

| PDT band | Windows | Directional accuracy | Brier score |
|---|---:|---:|---:|
| 00–04 | 48 | 81.8% | 0.1421 |
| 04–08 | 48 | 81.3% | 0.1403 |
| 08–12 | 42 | 74.8% | **0.1753** |
| 12–16 | 26 | 81.9% | 0.1395 |
| 16–20 | 27 | 77.2% | 0.1745 |
| 20–24 | 44 | 77.9% | 0.1486 |

The 08–12 PDT band is the only consistent warning across all three views:

- Live capital ROI −27.9%.
- Paper capital ROI −38.3%.
- Paper window-balanced mean −41.4%, with a clustered interval entirely below zero in this small sample.
- Forecast Brier 0.1753, materially worse than the best bands near 0.14.

The 04–08 PDT band lost in both execution tracks even though directional forecast quality was strong. That points to order selection/pricing and the former model-underdog policy rather than a time-specific inability to predict direction.

## Why this is not actionable yet

1. There are only two or three calendar days per band. Dozens of quarter-hour windows do not create independent evidence of a daily effect.
2. Policy and time are confounded. UP-only history dominates earlier local-time bands, while DOWN support, exits, warm-up changes, and policy v11 arrived later. The poor morning bands overlap the documented six-hour policy-v10 forecast failure.
3. Crypto regimes persist for hours. One trend or reversal episode can make a clock band appear predictive.
4. Positive bands are not consistent between live and paper and are concentrated in cheap-contract tail payouts.
5. There is almost no resolved policy-v11 live history, so these results do not estimate the current selected-side ≥55% strategy.

## Decision

- Do not add a production time-of-day gate.
- Record the 08–12 PDT / 15–19 UTC band as an observation-only risk segment.
- Re-run by policy version after at least 10 independent calendar days, preferably 20+, and require stability across days, UP/DOWN, assets, and fee-aware returns.
- A future gate must improve unseen policy-v11 P&L, not merely historical directional accuracy.

## Reproduction

```bash
pnpm analyze:time-of-day
```
