# Time-of-day and weekday review — 2026-08-14

## Decision

Do not add a production clock or weekday gate. The only recurring warning remains 08:00–12:00 PDT (15:00–19:00 UTC), but it has only five calendar dates, overlaps several policy generations, and does not clear uncertainty on live results. Day-of-week evidence is unusable: retained history has only one occurrence of each represented weekday.

## Executed results by four-hour Pacific band

Returns use terminal filled entries and exact recorded P&L. Window means first average correlated assets sharing a settlement timestamp.

| PDT | UTC | Live windows | Live capital ROI | Live window mean | Paper windows | Paper capital ROI | Paper window mean |
|---|---|---:|---:|---:|---:|---:|---:|
| 00–04 | 07–11 | 51 | −11.2% | −2.1% | 61 | −13.6% | −12.6% |
| 04–08 | 11–15 | 33 | +31.3% | −8.2% | 64 | −17.2% | −12.9% |
| **08–12** | **15–19** | **39** | **−26.1%** | **−24.3%** | **49** | **−9.6%** | **−31.0%** |
| 12–16 | 19–23 | 18 | +20.1% | +20.1% | 34 | −8.1% | −11.2% |
| 16–20 | 23–03 | 39 | +27.2% | +26.2% | 57 | +34.0% | +16.5% |
| 20–24 | 03–07 | 37 | −12.6% | +46.5% | 57 | −6.8% | +10.1% |

The 08–12 paper window mean has a nominal 95% interval of −56.4% to −5.6%; live remains much wider at −61.5% to +12.9%. Positive-looking periods are unstable: 04–06 was strongly positive live while adjacent 06–08 was strongly negative, and 16–18 was strongly positive while 18–20 reversed. Capital and window-balanced returns often disagree, showing cheap-contract tail concentration rather than a stable clock effect.

## Retention-complete fixed five-minute forecasts

The old forecast store permanently retains qualifying observations but caps nonqualifying calculations at 20,000. Its current unbiased overlap begins around 2026-08-11 21:35 UTC, so this diagnostic deliberately excludes earlier fixed snapshots rather than comparing selectively retained old qualifiers.

| PDT | Windows | Accuracy | Brier | Approx. 95% clustered Brier interval |
|---|---:|---:|---:|---:|
| 00–04 | 32 | 80.8% | 0.1409 | 0.1150–0.1668 |
| 04–08 | 32 | 81.3% | 0.1460 | 0.1161–0.1759 |
| 08–12 | 29 | 79.8% | 0.1679 | 0.1325–0.2034 |
| 12–16 | 32 | 79.5% | 0.1590 | 0.1390–0.1790 |
| 16–20 | 47 | 77.7% | 0.1624 | 0.1383–0.1865 |
| 20–24 | 30 | 79.0% | 0.1492 | 0.1206–0.1778 |

All intervals overlap. These 202 windows span only three local dates, not 202 independent examples of a daily effect.

## Current-policy cohort

Buy policy v17 has only one local date, all in the 16–20 PDT band:

- 10 live fills across 6 windows: +5.2% capital ROI, −29.0% window mean, interval −91.6% to +33.7%.
- 8 paper fills across 5 windows: +14.4% capital ROI, +18.6% window mean, interval −48.2% to +85.5%.
- 7 exact-contract regime sentinels: −17.0% mean bounded return, interval −52.7% to +18.8%.
- 10 fixed forecast windows at the review snapshot: 65.7% accuracy and 0.2288 Brier.

The views disagree and have no coverage of the other bands.

## Prospective collection added

`calendar-effects-v1` is a separate observation-only worker ledger. It commits:

- one fixed snapshot at the first collector update at or below five minutes remaining, within a 30-second tolerance, for every exact Kalshi asset/window whether the policy qualifies it or not;
- compact model probability, confidence, bid/ask/fees, selected side/edge, model factors, and cycle regime;
- one first actionable highest-edge current-policy candidate per correlated settlement window, or an explicit no-candidate marker after close;
- exact Kalshi outcomes, forecast Brier/accuracy, fee-aware ask return, and a prospectively captured empirical fill-weighted maker benchmark;
- policy and model versions, while retaining superseded cohorts without blending them.

Events append to a crash-replayable JSONL journal and compact to a snapshot at 50 MB. Unlike the general forecast store, this fixed-snapshot sample is not pruned. The collector is detached from execution and has no order, budget, gate, sizing, or promotion function.

The signed Performance → Calendar view reports six predeclared four-hour Pacific bands and seven weekdays. Time-of-day review remains locked until every band has at least 30 calendar dates and 100 resolved current-policy candidate windows. Weekday review requires at least 12 occurrences and 100 candidates for every weekday. Passing those counts only opens manual held-out review; it never changes production.
