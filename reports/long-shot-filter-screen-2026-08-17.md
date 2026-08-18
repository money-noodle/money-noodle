# Long-shot candidate filters, 2026-08-17 — thirty screened, none usable; a mostly null result

**No policy change is made or authorized by this.** It asks whether any entry-time signal separates the
long-shot candidates worth taking from the ones that are known-bad, so that a filter could raise the
sold-at-mark rate without simply taking fewer bets at random.

The answer is no, in a specific and useful way: the one signal that does separate them **selects almost
nothing inside the price band this policy trades**. Several proposals worth closing off permanently are
recorded below, because the cost of a null result not being written down is that it gets re-proposed.

Reproduce with `npm run analyze:long-shot-filters`.

## Method and cohort

Every `(contract, side)` in `data/contract-paths.*` reaching a price band with at least
`minimumSecondsRemaining` on the clock, production position limits applied, exit held fixed at the
production 90¢ mark so that only the entry filter varies. **1,499 windows, 2026-08-15 through 2026-08-17.**

**No lookahead.** Every feature is computed from information available strictly *before* the entry sample:
prior path points, and the most recent forecast issued at or before the entry instant, never after. Nothing
reads the entry sample's successor, the peak, or the settlement. One filter is marked `*` because it needs
the next sample — that makes it a delayed-entry rule which changes the fill, not a filter applied at the
tick.

Three corrections shape the design:

1. **Power.** Filters are estimated on the wide cohort (entry ≤30¢, n=429) because 49 production-band
   candidates cannot estimate thirty filters, then re-checked at ≤10¢. A filter that works only in the band
   it was chosen on is a fit, not a finding.
2. **Multiple comparisons.** Thirty filters produce a best cell whatever the data says (AGENTS §5.3), so
   filters are run in **groups** expressing one idea each. A group moving together is the readable signal;
   a single cell clearing a bar is not.
3. **Clustering.** Returns are averaged within a settlement window before averaging across windows, with
   standard errors over windows.

A method bug is worth recording: `cycleRegime` is an object on a forecast entry and the label is `.regime`.
Reading it as a string yields zero rows in every regime bucket, silently — which is what the first pass of
this analysis did.

## Clean nulls

Each of these is a proposal that sounds reasonable and is not supported. Wide cohort, n=429, baseline ratio
0.55, baseline return −0.216.

| proposal | result | verdict |
|---|---|---|
| **Use the forecast model as a veto** | prices the side at or above the ask on **91%** of wide candidates and **100%** of production-band candidates | There is no disagreement to trade on. The model and the book agree that cheap sides are cheap. |
| **Filter on spread / book quality** | 98% of candidates sit inside 4¢; `spread ≤ 2¢` lift 1.02 | Nothing to filter. |
| **Exclude bad assets (§13)** | SOL 0.83 → BNB 0.40 looks like separation, but against the **cohort mean** no asset exceeds 1.6 SE (HYPE −1.56, SOL +1.39, BNB −1.19, rest under 0.6) | Noise across seven assets. §13 should stay empty. |
| **The stall filter** | `not still falling` lift **1.04** here (0.55 → 0.57) | Far weaker than the 0.9%-vs-2.6% reading §7 records. Reported as a disagreement rather than smoothed. |
| **Enter earlier in the window** | `≥12 min left` raises the touch rate (20.8% vs 11.0%) but the return **falls** to −0.256 from −0.216 | The touch rate and the return move in opposite directions; more clock is not more money. |

Testing the model as a veto was the single most promising idea going in, and it is the most decisively dead:
the entry rule ignoring the forecast (design §2) costs nothing, because the forecast has nothing to add at
these prices.

## The one signal, read three ways

The movement filters move together, which is what §5.3 asks for:

| filter | keeps | ratio | lift | return/$1 |
|---|---|---|---|---|
| fell <10¢ from window high | 6% | 0.87 | **1.60** | +0.369 ± 0.314 |
| local vol <0.1% | 46% | 0.64 | 1.17 | −0.043 ± 0.141 |
| vol ratio <1 | 50% | 0.64 | 1.17 | −0.184 ± 0.109 |
| *(contrast)* local vol ≥0.1% | 40% | 0.43 | 0.79 | −0.411 ± 0.108 |
| *(contrast)* vol ratio ≥1 | 7% | 0.41 | 0.76 | −0.548 ± 0.215 |

All five say the same thing: **the side that got cheap without a big move is the better bet.** High realized
volatility means the price has already travelled, so the cheap side is cheap for a real reason and sits far
from its strike; in a quiet window a side is cheap on a small move that is easier to reverse.

This is the opposite of the intuition it was tested on — a long shot needs a large move, so high volatility
"should" help. It does not, and the direction is consistent across three separately-derived measures.

These are **not three independent tests**. 12 of the 27 candidates kept by the fall filter are also kept by
the low-volatility filter. They are three readings of one idea, which is why the group is reported rather
than the best member.

## Why it cannot be used

**In the production ≤10¢ band, the fall filter keeps 1 of 49 candidates.** Sides reach 10¢ *by* collapsing —
which restates §7's finding that a contract becomes cheap because the underlying already moved. Every filter
that looks good on the wide cohort is near-empty in the band the policy actually trades: `≥12 min left`
keeps 9, `local vol <0.1%` keeps 11, `fell <10¢ from high` keeps 1.

The confound check makes this sharper rather than rescuing it. "Fell less than 10¢ from the window high" can
mean "was always cheap" or merely "entered early with too few prior samples to have fallen from anything" —
the kept cohort averages 2.9 prior samples against 7.3 for the rest. Splitting on that:

- The subset with more than two prior samples, where "did not fall" is a real observation, is **stronger**:
  n=16, touch 43.8%, ratio 1.27, return **+0.834 ± 0.391** over 13 windows.
- Its **mean entry ask is 28.8¢**.

That is not a filter on the long-shot policy. It is a description of a different strategy — buy a
near-coin-flip side that has sat flat through a quiet window — and at n=16, reached by taking the best of
roughly thirty filters and then splitting it, it is not a finding. It is at most a hypothesis with a
plausible mechanism attached.

## What this authorizes

Nothing, per AGENTS §5.5. Concretely:

- **No filter should be added to the entry rule.** Nothing screens bad candidates out of the current rule
  without screening out nearly all candidates.
- **The model-veto, spread, and asset-exclusion proposals are closed**, and should not be re-proposed
  without new evidence.
- **§7's stall-filter figure should be read alongside this one.** Both are in the repo; the disagreement is
  the honest state of it.
- **The quiet-market signal is worth collecting against, not trading on.** A sentinel arm costs nothing and
  the design already has the machinery (`lib/hold-sentinel.ts`); a rule change on n=16 would not.

## Caveats, worst first

- **Thirty filters, one outcome, three days of data.** Every number here should be read as the best of many,
  and the report deliberately leads with the nulls for that reason.
- **The interesting subset is n=16 over 13 windows**, found by splitting the best of thirty cells.
- **Touch rates are floors** at fifteen-second sampling. Cohorts are compared like-for-like so the floor
  largely cancels in `lift`, but every absolute `ratio` here is understated; see
  [long-shot-gap-sweep-2026-08-17.md](/Users/raiphairow/code/money/reports/long-shot-gap-sweep-2026-08-17.md)
  for the measured correction.
- **Filters are estimated at ≤30¢ and applied at ≤10¢**, which assumes transferability the data does not
  demonstrate — and in the one case it can be checked, the filter does *not* transfer.
- 62 hours of one venue's `crypto-15m` market. No regime variety.

## What would change the answer

A cohort where cheap sides arrive by more than one route. Today they arrive by collapse almost exclusively,
so "how it got cheap" has no variance to exploit inside the band. If the quiet-market hypothesis is worth
testing, the way to test it is a committed sentinel arm at a higher entry band — written at decision time,
followed to settlement — not a filter bolted onto a policy whose candidates it does not select.
