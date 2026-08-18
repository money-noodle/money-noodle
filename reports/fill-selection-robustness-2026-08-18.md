# Fill selection, stress-tested — real and stable, but conflated with window selection

The v17 review reported that filled entries win about 25 points less than unfilled ones, and that figure
has been carried into every subsequent reading of why the edge policy loses. **It survives every robustness
check applied here except the one that matters most for choosing a fix**, and that failure is the finding.

Reproduce the underlying cohorts with `npm run analyze:entry-realization` and
`npm run analyze:take-the-ask`.

## What was checked, and what held

### The price effect does not explain it

A resting buy fills when the price falls, and a lower price mechanically implies a lower win rate. Some of
the gap is therefore arithmetic rather than a leak. It is not enough to matter:

| | filled | unfilled |
|---|---|---|
| mean limit price | 47.9¢ | 49.5¢ |
| win rate | 39.3% | 64.9% |
| **return at its own limit, held to settlement** | **−21.1%** | **+27.6%** |

Pricing both arms identically — each at its own limit, taker fee, held to settlement — the gap is
**−48.7pp (t=−3.23) live and −51.1pp (t=−3.77) paper**. The mean limit prices differ by 1.6¢. Selection,
not arithmetic.

### The method does not manufacture it

Permuting fill labels freely across the cohort, 5,000 draws: a gap as extreme as observed arises with
**p = 0.0004 (live)** and **p < 0.0001 (paper)**.

### It is stable over time

| | 08-14 | 08-15 | 08-16 | 08-17 |
|---|---|---|---|---|
| live | −39.7pp | −18.1pp | −27.0pp | −36.2pp |
| paper | −18.4pp | −21.5pp | −23.8pp | −54.1pp |

No drift toward zero across the cohort's life.

### The direction is universal

Negative in **26 of 26** sub-cohorts: 8 of 8 day-tracks, 12 of 12 asset-tracks, 6 of 6 price bands. These
are not 26 independent tests — the same orders appear in each split — but within a single track 6 of 6
assets is p ≈ 1.6%, and the two tracks agree.

## What did not hold: fill versus window

The decisive test permutes fill labels **only within each settlement window**. That holds window quality
fixed, so a surviving gap must come from *which order filled inside a window* rather than from the desk
ordering in worse windows.

| track | within-window p | windows with both filled and unfilled |
|---|---|---|
| live | **0.064** | **21 of 140** |
| paper | 0.002 | 42 of 146 |

**Only 21 live windows can discriminate at all.** The live evidence cannot separate "the fills are bad"
from "the windows are bad"; paper supports genuine fill selection, live is suggestive at best.

And window selection is independently established: contracts the desk was active for and passed over beat
the ones it ordered by **+16.2pp ±16.1 live and +21.3pp ±15.5 paper**.

**So there are two overlapping leaks, not one.** The −25pp headline conflates them. Which of the two
dominates decides the fix entirely — better fills and better window selection are different changes — and
that split is currently unresolved on the track that trades real money.

## Weak spots

- **The effect is concentrated.** On live it is carried by DOGE (−37pp), ETH (−40pp) and HYPE (−39pp),
  while BNB (−2.4pp), SOL (−5.1pp) and BTC (−10.4pp) show almost nothing. Consistent with a real effect
  measured noisily; also consistent with something narrower than it appears.
- **v18 is weak out-of-sample confirmation**: −15.8pp live and −17.2pp paper, both t ≈ −1.0, one day,
  n = 45. Same direction, roughly half the magnitude, not significant.
- Three days of one venue, one strategy.

## What this authorizes

Nothing, and specifically it does not authorize an execution change. The leak is real; its composition is
not established, and a fix aimed at the wrong component would be spending real money on a guess.

The next measurement should **decompose the whole gap** — from the gate's +15.5% on every admitted row
down to the realized −3.2% — into window selection, contract selection, fill selection, price, and exits,
with each step conditional on the last so the parts sum to the whole. A decomposition that fails to sum is
itself informative.
