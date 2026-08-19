# Can the desk avoid bad bets without dropping the winners? — 2026-08-19

> **Finding, not a policy change.** The closest candidate is refusing maker attempts fired on an edge
> spike of at least 2pp. Its tiny prospective cohort has so far removed four losing fills and no winning
> fills across the two tracks, but it is far below the locked review sample. Over all v21 history it also
> removes winning fills, and the live/paper effect sizes do not agree. No entry, execution, sizing, exit,
> or live-authority change is authorized.

## Inputs, method, and deciding caveat

Recalculated from the moving local durable files on 2026-08-19 with:

- `npm run analyze:positive-edge-current` at 2026-08-19T22:20:43Z: 2,699 orders and 64,844 forecasts;
- `npm run analyze:winner-preserving-filters` at 2026-08-19T22:26:36Z: 2,703 orders and 64,731 resolved forecasts;
- `npm run analyze:long-shot-roundtrip` on the same date: 2,789 paths and 4,882 resolved windows.

The execution comparison scores **every resolved issued maker attempt**. A fill receives its exact realized
return; a no-fill or refused attempt receives zero. Attempts are averaged within settlement time before the
mean and standard error are calculated. This is the relevant portfolio comparison: conditioning only on
fills would give a restriction credit for avoiding no-fill decisions that never spent money.

“Winning fill” below means the purchased side eventually settled in the money, including positions that
production sold before settlement. “Positive-P&L fill” is also counted separately by the script because an
exit can make those labels disagree. Live and paper are never pooled.

The most threatening caveat is sample age. The prospective maker sentinel has only **1 resolved live window
and 10 paper windows**, against its locked requirement of 60 resolved and 20 differing windows. Live and
paper see the same signals, so the four avoided losses are not four independent confirmations. The all-v21
view is retrospective and cannot promote a rule.

## 1. The entry gate is not the first thing to tighten

At the 22:20 read, the active v21 chain was:

| v21 population, ask-priced and held | decisions | windows | clustered return | ±SE |
| --- | ---: | ---: | ---: | ---: |
| Every first qualified position | 591 | 84 | **+12.0%** | 5.1pp |
| Positions selected for a live order | 90 | 36 | +1.7% | 14.0pp |
| Positions that obtained a live fill | 42 | 26 | **−31.6%** | 19.8pp |

The sign changes after fill selection, not at admission. This extends the earlier v17–v19 decomposition on a
larger active-policy cohort. Tightening price, side, asset, edge, or confidence from the small filled slices
would select on the leak rather than identify it, and prior screens already found those shapes reverse
between the admitted and executed populations.

**Conclusion:** an entry refusal is likely to drop profitable opportunities while leaving the maker
selection mechanism intact. No entry filter tested in this repo meets “remove losses, preserve winners.”

## 2. The two predeclared maker restrictions

These are the fixed candidates in
[`docs/positive-edge-execution-exit-sentinel-design.md`](../docs/positive-edge-execution-exit-sentinel-design.md):
spread no wider than 2¢ and edge spike below 2pp. No threshold was re-fit for this read.

### Retrospective all-v21 view

| track / candidate | resolved attempts (windows) | losing fills refused | winning fills refused | candidate P&L / stake | candidate − production, ±SE |
| --- | ---: | ---: | ---: | ---: | ---: |
| live production | 67 (33) | — | — | −992.07¢ / 2,771.80¢ | — |
| live spread ≤2¢ | 67 (33) | 6 | **7** | −988.28¢ / 1,676.04¢ | −0.4pp ±6.0pp |
| live spike <2pp | 67 (33) | **11** | **6** | −377.46¢ / 1,310.51¢ | +13.8pp ±7.2pp |
| paper production | 196 (57) | — | — | −195.88¢ / 6,701¢ | — |
| paper spread ≤2¢ | 196 (57) | **20** | **11** | +586.02¢ / 4,156¢ | +7.8pp ±3.6pp |
| paper spike <2pp | 196 (57) | 17 | **13** | +123.24¢ / 4,101¢ | +3.9pp ±5.9pp |

Neither rule preserves winners. The spike rule is directionally better on both tracks, but it excludes 19
winning fills while excluding 28 losing fills and clears neither a two-sided two-standard-error bar on live
nor any correction for looking at two candidates. The spread rule has the sharpest paper estimate and no
live replication; it removes more live winners than losers.

This is also why “just do not make in wide markets” is not the answer. Wide spread is not a stable bad-bet
label. The adverse-selection mechanism is real, but these issuance features do not yet isolate it cleanly.

### Prospective sentinel view

Collection began at 2026-08-19T15:50:10.470Z.

| track / candidate | resolved attempts (windows) | differing attempts | losing fills refused | winning fills refused | candidate P&L | candidate − production, ±SE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| live spike <2pp | 1 (1) | 1 | 1 | **0** | 0¢ vs −96¢ | +100pp, SE unavailable |
| paper spike <2pp | 22 (10) | 7 | 3 | **0** | −29.08¢ vs −248.08¢ | +15.0pp ±10.7pp |
| paper spread ≤2¢ | 22 (10) | 2 | 0 | 0 | −248.08¢ vs −248.08¢ | 0.0pp |

This is the only measured candidate currently satisfying the literal phrase “reduce bad bets without
missing the wins,” but only in **eleven very early track-windows**. It is a useful lead, not evidence for
re-arming the old entry gate or changing execution. The correct action is to let the already committed
sentinel reach its review boundary.

## 3. Changing exits now risks solving the last regime

In the current v21 maker cohort, strict-value exit fired on 10 positions in 8 live windows and went **0/10
against holding**, surrendering 272.27¢ relative to the settled hold outcomes. That is a direct example of
missing wins rather than filtering bad entries.

It is still not enough to disable the exit. Lifetime evidence favored the 1¢ strict-value rule, and the
new exit sentinel presently has no complete live path and only one complete paper path. Raising the margin,
requiring confirmation, or using the predeclared trailing arm remains a prospective question. Selecting a
fix from the current eight-window reversal would repeat the retroactive-screening error this project is
built to avoid.

## 4. The no-admission-loss option is sizing, but it is not ready

Bounded edge-proportional sizing is the only existing proposal that retains **every admitted position**.
On the prior 3,078-decision gate cohort, capped 0.3×–3× sizing returned +28.9% against +18.6% flat and was
better on 9/9 days. It therefore reduces capital on low-edge bets without deleting their possible wins.

That is not an execution result. The active filled cohort is negative, so weighting its purported edge more
heavily could amplify the leak. The prerequisite remains the approved design sequence in
[`docs/edge-proportional-sizing-design.md`](../docs/edge-proportional-sizing-design.md): first make global and
correlation exposure caps dollar-denominated without increasing total account exposure; then referee a
fixed sizing arm walk-forward against flat sizing and drawdown. Do not increase live stake from this review.

## 5. Separate strategy: the paper long shot

The long-shot strategy is paper-only. Its exact ledger now has **42 settled attempts in 28 windows, zero
`won` statuses, and −754.27¢ on 940¢**. Four historical `sold` rows include the known exit-scoping period and
must not be read as target-mark success. The latest settled 12¢→97¢ predecessor cohort is **0/9 over five
windows, −447¢ on 447¢**; the derived v2 cohort has no settled order.

If “bad bets” includes research-paper volume, retiring this lane is the clearest way to stop recording them,
but it does not save live money and it also ends the prospective test. The round-trip analysis found no exit
mark that beats holding reliably; continuing it is justified only as explicitly bounded evidence collection,
not as a strategy with demonstrated value.

## Decision

1. **Do not tighten the buy gate.** The active admitted population remains positive; the loss appears after
   execution.
2. **Do not activate either maker restriction yet.** The 2pp spike restriction is the lead to watch, but its
   all-v21 history drops winners and its prospective cohort is 1 live / 10 paper windows.
3. **Do not tune the strict exit from the eight-window reversal.** Let the committed exit paths become
   complete and reach their lock.
4. **If development effort is available, build dollar-denominated exposure caps before a fixed sizing
   evaluation arm.** This is the only route examined that changes capital without deleting admissions.
5. **Consider retiring the paper-only long-shot lane** if its collection value no longer justifies the noise;
   no live authority is involved.

No production policy changes. Nothing here is financial advice.
