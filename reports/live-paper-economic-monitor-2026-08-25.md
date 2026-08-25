# Live and paper economic monitor — 24 hours through 2026-08-25T14:30Z

> **Finding:** recent funded and paper execution remained negative while the complete ask-priced v22 opportunity
> surface remained positive. The strongest diagnosis is still implementation selection and exits, not a justified
> forecast or entry-threshold replacement. No policy, route, exit, asset, stake, capital ceiling, or live-authority
> change is authorized. Funded automation remains under explicit active operator intent.

## Method and fixed boundary

The review reran at **2026-08-25T14:43–14:44Z**:

```bash
npm run analyze:paper-settlement
npm run analyze:live-opportunities
npm run analyze:positive-edge-current
npm run analyze:forecast-candidates
npm run analyze:paper-execution-timing
```

The primary interval is the fixed 24 hours ending at the latest fully resolved quarter-hour boundary,
**2026-08-25T14:30:00Z**. Returns are averaged inside UTC settlement timestamp before standard error. No-fill is a
zero-spend execution result, not an investment loss. Exact reporting P&L and whole-cent bankroll control remain
separate.

The caveat that most threatens the conclusion is execution attribution: public paper evidence undercaptures live
fills, and two valid current-execution analyzers differ by one attributed settlement because their cohort
boundaries answer slightly different questions. Both are reported rather than smoothed.

## 1. Funded account and capital controls

The authenticated control read at **2026-08-25T14:43:30Z** was active at revision 6,746, with no reservation or
open managed position, periodic reconciliation READY, and no blocker.

| Control view | Result |
| --- | ---: |
| Current budget start / available | 2,000¢ / 1,844¢ |
| Whole-cent current-budget P&L | −156¢ |
| Peak-to-current drawdown | 667¢ / 26.6% |
| Maximum current-epoch drawdown | 1,600¢ / 80% |
| Lifetime exact live P&L | −1,025.0685¢ |
| Lifetime-loss ceiling | 3,000¢ |

The stake-expansion gate is explicitly closed: current-epoch clustered return was **−7.9% ±8.7pp over 189
windows**, drawdown exceeded its 10% expansion limit, and lifetime P&L was negative. These are capital/risk
controls. They forbid expansion but do not identify a better trading rule.

The adaptive regime sentinel remained open over 384 current-policy windows: +6.0pp half-life-weighted fee-aware
ask result, 8.1pp standard error, and 23.0% estimated negative-return probability versus 99% required to pause.
That sentinel scores one ask-priced policy opportunity per settlement window; it is not an actual-fill or exit-loss
sentinel. Hard drawdown and lifetime limits remain the money-preservation backstops.

## 2. Last-day execution result

The policy-complete live-opportunity route found **134 resolved attempts, 98 venue acceptances, 47 fills over 34
independent windows, 71 unfilled, and 16 rejected/other**. Eighteen filled positions were profitable.

- exact stake: **1,196.38¢**;
- exact realized P&L: **−259.466¢**;
- aggregate ROI: **−21.69%**;
- clustered realized return: **−7.23% ±17.91pp**.

The execution-generation report includes one additional attributed settlement: **48 settlements / 35 windows,
1,219.74¢ stake, −235.0402¢ P&L, −19.27% aggregate ROI, and −4.04% ±17.68pp clustered return**. The difference is
an attribution-boundary disagreement, not an accounting adjustment; each source remains auditable.

Maker supplied 44 of the first route's fills and lost 263.966¢ exact. Three taker fills gained 4.5¢ exact, but their
three-window clustered estimate was −25.46% ±74.54pp. The completed bounded-taker pilot therefore supplies no
basis for an unconditional route switch.

## 3. Signal-to-fill gap

The complete v22 signal surface did not share the realized loss:

| Cohort | Rows / windows | Ask-and-hold clustered return |
| --- | ---: | ---: |
| Every last-day qualifying v22 decision | 418 / 87 | **+22.56% ±7.30pp** |
| Every active-v22 qualifying decision | 2,311 / 471 | **+33.27% ±3.06pp** |
| Positions ordered live in active v22 | 644 / 326 | +29.39% ±5.85pp |
| Positions that filled live in active v22 | 229 / 170 | **−14.25% ±7.45pp** |

In the last-day current-execution cohort, 51 accepted maker misses across 30 windows would have returned
**+40.27% ±18.25pp** at their posted terms, while actual fills returned −7.23% ±17.91pp. This is consistent with
maker adverse selection: passive orders are more likely to fill after the market moves against the selected side.
It is a diagnosis, not proof that crossing every ask would remain profitable under latency, depth, capital, and
rate limits.

The prospective maker restrictions remain locked. Live `maker-spread-max2c-v1` improved the normalized estimate by
+6.49pp ±3.95pp but has only 13/20 required divergent windows; paper's estimate is only +1.56pp ±1.36pp. The spike
arm has ten live divergent windows and is negative in paper. Neither passes joint coverage, positive-cash, and
Holm-corrected live/paper eligibility.

## 4. Exit evidence

Across active v22, 54 authoritative live strict-value exits in 49 windows beat hold **0/54**, costing
**262.5971¢** versus settlement hold with clustered incremental return **−17.90% ±3.11pp**. This is the strongest
current lead, but the prospective v2 generation—not a later retrospective replay—owns change authority.

Exit sentinel v2 currently has:

| Track | Complete / resolved | Complete windows | Coverage | Hold minus production cash | Hold incremental mean ± SE |
| --- | ---: | ---: | ---: | ---: | ---: |
| Live | 32 / 48 | 28 | 66.67% | +76.6762¢ | +10.53% ±4.63pp |
| Paper | 35 / 51 | 30 | 68.63% | +67.006¢ | +9.41% ±4.52pp |

The review gate requires 60 independent windows, 20 divergent windows, at least 90% observed-cycle coverage,
positive cash and clustered mean, one-sided Holm family-wise significance, and simultaneous positive live/paper
eligibility. Every arm remains `reviewUnlocked: false`. Low coverage is currently as important as count; missing
trigger-time public depth cannot be converted into a favorable fill afterward.

For the fixed paper day alone, the 11 actual exits were **45.692¢ better than hold**. That disagrees with the broader
active-v22 strict-exit result and is another reason not to change exits from one day.

## 5. Paper operations and economics

Paper settlement remained mechanically healthy over the fixed day:

| Measure | Result |
| --- | ---: |
| Attempts / attempt windows | 182 / 69 |
| Fills / economic windows | 52 / 42 |
| Confirmed no-fills | 130 |
| Rejected / nonterminal | 0 / 0 |
| Exact stake / P&L | 1,394¢ / **−258.308¢** |
| Whole-cent P&L | −265¢ |
| Aggregate ROI | −18.53% |
| Clustered return | **−12.69% ±16.01pp** |
| Settlement latency | 14.168s median / 36.841s p95 |
| Overdue or open at boundary | 0 / 0 |

The prior fixed day lost 485.959¢ exact on the same 52 fills across 37 windows. The latest loss was smaller, but two
overlapping daily observations do not establish a trend reversal.

Paper bankroll control tied independently: 10,000¢ starting, −3,380¢ whole-cent realized P&L, zero open stake,
6,620¢ available, and zero residual. Lifetime exact paper reporting P&L was −3,919.712¢. Those views differ because
budget control quantizes each order adversely; they are not interchangeable.

Paper/live fidelity remains incomplete. Among 93 accepted same-route maker pairs across 52 windows, the cells were
15 both-filled, three paper-only, 24 live-only, and 51 neither: 70.97% agreement, only 38.46% capture of live fills,
and 83.33% paper-positive precision. Paper is therefore useful but cannot substitute for actual fill-selection
evidence.

## Decision and next gates

1. Keep production v22, current maker control after the completed bounded taker pilot, strict-value exits, sizing,
   assets, and every safety/capital ceiling unchanged.
2. Continue forecast Phase 2, maker-restriction, exit-v2, and paper-timing F2 cohorts without tuning.
3. Review forecast coverage at 100 closed windows and Phase 2 exit at 300; do not start Phase 3 before its written
   phase-exit approval.
4. Review maker restrictions only when both tracks pass every locked gate, not merely when live cash looks better.
5. Diagnose exit-v2's sub-90% coverage while preserving missing evidence; do not backfill it from outcomes.
6. Repeat this fixed-UTC operational/economic separation. A worsening loss is evidence, but only correctness,
   accounting, or safety contradictions bypass the precommitted economic review boundaries.

This report records an active collection posture, not an endorsement of profitability and not financial advice.
