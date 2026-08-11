# Forecast failure, UP/DOWN policy, and exit review — 2026-08-11

## Forecast diagnosis

The six-hour failure was not primarily directional classification failure:

- 805 fixed issuance snapshots across 23 windows had 73.17% production directional accuracy and 0.1858 Brier score.
- Basis-only variants modestly improved Brier score, but no venue-independent parameter grid produced positive lower-bound fee-aware return in the six-hour cohort.
- Kalshi remained the best probability benchmark (0.1633 Brier), but remains excluded from tradeable probability by policy.

The failure came from converting a reasonably directional forecast into underdog purchases. Policy v10 frequently bought the selected side even when independent `P(side) < 50%`, because a cheap ask created apparent edge:

- 347 six-hour model-underdog fixed-snapshot buys won 17.77% and returned −5.24% after estimated fees.
- Model-favored buys won 50.53% and returned +6.58%.
- Trades agreeing with the raw basis direction returned +7.09%; basis-disagreeing trades returned −5.93%.

This affected both UP and DOWN. DOWN was worse in the six-hour live fills (1/27, −177.82¢), but a symmetric selected-side gate is more defensible than direction-specific model changes.

## Full historical fixed-snapshot replay

The replay used five fixed issuance ages per asset-cycle, exact same-Kalshi-contract asks/outcomes, clustered settlement windows, and fees. It retained 8,058 snapshots across 228 windows.

| Minimum independent selected-side probability | Trades | Windows | Clustered win rate | Mean fee-aware return |
|---|---:|---:|---:|---:|
| No floor | 2,941 | 228 | 33.27% | +2.95% |
| 45% | 1,127 | 221 | 40.39% | +0.31% |
| 50% | 553 | 184 | 45.54% | +1.25% |
| **55%** | **269** | **135** | **54.11%** | **+4.68%** |

At 55%:

- First chronological half: +3.91% mean return.
- Second chronological half: +5.56%.
- Last six hours: 62.33% clustered win rate and +9.99% mean return.
- Raw counts: UP 115/228 and DOWN 20/41.

Clustered lower bounds remain below zero, so the change is a conservative qualification/risk adjustment rather than proof of a new model edge.

## Implemented forecast-policy change

Binary buy policy v11 now requires all existing gates plus independent `P(selected side) ≥ 55%`. It is symmetric:

- UP requires `P(UP) ≥ 55%`.
- DOWN requires `P(DOWN)=1−P(UP) ≥ 55%`.

Venue prices remain costs only and do not enter probability. Model weights, volatility, edge threshold, quality threshold, warm-up, persistence, execution, and stake remain unchanged.

## Exit review

Sixteen reconstructed full live exits produced:

- Actual full-exit P&L: +235.04¢.
- Counterfactual hold P&L: +426.27¢.
- Exit versus hold: −191.23¢.

By policy:

- Profit reversal: 9 exits, −130.36¢ versus hold; three exits beat hold.
- Strict value: 7 exits, −60.88¢ versus hold; none beat hold ex post.

This is hindsight and only 16 observations. Full exits reduced variance and realized gains but surrendered much of the cheap-contract tail payoff that drives profitability. It does not justify deleting the approved exit protections.

## Implemented exit measurement changes

- Every full standalone sold position now receives authoritative counterfactual hold outcome and P&L after venue resolution, not only switched positions.
- Performance reports standalone exit-versus-hold separately from actual P&L and switches.
- An observation-only principal-recovery shadow models selling only enough at the realized full-exit price to recover exact principal and retaining the remaining binary payout.
- No live exit threshold or +75% behavior changed.

A reconstruction at the observed exit prices estimated approximately +349.06¢ for principal recovery versus +235.04¢ for full exits, but this is in-sample hindsight and requires prospective evidence before promotion.

## Configuration note

The operator-set limits were left unchanged:

- `MONEY_NOODLE_MAX_OPEN_POSITIONS=6`
- `MONEY_NOODLE_MAX_SAME_WINDOW_POSITIONS=3`
- `MONEY_NOODLE_MAX_SAME_GROUP_POSITIONS=1`

The same-group limit of one reduces simultaneous correlated exposure, while policy v11 materially reduces candidate volume. The global cap of six still increases maximum cross-group exposure and should remain visible in rolling risk evaluation.
