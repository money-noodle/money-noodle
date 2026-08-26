# Where the edge policy's money goes, 2026-08-18 — the fill-selection headline was double-counted

> **Correction, 2026-08-19:** stage 3 is an **ordered-cohort selection** gap, not a decision-time ranking
> comparison. The corrected state replay applies persistence, regime, cooldown/retry, active exposure,
> production sizing, and historical caps; chosen minus replay-preferred is **−0.9pp ±2.7pp (95%) over 232
> v17-v19 windows**, with the same choice in 331 of 339 positive-control snapshots. Findings 2 and the
> "two leaks" conclusion below are superseded as ranking claims; the stage values remain the historical
> admitted-to-ordered decomposition. See `reports/edge-buy-opportunities-2026-08-19.md` §8.

**No policy change is authorized by this.** It decomposes the gap between what the gate is worth and what
the desk realizes into one conditional chain, so each decision's cost is measured with the others held
fixed and the parts sum to the whole.

The result changes the diagnosis. **Window selection costs nothing. The fill-selection figure carried since
the v17 review is roughly twice its true conditional size. And the exit rule — not the entry gate — is the
desk's strongest component.**

Reproduce with `npm run analyze:loss-decomposition`.

## Why a chain

The standalone estimates do not compose. Window selection read ~16pp, fill selection ~25pp, the maker
discount ~16pp — each against a different baseline, so an order sitting in a bad window *and* filling badly
was counted in both. Conditioning each stage on the previous makes every delta the marginal cost of that
decision alone.

Admitted rows are deduplicated to one per `(symbol, window, side)`. The forecast history records a row per
calculation, several hundred a window; an order is one decision. Without that, the early stages weight by
how long a contract stayed qualified rather than by opportunity, and are not comparable to the order stages.
The first version of this file made exactly that error — 231 "rows" at stage 4 against 21 orders at stage 5.

## v17

| stage | live | Δ | paper | Δ |
|---|---|---|---|---|
| 1 every admitted row, at ask, held | +14.4% | | +14.4% | |
| 2 in windows the desk was active for | +14.3% | **−0.1%** | +14.3% | **−0.2%** |
| 3 contracts it actually ordered | −1.4% | **−15.7%** | +2.5% | **−11.8%** |
| 4 the ones that filled | −20.8% | **−19.4%** | −25.0% | **−27.4%** |
| 5 repriced at the maker fill | −17.5% | **+3.4%** | −23.5% | **+1.5%** |
| 6 with the exits it took = **realized** | −2.9% | **+14.6%** | −5.7% | **+17.8%** |

Gate to realized: **+14.4% → −2.9% (live), −5.7% (paper)**. The deltas sum to the gap exactly.

## What this establishes

**1. Window selection costs nothing.** −0.1pp live, −0.2pp paper. The desk is *not* active in worse
windows. The earlier "+16.2pp for passed-over contracts" was never window selection — it was contract
selection wearing its clothes.

**2. Contract selection is a real leak: −15.7pp live, −11.8pp paper.** Which contract the desk picks
*within* a window it is already trading is costly, and this has not previously been separated out.

**3. Fill selection is real but half its reputation.** Conditional on contract selection it costs −19.4pp
live and −27.4pp paper, against standalone figures of −44.5pp and −56.9pp. **The standalone number
double-counts contract selection by roughly a factor of two.** Every previous reading of this policy has
used the inflated version.

**4. The maker discount helps**: +3.4pp live, +1.5pp paper — confirming
[take-the-ask-2026-08-18.md](take-the-ask-2026-08-18.md) from a second
direction. Switching to taking would forfeit it.

**5. The exit rule is the desk's best component: +14.6pp live, +17.8pp paper.** Holding to settlement is
substantially worse than what the standalone exits actually do. That inverts the working assumption that
execution is uniformly the problem — one part of execution is carrying the rest.

## Where the loss actually comes from

Two leaks of comparable size, both inside a window the desk was right to be trading:

```
live      contract selection  −15.7pp
          fill selection      −19.4pp
          offset by exits     +14.6pp  and the maker discount +3.4pp
                              ────────
          net                 −17.3pp
```

A fix aimed only at fills addresses at most half of it.

## Caveats, worst first

- **Stage 4 rests on fewer windows than stage 3** (86 against 140 live): only windows containing a fill can
  contribute. The fill delta and the contract delta are therefore measured on overlapping but different
  window sets, which conditioning cannot fully repair.
- **Stage 6 is the only stage containing exits.** Its delta carries every difference between holding and
  what the desk did, including switches, so "the exit rule" is really "everything the desk does after
  entry".
- Stages 1–3 are forecast rows, 4–6 are orders, matched on `(symbol, window, side)`. A decision made
  outside an admitted row is invisible.
- v18's cohort is one day and too small to confirm or refute any of this.
- Three days, one venue, one strategy.
