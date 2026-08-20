# Buy-policy v22 entry-admission review — 2026-08-20

> **Finding:** v22 is purely restrictive, but the original uncertainty attached to its dropped cohort was
> not settlement-window clustered. Recalculation with exact provider outcomes finds that the rows v22 omits
> were positive and that v22 trails v21 in the ask-priced, held-to-settlement comparison. This does not
> reverse the operator deployment automatically; it records the cost accurately and reinforces that v22 was
> an execution-judgment narrowing, not an evidence promotion.

## Inputs, method, and correction

Recalculated at **2026-08-20T05:00:49Z** from **66,728 forecast rows, 66,651 resolved**, spanning
2026-08-08T21:19:19Z–2026-08-20T04:52:04Z. Reproduce with:

```bash
npm run analyze:entry-admission-v22
```

For v21 and v22 independently, the script takes the first qualifying calculation per
`(symbol, closesAt, side)`. It selects that side's highest-net-edge enabled actionable venue, requires the
outcome from that exact provider, prices entry at ask plus the shared taker admission fee, and holds to
settlement. Assets sharing `closesAt` are averaged before the mean and standard error. A v21 position omitted
by v22 earns zero in the paired v22 arm. This scores every v21 position, not only v22's surviving cohort.

The original source/status text reported the omitted cohort at +24.6% ±3.8 over 237 settlement windows. The
point estimate was directionally right, but **±3.8pp was the edge-floor subgroup's standard error, not the
whole omitted cohort's settlement-window-clustered uncertainty**. The corrected whole-cohort uncertainty is
±7.6pp at this read. This matters because rows in one settlement timestamp are correlated and may not be
counted as independent trials.

The largest caveat is execution transfer. This is retrospective, ask-priced screening with no persistence,
maker-fill selection, portfolio capacity, sizing, exits, or budget reuse. V22 was deployed because the desk
does not receive the ask-filled upper bound uniformly; this replay does not test that rationale. Forecast
history also retains every qualifying calculation but only bounded nonqualifying calculations, so the true
first qualification can precede the first recorded one.

## Main comparison

| cohort | decisions / settlement timestamps | wins | mean ask | clustered return ±SE | bounded edge ±SE |
| --- | ---: | ---: | ---: | ---: | ---: |
| v21 | 3,941 / 853 | 2,399 | 51.3¢ | +20.7% ±2.4 | +9.1pp ±1.0 |
| v22 | 3,373 / 837 | 1,982 | 48.7¢ | +19.2% ±2.3 | +9.0pp ±1.0 |
| v21-only | 568 / 238 | 417 | 61.2¢ | **+26.1% ±7.6** | **+12.8pp ±2.0** |

V22 adds **zero** positions and omits **568**, a **14.4%** reduction. On every v21 position, with omitted
positions assigned zero and later v22 first fires retained, v22 changes return by:

- **−3.7pp ±1.3pp** per dollar committed; and
- **−1.09pp ±0.31pp** on bounded payout edge.

This is evidence that the narrowing costs ask-priced signal value. It is not an executable P&L estimate.

## Exclusive gate attribution

Price is attributed first so the three categories are disjoint; the edge cohort means inside the 10–75¢
band but below +5pp.

| first v21 position omitted by | decisions / timestamps | wins | mean ask | clustered return ±SE |
| --- | ---: | ---: | ---: | ---: |
| below 10¢ | 9 / 9 | 2 | 7.9¢ | +173.2% ±185.9 |
| above 75¢ | 72 / 64 | 64 | 80.4¢ | +8.1% ±5.2 |
| edge below +5pp inside band | 487 / 204 | 351 | 59.3¢ | +21.3% ±3.8 |

The low-price cell is nine highly skewed positions and says almost nothing. The high-price cell is positive
but uncertain. The edge-floor cell is the stable source of the omitted cohort's positive value. These are
three diagnostic looks at one policy comparison, not three independent confirmations.

## Materially different formulation

If v22 is applied only to v21's original firing calculation and is forbidden from qualifying later, it omits
979 positions rather than 568. That same-trigger omitted arm returns +25.8% ±8.5 over 270 settlement
timestamps. Production repeatedly evaluates the policy, so independent first-to-fire is the primary result;
the sensitivity shows that the estimated volume effect depends materially on allowing a later v22 entry.

## Decision status

No automatic policy action follows.

- V22 was explicitly deployed as an operator narrowing, not promoted from this replay.
- The corrected replay does **not** supply economic evidence for v22; it measures a positive cohort being
  removed and a negative paired ask-priced increment.
- The operator rationale remains that ask-priced return is an upper bound under adverse maker selection and
  incomplete exits. Settling that rationale requires forward executable evidence, not another threshold
  sweep over the same history.
- Any reversal or further narrowing requires a new shared buy-policy version, manifest history, and written
  decision. A prospective candidate remains the normal promotion path under SPEC §12.5.

Nothing here is financial advice.
