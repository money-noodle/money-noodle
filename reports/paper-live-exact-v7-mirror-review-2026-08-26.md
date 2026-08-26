# Exact live-v7 / paper-v6 mirror review — 2026-08-26

## Decision

The current exact mirror cohort is large enough for the planned diagnostic review, but it does **not** authorize a paper-model change. This diagnostic had no precommitted promotion threshold; reaching this count permits description only.

Paper remains a conservative public-data simulation, not a point estimate of funded fills. On the mechanically comparable subset—122 exact pairs where live had an accepted maker, both lanes chose maker, and requested quantity matched—paper reproduced only **24 of 66 live fills (36.36%)**. Fill/no-fill agreement was **63.11%**, and paper filled three positions live did not. Averaged inside settlement windows, paper minus live fill rate was **−35.93pp ±5.72pp SE** over 77 windows.

Continue the precommitted F2 timing cohort and do not activate F3, adopt a queue-clear fraction, alter live execution, or tune paper from these known outcomes. F2 remains only 53/100 independent windows and 1 observed create race against its later 30-race phase-exit requirement.

This review is a **diagnostic fidelity finding**, not an economic selector or promotion. Different fill populations have different investments and returns; their P&L must not be compared as though one route had deployed the other's capital.

## Question

When paper and live start from the same exact strategy/provider/contract/side/close/calculation/episode identity:

1. do they make the same route decision and request the same quantity; and
2. conditional on the venue accepting the comparable live maker, does the public paper queue model reproduce its fill/no-fill result?

The first question checks policy mirroring. The second checks market-microstructure fidelity. A no-fill is zero spend, not a losing trade.

## Inputs and deciding corrections

Recalculated at **2026-08-26T02:16:35.334Z** with `npm run analyze:paper-live-mirror` from the hydrated execution-ledger v9 read path.

- exact pair generation: `entry-execution-mirror-pair-v1`;
- paper generation: `paper-managed-execution-route-ioc-requalify3-calibrated-v6`;
- live generation: `maker-high30-requalify3-fresh1c-bounded-taker-pilot-v7`;
- scope start: **2026-08-24T18:31:40.507Z**, the first live-v7 intent;
- scope end: 2026-08-26T02:14:27.274Z;
- source: 4,856 ledger rows; hydrated-ledger SHA-256 `f8d07109c0a2bc09545f2d05309497d0929a643dba134e3ad6b01623b3ba01b7`;
- pair rule: exactly one paper and one live row sharing the immutable pair ID;
- no nearest-time matching, timestamp tolerance, or historical backfill;
- nonterminal pairs remain awaiting and are not scored;
- return uncertainty is not used to select a fill model; the fill-rate difference is averaged within UTC settlement close before its standard error is calculated;
- exact reporting P&L and whole-cent control P&L remain separate.

The caveat that most threatens interpretation is private queue state. Public depth shows displayed quantity, not the desk's true FIFO position or cancellations ahead. Therefore the report can measure disagreement but cannot identify a unique correction.

## Identity and decision coverage

| Measure | Result |
| --- | ---: |
| Paper intents in scope | 248 |
| Live intents in scope | 187 |
| Distinct exact pair IDs | 264 |
| Exact two-lane pairs | 171 |
| Terminal exact pairs | **170** |
| Independent close windows | **93** |
| Awaiting pairs | 1 |
| Paper-only intent IDs | 77 |
| Live-only intent IDs | 16 |
| Ambiguous IDs | **0** |
| Same route among terminal pairs | 164 / 170 |
| Same requested quantity | 164 / 170 |
| Unexpected route mismatches | **0** |

All six route mismatches were the predeclared bounded-pilot asymmetry: paper retained its assigned treatment simulation while live's capital/rate ceiling stamped `treatment-withheld` and used incumbent maker. The same six rows account for the quantity mismatches. They are expected execution/capital differences, not a shared entry-policy disagreement.

The 76 paper-only and 16 live-only IDs remain visible rather than forced into pairs. Paper intentionally ignores live pause, reconciliation, loss, rate, and capital gates, while independent prior fills can also change later episode eligibility. These rows describe intent coverage but cannot score fill fidelity.

## Primary comparable maker result

The primary execution comparison requires:

- an exact terminal pair;
- an accepted live venue order;
- maker in both lanes; and
- equal requested quantity.

That leaves **122 pairs across 77 independent settlement windows**.

| Outcome | Pairs |
| --- | ---: |
| Both filled | 24 |
| Paper filled, live did not | 3 |
| Live filled, paper did not | **42** |
| Neither filled | 53 |
| **Total** | **122** |

Derived fidelity:

| Measure | Result |
| --- | ---: |
| Paper fill rate | 22.13% |
| Live fill rate | 54.10% |
| Fill/no-fill agreement | 63.11% |
| Paper capture of live fills | **36.36%** |
| Paper-positive precision | 88.89% |
| Clustered paper-minus-live fill rate | **−35.93pp ±5.72pp SE** |

In beginner terms: among the 66 accepted live makers that filled, paper recognized only 24. It also simulated three fills among 56 accepted live makers that did not fill. Paper is strongly conservative in aggregate, but not a strict lower bound on every individual order.

The 24 both-filled makers acquired the same quantity in **24/24** cases. Paper's average fill price was **0.958¢ higher per contract** than live's. This is another conservative direction, but 24 observations are not enough to define a price adjustment and price calibration was not a precommitted candidate here.

## Complete exact-pair context

Across all 170 terminal exact pairs—including takers and the expected bounded-pilot withholds—the fill matrix was 27 both, 18 paper-only, 43 live-only, and 82 neither. Agreement was 64.12%; paper captured 38.57% of live fills. Clustered paper-minus-live fill rate was −18.19pp ±5.68pp over 93 windows.

The accepted same-route maker subset is primary because it removes submission refusal and route mismatch from the queue question. The broader result is retained to expose, not smooth over, materially different routes.

## Accounting check

The paper edge bankroll tied exactly at the snapshot:

- starting: 10,000¢;
- realized whole-cent P&L: −3,802¢;
- open edge stake: 0¢;
- available: 6,198¢;
- residual: **0¢**.

The paired matrix also retained exact and whole-cent P&L separately in every cell. These values are audit terms, not a treatment comparison: paper-only and live-only cells deployed different money, and no-fill cells correctly deployed zero.

## Comparison with the earlier v4 review

The 2026-08-21 v4 review found, conditional on 61 accepted live makers, 15 both-filled, zero paper-only, nine live-only, and 37 neither: 85.2% agreement and 62.5% live-fill capture.

The current prospective exact-ID cohort has more accepted pairs (121) but lower agreement (63.6%) and capture (36.9%). This is a real descriptive deterioration as a group, but it cannot be attributed uniquely to one cause:

- the cohorts cover different market periods;
- current paper includes repaired requalifying episodes;
- the exact-ID method is stricter than the old one-second retrospective pairing;
- true live FIFO position and cancellations remain private;
- live order activity can alter the public book paper later observes.

The result therefore rejects “paper v6 is live-equivalent.” It does not select a queue-clear fraction or execution horizon.

## Relation to F2 timing evidence

The separately frozen F2 timing shadow read at **2026-08-26T02:06:40.491Z** had:

- 121/121 complete decisions across 53 windows;
- 69 known live pairs;
- 56 accepted/accepted, 12 accepted/not-accepted, and one observed create race;
- 100% acceptance and final-grace evidence availability;
- zero grace-induced fill changes.

F2 and this report answer different questions. F2 measures whether sub-second create/acknowledgement timing explains acceptance classification. The accepted-maker subset here starts after the live venue accepted the order and primarily tests queue/fill fidelity. Their counts must not be pooled.

## What the evidence authorizes

Authorized:

- call paper v6 a materially conservative fill approximation, not live-equivalent;
- keep the exact pair instrumentation and updated repeatable analyzer;
- continue F2 unchanged to its 100- and 300-window/race gates;
- retain private FIFO/cancellation state as the leading unknown rather than inventing it.

Not authorized:

- adopting any `queueClearFraction` from this known-outcome cohort;
- activating F3 before F2's written gates;
- copying live fills into paper;
- changing the six-check, two-second, 12-second executable horizon;
- changing funded maker/taker routing, entry rules, sizing, exits, or capital;
- treating different paired-cell P&L as a causal return comparison.

The next scheduled evidence gate remains forecast Phase 2's coverage-only review, currently 91/100 closed windows. Maker spread remains 18/20 live divergent windows and paper timing remains 53/100 windows.

Nothing here is financial advice.
