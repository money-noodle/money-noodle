# Long-shot buy→sell gap sweep, 2026-08-17 — no gap is priced loosely enough to pay

> **Corrected 2026-08-17, same day, before any decision rested on it.** The first version of this report
> applied a "sampler coverage" correction that lifted two cells above break-even. That correction is
> **withdrawn**: it assumed every contract settling in the money passed through every mark below 100¢ on
> its way there, which is false for this market. See *The correction that decides the answer* below. With
> it withdrawn, **no cell in the grid clears 1.00** — which strengthens the report's conclusion and removes
> its one hopeful corner. §14a's 68.4%/1.36× figure rests on the same false premise and is withdrawn with it.

**No policy change is made or authorized by this.** It re-runs the §14a sweep on a corrected method and a
larger dataset, and answers a question §14a did not ask: not "which marks work" but "which *gap* between buy
and sell is achieved often enough to pay for itself." The answer is none, and the flatness is again the
finding rather than the best cell.

Reproduce with `npm run analyze:long-shot-gaps`.

## Method and cohort

Every `(contract, side)` in `data/contract-paths.*` whose executable ask entered a price band with at least
`minimumSecondsRemaining` on the clock, with production's position limits applied — one open per asset and
settlement window, at most `maximumOpenPerSettlementWindow` across a window, earliest entry winning. Fees and
sizing are reproduced from `venueFeeCents` and `estimatePaperFill` rather than approximated.

**1,506 windows, closing 2026-08-15T08:45Z through 2026-08-17T22:45Z** — roughly 62 hours.

Three method changes from §14a, all of which matter:

1. **Entry is a band, not a cumulative mark.** A cumulative "ask ≤ 40¢" cohort is dominated by 10¢ entries,
   so a 40→60 row built that way does not describe buying at 40. This is what makes gap sizes comparable.
2. **Settlement is authoritative**, joined by symbol and `closesAt` to the resolved `outcome` in the forecast
   history; 1,492 of 1,506 windows join. §14a inferred settlement from the last path sample, which is
   circular against the 90¢ mark and selects for windows with good late coverage. Kept as a cross-check, the
   inference agrees with the venue on 983 of 994 windows (98.9%).
3. **Misses are graded at their real settlement.** With no fallback exit a miss is not a total loss; it
   settles. `ratio` retains §14a's pessimistic accounting for comparability, but the return column does not.

Returns are averaged within a settlement window before being averaged across windows, and standard errors are
over windows, because contracts sharing a close share one coin flip (AGENTS §5.1). The exit comparison is
additionally run **paired** on identical triggers, which cancels the window-level noise dominating the
unpaired errors.

### The correction that decides the answer

Touch rates are floors: 15-second sampling cannot see a spike between samples. **No correction is applied,
and the one this report originally applied is withdrawn.**

That correction measured the fraction of contracts settling in the money which were *observed* reaching each
mark — 72% at 90¢ — and treated the shortfall as sampling blindness, on the premise that every winner passed
through every mark below 100¢ on its way to settlement. **The premise is false.** These contracts settle on a
price comparison at the close, so the move to 100¢ happens *at* settlement rather than through the book.
Measured over 1,033 resolved windows carrying a sample inside the last 30 seconds:

| winning side's bid, 15s before close | share |
|---|---|
| 90–99¢ | 90.0% |
| 80–89¢ | 2.8% |
| 50–79¢ | 4.2% |
| under 50¢ | **3.0%** (0.8% under 10¢) |

**10.0% of winners were still bid below 90¢ fifteen seconds before close**, some under 10¢. A contract can
trade at 25¢ with seconds left and still settle in the money. So "observed reaching 90¢" conflates sampling
blindness with a discontinuity no sampling rate can see, and cannot be used as a coverage measure.

The replacement is a like-for-like read with no premise about what winners must have done: the dense (1s)
paths decimated to a 15-second grid.

| entry | mark | dense | coarse | implied |
|---|---|---|---|---|
| ≤20¢ | 90¢ | 8.9% | 8.9% | 1.00× |
| ≤30¢ | 90¢ | 8.9% | 8.9% | 1.00× |
| ≤20¢ | 70¢ | 11.1% | 8.9% | 1.25× |
| ≤10¢ | 90¢ | 8.9% | 2.6% | 3.47× *(unstable)* |

At ≤10¢ the decimation also changes *which* candidates qualify, so those rows swing between 1.7× and 4.3×
and are not usable. Where entry detection is robust the implied correction is **1.00–1.25×**, on n=45
windows. Per AGENTS §6 the instability across routes is itself the reportable result: **this dataset cannot
estimate the correction**, so none is applied and every `ratio` below is an uncorrected floor.

## How often each gap is achieved

Percent of entries in each band whose owned-side bid later reached each exit mark.

```
entry band    n     20   25   30   35   40   45   50   55   60   70   80   90   95
 6-10c       48     27   25   19   15   15   13   13   13   10   10    8    8    8
11-15c      114     41   30   25   23   22   20   17   17   13   12   11   10    7
16-20c      206      —   46   37   33   31   28   24   23   19   17   15   13   12
21-25c      280      —    —   55   45   40   36   32   29   25   21   18   16   13
26-30c      372      —    —    —   57   49   44   39   35   33   28   22   20   17
31-35c      430      —    —    —    —   64   55   50   44   40   35   28   24   21
36-40c      473      —    —    —    —    —   62   56   49   45   38   32   28   24
41-45c      480      —    —    —    —    —    —   67   59   55   46   38   34   31
46-49c      481      —    —    —    —    —    —   75   66   59   51   44   40   36
```

The 1–5¢ band produced **10 entries in 62 hours and zero touches at any mark**, and none settled in the
money. Below 6¢ there is no strategy to evaluate, only an absence of candidates.

## Whether any of them pays

Break-even is approximately entry ÷ exit, so the bar moves with the gap: 40→60 needs about 70% and 10→90
about 11%. "Wins more often than not" is therefore only the right bar for gaps under 2×. Dividing each cell
by what it needs:

```
ratio = touch / break-even    20   25   30   35   40   45   50   55   60   70   80   90   95
 6-10c                      0.52 0.61 0.55 0.50 0.58 0.56 0.62 0.69 0.63 0.74 0.68 0.77 0.82
11-15c                      0.49 0.45 0.45 0.49 0.53 0.56 0.51 0.57 0.49 0.54 0.53 0.56 0.43
16-20c                         —  .51  .51  .52  .56  .58  .55  .59  .55  .56  .55  .57  .53
21-25c                         —    —  .61  .59  .61  .62  .61  .61  .58  .58  .55  .56  .50
26-30c                         —    —    —  .62  .61  .62  .61  .62  .63  .63  .58  .58  .54
31-35c                         —    —    —    —  .70  .67  .67  .66  .67  .67  .63  .61  .56
36-40c                         —    —    —    —    —  .66  .67  .64  .65  .64  .61  .61  .57
41-45c                         —    —    —    —    —    —  .70  .68  .69  .68  .66  .66  .64
46-49c                         —    —    —    —    —    —  .70  .69  .67  .67  .68  .68  .66
```

**131 populated cells, spanning 0.43–0.82. Not one clears 1.00.** The best cell in the entire grid needs
about 20% more touches than it gets.

The touch rate tracks break-even at roughly 0.6–0.8× of it across the entire grid. Narrow gaps are achieved
more often in almost exact proportion to paying less. That is what an efficiently priced book looks like, and
it is the same conclusion §14a reached from a smaller and differently-biased dataset.

## The exit mark, paired against the live rule

49 triggers at or below 10¢ across 32 settlement windows, each alternative scored on the same entries as the
production 90¢ exit.

| alternative | mean diff | SE | t |
|---|---|---|---|
| sell at 20¢ | −0.357 | 0.441 | −0.81 |
| sell at 40¢ | −0.365 | 0.336 | −1.08 |
| sell at 70¢ | +0.041 | 0.229 | 0.18 |
| sell at 80¢ | −0.084 | 0.048 | −1.76 |
| sell at 95¢ | +0.044 | 0.025 | 1.76 |
| **never sell** | **+0.088** | **0.050** | **1.76** |

**Every exit earlier than the live mark has a negative point estimate.** The two positives are later. Nothing
reaches |t| = 2, and these are 17 comparisons.

The mechanism is countable rather than inferred. Of the 49 entries at or below 10¢ under production caps, 5
settled in the money and 44 did not:

| exit | sales | sold-at-mark rate | of which winners | of which losers rescued |
|---|---|---|---|---|
| 15¢ | 21 | 42.9% | 5 of 5 | 16 of 44 |
| 20¢ | 13 | 26.5% | 5 of 5 | 8 of 44 |
| 40¢ | 7 | 14.3% | 5 of 5 | 2 of 44 |
| 90¢ | 4 | 8.2% | 4 of 5 | 0 of 44 |

Lowering the exit from 90¢ to 20¢ raises the sold-at-mark rate from 8.2% to 26.5% — a 3.2× improvement in the
statistic — by selling all five winners at roughly 2× instead of letting them settle at roughly 10×, in
exchange for rescuing 8 of 44 losers. **A lower exit mark does not find more successes; it converts existing
winners into small ones and relabels some losses.** Sold-at-mark rate is not a proxy for return, and moves
against it here.

## What this authorizes

Nothing. Per AGENTS §5.5, retroactive screening never promotes anything: promotion needs sentinels committed
at decision time, a minimum count of independent windows, and a clustered return clearing a stated threshold.

Three things the evidence does support saying:

- **The live configuration is in the best corner of the map, and the best corner still loses.** The highest
  cells in the grid are 6–10¢ entry at 90–95¢ (0.77 and 0.82), which is where the policy already sits. No
  narrower gap and no other entry band comes close, so there is no tuning move available — and no cell is
  viable.
- **The refinement the data points at is later, not earlier** — 95¢ over 90¢, and never-selling over both.
  Both are t = 1.76, both are the best of many comparisons, and neither is promotable.
- **The sampling question is now smaller than it looked.** The withdrawn correction implied 15-second
  sampling was hiding a third of all touches. The like-for-like measurement puts it at 1.00–1.25× where it
  can be read at all, on n=45 windows. Denser sampling is still the way to settle it, but it is no longer
  plausible that it rescues a cell from 0.82 to above 1.00.

## Caveats, worst first

- **This report shipped with a wrong correction and was fixed the same day.** The failure mode is worth
  naming: a plausible-sounding structural argument ("every winner passes through 90¢") was accepted without
  being checked against the data, and it moved the headline conclusion. It was caught by an unrelated
  measurement — exit dwell times — disagreeing with it. Assume the same class of error is present elsewhere
  in this analysis.
- **The 6–10¢ cell rests on n=48 entries over 32 windows, SE 0.50**, and is the best of 131 cells. This is
  precisely the shape AGENTS §5.3 warns about.
- **The sampling floor is measured on 45 windows** and is unstable at the entry band that matters.
- **62 hours is three calendar days** of one venue's `crypto-15m` market. No regime variety is represented.
- Entry assumes a fill at the observed ask; production's price-capped taker IOC can fail to fill, which would
  reduce n rather than change the rates.

## What would change the answer

Dense sampling on cheap sides at scale, which would replace the correction with a measurement. Failing that,
a cohort of 60+ resolved attempts under committed sentinels at a single policy version, which the paper lane
is accumulating at roughly 12/day. Re-run `npm run analyze:long-shot-gaps` then; if the 6–10¢/90–95¢ corner
holds above 1.00 on measured rather than corrected touch rates, that is the first result worth arguing about.
