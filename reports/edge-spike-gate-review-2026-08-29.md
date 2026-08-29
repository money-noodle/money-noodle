# Edge-spike gate review — 2026-08-29

## Question and decision

`edge-spike-sentinel-v1` passed its review bar of 60 resolved declined-arm windows. Does its evidence support
arming the edge-spike freshness gate?

**No. Nothing changes: the gate stays disarmed and the sentinel keeps collecting.** The measured advantage
points against the gate rather than for it, but it is not significant, and — the load-bearing observation —
it is *shrinking* as evidence accrues. Its clustered effect halved while the sample grew twelvefold, which is
what regression toward zero looks like, not an effect earning significance.

**A correction to how this was first reported.** An earlier reading in session described this as a production
gate that might be "actively costing money". That was wrong on a material point: the gate has been **disarmed
since v19 on 2026-08-18** by operator decision (`edgeSpikeGateEnabled`, `src/lib/edge-spike-policy.ts`, which
requires `MONEY_NOODLE_EDGE_SPIKE_GATE=true` and is unset). It refuses nothing today. The spike is computed
and recorded on every decision precisely so the question can be settled prospectively; the live question is
whether to arm it, not whether to keep it.

## Fixed inputs

- Cohort: `data/edge-spike-sentinels.json`, restricted to buy policy
  `buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22`, since a policy change
  starts a fresh evidence cohort. 1,354 records, 1,353 resolved and scoreable, none invalid.
- Interval: settlement windows from 2026-08-20 through 2026-08-29.
- Recalculated in session on 2026-08-29 from the durable store, independently of the report builder. No file
  under `data/` was written and no order was placed.

## Method

Both arms come from one evaluation of one population at the same moment in each window, so they are
comparable by construction. The arm label is whether the spike sat within `MAX_EDGE_SPIKE` (2pp).

Neither arm is taken from the order ledger. `realizedEdge` is an ask-priced counterfactual on both sides,
which is deliberate: the admitted arm would otherwise inherit maker fill selection, and scoring a real-fills
arm against a counterfactual one would reproduce the very adverse selection the gate exists to address.

Returns are averaged within a settlement window and then across windows ([`AGENTS.md`](../AGENTS.md) §5.1).
The advantage is admitted minus declined, so **positive would mean the gate refuses the worse cohort** and
would be the direction that justifies arming it.

## Result

| Arm | Spike | Samples | Windows | Win rate | Clustered edge | SE |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Admitted | ≤ 2pp (median 0.05pp) | 1,153 | 563 | 55.9% | **+6.25pp** | 1.69 |
| Declined | > 2pp (median 4.00pp) | 200 | 170 | 59.0% | **+12.41pp** | 3.40 |

**Advantage: −6.16pp ± 3.80, t = −1.62.**

Both arms are positive. The gate would not be refusing losers; it would be refusing rows that scored better
on this measure than the ones it admits.

## Why this is not an effect

Expanding the cohort day by day, the advantage peaks and then decays:

| Through | n | Declined windows | Advantage | t |
| --- | ---: | ---: | ---: | ---: |
| 2026-08-22 | 442 | 65 | −10.74pp | −1.73 |
| 2026-08-25 | 888 | 117 | −8.92pp | −1.96 |
| 2026-08-27 | 1,175 | 147 | −8.31pp | **−2.06** |
| 2026-08-28 | 1,276 | 162 | −6.89pp | −1.78 |
| 2026-08-29 | 1,353 | 170 | −6.16pp | −1.62 |

At a constant effect size `t` grows with the square root of the sample. Here the sample grew twelvefold from
the first day while the point estimate halved, and `t` has fallen for two consecutive days after peaking
below the 1.96 bar. Per day, eight of ten days are negative and two positive, and no single day reaches
`|t| > 1.65`.

The evidence recorded when the gate was disarmed pointed the *other* way — over 52 graded sentinels the
refused decisions returned −24.4% against −7.2% admitted, +17.2pp in the gate's favour at t=0.43. Two
readings of opposite sign, neither significant, is what no effect looks like.

## What this authorizes

Nothing changes. The gate stays disarmed, `MAX_EDGE_SPIKE` is unchanged at 2pp, and the sentinel continues
collecting. Arming it is not supported; nor is retiring the measurement, because a null reading that is still
moving is not a settled one.

What would change the answer: a clustered advantage clearing the family-wise bar in a stable direction across
a materially longer interval, together with a fill model showing the declined cohort is capturable. Both arms
are ask-priced, so a positive reading on either side remains an upper bound this book has never realized.

## Caveats, worst first

- **Both arms are counterfactual.** Neither cohort's edge was realized through a fill. The declined arm's
  apparent advantage says its *signal* was better, not that the desk could have captured it.
- **The arms are unbalanced**: 1,153 admitted against 200 declined, and the declined arm carries twice the
  standard error. The comparison rests on the smaller side.
- **This review was triggered by the instrument crossing its own bar**, which is the intended path, but the
  reading was inspected repeatedly during a single session before this was written. Repeated inspection of an
  accumulating cohort cannot itself create authority.
- One measure, one pre-specified comparison, one policy cohort. No multiple-comparison correction was needed
  and none was applied.
