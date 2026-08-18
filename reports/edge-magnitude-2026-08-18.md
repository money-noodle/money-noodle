# High edge is the best band, not the worst — and three reversals in an hour

**No policy change is authorized by this**, and the strongest thing in it is not a number: the diagnosis of
why the edge policy loses moved three times in one session, each time because a control was added that
should have been there first. That instability is the finding (AGENTS §6), and it is why nothing here is
ready to act on.

Reproduce with `npm run analyze:loss-decomposition` and `npm run analyze:entry-realization`.

## The reversal that matters

Ranking placed orders by `netEdge` shows the top quintile winning **28.1% ±4.9** against 60.4% ±5.2 for the
bottom — t = 4.5, and a clean mechanism was available: the desk ranks by expected profit, expected profit
scales with edge, so it preferentially buys its own worst predictions. That reads as a model calibration
failure at the tail.

**It is wrong.** Measured on the *admitted* population — every qualifying decision, deduplicated to one per
`(symbol, window, side)`, unbiased by what the desk chose to order or managed to fill:

| netEdge band | n | win rate | return per $1 |
|---|---|---|---|
| 5–10pp | 1,281 | 62.7% ±1.5 | +11.6% ±2.8 |
| 10–15pp | 585 | 56.6% ±2.2 | +11.6% ±4.5 |
| 15–20pp | 322 | 55.9% ±3.0 | +20.4% ±6.6 |
| 20–25pp | 196 | 54.9% ±3.7 | +32.2% ±9.4 |
| **25–35pp** | **183** | **51.9% ±3.8** | **+44.0% ±11.5** |

The win rate does fall with edge — and the **return per dollar rises steeply**, because a high edge means a
low price and a lower win rate still pays more. The highest band is the most profitable one, positive on
**8 of 9 days**.

The first measurement was taken on the desk's *filled* orders, which are selected by exactly the execution
process under investigation. **Win rate is the wrong statistic** for comparing across price levels, and
using it invited a confident conclusion in the opposite direction of the truth.

## What the interaction says

Fill selection is not uniform across the gate. It widens with edge, and high-edge orders fill *more* often:

| netEdge band | fill-selection gap | t | fill rate |
|---|---|---|---|
| 5–10pp | −6.4pp | −0.88 | 55% |
| 10–15pp | −11.9pp | −1.47 | 49% |
| 15–20pp | −19.2pp | −1.74 | 55% |
| 20–25pp | −16.9pp | −1.47 | 65% |
| 25–40pp | −17.3pp | −1.51 | 63% |

So the coherent story is: **the rows worth the most are the ones execution damages most.** Not one of those
cells is individually significant; the monotone shape carries whatever weight this has.

## The three reversals, recorded deliberately

| claim, as stated earlier the same day | after the control was added |
|---|---|
| Fill selection costs −25pp | Conditional on contract selection, **−19pp**; the standalone figure double-counts by ~2× |
| Window selection costs ~16pp | **−0.1pp.** It was contract selection wearing its clothes |
| The model is miscalibrated at high edge | High edge is the **most profitable band**, +44% per $1 |

Each correction came from a control that should have been applied first — conditioning, deduplication to
one row per decision, and measuring the unbiased population rather than the filled one. Each intermediate
version produced a plausible number, a clean mechanism, and a confident recommendation.

**The surviving effects sit at t = 1.5–1.7.** Three days of one venue is not enough to referee between
specifications that disagree this much, and picking whichever survives the most controls is itself a
selection procedure.

## What this authorizes

Nothing, and specifically **not** an execution or gate change. Two things follow:

- **Do not lower the max-edge ceiling.** The natural reading of the first measurement was that 20–35pp
  edges should be excluded. The unbiased population says that band earns +32% and +44% per $1 and would be
  the most expensive thing to cut.
- **The blocker is refereeing, not measurement.** Every question today ended at "needs prospective
  evidence," and the walk-forward evaluator cannot supply it: `WalkForwardParameters` carries no
  maximum-edge or selected-side-floor dimension, so its baseline is not the production gate, and
  `selectedTrade` scores buy-at-the-ask-and-hold — a counterfactual this work has now measured to be
  biased. That gap is already recorded in `STATUS.md` as a prerequisite to promotion; it is now the
  binding constraint on every open question about this policy.

## Caveats

- Admitted rows are the first qualifying calculation per decision; the desk decides at a different instant,
  so the two populations are not sampled at the same moment.
- The 25–35pp band is 183 decisions over 156 windows. Its ±11.5 interval is wide.
- Return per $1 held to settlement ignores the exits, which the decomposition shows are worth +14.6pp.
- Three days of one venue's `crypto-15m` market, one strategy.
