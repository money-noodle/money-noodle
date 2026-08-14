# Exit counterfactual analysis — 2026-08-14

Buy-and-hold versus buy-plus-exit for each standalone exit policy, plus the reverse arm for positions
held to settlement. Positive incremental return means the action actually taken beat the alternative it
rejected. Means and standard errors are clustered by settlement window. Reporting only.

| Mode | Arm | Basis | n | Windows | Action return | Alternative return | Incremental | ±SE | t | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| live | EXIT vs HOLD · strict-value-v1 | authoritative | 30 | 27 | +184.3% | +179.2% | +5.1% | 19.7pp | 0.26 | +270.8¢ |
| live | EXIT vs HOLD · profit-reversal-75-v1 | authoritative | 9 | 8 | +73.8% | +266.7% | -192.9% | 81.5pp | -2.37 | -130.4¢ |
| live | HOLD vs EXIT · exit-at-last-observation | approximate | 145 | 85 | -43.0% | -44.8% | +1.9% | 9.2pp | 0.20 | -689.3¢ |
| live | HOLD vs EXIT · exit-at-armed-peak | approximate | 28 | 22 | +96.6% | +146.6% | -50.1% | 40.6pp | -1.23 | -669.5¢ |
| paper | EXIT vs HOLD · strict-value-v1 | authoritative | 111 | 75 | +110.9% | +80.6% | +30.3% | 14.3pp | 2.12 | +2264.0¢ |
| paper | EXIT vs HOLD · profit-reversal-75-v1 | authoritative | 37 | 23 | +59.0% | +69.1% | -10.1% | 29.3pp | -0.34 | -83.1¢ |
| paper | HOLD vs EXIT · exit-at-last-observation | approximate | 217 | 94 | -76.5% | -85.4% | +8.9% | 2.7pp | 3.34 | +1049.6¢ |
| paper | HOLD vs EXIT · exit-at-armed-peak | approximate | 6 | 5 | +139.1% | +142.0% | -2.9% | 30.7pp | -0.09 | +93.6¢ |

## Reading the table

- **Incremental** is the equal-weighted per-window mean of per-stake incremental return; **Total** is the raw
  cent sum. They can disagree in sign, because stake sizing rose from roughly 9¢ to as much as 140¢ per order
  during the recorded history, so the cent sum is dominated by the largest-stake era. The per-stake mean is the
  comparable figure; the cent sum is what the account actually felt.
- The `approximate` HOLD arms price the rejected exit from an executable bid recorded while the position was
  open, not from a settled outcome. `exit-at-armed-peak` prices it at the high-water mark, which is the best
  exit that population could conceivably have taken rather than one any policy could reliably hit. A negative
  arm there is expected by construction and only its magnitude is informative.

## Counterfactual hold win rate at exit

- live EXIT vs HOLD · strict-value-v1: holding would have settled in the money on 80.0% of 30 exits.
- live EXIT vs HOLD · profit-reversal-75-v1: holding would have settled in the money on 66.7% of 9 exits.
- paper EXIT vs HOLD · strict-value-v1: holding would have settled in the money on 66.7% of 111 exits.
- paper EXIT vs HOLD · profit-reversal-75-v1: holding would have settled in the money on 43.2% of 37 exits.
