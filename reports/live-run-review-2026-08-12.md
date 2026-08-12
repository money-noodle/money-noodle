# Live run review — 2026-08-12

## Interval and method

Primary order interval: **2026-08-11 12:00 PDT through 2026-08-12 08:51 PDT** (`2026-08-11T19:00:00Z` onward). Results come from durable `paper-orders.json` order lifecycle records and exact issuance-time `entry-decision-v1` snapshots. Sold positions use authoritative exit proceeds and exact resolved hold counterfactuals. Unfilled maker intents are not counted as capital deployed. Independent sample counts are settlement windows, not trades or 15-second updates.

A fill-independent diagnostic also uses one forecast nearest five minutes per asset/window; its history extended a few minutes beyond the primary extraction while this report was prepared. All findings remain descriptive unless stated otherwise.

## Executive conclusion

The run made money, but the profit was not broad evidence that every component works:

- 61 live intents, 37 acquired exposures, and 24 no-spend maker non-fills.
- 37 resolved exposures across 32 settlement windows.
- Exact deployed stake 1,395.25¢; exact live P&L **+469.74¢ (+33.7% capital ROI)**.
- The clustered mean-return interval remains wide: approximately **−24.0% to +64.3%**, so this does not establish stable profitability.
- Holding every acquired contract would have returned **+249.75¢**. Approved strict exits added approximately **+219.99¢** relative to holding.
- Profit was concentrated: SOL contributed +269.25¢ and HYPE +148.16¢. BNB, DOGE, and ETH were near flat.
- The second chronological half deteriorated sharply: the first v12 half made +451.67¢ (+419.15¢ hold), while the second made only +34.07¢ and would have lost −153.40¢ if held. A time split near midnight PDT gives +516.17¢ before and −30.43¢ after, with hold falling from +485.15¢ to −219.40¢.

## What worked

### 1. The candidate-net widening increased flow

The v12 production interval generated approximately 3.6 live intents/hour versus 1.5/hour during the short v11 interval represented in the current ledger. This comparison is confounded by time and regime, but the requested widening clearly solved candidate scarcity:

- v12: 58 live intents, 35 exposures, 30 resolved exposure windows, +485.74¢.
- v11 portion after noon: 3 intents, 2 fills, both lost, −16¢.

This does not mean the newly admitted 52.5–55% band itself worked; most v12 profit came from stronger probability bands.

### 2. Strict value exits materially improved realized wealth

Fifteen live strict exits realized **+856.16¢** versus **+636.17¢** from holding, an incremental **+219.99¢**.

- Only 4/15 exits beat hold individually, but those four avoided later losses and added +292.51¢.
- Eleven early sales gave up 72.52¢ versus eventual hold.
- The asymmetric result is favorable: several large avoided losses outweighed many small opportunity costs.
- Paper independently showed +527.30¢ exit-versus-hold across 34 exits.
- Observation-only principal recovery would have underperformed full live exits by approximately 79.81¢ in this interval. Do not promote it from the earlier sparse reconstruction.

### 3. Maker-only remained better than taker execution

Current-interval live maker funnel:

- 61 submissions.
- 55 accepted (90.2%).
- 37 filled; 18 accepted/rested without fill.
- 67.3% fill rate conditional on acceptance.
- Six post-only acknowledgement races.

Across 59 resolved taker counterfactuals, pure taker made +110¢ versus +249.75¢ for the same maker lifecycle held to outcome, and versus +469.74¢ including approved exits. The five resolved adaptive taker recommendations lost 18¢ versus +2.60¢ from their actual maker lifecycle. There is still no support for live taker promotion.

### 4. Core direction estimation remained useful away from trade selection

One fixed five-minute forecast per asset/window produced:

- 576 asset/windows across 83 settlement windows.
- Production model: 80.7% window-balanced directional accuracy, Brier 0.1462.
- Basis-only: 81.2%, Brier 0.1326.
- Settlement-average observation model: 81.2%, Brier 0.1325.

The production model is not broadly unable to classify direction. The failure is concentrated in which model/venue disagreements become purchases and which maker orders fill.

### 5. Operational controls worked

At extraction, automation was active with no open positions/reservations, no blockers, and authoritative periodic reconciliation ready. No ambiguous transaction or unmanaged exposure was present. The live run's measured peak-to-trough P&L decline was approximately 131¢, below configured hard stops.

## What did not work

### 1. The new 52.5–55% live-fill cohort lost

The exact increment admitted by v12 generated:

- 14 live intents.
- 7 fills across 7 windows.
- 1/7 acquired sides won if held.
- Actual P&L **−83.38¢** after exits.
- Hold P&L **−115.98¢**.
- Pure taker counterfactual **−67¢**.

Six of the seven fills were DOWN. Paper results looked profitable after exits (+246.43¢), but hold was still −17¢ and only 5/13 sides won. The side-independent regime sentinel saw 11 near-floor windows, 4 wins, and approximately flat fee-aware return (−0.27% mean). The band increased activity but has not demonstrated entry edge.

### 2. DOWN entry forecasts remained weak and were rescued by exits

Live DOWN fills:

- 17 exposures, 5/17 hold wins.
- Mean selected-side forecast 57.7% versus 29.4% observed wins.
- Hold P&L −151.48¢.
- Actual P&L +39.82¢ only after exits.

Regime sentinels agree directionally:

- UP: 12/24 wins, +5.4% mean fee-aware return.
- DOWN: 4/16 wins, −12.0% mean fee-aware return.

Intervals still span zero, but this repeats the earlier six-hour warning. Depending on exits to rescue incorrect DOWN entries is not a robust entry policy.

### 3. Early-cycle and low-quality selected entries were poor

Every live fill with more than ten minutes remaining also had estimate quality below 65%:

- More than ten minutes remaining: 9 windows, 1 hold win, actual P&L −220.61¢, hold −266.90¢.
- Confidence below 65%: 13 windows, 2 hold wins, actual −189.68¢, hold −396.79¢.
- Confidence at least 65%: 24 fills across 23 windows, actual +659.42¢ and hold +646.54¢.

Timing and quality are confounded in this run, so it does not identify which gate is causal. It does justify a paired shadow replay of a 300-second warm-up and a 65% quality floor before any promotion.

### 4. Trade selection remained overconfident even while global direction was good

On the 37 acquired live exposures:

- Mean selected-side probability was 59.6%.
- Only 43.2% won if held.
- Selected-side Brier score was 0.2542.
- UP was mildly overestimated: 61.2% predicted versus 55.0% observed.
- DOWN was severely overestimated: 57.7% predicted versus 29.4% observed.

Basis-only and settlement-average probabilities were even more extreme on this selected cohort and had worse Brier scores. Their better global fixed-snapshot Brier therefore does not authorize using them as direct entry gates without selection-aware evaluation.

### 5. Maker monitoring suggests adverse selection, but not yet a production fix

In this interval, filled accepted orders won 43.2%; accepted no-fills would have won 43.8%. Across the six settlement windows containing both, fills underperformed no-fills by 50 percentage points and about 96.5 normalized return points. Post-only races happened to include 4/6 winners. These samples are too small and conflict with noisier long-run paired results, but they show that “more fills” is not automatically better.

The first-passage fill model also remains poorly calibrated by cohort. In this interval it predicted 58.2% mean fill probability versus 65.5% observed, while the 75–100% prediction bucket filled only 52.4%. It should be recalibrated and paired with depth/queue observations before being used for execution promotion.

### 6. Adaptive regime monitoring observed deterioration but did not cool entries

The v12 gate reached its 12-window warm-up and opened. At extraction:

- 40 resolved v12 sentinel windows.
- Weighted mean fee-aware edge −4.0%.
- 68.2% confidence the recent mean was negative.
- Entry gate remained open because production requires 99% pause confidence.

Unweighted chronological diagnostics show first 20 windows +6.1%, second 20 −9.2%, and last 12 −3.9%. The gate is operating according to its conservative design, but an aggregate sentinel masks the sharper DOWN weakness and responds slowly to moderate deterioration.

## What monitoring taught us

1. **Do not widen below 52.5%.** The current missed-buy computation for deeper underdogs is approximately flat overall and highly tail-dependent. It does not justify further expansion.
2. **The 52.5–55% live relaxation should be reconsidered.** Its fills lost, especially DOWN. Safest action is to restore the 55% live floor and keep 52.5–55% as shadow, or at minimum quarantine near-floor DOWN.
3. **DOWN needs separate monitoring/gating.** Add side-stratified regime evidence and promotion reports; the aggregate sentinel lets positive UP evidence mask weak DOWN evidence.
4. **Evaluate 65% quality and a five-minute elapsed-time gate separately.** They are perfectly confounded in current live fills. Run paired, clustered counterfactuals before changing production.
5. **Keep strict exits and maker-only execution.** This run supplies prospective evidence for both. Do not promote principal recovery or taker execution.
6. **Recalibrate the fill model rather than chasing fill count.** Add paired incremental P&L, queue/depth/slippage coverage, and cohort reliability diagnostics.
7. **Add peak-equity drawdown to live risk.** The run experienced a 131¢ peak-to-trough decline while the current status reported zero current-epoch drawdown at the recovered endpoint. Endpoint-vs-start drawdown cannot express intra-epoch giveback.
8. **Fix the missed-buy report label.** After v12, code correctly applies the active 52.5% threshold but still labels the report “55% selected-side floor rejects.” This is a reporting defect only; it did not alter trades.

## Recommended priority

Without autonomously changing production:

1. Revert the live selected-side floor to 55% and retain 52.5–55% in paper/shadow, or explicitly quarantine only near-floor DOWN if candidate volume must remain higher.
2. Add direction-specific regime sentinel reporting.
3. Add paired shadow candidates for quality ≥65% and no entry during the first five minutes of a cycle.
4. Keep maker-only, attempt two disabled, and strict exits unchanged.
5. Continue collecting unseen windows; do not promote asset-specific SOL behavior from six windows.
