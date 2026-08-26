# The long-shot hold sentinel has not cleared its bar, and my earlier reading of it was wrong

> **No policy change is made or authorized by this.** It reviews the committed sentinel
> `long-shot-hold-v1` (`src/lib/hold-sentinel.ts`) against its stated bar of
> `HOLD_SENTINEL_MINIMUM_REVIEW_WINDOWS` = 60 independent settlement windows.
>
> **Every figure is one read of `data/hold-sentinels.json` at 2026-08-18T21:50Z.** Reproduce the sweep it
> is compared against with `npm run analyze:long-shot-marks`.

## Retraction first

Earlier on 2026-08-18 I reported to the maintainer that this sentinel had "cleared its bar — 68 windows
against 60 — and the answer is a null, −8.4% ±65.0". **That is withdrawn.** It is wrong three ways, and
each error flattered the appearance of a settled question:

1. **68 pools three different configurations.** The store holds `buy10-sell90-win600-v1` (n=64),
   `buy40-sell45-win600-v1` (n=2), and `buy40-sell90-win600-v1` (n=2). A bar is per configuration. Only
   the first has a sample worth reading, and the two 40¢ arms are 2 records each.
2. **`peakOwnedSideBidCents` does not exist before 2026-08-18.** It is present on 38 of the 64 records and
   absent on all 26 written between 08-15 and 08-17. The exit-mark question — did the owned bid ever reach
   90¢ — can only be asked of the 38. **So the touch evidence is 38 windows on a single day, not 64 over
   four**, and against a 60-window bar the sentinel has **not** cleared for the question it exists to
   answer. Treating the 26 blanks as "did not touch" is what produced the 9% touch rate I quoted; they are
   not observations of a miss, they are absences of an observation.
3. **All six in-the-money settlements fall on 2026-08-18** — the same single day. The three prior days are
   0 of 26. Pooling them into one mean hid that entirely.

The direction of the correction matters: the honest read of the covered day is **positive**, not null.

## What the sentinel actually says

`long-shot-round-trip-buy10-sell90-win600-v1`, entries at a median 8.8¢ ask (range 3.5–10.0¢), 19¢ stake,
600 seconds minimum remaining, collected 2026-08-15T16:34Z to 2026-08-18T20:34Z. Nothing was executed —
every record carries `executed: false`, *"Collection only: the long-shot execution path is not wired in
yet."* No money moved.

**On the 38 windows with a recorded peak, all 2026-08-18:**

| measure | value |
|---|---|
| touched the 90¢ exit mark | **6 of 38 — 15.8%** |
| break-even touch rate at a mean 9.5¢ all-in cost | **10.6%** |
| sell at the mark, else settle | **+64.0% ±111.7** |
| hold to settlement instead | +55.3% ±115.8 |

**Across all 64 windows, settlement only** — the one question the whole cohort can answer: 6 settled in the
money, 9.4%, and all six on the last day.

An interval of ±112 percentage points is the finding as much as the point estimate is. This is a strategy
whose return is carried by a handful of events, and 38 windows cannot measure it.

## The shape of the thing, which explains the interval

Peak owned-side bid, over the 38 windows where it was recorded:

| p25 | median | p75 | p90 | max |
|---|---|---|---|---|
| 8.6¢ | 14¢ | 31¢ | 99.2¢ | 99.9¢ |

It is bimodal, not dispersed. Most candidates bought near 9¢ decay and never trade above 14¢; a few go to
near-certainty. Eight of 38 peaked above 50¢ and six above 90¢ — there is almost nothing in between. That
is why an exit mark anywhere in the middle of the range is nearly untestable at this sample size, and why
the per-window standard error is larger than the mean.

## What the exit mark is doing, and it is not much

Of the six firings, **five would have settled in the money anyway** — the mark converts those from 100¢ to
90¢ — and **one was rescued** from a loss. Net of six events, selling at the mark is worth roughly one
rescue less five haircuts, which is why it reads +64.0% against +55.3% for holding. On six events that
difference is not a result.

## The disagreement worth recording

The retroactive sweep over 2,131 recorded contract paths (`npm run analyze:long-shot-marks`) puts this
configuration at the **only cell above break-even in the entire grid**:

| entry | exit | n | touch% | break-even% | ratio |
|---|---|---|---|---|---|
| 10¢ | 70¢ | 122 | 14.8 | 14.3 | 1.03 |
| **10¢** | **90¢** | **122** | **12.3** | **11.0** | **1.12** |
| 15¢ | 90¢ | 267 | 13.1 | 16.0 | 0.82 |
| 20¢ | 90¢ | 490 | 15.1 | 21.7 | 0.70 |
| 25¢ | 90¢ | 732 | 17.9 | 26.5 | 0.68 |

Every 5¢, 15¢, 20¢ and 25¢ entry is below 1.00, most of them well below. The prospective sentinel's one
covered day reads 15.8% against a 10.6% break-even, also above. Two routes, both marginally positive, both
on the same narrow band — and neither has the sample to establish it. The sweep's touch rates were floors
at fifteen-second sampling; from 2026-08-18 the path is sampled every two seconds, so that floor tightens
from here.

## Instrumentation defects found

- **`peakOwnedSideBidCents` was not written before 2026-08-18.** Anything computed from it over the earlier
  cohort is silently wrong rather than missing, because the field reads as `undefined` and a naive
  comparison treats it as a miss. This is the same class of bug the 2026-08-17 filter screen recorded
  against `cycleRegime.regime`.
- **Two configurations hold 2 records each** and will never reach a bar. Either they are retired or their
  collection is fixed; carrying them invites exactly the pooling error made above.

## What this authorizes

Nothing, and specifically **not** the conclusion I offered earlier that the exit mark is settled. Concretely:

- **Keep collecting.** The sentinel needs 60 windows *with a recorded peak*; it has 38, all from one day.
  At the current rate that is days, not weeks.
- **Do not retire the 90¢ mark on this evidence**, and do not promote it either.
- **The single-day concentration of every winner is the most interesting thing here** and is not explained
  by daily volatility: 2026-08-17 had the highest mean local 15-minute volatility of the four days (0.149%
  against 0.129% on 08-18) and produced 0 winners in 18 records. Whatever separates the days, it is not
  that.

## Caveats, worst first

- **38 windows on one day** for every touch figure, and 64 windows over four days for settlement.
- Six events carry the entire positive result.
- Nothing was executed; these are modelled entries at the recorded ask with production sizing, so they
  carry no fill evidence at all.
- Seven assets, one venue, one strategy. The per-asset split (DOGE 4 of 10 reached the mark, HYPE 1 of 16,
  XRP 1 of 11, and 0 for BNB, BTC, ETH, SOL) is reported for completeness and is not powered.
