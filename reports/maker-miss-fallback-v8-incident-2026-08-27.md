# Maker-miss fallback v8 production incident — 2026-08-27

## Question and decision

Did `maker-then-positive-edge-taker2-fresh2tick-v8` execute the accepted one-maker-then-taker-only lifecycle after its production activation, and what does the observed cohort authorize?

The fixed review found that it did not. A refused continuation could be submitted as another maker. The desk was paused and fully reconciled. This evidence authorizes a fail-closed implementation correction and a new execution generation; it does not authorize any change to admission thresholds, sizing, capital, exits, or the intended fallback economics.

## Fixed interval and inputs

- Interval: `2026-08-27T06:32:36.523Z` through the operator safety pause at `2026-08-27T15:19:22.325Z`.
- Durable input: worker-local `data/paper-orders.json`, filtered to entry rows stamped `maker-then-positive-edge-taker2-fresh2tick-v8` and grouped by `logicalOrderId` and settlement `closesAt`.
- Operational confirmation: authenticated trading-control response after Pause/drain and manual full reconciliation.
- Implementation review: `evaluateEntryExecutionPolicy`, `adaptiveEntryEpisodeDecision`, `runLive`, and `runPaper` in the source generation deployed for the interval.
- Money views: whole-cent `pnlCents` is the budget-control view; `actualPnlCents` is the exact reporting view. They are reported separately.

Historical rows were not modified. Counts below were recalculated from the durable ledger during this review.

## Live cohort

The interval contained 45 durable live entry rows representing 37 logical sequences across 18 settlement windows.

Initial intents:

- 37 managed makers;
- five filled;
- 24 were accepted, rested, canceled, and authoritatively returned zero fill; and
- eight ended as never-accepted post-only races.

Continuation intents:

- eight episode-2 rows;
- all eight were stamped `makerMissFallback: true` but routed as `ordinary-maker` with `executedStyle: maker`;
- seven reached accepted venue identity, one remained a post-only race;
- two filled and six spent nothing; and
- zero live rows used `maker-miss-taker-fallback`, so no live IOC 1 or IOC 2 executed.

The eight continuation decisions explicitly withheld the taker for quality below 65%, spread above 2¢, or both. Those were genuine policy refusals under the accepted design. The implementation nevertheless treated the decision's conservative maker-style return as authority to execute another maker.

## Money outcome

Seven live rows filled across only five independent settlement windows. They staked 192.72¢ exact in total and recorded:

- **+60¢** whole-cent budget P&L; and
- **+63.1561¢** exact reporting P&L.

The two filled episode-2 makers accounted for 55.79¢ exact stake, +46¢ whole-cent P&L, and +46.912¢ exact P&L. Their favorable realized outcome does not authorize an order route the policy refused.

The small five-window filled cohort, overlapping contracts inside shared settlement windows, strict-value exits, and the route violation make profitability inference inappropriate. The load-bearing result is the route identity, not return.

## Paper evidence

The same interval contained 43 paper rows representing 32 logical sequences across the same 18 settlement-window population. Eleven were continuation rows:

- four used the intended taker-fallback route;
- three ended before simulated submission when the refreshed ask exceeded the approved cap;
- one simulated IOC filled at 51¢ under a 63¢ signed limit with approximately 0.559pp worst-case signed edge and lost 22¢; and
- seven refused continuations were incorrectly simulated as another maker, three of which filled.

Paper therefore reproduced the same refusal-to-maker defect while also demonstrating that the taker branch itself could be reached. It supplies no authoritative venue fill, fee, latency, partial-fill, or IOC-zero-fill evidence.

## Root cause

`evaluateEntryExecutionPolicy` correctly represents a failed taker gate conservatively as maker style. The v8 live and paper orchestrators interpreted that result as an executable route even when `adaptiveEntryEpisodeDecision` had authorized a taker-only continuation. There was no orchestration guard requiring every adaptive episode after the first to be `maker-miss-taker-fallback` plus `executedStyle: taker`.

The separately merged hourly-threshold observation feature changed no entry-policy, episode, order, budget, or reconciliation module and did not cause this defect.

## Safety action and authorized correction

At `2026-08-27T15:19:22.325Z`, Pause withdrew operator intent. The serialized drain completed quiescent and restart-safe. Manual full reconciliation passed with zero local positions, venue-managed positions, reservations, resting managed orders, or recovered fills.

The correction must:

1. treat any non-taker result for adaptive episode 2 or 3 as terminal refusal before reservation or venue submission;
2. persist the exact refusal on the predecessor when no child intent exists;
3. preserve first-writer terminal evidence against generic outer handling;
4. apply identically to live and paper route decisions;
5. retain signed-quote pre-submit refusal on a distinct taker intent when that intent already exists;
6. stamp a new execution generation so v8 evidence is never blended with corrected behavior; and
7. retain the existing edge, quality, spread, tick, cap, sizing, funding, risk, reconciliation, and exit rules unchanged.

The desk must remain paused until the corrected build passes invariant tests and full validation, startup full reconciliation passes, the new generation is confirmed loaded with zero unresolved authority, and the operator explicitly resumes.
