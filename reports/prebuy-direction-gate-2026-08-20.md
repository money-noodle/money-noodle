# Pre-buy short-term direction gate: would it have kept our winners and skipped our losers? — 2026-08-20

> **Observation-only read.** Uses the `entry-direction-observation-v1` sentinel that the running desk already
> records on every live order (issuance ask → exact pre-submit ask movement, in cents, plus
> `candidateDecision`). The gate is **not** enforced; this is exactly the counterfactual the sentinel was
> built to answer. No policy change is authorized by this. Sample: 29 filled live edge orders, last 18 h.

## The question

"If we consulted short-term direction just before the buy and only bought when it was up — would we have kept
the winners we actually bought and avoided the losers?"

## What the sentinel records, in this window

For each filled order, `entryDirectionObservation.preSubmit` gives the selected-side ask movement from
issuance to the exact pre-submit quote (seconds before placement), classified `favorable` (up), `stable`, or
`adverse` (down), plus the `candidateDecision` a gate would have taken.

## The answer, in two tables

**Winners we actually bought (won + sold-hold-win):** 14, of which the pre-submit reading was
**6 favorable, 3 stable, 5 adverse**.

**Losers we actually bought:** 15 (16 minus one with no reading), of which **10 adverse, 4 favorable, 1 stable**.

### Counterfactual A — skip `adverse` (keep favorable + stable)

| | Winners | Losers | PnL effect |
| --- | --- | --- | --- |
| **Kept** | 9 | 5 | +259¢ winners, −139¢ losers |
| **Skipped** | **5 foregone** | **10 avoided** | −183¢ foregone, +215¢ saved |

**Net: +32¢ over the window** (using hold-value for the dropped winners; +47¢ using realized exit value).

### Counterfactual B — buy only `favorable`

Would have kept 6 winners / 4 losers and skipped 8 winners / 11 losers. Strictly worse than A: it throws
away the stable winners (including the +43¢ and +32¢ wins) to avoid only one more loser.

## What that +32¢ is made of

The gate avoided the **crash cohort** — every big adverse move was a loser:

```
−32c  LOSE  BNB UP   −30c  LOSE  ETH UP   −18c  LOSE  DOGE DOWN   −12c  LOSE  DOGE UP
```

But it also dropped **the day's best maker-discount captures**, every one of which won *through* the
adverse move — the dip to our resting bid was the fill:

```
−9c  WIN  ETH  UP  sold  +32 (hold +32)      −6c  WIN  BTC  UP  sold  +37 (hold +37)
−5c  WIN  BNB  DOWN sold +27 (hold +41)      −4c  WIN  DOGE UP  sold  +36 (hold +36)
−2c  WIN  BNB  UP  won   +37
```

## Why this happens — the structural point

For a **maker** entry, "adverse short-term move just before the buy" is **ambiguous by construction**:

- It can be the start of a crash (the losers: −12 to −32¢ and a failed contract), **or**
- It can be the market dipping to your resting bid — which is the *only way a maker order fills*, and
  precisely the mechanism that earned the discount (the winners: −2 to −9¢, filled and held UP).

A 2-second reading cannot tell them apart: BNB UP won at −2¢ adverse, HYPE UP lost at −2¢ adverse. The
discriminating feature is not the sign of the short-term move — it's the *magnitude* (crash cohort is −12 to
−32¢, winners −2 to −9¢) — and even that is not clean (−6¢ was both a +37¢ winner and a −27¢ loser).

## So: would it have helped?

- **It would have avoided most of the big losers** (10 of 15), worth +215¢ of avoided loss.
- **But it would have dropped 5 real winners**, including the single biggest hold-winner of the day
  (BNB DOWN, +41¢ hold) and three other +32 to +37¢ wins — worth −183¢ foregone.
- **Net ≈ +32¢ on a 73¢ actual book over 18 h** — inside the noise of 29 orders, and *paid for* by
  abandoning exactly the maker-discount fills the strategy exists to capture.

That net is not zero, and the loser cohort is real, so this is a *plausible* candidate to keep
measuring — but on today's data it does **not** cleanly "keep the winners and skip the bad ones." It keeps
9/14 winners and skips 10/15 losers, and the winners it drops are the discount captures.

## What would actually settle it

- **The same sentinel, forward, with the magnitude threshold predeclared** (e.g. skip only moves
  < −10¢, which keeps all five dropped winners and still avoids the four big crashes). That variant needs
  precommitment before any promotion — SPEC §12.5.
- The existing quote-trajectory collection (`trailing-60s`, `cycle-to-date`) answers the longer-horizon
  version of this question; the 2-second pre-submit reading is the wrong instrument for a maker fill.

Full inputs: `data/paper-orders.json`, `src/lib/entry-direction-observation.ts`.