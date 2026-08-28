# Early cancel-and-take cutover review — 2026-08-28

## Question and decision

Would cancelling an unfilled managed maker at the first management poll (~2 seconds) and placing a taker IOC at the
then-current ask plus two venue ticks have returned more than the live rule?

It would not. Across every cut of the v9 live cohort the candidate returned less than the live rule, and none of the
differences is statistically distinguishable from zero once returns are clustered on the settlement window. The
load-bearing result is not the P&L: it is the break-even arithmetic, which does not depend on the sample size.
**Taking the offer on these rows needs a 63.3% hit rate to return zero, while the model's own median forecast on the
same rows is 59.6%.** The candidate is short of break-even before any model error.

This evidence authorizes no change to admission thresholds, sizing, capital, exits, the maker horizon, or the
maker-miss fallback lifecycle. It is retroactive screening and can promote nothing
([`AGENTS.md`](../AGENTS.md) §5.5).

## Fixed interval and inputs

- Interval: `2026-08-27T17:04:50Z` through `2026-08-28T01:48:47Z`, the v9 execution generation
  (`maker-then-positive-edge-taker2-terminal-refusal-v9`).
- Durable inputs: `data/paper-orders.json` (live attempt-1 entry rows and their
  `entryExecutionObservations`), `data/forecast-history-shards/*` and `data/forecast-history.journal.jsonl`
  (settlement outcomes and the post-entry observation series).
- Settlement: the Kalshi venue outcome matched by contract id, never the cross-venue top-level field. Sealed shards
  carry settled history; the live journal carries later resolutions as `patch` ops in `changes`.
- Script: `npm run analyze:early-taker` (`scripts/analyze-early-taker-cutover.ts`). Sizing, fees and rounding call
  the production `estimatePaperFill` and `venueFeeCents`, so the arithmetic matches the desk.
- Recalculated in session on 2026-08-28. No file under `data/` was written.

## Method

At the first management observation at or after 2 seconds, a maker that has not filled is cancelled and a taker IOC
is placed at `min(0.75, ask + 2 ticks)`, sized and reserved at that worst submittable price and assumed to fill in
full at the observed ask. Two cohorts are reported, because at 2 seconds the desk cannot know which makers would
still have filled:

- **Cohort A** — only the makers that actually missed. This is the question as usually asked, and it is optimistic:
  it uses knowledge unavailable at the cutover.
- **Cohort B** — every maker still resting at 2 seconds. This forfeits the 16 maker fills the rule would have
  cancelled, and is the honest comparison ([`AGENTS.md`](../AGENTS.md) §5.2).

Returns are clustered on `closesAt` via `clusterByWindow`, because rows closing in one window share a single market
move. Both a held-to-settlement view and a view with the production `evaluateExitPolicy` replayed are reported, so
the comparison against the live rule is like-for-like ([`AGENTS.md`](../AGENTS.md) §5.4).

## Results

Whole-cent budget P&L. Nine rows had no venue quote at the cutover and are excluded; all remaining rows settled.

| Cut | Orders | Windows | Hit rate | Staked | P&L | Return | Per-window mean | t |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A, held to settlement | 39 | 24 | 56% | 1158¢ | −163¢ | −14.1% | −2.28¢ (SE 4.37) | −0.52 |
| B, held to settlement | 55 | 27 | 55% | 1624¢ | −205¢ | −12.6% | −2.01¢ (SE 3.89) | −0.52 |
| — of which, maker fills taken instead | 16 | 14 | 50% | 466¢ | −42¢ | −9.0% | −3.04¢ (SE 6.68) | −0.45 |
| A, with exits replayed | 39 | 24 | 56% | 1158¢ | −181¢ | −15.6% | −3.26¢ (SE 3.46) | −0.94 |
| B, with exits replayed | 55 | 27 | 55% | 1624¢ | −111¢ | −6.8% | −0.64¢ (SE 3.21) | −0.20 |
| **The live rule, same interval** | 25 | 22 | — | 658¢ | **−28¢** | **−4.3%** | −1.16¢ (SE 4.71) | — |

The exits fired on 23 of 39 rows in cohort A and 34 of 55 in cohort B. They improve cohort B substantially
(−12.6% to −6.8%) and make cohort A slightly worse (−14.1% to −15.6%), because in the miss-only cohort they cut
some winners short. The live rule outperforms every cut.

## The result that does not depend on sample size

| Break-even hit rate required to return zero | |
| --- | --- |
| Taking the offer at the 2-second ask | **63.3%** |
| Making at the maker's own resting limit | **50.5%** |
| The model's own median forecast on these rows | 59.6% |
| Realised on the cohort | 56.4% |

Crossing the spread and paying the taker fee moves break-even by 12.8 points. The same signal clears the maker
break-even by roughly 6 points and misses the taker break-even by 3.7 points on the model's own forecast, and by
6.9 points on realised outcomes. This is arithmetic on the observed prices, not an estimate, and more data will not
move it. It is the reason the P&L comes out negative on every cut.

## Caveats, worst first

- **The exit replay under-triggers.** The forecast-history observation series runs at roughly 30–60 seconds while
  production evaluates exits on every collector cycle (~17 seconds). The replayed exits are a lower bound on exit
  activity, so the with-exits rows flatter the held-to-settlement comparison less than production would.
- **Nothing here is statistically significant.** Every t statistic falls between −0.94 and −0.20 across 24–27
  windows. The consistent negative sign across four independent cuts is suggestive; it is not evidence.
- **One 8.7-hour interval, one strategy, one venue**, and the fill is assumed complete at the observed ask. Recorded
  best-ask depth was present on only some observations.
- **The candidate was not scored against a double-fill cost.** The rule as proposed submits the taker while the
  cancel is in flight; the measured cancel round-trip is a median 510 ms, and any maker fill inside that window
  produces twice the sized ticket. This review scores the rule as if that race never resolves against the desk.

## What this authorizes

Nothing changes. The maker-miss fallback lifecycle, the 12-second managed-maker horizon, the taker quality and
spread gates, and the `1.25 × M` ceiling all stand as they are. A concurrent cancel-and-take design would also
contradict the confirmed-cancellation requirement in
[`maker-miss-two-taker-fallback-design.md`](../docs/maker-miss-two-taker-fallback-design.md) §1 and the fail-closed
rule in [`AGENTS.md`](../AGENTS.md) §4, and would require prose agreement, a design, and a decision record before
any implementation.

What would change the answer: a cohort where the model's forecast on maker-miss rows clears the taker break-even
with margin, measured prospectively with sentinels written at decision time and followed to settlement.
