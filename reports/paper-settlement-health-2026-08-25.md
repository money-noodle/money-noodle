# Paper settlement health review — 2026-08-25

## Decision summary

**Operational settlement was healthy; paper trading economics were not.** In the 24 hours ending
2026-08-25T05:15:00Z, every one of 183 paper edge-strategy attempts was terminal at the deciding read, no current
paper position with a close at or before the boundary was overdue, the whole-cent bankroll tied exactly, and
ordinary binary settlement completed in a median
14.168 seconds. But 48 filled paper positions lost **398.481¢ exact** on 1,250¢ staked, an aggregate **−31.88%**.
The settlement-window-clustered mean was **−30.93% ±15.77pp standard error over 37 independent windows**.

The dominant caveat is execution fidelity, not outcome resolution, but it has two different mechanisms. Among 161
exact contemporaneous paper/live pairs in 67 windows, overall fill/no-fill agreement was 80.1%. Twelve of the 14
paper-only fills occurred when live never accepted a working order—10 post-only acknowledgement races and two
intents later proven absent by reconciliation—so those rows do not diagnose the queue model. Conditional on 125
same-route, same-quantity pairs where live did accept a maker, agreement was 84.8%, paper captured 58.5% of live
fills, and 92.3% of paper fills were also live fills. The paper queue is therefore conservative after acceptance,
while paper's instantaneous hypothetical acceptance misses a separate live create-race cost.

No policy, fill calibration, exit, bankroll, or public display changes are authorized by this one-day review.
The new read-only command `npm run analyze:paper-settlement` makes the same checks repeatable.

## Inputs and method

Generated from execution-ledger v9 at 2026-08-25T05:20:43Z, with 4,620 total ledger rows, 2,329 paper edge rows,
and no historical rewrite. Reproduce the fixed review with:

```bash
npm run analyze:paper-settlement -- 2026-08-25T05:15:00.000Z
npm run verify:execution-ledger
npm run analyze:paper-fill-calibration
npm run analyze:live-opportunities -- 2026-08-25T05:15:00.000Z
```

Method:

- select paper `edge-binary-buy` rows by UTC contract close in `(start, end]`;
- count no-fills as zero-spend execution outcomes, not losses;
- retain any partial-exit accounting children in exact and whole-cent money totals;
- calculate exact reporting P&L from `actualPnlCents` where present and whole-cent control P&L from `pnlCents`;
- average position returns inside each settlement timestamp before calculating uncertainty;
- measure settlement latency only for `won` / `lost` / `invalid` outcomes, because `sold` positions terminate
  economically before contract settlement;
- compare paper/live only through the prospective exact `executionMirrorPair.id`, split by paper execution
  generation; and
- report the current public endpoints separately from local durable calculations.

The biggest biases are that public prints and displayed depth do not reveal private FIFO rank or cancellations,
24 hours contains only 37 filled independent windows, the final ledger cannot reconstruct whether a now-settled
row was still open at an earlier historical checkpoint, and strict exits make `won`/`lost` counts different from
the number of profitable positions.

## Last 24 hours versus the prior 24 hours

| Measure | Last 24h | Prior 24h |
| --- | ---: | ---: |
| UTC interval | 2026-08-24 05:15 → 2026-08-25 05:15 | 2026-08-23 05:15 → 2026-08-24 05:15 |
| Attempts / attempt windows | 183 / 68 | 148 / 66 |
| Fills / fill rate | 48 / 26.2% | 55 / 37.2% |
| Partial fills | 0 | 2 |
| Unfilled | 135 | 93 |
| Rejected / nonterminal | 0 / 0 | 0 / 0 |
| Filled accounting rows / windows | 48 / 37 | 55 / 41 |
| Exact stake | 1,250¢ | 1,433¢ |
| Exact P&L | **−398.481¢** | +20.598¢ |
| Whole-cent control P&L | **−403¢** | +14¢ |
| Aggregate exact ROI | **−31.88%** | +1.44% |
| Clustered mean return | **−30.93% ±15.77pp SE** | −25.76% ±14.65pp SE |
| Won / lost / sold / invalid | 7 / 33 / 8 / 0 | 8 / 34 / 13 / 0 |
| Profitable positions | 15 / 48 | 21 / 55 |

The prior day's positive aggregate cash return and negative clustered mean disagree because a small number of
larger winners outweighed the typical settlement window. The current day is negative under both views. Neither day
alone has enough independent windows to establish a stable expected return.

### Execution funnel

Last-day no-fill reasons were:

- 116 accepted/rested maker zero-fills;
- 17 pre-submit quote-movement refusals; and
- 2 IOC zero-fills.

There were no paper rejections, partial fills, or unresolved attempts. The lower 26.2% paper fill rate is not by
itself good or bad: a fill is valuable only if the filled cohort pays, and this cohort did not.

## Economic decomposition

### Asset concentration

| Asset | Rows / windows | Exact stake | Exact P&L | Aggregate ROI |
| --- | ---: | ---: | ---: | ---: |
| BNB | 14 / 14 | 398¢ | +32.007¢ | +8.04% |
| BTC | 3 / 3 | 79¢ | −23.912¢ | −30.27% |
| DOGE | 8 / 8 | 170¢ | **−135.660¢** | −79.80% |
| ETH | 4 / 4 | 91¢ | −50.032¢ | −54.98% |
| HYPE | 7 / 7 | 174¢ | +8.000¢ | +4.60% |
| SOL | 12 / 12 | 338¢ | **−228.884¢** | −67.72% |

SOL and DOGE supplied 364.544¢, or 91.5%, of the day's exact loss. This is concentration, not proof that either
asset should be excluded: the counts are only 12 and 8 independent windows and any asset-policy change requires a
new prospective cohort.

Both directions were negative: UP lost 174.376¢ on 729¢ and DOWN lost 224.105¢ on 521¢. Maker fills lost
377.569¢ on 1,174¢; four taker fills lost 20.912¢ on 76¢. All 48 rows carried the current
`paper-managed-execution-route-ioc-requalify3-calibrated-v6` paper generation and exact
`kalshi:kalshi-15m-maker-v1` provider variant.

### Exits did not cause the loss

Eight sold positions had complete hold counterfactuals. Their realized result was **53.519¢ better than hold** in
aggregate. Holding those positions instead would therefore have made the day's total worse, approximately
−452.000¢ rather than −398.481¢. This is a one-day result and does not settle the broader strict-exit review, but it
rejects exits as the immediate explanation for this day's paper loss.

### Upstream signal and paper execution disagreed

The separately rerun current-policy signal review through the same 05:15Z close found 447 first-to-fire ask-priced
positions over 89 windows returning **+30.69% ±7.37pp SE**. That is an optimistic ask benchmark over a broader
signal cohort, not the same population as the 48 paper fills. The opposite signs nevertheless locate the current
problem after basic signal admission: candidate selection, simulated fill selection, and lifecycle outcomes need to
be kept separate rather than smoothing the ask benchmark into paper P&L.

## Paper/live execution fidelity

The last-day exact prospective pairing contained 161 one-to-one terminal pairs over 67 settlement windows, all
under paper generation v6:

| End-to-end pair cell | Pairs | Paper exact P&L | Live exact P&L |
| --- | ---: | ---: | ---: |
| Both filled | 27 | −94.565¢ | −149.3989¢ |
| Paper only filled | 14 | **−304.032¢** | 0¢ |
| Live only filled | 18 | 0¢ | **+93.6802¢** |
| Neither filled | 102 | 0¢ | 0¢ |

End-to-end agreement was 80.1%, paper capture of live fills 60.0%, and paper-positive precision 65.9%. Those are
valid whole-path mirror measures, but they are not queue-model measures because live did not accept every intent.

### Acceptance mismatch

Of the 14 paper-only fills:

- only **2** had an accepted live maker; they lost 56¢ paper;
- **10** met a live post-only acknowledgement race;
- **2** were later proven by reconciliation to have no accepted venue order; and
- one of the unaccepted rows also had a maker/taker route mismatch.

The 12 rows for which live never accepted an order lost 248.032¢ paper. Paper currently takes its first exact quote
as immediate hypothetical acceptance, while live's later signed create can race the moving book. That acceptance
latency—not a permissive paper queue—explains most of the paper-only loss.

### Queue fidelity conditional on acceptance

Restricting to the 125 pairs over 61 windows with the same maker route, same requested quantity, and an accepted
live order gives the actual queue-model comparison:

| Accepted-maker pair cell | Pairs |
| --- | ---: |
| Both filled | 24 |
| Paper only filled | 2 |
| Live only filled | 17 |
| Neither filled | 82 |

- fill/no-fill agreement: **84.8%**;
- paper capture of live fills: **58.5%**; and
- paper-positive precision: **92.3%**.

The queue model is conservative: it rarely invents a fill after comparable acceptance, but it misses many real
fills. The 17 accepted-maker live-only rows made 47.7997¢ live in aggregate in this day; their mixed outcomes do not
authorize blindly increasing paper fills.

Twenty-two last-day paper pair identities did not have exactly one row in both lanes and were excluded from the
paired denominator. This is expected when live does not issue or a lane is unavailable; it is why the paired view
must remain separate from the complete paper intent-to-treat result.

The corrected broader `analyze:paper-fill-calibration` review now conditions on accepted, same-route,
same-quantity makers. Its held-out half contained 94 independent windows with 46 both-filled, 6 paper-only, 22
live-only, and 123 neither-filled pairs: 85.8% agreement, 67.6% live-fill capture, and 88.5% paper-positive
precision. Exact FIFO and cancellation state remain unavailable, and no acceptance-delay or queue-clear parameter
is promotable from this inspected evidence.

## Settlement and bankroll integrity

Operational checks passed at the deciding snapshot:

- zero currently overdue paper entries whose close was at or before the 05:15Z boundary;
- zero open, pending-reservation, or uncertain paper entries;
- 40 ordinary binary settlements with 14.168-second median and 35.117-second p95 latency;
- one BNB settlement delayed 364.977 seconds; no other settlement exceeded 60 seconds;
- zero invalid outcomes and zero negative settlement latencies;
- execution-ledger v9 verification passed over all 4,620 rows; and
- paper bankroll was 10,000¢ starting, −3,258¢ whole-cent realized, 0¢ open, and 6,742¢ available, with an exact
  **0¢ budget residual** and no resets.

The one six-minute settlement is an availability outlier worth retaining in the rolling monitor. It left no overdue
or money contradiction.

## Is two-second polling enough?

For the last-day 160 paper maker attempts, the durable path contained 787 successful public trade-read observations.
Every one of the 116 maker zero-fills had all six expected reads. Public read latency was 80ms median / 177ms p95 /
987ms maximum. For the 95 reads that discovered a consuming print, wall time from the newest print's venue timestamp
to the observation was 1.221 seconds median / 2.072 seconds p95 / 3.314 seconds maximum. This lag combines the
intentional two-second cadence, network/read time, and any venue publication delay; it is not a direct measurement
of publication delay alone.

The ordinary manager completed in 12.534 seconds median / 12.928 seconds p95. One attempt took 56.374 seconds. The
complete six-read coverage on every classified miss means the main problem is not widespread missing polls.

**Do not poll the whole horizon faster yet.** Live itself changes or checks the managed order every two seconds, so
two-second quote/depth sampling matches the action clock. One-second polling would roughly double public request
load without revealing private cancellations or FIFO rank, the principal accepted-order blind spot.

A cheaper prospective candidate is a bounded **read-after-horizon grace**:

1. end the simulated order at the same 12-second horizon;
2. wait approximately three seconds for one final public trade-history read;
3. admit only venue prints whose `created_time` is at or before the original 12-second cutoff; and
4. replay each late print against the paper limit that was actually in force at its event time, never the final
   limit merely because the API exposed it later.

This would improve observation completeness without granting the paper order extra execution time. Current summary
rows cannot prove how many unseen in-horizon prints would be recovered, so the grace must begin as a prospective
candidate rather than rewriting prior misses.

Sub-second evidence is needed only for the separate create/acknowledgement race: the observed paper submission
preceded live's create quote by roughly 0.4 seconds and live acceptance/rejection followed roughly 0.2 seconds later.
Waiting longer for the final binary **contract outcome** is not indicated; outcome settlement was already complete
and timely. The useful wait is after the 12-second maker horizon to catch late-published, in-horizon execution
evidence.

## Public-site check

At approximately 2026-08-25T05:16Z:

- `/api/paper-performance/summary` returned HTTP 200 in 0.119 seconds, with a projection generated at 05:15:15Z;
- `/api/paper-performance` returned HTTP 200 in 0.308 seconds, 310,895 bytes, with a projection generated at
  05:09:01Z; and
- `/api/paper-budget` returned HTTP 200 in 0.116 seconds with 6,742¢ available and no open position.

The public lifetime edge-paper record showed 1,265 settled accounting rows over 713 windows, −3,800.552¢ exact P&L,
and −6.23% return on cumulative stake. The budget showed −3,258¢ whole-cent realized P&L. Those are deliberately
different views: exact trade reporting versus adversely rounded whole-cent bankroll control plus durable historical
corrections. The 0¢ bankroll residual shows no control-ledger drift.

The public forecast summary simultaneously showed 64.97% lifetime directional accuracy. Accuracy is not trading
profit, and the public surface should continue to make the distinction between forecast settlement, paper fill,
exact P&L, and whole-cent bankroll unmistakable.

## Continual evaluation

Run `npm run analyze:paper-settlement` at fixed UTC checkpoints and retain reports without rewriting prior findings.
Each review should publish:

1. exact and whole-cent P&L, aggregate ROI, and window-clustered return;
2. attempts → accepted/refused → zero/partial/full fill → sold/won/lost/invalid;
3. overdue positions, settlement latency, invalid outcomes, and bankroll residual;
4. end-to-end pair cells plus the accepted/same-route/same-quantity maker subset, with acceptance-race attribution,
   P&L, agreement, capture, and precision;
5. asset, direction, route, provider variant, and execution-generation splits;
6. exit-versus-hold disagreement; and
7. public projection status, age, size, and response time.

Correctness alarms should be fail-closed: any unexplained overdue position, nonzero bankroll residual, impossible
status, unresolved reservation, provider-contract mismatch, or stale/unavailable public projection requires
investigation. Negative return is a measured economic result, not an operational fault and not automatic authority
to change policy.

## What this evidence authorizes

- Continue to describe paper settlement mechanics and public projection as operationally healthy at this dated
  read.
- Do **not** describe last-day paper trading performance as going well; it lost 398.481¢ exact over 37 independent
  filled windows.
- Split improvement work into two prospective mechanisms before changing paper: model live create/acknowledgement
  races so paper does not assume instant acceptance, then calibrate the conservative queue only on accepted,
  same-route, same-quantity makers. Keep public metric clarity ahead of entry tightening.
- Make no production, paper calibration, asset, exit, or bankroll change from this inspected cohort.
