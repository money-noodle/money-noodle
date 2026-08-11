# Live entry warm-up timing analysis — 2026-08-11

## Question

Would live performance improve if the current 60-second post-open warm-up were longer? Do later entries outperform early entries?

## Dataset and method

- 220 settled, filled live Kalshi entries (`won`/`lost`), excluding synthetic exit rows.
- 125 unique settlement windows from 2026-08-09 01:09 UTC through 2026-08-11 09:49 UTC.
- Entry time is durable order creation time relative to the 15-minute cycle open; managed maker fill occurs within the following 12 seconds.
- Returns use exact live principal, fee, and P&L where available.
- Cross-asset trades sharing a close are clustered by settlement window for uncertainty.
- Results are descriptive, not a causal replay: changing warm-up can alter which later candidates, portfolio slots, and fills become available.

## Timing buckets

| Entry after cycle open | Trades | Windows | Win rate | Capital-weighted ROI | Exact P&L |
|---|---:|---:|---:|---:|---:|
| 60–90s | 34 | 30 | 20.6% | **−28.5%** | **−75.52¢** |
| 90–120s | 30 | 26 | 36.7% | +22.8% | +56.90¢ |
| 120–180s | 34 | 32 | 26.5% | −25.0% | −69.65¢ |
| 180–300s | 44 | 38 | 34.1% | +24.7% | +85.45¢ |
| 300–450s | 39 | 36 | 15.4% | −44.0% | −130.22¢ |
| 450–600s | 24 | 19 | 37.5% | +113.6% | +212.18¢ |
| 600–780s | 13 | 11 | 15.4% | +54.0% | +53.27¢ |

There is no monotonic “later is better” relationship. Results alternate sharply by bucket, and late positive returns are concentrated in cheap-contract tail wins.

## Current warm-up versus longer descriptive thresholds

Assuming every later historical fill remained unchanged:

| Minimum elapsed time | Trades retained | Windows | Capital ROI | P&L |
|---|---:|---:|---:|---:|
| 60s (current) | 218 | 124 | +7.7% | +132.41¢ |
| 90s | 184 | 115 | **+14.3%** | **+207.93¢** |
| 120s | 154 | 102 | +12.5% | +151.03¢ |
| 180s | 120 | 86 | +23.8% | +220.68¢ |

A 90-second warm-up would have removed the 60–90 second cohort's −75.52¢. Longer thresholds are increasingly dominated by a few late tail wins and are not reliable evidence for waiting several minutes.

## Robustness and calibration

- The 60–90 second cohort lost in both chronological halves: approximately −23.6% and −31.6% capital ROI.
- Its model-owned-side probability averaged 47.4%, but only 20.6% won: a −26.8 percentage-point calibration/selection gap.
- Among 57 accepted maker intents in this interval with recoverable outcomes, filled entries averaged −30.8% return and accepted no-fills had a −16.1% ask-side counterfactual. The weakness was therefore not solely maker fill selection.
- Window-balanced mean return for 60–90 seconds was −25.8%, but its approximate 95% clustered interval was wide (−77.7% to +26.0%).
- Excluding the two largest wins in the complete ledger, the current ≥60-second cohort was −3.7% capital ROI, while ≥90 seconds was +0.9%. This is directionally supportive but not strong evidence.
- In the latest binary-policy era, only two settled fills occurred from 60–90 seconds, so recent-policy confirmation is insufficient.

## End-of-cycle review

The settled live-fill tail does look weak beneath the headline return:

- Seconds 600–780 (five through two minutes remaining): 13 fills, 2 wins, +53.27¢. One 5.8¢ DOGE winner contributed +128.11¢; excluding it, this cohort lost about 69.7% of capital.
- Seconds 660–780 (four through two minutes remaining): 8 fills across 6 windows, **0 wins**, and −59.62¢.
- All 10 accepted maker intents with recoverable outcomes after second 660 lost, including two accepted no-fills. This was not only fill selection.
- The owned-side model probability for seconds 600–780 averaged 49.9%, versus 15.4% realized wins, a −34.5pp gap.

However, the larger fixed-snapshot forecast replay does not yet confirm a hard late-cycle exclusion: 4,108 actionable 2–5-minute rows across 178 windows returned +1.51% on average, with a clustered interval of approximately −2.38% to +5.40%. The eight live losses occupy only six windows, and choosing a boundary immediately after the 655.9-second DOGE tail winner would be especially vulnerable to threshold overfitting.

Therefore the final-120-second production cutoff remains unchanged. Prospectively track 2–3, 3–4, and 4–5-minute cohorts and evaluate a final-240-second candidate in shadow; do not promote it from six losing windows alone.

## Decision

The evidence does **not** support a general claim that later entries are better. It supports a narrow operational hypothesis that the first 30 seconds after the former warm-up (60–90 seconds after open) are unusually weak.

Approved and implemented: increase warm-up from 60 to **90 seconds**, leaving three-snapshot persistence, final-120-second cutoff, model, edge gates, execution, and stake unchanged. Treat this as a bounded safety adjustment, not a proven model improvement, and continue reporting timing buckets prospectively.
