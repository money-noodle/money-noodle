# Live strict-value exit: cost vs. save, last 18h — 2026-08-20

**Measure:** For live `strict-value-v1` standalone exits since 2026-08-20T05:14Z (18 h before data read at
2026-08-20T23:14Z), is the sell rule locking a profit that would have been surrendered (saving) or cutting a
winning binary short (costing winnings)?

**Method:** Reloaded 3,059 rows from `data/paper-orders.json` at 2026-08-20T23:26Z and retained `sold`,
non-switch `strict-value-v1` rows whose `standaloneExitAttemptedAt` falls in the fixed interval. Every such
exit later receives an authoritative hold counterfactual (`updateSoldCounterfactuals`,
`src/lib/paper-execution.ts`) computed from the actual settled outcome:
`counterfactualHoldPnlCents = (won ? potentialPayoutCents : 0) − stake`. The per-track incremental is
`exitPnl − holdPnl`. Per-window means cluster on settlement `closesAt`; `n` is exits. Live was `state:
active`, `mode: live` with budget 1730¢ / 0¢ reserved at the original 23:14Z read; that point-in-time state
does not establish uninterrupted operation across the interval.

**Deciding correction:** clustered per settlement window (AGENTS.md §5 item 1). Samples are small; read the
caveats.

## Result — last 18 h (2026-08-20T05:14Z..23:14Z)

| Track | Exits | Windows | Hold-would-WIN | Hold-would-LOSE | Sum exit−hold | Mean exit−hold per exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **live** | 10 | 10 | **10 / 10** | 0 / 10 | **−33.1¢** | −3.3¢ |
| **paper** | 9 | 8 | **9 / 9** | 0 / 9 | −49.1¢ | −5.5¢ |

Live clustered exit-minus-hold was −3.3¢ ±1.5 per window (`t = −2.23`, 10 windows): **hold beat the exit on
average**. Paper's corresponding clustered mean was −5.0¢ ±1.4 (`t = −3.64`, 8 windows). As a fraction of
stake, clustered mean foregone was **13.1% (live)** and **22.7% (paper)** per window.

Largest live foregone this window:
- BNB DOWN: exit +26.5¢ vs hold +41.0¢ (foregone 14.4¢, stake 24¢)
- SOL UP: exit +17.1¢ vs hold +24.4¢ (foregone 7.3¢)
- SOL UP: exit +30.0¢ vs hold +35.4¢ (foregone 5.1¢)

## Interpretation

**In the last 18 h the exit cost winnings rather than saving a later loss.** All 10 live (and 9 paper) exits
were positions that, held to settlement, **won**. Not one would have gone on to lose, so every exit in this
window paid the foregone-upside tail with no offsetting save. The rule fires only when the position is
profitable at the executable bid (cash exceeds the optimistic hold value by at least 1¢); it therefore cuts
positions that are winning *at exit time*, not necessarily contracts that will settle in the money. It nets
positive only when enough of those profitable positions later reverse. In this interval that subset was
empty.

## Why this differs from the full history

| Bucket | Exits | Hold-WIN | Hold-LOSE | Sum exit−hold | Per-window mean | t |
| --- | --- | --- | --- | --- | --- | --- |
| All live history | 104 | 88 | 16 | **+855¢** | +9.7¢ | 1.07 |
| >18 h ago | 94 | 78 | 16 | +889¢ | +11.2¢ | 1.11 |
| Last 18 h | 10 | **10** | **0** | **−33.1¢** | −3.3¢ | −2.23 |

Over the full non-switch live book the exit has **beaten holding** (+855¢), but that surplus is owned by the
16 hold-would-LOSE exits — a median ~166¢ save each — against a persistent ~18.6¢/exit foregone on the 88
hold-would-WIN exits. That historical advantage is real but **not statistically firm** (`t ≈ 1.07` per
window). The last 18 h is the mirror-image tail: zero saves, only foregone upside.

## Caveats

- **Small sample.** 10 live exits / 10 windows; the last-18 h `t = −2.23` is nominally "significant" but is
  one short favorable-window stretch, not evidence the rule has flipped. Do not promote a policy change off it.
- **No redeployment credit.** The counterfactual values *holding this position to settlement* only. The freed
  stake can re-enter another window; no same-window live re-entry occurred here, but the counterfactual does
  not add redeployment return. By this construction the foregone figure is an upper bound.
- **The held basket was net-down this window** (7 held-won vs 16 held-lost live). So the exit's caution was not
  aimed at a rising market; the assets it exited happened to be the ones that kept rising.
- **63 of 96 live entries stayed unfilled** this window — a separate, larger leak than the exit tail and
  independent of it.

## What would change the answer

- A handful more windows without a hold-would-LOSE save moves the live tail clearly negative; one or two saves
  flips it back toward the historical positive.
- The distinguishing question is not "sells when up" but "do positions sold while profitable reverse often
  enough to pay for the foregone upside on the ones that do not." Historical data says weakly yes (+855¢);
  the last 18 h says no on its small sample. Neither is conclusive.

**Policy decision:** none. This fixed 18-hour, 10-window live slice does not authorize an exit-policy change.