# There is no exit mark that makes the long shot work — the round trip is the wrong shape

> **No policy change is made or authorized by this.** It opens a new line on the long-shot policy at the
> maintainer's request, on the premise that "there is something to it, we just haven't found the gating
> factor". The measurement says the gating factor is not on the entry side at all.
>
> Reproduce with `npm run analyze:long-shot-roundtrip`. 2,124 recorded contract paths against 4,173
> resolved settlement windows, read at 2026-08-18T22:05Z.

## The question every previous screen skipped

[long-shot-filter-screen-2026-08-17.md](long-shot-filter-screen-2026-08-17.md) screened thirty entry
filters and found nothing usable. Every one of them scored candidates on whether they **win**. For a round
trip that is the wrong target.

Buying at 10¢ and selling at 90¢ is not a bet on settlement. It is a bet on the *path* — and it is worth
more than simply holding **only** on contracts that reach the mark and would *not* have settled in the
money. Call that a spike-and-lose. Where spike-and-lose is rare, the mark is selling winners at a discount,
and no entry filter can repair that, because the exit subtracts value on every trade it touches.

So this measures touch against settlement on the same cohort, which had not been done.

## The result

`gap` is touch minus settle in points. `b/e` is the touch rate the configuration needs: mean all-in cost
divided by the mark.

| band | ≥s left | n | settles | touch 30¢ | gap | b/e | touch 50¢ | gap | b/e | touch 90¢ | gap | b/e | spike-and-lose at 90¢ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0–10¢ | 600 | 77 | 11.7% | 23.4% | +11.7 | 30.4% | 14.3% | +2.6 | 18.2% | 10.4% | **−1.3** | 10.1% | **0 of 77** |
| 0–10¢ | 300 | 474 | 8.6% | 18.6% | +9.9 | 28.6% | 10.1% | +1.5 | 17.2% | 5.1% | **−3.6** | 9.5% | 1 of 474 |
| 10–15¢ | 300 | 549 | 14.0% | 28.6% | +14.6 | 48.0% | 18.6% | +4.6 | 28.8% | 10.4% | **−3.6** | 16.0% | 3 of 549 |
| 15–20¢ | 300 | 664 | 18.2% | 39.0% | +20.8 | 64.6% | 24.2% | +6.0 | 38.7% | 12.3% | **−5.9** | 21.5% | 4 of 664 |
| 20–30¢ | 300 | 1,074 | 25.2% | 64.6% | +39.4 | 92.9% | 38.0% | +12.8 | 55.7% | 19.8% | **−5.4** | 31.0% | 14 of 1,074 |

**1. A contract that prints a 90¢ bid has essentially already won.** Spike-and-lose is 0, 1, 3, 4, and 14
cases — about 1% of entries in every band. The 90¢ mark is not harvesting a reversal. It converts a winner
from 100¢ to 90¢.

**2. The 90¢ mark reaches *fewer* contracts than holding wins**, in every band, by 1.3 to 5.9 points. These
contracts settle on a close-price comparison, so a winner can settle in the money without its bid ever
trading near 90¢. The mark both takes a haircut on the winners it catches and misses winners entirely.

**3. The retrace population is real, and it is in the middle of the range.** At the 30¢ mark the gap is
+11.7 to +39.4 points: many contracts do touch 30¢ and go on to lose. That is the spike-and-retrace the
strategy was designed around — it simply does not happen at 90¢.

**4. It still does not pay, because the two effects are on opposite ends.** Where the retrace premium is
large the payoff multiple is small, so break-even runs ahead of the touch rate everywhere: 30¢ needs
28.6–92.9% and delivers 18.6–64.6%; 50¢ needs 17.2–55.7% and delivers 10.1–38.0%. **No cell in the grid
clears break-even** except 0–10¢/≥600s at 90¢ — 10.4% against 10.1% — and that is precisely the cell where
the mark loses 1.3 points to holding.

## What holding alone does

The arm every mark is competing with. Buy at the ask, no exit, settle:

| band | ≥s left | n | mean cost | settles | return per $1 |
|---|---|---|---|---|---|
| **0–10¢** | **600** | 77 | 9.1¢ | 11.7% | **+16.8% ±72.3** |
| 0–10¢ | 300 | 474 | 8.6¢ | 8.6% | +3.1% ±34.8 |
| 10–15¢ | 300 | 549 | 14.4¢ | 14.0% | −3.7% ±20.1 |
| 15–20¢ | 300 | 664 | 19.4¢ | 18.2% | −5.3% ±15.3 |
| 20–30¢ | 300 | 1,074 | 27.9¢ | 25.2% | −8.9% ±9.5 |

Return falls monotonically as the entry gets more expensive, and only the cheapest band entered **early** is
positive. That is 9 winners in 77 entries with an interval of ±72 points — it is a direction, not a result,
and it sits against `long-shot-filter-screen-2026-08-17.md` §"clean nulls", which found `≥12 min left`
raised the touch rate while *lowering* return. Different cohorts and different target variables; the
disagreement is reported rather than resolved.

## The realized ledger

33 paper entries under `long-shot-round-trip`: **−309¢ on 493¢, −62.7%, and 0 of 33 settled in the money.**

Two things must be subtracted before reading that as evidence about the mark:

- **Three of the `sold` rows are strict-value exits**, from before `observeAndExecuteStandaloneExits` was
  scoped to `EDGE_BINARY_BUY`. STATUS.md already records this. They are not round trips.
- **The three live entries were manual tests at a deliberately higher entry price**, placed to prove the
  round-trip mechanism executes end to end. They are not policy execution and are excluded here.

Zero winners in 33 against an expected 8–18% is unlucky rather than structural — but it means the ledger
contributes almost nothing to the question, and the path measurement above carries it.

## What this authorizes

Nothing yet, and specifically it does **not** authorize a new entry filter. Concretely:

- **The 90¢ exit mark should be removed or replaced, not tuned.** It is negative against holding in every
  band measured, on 1,218 entries, and the mechanism is structural rather than a sample artifact. Doing so
  is a long-shot policy version bump with a manifest entry, and it needs the maintainer's decision because
  it changes what the strategy *is*: without a mark, `long-shot-round-trip` is not a round trip.
- **Retiring the mark does not make the strategy positive.** Holding is negative in every band except
  0–10¢ entered with ten minutes left, where it is +16.8% ±72.3 on 9 winners. The honest read is that the
  policy's remaining hope is a narrow, rare cohort, not that removing the exit fixes it.
- **The next question is the entry band and the clock, not a feature filter** — how often a side is under
  10¢ with ten minutes left, and whether that cohort survives its own interval. STATUS.md already records
  that only 2% of sides reaching 10¢ do so inside the first five minutes.

## Caveats, worst first

- **Touch rates are floors, and the bias runs *against* the mark — corrected 2026-08-18.** An earlier
  version of this line claimed the undercount flattered the mark and that correcting it "can only
  strengthen the conclusion". **That is backwards and is withdrawn.** Fifteen-second sampling cannot see a
  spike between samples, so every touch rate above is understated while the settlement rate it is compared
  against is exact. The measurement is therefore run on data that penalizes the exit mark, and finer
  sampling can only move the mark's numbers **up**. Every negative `gap` in the table is an upper bound on
  how negative it really is. The finer-sampling follow-up named here as `long-shot-fine-marks-2026-08-18.md` was never written; the long-shot workstream was retired before it was produced.
- The one positive holding cell is **9 winners in 77 entries** with a ±72-point interval.
- Entries are bought at the recorded ask with no fill model; the long-shot path rests a maker order.
- Exits are priced optimistically at exactly the mark; a bid gapping through fills worse.
- Windows without a resolved outcome are dropped, which drops the most recent ones first.
- Four days, seven assets, one venue.
