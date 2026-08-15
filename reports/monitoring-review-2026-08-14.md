# Monitoring review — 2026-08-14

## Decision

No observation-only feature currently clears its evidence gate for live activation. Keep the production model, 55% selected-side floor, three-snapshot persistence, managed maker execution, strict-value exit, and existing stake cap unchanged. Keep `profit-reversal-75-v1`, adaptive taker execution, calendar gates, and queue-aware live gates withheld.

This review did identify a reporting defect worth fixing before any later activation decision: the adaptive taker headline averaged individual recommendations across historical buy policies. It did not cluster correlated recommendations by settlement window, did not compare taker with the same intent's actual maker result, and did not expose the active-policy cohort separately. The monitoring surface now does all three. The missed-buy best-per-window action now also reports its own window standard error.

## Evidence, in dashboard order

| Monitor | Current evidence | Decision |
| --- | --- | --- |
| Missed-good-buy / 55% floor | 308 candidates across 85 windows. All-candidate mean +3.1% ±3.3%; the action-relevant best-per-window mean is only +1.3% ±4.2%, with 16/85 profitable selections. | Do not lower the 55% floor. |
| Live track / stake expansion | 404 settled entries across 235 windows, lifetime −182.41¢ on 13,513.95¢ staked. Current control equity is 758¢ versus a 2,000¢ peak, a 62.1% drawdown. Mean clustered window return +5.8% ±9.8%. | No stake expansion; three of five expansion gates fail. |
| Exit actions | Strict value: live +1.5% ±18.6% over 29 windows; paper +30.2% ±13.9% over 77. Profit reversal: live −192.9% ±81.5% over 8 windows; paper −10.1% ±29.3% over 23. | Keep strict value live. Profit reversal is already withheld from execution locally; keep collecting armed counterfactuals. |
| Two-snapshot persistence | 81 resolved incremental intents across 48 independent windows; ask return +6.3¢ ±6.5¢ per $1 payout. Review gate is 100 windows. | Keep observation-only. |
| Calendar effects | 2 dates, 33 resolved candidate windows. Review requires 30 dates and 100 candidates in every time cohort; weekday review also requires 12 occurrences. | Keep observation-only. |
| Target integrity | 2,290/2,290 contracts have rule metadata. Venue outcomes disagree in 32/1,543 paired asset-windows; Kalshi/Kraken proxy agreement is 91.5%. The targets remain approximate because oracle/method semantics differ. | No forecast-input or contract-substitution change. |
| Walk-forward model | Latest 550-window run retained baseline. Candidate return +4.37% versus baseline +4.81%, beat baseline in 2/5 folds, and had larger maximum drawdown. | Do not promote the model candidate. |
| Adaptive taker | Historical-policy mixture: 46 recommendations across 38 windows, +23.4% ±29.6%; paired advantage over actual maker +23.4% ±25.2%. Active buy policy v17: only 6 windows, taker −22.3% ±49.8%, paired advantage −20.0% ±16.1%. | Do not activate taker. The former unclustered +24.7% headline was not deployment-grade evidence. |
| Maker queue/depth | First-passage proxy remains inverted/miscalibrated (71.6% predicted versus 55.1% fills); paired filled-vs-no-fill return gap +4.9% ±15.9% over 125 windows. New trade/queue paper lane has only 3 matched live intents, with 1 both-filled and 2 live-only. | Keep managed maker live; do not add queue-aware gates, sizing, retries, or taker fallback. |
| Organic switch | One completed live switch, −24.396¢ versus hold. | Far too little evidence; never force another switch. |

## Operational note

The collector and all source-health flags were healthy during the review. At the final sample automation was active with one open live position, 195¢ reserved, reconciliation ready, and zero working engine transactions. Given the 62.1% current drawdown, continued live operation is evidence collection at the existing cap—not evidence for expansion. It does not justify a larger stake or any additional live feature.
