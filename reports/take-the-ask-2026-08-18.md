# Taking the ask instead of resting, 2026-08-18 — the discount is worth keeping; the missed fills are the leak

**No policy change is made or authorized by this**, and it **contradicts the suggestion that prompted it.**
Reviewing the v17 fill-selection leak I proposed that paying the spread might beat chasing the maker
discount. Measured against the proper control, the opposite holds: **the discount is worth 9–16pp of return
on the trades it wins**, and switching to taking does not improve the rate of return at all.

Reproduce with `npm run analyze:take-the-ask`.

## Why the naive comparison misleads

`A as traded` includes the standalone exits; a take-the-ask counterfactual is held to settlement. Comparing
them directly mixes the price change with the exit rule and makes taking look far worse than it is. **A2 —
the same maker fills, settled rather than exited — is the control that makes the comparison readable**, and
it was missing from the first version of this measurement.

Decisions are deduplicated to one per `(symbol, window, side)`: the maker path issues several orders per
decision as it reprices, and a taker issues one. Counting retries as separate takes would multiply the
counterfactual's fees and stake.

## v17, the closed cohort

| arm | live return/$1 | paper return/$1 | live total | paper total |
|---|---|---|---|---|
| A as traded | −1.7% ±13.1 | −4.4% ±10.8 | −382c | −1,127c |
| A2 as filled, held | −6.0% ±13.5 | −17.4% ±11.7 | −706c | −3,003c |
| B take ask, filled only | −21.7% ±10.2 | −26.6% ±9.6 | −2,267c | −3,780c |
| C take ask, every decision | −1.0% ±8.1 | +1.8% ±7.8 | +602c | +862c |

206 live decisions (110 filled by the maker, 53%), 225 paper (118 filled, 52%).

Three effects separate cleanly:

- **The maker discount is genuinely valuable.** A2 → B costs **−15.7pp live, −9.2pp paper**. Buying ~4¢
  under the issuance ask, at zero fee, is worth roughly a tenth to a sixth of the return on the trades that
  fill. That is the clean price effect, with the exit held constant.
- **The standalone exits help.** A → A2 shows the exits adding **+4.3pp live and +13.0pp paper**. They are
  not the problem.
- **The missed fills are the leak.** B → C is worth **+2,869c live and +4,642c paper** — the decisions the
  resting order never filled, which `analyze:entry-realization` shows win about 25pp more than the ones it
  did.

## Why taking the ask still is not the answer

**It does not improve the rate of return.** C sits at −1.0% ±8.1 live and +1.8% ±7.8 paper, which is not
distinguishable from A (−1.7%, −4.4%) or from zero. The entire total-P&L advantage comes from **deploying
roughly twice the capital**: 26,750c against 13,215c live, 31,552c against 15,557c paper.

The desk runs a 2,000c budget. It cannot double deployment, so the cash advantage in column C is not
available to it, and what remains — the rate — is unchanged.

**And it does not replicate in v18.** On the current cohort C is *worse* than A on both tracks (−14.0%
against +5.7% live, −12.1% against −10.3% paper) on 45 decisions with ±15 intervals. That is noise, but it
is not support.

## What the measurement actually says to do

The problem is not maker versus taker. **The maker fills the losers and misses the winners**, and the
discount it earns is real but adversely selected. Paying the spread on everything buys the winners back and
pays for them by giving up the discount on all the rest, netting out to the same rate.

That points at something selective rather than a global switch — crossing only when the signal is strong
enough to be worth 4¢, or posting closer to the ask on those decisions — and none of that is tested here.

## Caveats, worst first

- **C assumes capacity the desk does not have**: the hourly order ceiling and the budget would not have
  permitted filling every decision. C is an upper bound on deployment, not a schedule.
- **Taking is assumed to fill at the issuance ask, in full.** A thin book fills worse, which makes B and C
  optimistic.
- **The exit is not modelled in B or C.** They are held to settlement, so a profitable exit is credited to
  A alone — the +4.3pp and +13.0pp above.
- v18's cohort is 45 decisions per track. It cannot confirm or refute v17's reading.
- Three days of one venue's market, one strategy.
