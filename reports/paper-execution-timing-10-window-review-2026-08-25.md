# Paper execution timing F2 10-window review — 2026-08-25

> **Finding:** F2 passed its predeclared 10-window identity, request-budget, event-time-cutoff, and unavailable-
> wiring milestone. It now includes accepted live maker and post-only-race targets, but only 20 independent windows
> and 25 exact live pairs. F2 continues unchanged; F3 remains unactivated, and no paper fill, bankroll, funded
> execution, or promotion behavior changes.

## Question and method

This review follows the two-window smoke in
[`reports/paper-execution-timing-smoke-2026-08-25.md`](paper-execution-timing-smoke-2026-08-25.md) and asks whether
`paper-execution-timing-shadow-v1` now clears the first Phase F2 milestone in
[`docs/paper-execution-fidelity-v2-design.md`](../docs/paper-execution-fidelity-v2-design.md) §4.3.

The fixed prospective clock began **2026-08-25T06:47:41.724Z**. The review reran:

```bash
npm run analyze:paper-execution-timing
```

at **2026-08-25T14:43:39.759Z**. The analyzer reloads the detached journal, anchors expected coverage on exact paper
maker creation, and joins live state afterward only by exact prospective mirror-pair identity. Missing, pending,
and ambiguous live pairs remain distinct.

The most threatening caveat is target maturity: **20 of 45 records have no exact live pair**, only seven paired
live targets were non-accepted, and five of those were historical `market_not_found` responses that a public
post-only quote model is not designed to predict.

## Identity and coverage

| Measure | Result |
| --- | ---: |
| Timing records / expected paper makers | 45 / 45 |
| Independent UTC close windows | 20 |
| Missing decisions | 0 |
| Decision, acceptance, and grace coverage | 100% |
| Known exact live pairs | 25 |
| Missing live pairs | 20 |
| Pending / ambiguous live pairs | 0 / 0 |
| Unavailable / incomplete timing rows | 0 / 0 |

Every record retained the frozen 400ms create delay, 250ms acknowledgement delay, three-second final evidence
grace, exact provider contract, side, close, mirror identity, quantity, issuance cap, and paper execution
generation. The observer stayed detached from paper status, fills, reservation, stake, P&L, and every live order
field.

## Acceptance target

| Public candidate / later live target | Count |
| --- | ---: |
| Candidate accepted / live accepted | 18 |
| Candidate accepted / live non-accepted | 6 |
| Candidate race / live accepted | 0 |
| Candidate race / live non-accepted | 1 |

The analyzer reports 100% accepted recall and 14.29% pooled non-acceptance/race recall. The latter is not a clean
post-only-race estimate: live non-acceptance provenance consists of five `market_not_found_then_reconciled_absent`
and two post-only races. Identity is now useful, but this sample cannot freeze an acceptance model.

## Timing and final evidence

| Measure | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Create public-read latency | 74ms | 171ms | 329ms |
| Acknowledgement public-read latency | 72ms | 166ms | 186ms |
| Create schedule lateness | 2ms | 74ms | 101ms |
| Acknowledgement schedule lateness | 3ms | 130ms | 243ms |
| Final-grace schedule lateness | 2ms | 80ms | 226ms |

All 45 grace rows were available. Event-time replay recovered zero fills, removed zero fills, and differed from the
ordinary control zero times. That is a null timing result so far, not permission to delete the grace: the phase is
not mature and the observed-print lag distribution can still produce later differences.

No timing-shadow runtime error, unavailable row, pending identity, 429 attribution, or paper-result mutation was
observed. This does not yet establish “no production-latency effect”; that remains a 300-window phase-exit check.

## Milestone disposition

| F2 gate | State |
| --- | --- |
| 10 independent windows wiring | **passed** at 20 windows |
| 100 exact maker-pair windows / 95% control coverage | **closed** |
| 300 exact maker-pair windows / 30 live create races / 95% timing coverage / non-interference | **closed** |

Continue F2 unchanged. Keep ordinary management at six two-second checks over the original 12-second executable
horizon. Do not adopt the 400ms/250ms acceptance candidate, remove or adopt the grace, accelerate ordinary polling,
or begin F3 until the full F2 phase-exit review freezes retained timing mechanics.
