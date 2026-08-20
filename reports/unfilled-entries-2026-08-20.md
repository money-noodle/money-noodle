# Unfilled live edge entries — why so many, and would rested makers have paid? — 2026-08-20

> **No policy change is authorized.** This fixes an 18-hour cohort at
> `2026-08-20T05:24:00Z..23:24:00Z`, separates actual rested maker misses from create rejections and taker
> refusals, and scores only the rested cohort. Reproduce with
> `node scripts/analyze-unfilled-entries.mjs 18 2026-08-20T23:24:00Z`.

## Inputs and method

A 2026-08-20T23:34Z reload of `data/paper-orders.json` contained 3,059 rows. The cohort retains live Kalshi
`edge-binary-buy` entry rows whose calculation timestamp falls in the fixed interval. Outcomes come first
from authoritative settled order/counterfactual fields; 37 unique missing contracts were read sequentially
from Kalshi's public market endpoint. No sealed forecast shard was loaded, no durable file was written, and
no order was placed.

The counterfactual applies only to an order that actually rested and ended without a fill. It assumes the
requested quantity filled at `initialSubmittedPrice`, pays no maker fee, and holds to settlement. P&L and
stake preserve fractional cents. Means, uncertainty, ranges, and the selected-side control cluster by
settlement `closesAt`; rows in one market window are not independent.

## What did not fill

The desk produced **95** live edge entry rows:

| Terminal route | Rows |
| --- | ---: |
| Rested maker, zero fill | **55** |
| Post-only create rejection before a resting order was established | 5 |
| Taker refused because the fresh ask exceeded its approved cap | 2 |
| Filled, settled, or sold | 32 |
| Other rejected entry | 1 |

Thus 62/95 rows were locally `unfilled`, but only 55 are queue/fill misses. Pooling the seven pre-placement
refusals with rested orders would answer a different question and manufacture a "posted-price" fill where
no accepted post existed.

## Rested-maker hold counterfactual

All 55 rested misses resolved across **32 independent settlement windows**:

- selected side would win: **36/55 (65.5%)**;
- aggregate hold P&L at posted price: **+794.7¢ on 1,588.3¢ = +50.0%**;
- clustered mean return: **+52.8% ±16.7%, `t = 3.15`**, with window means from −100% to +233.3%;
- 44/55 rested at their approved maximum price.

This is a conditional-on-no-fill ceiling, not an executable return estimate. A maker misses precisely when
the path does not trade through its queue before cancellation. Granting it a fill while retaining the
favorable path that caused the miss combines mutually inconsistent states.

## Direction control and adverse selection

An always-UP decision on the same rows is the relevant control for this strongly upward interval. Clustered
by window, the model-selected side beat always-UP by only **+5.7pp ±5.7pp (`t = 1.00`)**. The point estimate
is positive, unlike the first draft's duplicated-row base-rate calculation, but it is not statistically firm
and does not separate model edge from one favorable regime.

The contemporaneous filled/settled/sold cohort had 16/32 hold-would-win outcomes (50.0%) versus 36/55 for
the rested misses (65.5%). That gap has the expected adverse-selection direction: price moves toward bids
that fill and away from bids that miss. Lifetime evidence is stronger and similarly adverse:
[`maker-adverse-selection-and-exit-depth-2026-08-19.md`](maker-adverse-selection-and-exit-depth-2026-08-19.md)
reported materially higher fill rates for eventual losers. One recent regime does not establish that the
mechanism changed.

## Should bids rise or cross?

**Not on this evidence.**

1. The +50.0% counterfactual assumes a fill on paths selected for not filling; it is not a reachable order
   strategy.
2. Selected side versus always-UP was only `t = 1.00` across 32 windows.
3. Raising 44 orders above their recorded approved maximum is a policy/cap change, not execution tuning.
4. Crossing pays the ask and gives up the maker discount. The dedicated historical comparison in
   [`take-the-ask-2026-08-18.md`](take-the-ask-2026-08-18.md) found no return-per-dollar improvement from
   taking every decision while deploying substantially more capital.

A bid change would require prospective evidence that an implementable alternative price/route beats the
live rule on every decision, including zero deployment and the route's actual fees, queue selection, exits,
and capital use. Exact own-order queue-position collection is the cleaner next instrument after the known
client-order-ID collision is repaired.

## Caveats

- Fixed 18-hour interval, 55 rested misses, 32 windows, one favorable regime.
- Counterfactual ignores the causal path required to create the fill and therefore overstates capturable
  return; this is the dominant caveat.
- Public settlement reads are current authoritative results but not a retained API-response artifact. Every
  unavailable outcome would have been excluded rather than guessed; none was unavailable in this run.
- It gives no redeployment credit and scores hold-to-settlement, not the production exit policy.
- Multiple comparisons were not searched here, but the interval was selected after noticing a high miss
  count; nominal `t = 3.15` does not erase that post-selection cost.

**Policy decision:** none. Keep the current maker prices, caps, route selection, and attempt policy.
