# Window-consensus direction signals: exploration and evaluation plan — 2026-08-20

> **Exploration only — nothing here is a policy candidate, and nothing is promotable.** This report sizes
> the data and the evaluation grid for a possible future "buy when the selected side is rising over a
> window consensus" gate, per SPEC §12.5. The screen is retrospective (SPEC §5.5: retroactive screening
> never promotes anything); it exists to precommit the right *forward* collection and the right
> *denominator* before any sentinel is started. Reproduce with `npm run analyze:window-consensus`
> (`scripts/analyze-window-consensus.mjs`).

## The question, restated

If we record the selected-side venue move over several lookback windows before each buy
(2s, 30s, 60s, 120s, and the longer 240s/360s/480s/600s = 4/6/8/10 min), and buy only when a consensus of
those windows shows an up-move, does that *rate* improvement survive once we account for how often it fires
and how much of the book it drops?

## The data we can already reconstruct (and its limits)

- **15s ask series**: `forecast-history` shards (08-08..08-20) + journal + megafile give a per-contract
  selected-side ask on a ~15s grid from cycle open. From this, the move over any window ≥30s is
  reconstructable at buy time.
- **2s reading**: `entryDirectionObservation.preSubmit` (issuance → exact pre-submit) exists only on ~23
  orders, all 08-19/08-20 — the sentinel is new.
- **Coverage**: 104 live orders have full 30s..600s windows across 12 days. Base win rate 18.3% (19/104).
  The daily win rates are wildly heterogeneous (0% on 08-11/12/14/16, 56% on 08-18), so the pooled numbers
  below are dominated by regime shifts, not a stable effect.

## What the screen finds (104 orders, 12 days)

### Per-window: win rate by direction

| Window | Up-move | Down-move | gap |
| --- | --- | --- | --- |
| 30s | 17% (35) | 16% (50) | +1pp |
| 60s | 23% (39) | 17% (60) | +6pp |
| 120s | 20% (41) | 18% (61) | +2pp |
| 240s | 23% (44) | 15% (59) | +8pp |
| 360s | 23% (43) | 14% (57) | +9pp |
| 480s | **27% (44)** | **11% (56)** | **+16pp** |
| 600s | **26% (46)** | **12% (58)** | **+14pp** |

The gradient exists and **grows with the window**: the 8-10 min move separates winners from losers twice as
well as the 30s move. This is the opposite sign from the 18-hour-day read (where adverse moves preceded
winners) — that day was a dip-and-recover regime; the pooled book is dominated by other days.

### Combinations (ALL-of-set must be positive)

| Consensus set | n | Win rate | Net | 
| --- | --- | --- | --- |
| 30,60,120 | 20 | 25% | +510c |
| 60,120,240 | 25 | 28% | +478c |
| 360,480,600 | 27 | **30%** | +450c |
| 30..240 all | 18 | 28% | +510c |
| **30..600 all** | **8** | **50%** | +268c |
| negative 30,60,120 | 37 | 16% | +459c |

The full-grid consensus (all seven windows positive) reaches 50% win rate — but **n=8 across 12 days**,
i.e. ~0.7 trades/day. Buying only those would have kept 268¢ and dropped 810¢ of a 1,079¢ book. The rate
improvement is real but the **frequency cost is catastrophic**: the desk already fills only ~half its
decisions; a window gate on top would starve it.

### The 2s reading adds nothing

Of 23 orders with a 2s pre-submit reading: all-{2,30,60,120}-positive fired **0 times**; all-negative fired
4 times, 0 winners. The 2s move is too noisy to contribute to any consensus (consistent with the earlier
18h finding that 2s direction is flat/random during the 12s management window).

## Why the retrospective screen cannot decide anything

1. **Regime heterogeneity**: daily win rates range 0–56%. A consensus gate that "works" pooled would have
   to hold within days, and the 18h day already showed the *opposite* sign. Any pooled number is a mix.
2. **Multiple comparisons**: ~10 windows × ~30 combinations = hundreds of looks at 104 orders. The 50% at
   `30..600 all` is the best cell of a grid, not a discovery.
3. **Rate vs capital**: the desk's constraint is not win rate, it's deployed capital under a 2,000¢ budget.
   A gate that halves fills to raise win rate can easily lose money per day (the +510c `30..240` vs +1,079c
   whole book).

## The plan: what to collect forward, and how to evaluate

### Data to collect (decision-time feature stamp)

Add to the existing observation layer a **durable per-decision window-feature record** stamped at entry
decision time (not at fill — unfilled decisions need it too), containing for the selected side:

- move over **2s, 30s, 60s, 120s, 240s, 360s, 480s, 600s** (cents, signed), each from the exact
  pre-submit quote series;
- the same eight windows for the **underlying** (Kraken basis) move, separate from the venue move
  (the two mean different things: a venue dip is the maker fill mechanism; an underlying dip is asset
  momentum);
- the per-window quote **age** at each read, so a stale read cannot masquerade as a move.

This reuses the existing `quote-trajectory-spread-v1` collection boundary (it already records trailing-60s
and cycle-to-date) — extend it to the full eight-window grid rather than add a new store. The 2s reading
already exists (`entryDirectionObservation`); keep collecting it but do not weight it until it has hundreds
of windows.

### Evaluation plan (forward, precommitted)

1. **Candidate set is fixed now**: all 127 non-empty subsets of the 8 windows as ALL-positive gates, plus
   the >=k-of-4 family, plus the magnitude-thresholded versions of the top 5 (thresholds −5/−10/−15/−20¢).
   Written down before any result is seen — that is the multiple-comparison denominator (127+ candidates).
2. **Sentinel**: every qualified decision (filled or not) gets the feature stamp; a lightweight
   first-to-fire sentinel marks each candidate's first qualifying decision and follows it to settlement.
3. **Decision statistic**: clustered per settlement window; candidate beats BOTH the live rule and the
   whole-book rate *within a single regime* (not pooled across the 0–56% days), on ≥30 independent windows,
   with the multiple-comparison cost stated (§5.3).
4. **Frequency gate**: any candidate must show it does not starve the desk — minimum ~3 trades/day at the
   deployed stake, or it is rejected regardless of win rate (rate-without-capital is not an edge under a
   2,000¢ budget).
5. **Promotion**: manual, versioned, SPEC §12.5 — never automatic.

### Revisit cadence (the "look over longer timelines" ask)

- **Every 500 resolved decision-windows** (~5 days at current fill volume), regenerate this exact screen
  on the full ledger since the last review, appending to a dated report. Same script, same denominators —
  the growth is the point, not a re-tuning.
- **Weekly**: rerun the with-2s subset once the 2s sentinel has ≥300 windows (expected ~08-27).
- **Monthly**: a walk-forward-style review of the *whole* decision history, clustered by regime (the daily
  0–56% spread means regime labeling is mandatory before any pooled claim).
- Each review states: candidates evaluated, window sets, n, win rate, net, trades/day, and the multiple-
  comparison count. Null results get written up (§5.6). Nothing auto-promotes.

## Caveats

- Retrospective; 104 orders; 12 days; regime-heterogeneous. Not a basis for any change.
- 2s coverage is only 23 orders — the with-2s conclusions are the weakest in this report.
- The 08-20 day (25 orders, 8% win) is the current live regime and already showed the *opposite* sign of
  the pooled book — the plan's regime labeling is not optional.

Full inputs: `data/forecast-history-shards/*.json`, `data/forecast-history.journal.jsonl`,
`data/forecast-history.json`, `data/paper-orders.json`.