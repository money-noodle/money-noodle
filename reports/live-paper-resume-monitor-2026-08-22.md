# Live resume and paper-mirror monitor — 2026-08-22

## Question and authority

After execution-ledger v9 activation, does funded execution resume safely, does a paper position complete its
lifecycle correctly, and does current paper execution remain a useful approximation of live execution?

This was a read-only evaluation after the explicitly authorized resume. It changed no forecast, entry, execution,
exit, budget, calibration, or reconciliation policy. Inputs were the authenticated control surface, the verified
v9 execution ledger, the forecast-storage verifier, `npm run analyze:paper-live-mirror`,
`npm run analyze:paper-fill-calibration`, and `npm run analyze:positive-edge-current`. The deciding unit for fill
comparisons is the settlement window, not an individual attempt.

Monitoring covered 2026-08-22T22:53:16Z through 2026-08-22T23:20:54Z. This is only one newly observed settlement
window with three paired attempts; it is operational evidence, not enough independent evidence to change policy.
The broader held-out calibration cohort contained 28 windows.

## Operational result

A manual pre-resume reconciliation completed READY at `2026-08-22T22:53:15.330Z`. It found 5,824.76¢ venue cash,
zero local or venue-managed positions, zero resting cancellations, zero recovered fills, and zero reservations.
Normal readiness had no blockers and live risk was allowed. The explicit resume advanced control to revision
5,546 at `2026-08-22T22:53:16.472Z`.

The worker remained active through the monitor. Periodic reconciliations completed READY at
`2026-08-22T23:14:18.332Z` and `2026-08-22T23:20:18.907Z`; both again found zero local/venue-managed positions,
resting cancellations, recovered fills, and reservations. At the end, control remained live/active with operator
intent active, 2,086¢ available, 0¢ reserved, no readiness blocker, and allowed live risk. The compact control
read took 117.6 ms. This establishes normal issuance/cancellation/reconciliation behavior over the observed
interval, not long-run availability.

## Paper lifecycle observed

The paper order already open around resume was `HYPE UP` for the 23:00 UTC settlement window. It was issued while
live was paused, so it is not a paper/live pair and must not be used as mirror evidence.

- simulated maker fill: 0.58 contracts at 48¢;
- strict-value exit: 77¢ with a 1¢ modeled exit fee;
- exact sale proceeds: 43.66¢;
- result: +15.66¢ exact reporting P&L / +15¢ whole-cent control P&L;
- final hold outcome: DOWN, for a -28¢ counterfactual hold result.

The exit therefore improved this particular row by 43.66¢ versus its whole-cent hold counterfactual. The
counterfactual was attached by 23:00:37Z, after the window closed. Arithmetic, lifecycle transition, and funding
release behaved as designed.

## Newly observed paired window

The 23:15 UTC window produced three same-start paper/live pairs. All three selected the same symbol, side, maker
route, and requested quantity in both lanes.

| Pair | Paper | Live | Result |
| --- | --- | --- | --- |
| BNB DOWN, 0.62 | rested, no fill | venue accepted, rested, no fill | agreement; no money spent |
| DOGE DOWN, 0.54 | rested, no fill | venue accepted, rested, no fill | agreement; no money spent |
| BNB UP, 0.62 | simulated fill at 37¢, lost 23¢ | three post-only retries rejected before placement | execution divergence; live spent 0¢ |

Every temporary 30¢ live reservation was returned. The two accepted live maker orders received venue IDs, rested
for the managed horizon, were canceled, and finished unfilled. The BNB UP rejection failed closed before
placement. No live position or uncertain state remained.

## Current mirror measurements

At `2026-08-22T23:18Z`, the active v6 calibration cohort had 133 terminal paired intents in 56 settlement windows.
The held-out half comprised 70 intents in 28 windows:

- both filled / paper only / live only / neither: **12 / 4 / 9 / 45**;
- fill/no-fill agreement: **81.4%**;
- paper capture of live fills: **57.1%**;
- paper-positive precision: **75.0%**.

As a diagnostic only, restricting to the 66 held-out rows with a live venue order ID produced 12 / 2 / 9 / 43:
83.3% agreement and 85.7% paper-positive precision, while capture remained 57.1%. This restriction is not the
primary score because it conditions on successful live placement. Exact FIFO rank and cancellations ahead are
private, and the ledger lacks per-print replay streams; those are the main threats to interpretation.

The older closed primary cohort still showed 69/69 matching route decisions and requested quantities, 79.7%
fill/no-fill agreement over 41 windows, and a clustered paper-minus-live fill-rate difference of -2.8% ±9.4%.
Generations were not pooled.

The latest divergence was not isolated. Under current live execution policy, 19 of 301 attempts (6.3%) ended in
`post_only_race`; BNB UP accounted for 5 of those 19. In the current held-out set, two of four paper-only fills
were post-only races and two were accepted live makers that did not fill. This supports investigation of live
post-only acknowledgement timing, but not conversion to taker execution or relaxation of post-only safety.

## Broader current economic signal

The freshly recalculated positive-edge report used 3,836 orders and 73,320 forecasts. Its current active-policy
strict-exit diagnostic contained 15 live exits in 12 independent windows. None beat authoritative hold, and the
exits gave up 68.7974¢ in aggregate versus hold; clustered mean incremental return was -0.1326 with standard error
0.0576. This is materially concerning, but it is retrospective and one of multiple evaluated policy variants.
The successful HYPE paper exit above demonstrates heterogeneity rather than invalidating the aggregate result.
Any exit-policy change still requires a committed design, policy-manifest version/history, prospective sentinels,
and comparison against the complete live rule.

## Storage and projection checks

- execution ledger v9 verified: 3,836 rows, 3,548 compact rows;
- forecast storage verified: 73,320 current rows, zero structural/checksum errors;
- hosted Postgres projections recovered and returned durable 200 responses after deployment;
- no immutable evidence or journal was rewritten during this evaluation.

## Priority-ordered findings

1. **Evaluate strict-value exits before changing them.** The current 15-exit/12-window authoritative cohort moved
   uniformly against hold and gave up 68.7974¢. Run the existing alternative-exit evaluation with multiple-
   comparison accounting and commit prospective sentinels before proposing a policy version.
2. **Investigate post-only acknowledgement races without weakening post-only protection.** They affected 19/301
   current-policy attempts and caused the monitored paper-only loss. Preserve refreshed-price, rejection, retry,
   and tick-backoff evidence so stale quote movement can be separated from venue acknowledgement behavior.
3. **Continue prospective paper-fill validation; do not calibrate from this retrospective.** Current held-out
   agreement is 81.4%, but paper captures only 57.1% of live fills and paper-positive precision is 75.0%. A real
   queue calibration requires retained per-print replay evidence and a new held-out generation.
4. **Collect more independent active windows.** The resume interval contributed only one window and three pairs;
   it proves lifecycle operation, not stable paper/live equivalence or economic performance.
5. **Continue the separate runtime-residency work.** V9 integrity passed and the observed process remained
   responsive, but the previously identified observational journals still need independent bounded-store designs.

No immediate safety repair was identified, and this report authorizes no automatic policy or calibration change.
