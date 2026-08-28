# Report index

Dated measurements, methods, cohorts, and caveats. Every report is canonical for the analysis it contains and for
nothing else: a report records what was measured on a stated date against a stated cohort. It cannot create a
requirement, authorize an implementation, or describe present behavior.

This index names the **question each report answers** and deliberately does not restate its numbers. A measurement
travels with its date, sample size, and material caveat ([`AGENTS.md`](../AGENTS.md) §6), and those live in the
report. Recalculate from durable inputs before making a current quantitative claim.

Groups are ordered newest first. A later report in a group frequently revises an earlier one — including reports
that corrected the author's own prior reading — so read down from the top of a group rather than picking by title.
Superseded reports are never deleted; that is why the older rows remain.

Reports marked **cited by current status** are the evidence [`STATUS.md`](../STATUS.md) currently rests on.

## Entry policy and edge admission

| Report | Question it answers |
| --- | --- |
| [`entry-admission-v22-review-2026-08-20`](entry-admission-v22-review-2026-08-20.md) | What buy-policy v22 admits and drops versus v21, on exact-provider replay |
| [`unfilled-entries-2026-08-20`](unfilled-entries-2026-08-20.md) | Why so many live edge entries went unfilled, and whether rested makers would have paid |
| [`prebuy-direction-gate-2026-08-20`](prebuy-direction-gate-2026-08-20.md) | Whether a pre-buy short-term direction gate would have kept winners and skipped losers |
| [`prebuy-longer-window-2026-08-20`](prebuy-longer-window-2026-08-20.md) | Whether a longer (30s–8min) pre-buy trend gate would have helped |
| [`window-consensus-exploration-2026-08-20`](window-consensus-exploration-2026-08-20.md) | Whether window-consensus direction signals are worth collecting, and how to evaluate them |
| [`xrp-exclusion-review-2026-08-20`](xrp-exclusion-review-2026-08-20.md) | Whether excluding XRP is supported by evidence rather than by retrospective screening |
| [`winner-preserving-loss-filter-review-2026-08-19`](winner-preserving-loss-filter-review-2026-08-19.md) | Whether the desk can avoid bad bets without dropping the winners |
| [`edge-buy-opportunities-2026-08-19`](edge-buy-opportunities-2026-08-19.md) | Where the edge policy's money is and is not, across eleven screened ideas |
| [`missed-entry-review-2026-08-18`](missed-entry-review-2026-08-18.md) | Whether the entry gate or persistence is what keeps volume out |
| [`edge-magnitude-2026-08-18`](edge-magnitude-2026-08-18.md) | Whether high edge is the best or worst band |
| [`edge-policy-review-2026-08-17`](edge-policy-review-2026-08-17.md) | Whether the entry gate or the execution path is the binding constraint |
| [`edge-policy-margin-review-2026-08-16`](edge-policy-margin-review-2026-08-16.md) | Where the edge policy's margin actually is — also the worked example for [`AGENTS.md`](../AGENTS.md) §5 analysis discipline |

## Execution — makers, takers, and fill selection

| Report | Question it answers |
| --- | --- |
| [`early-taker-cutover-review-2026-08-28`](early-taker-cutover-review-2026-08-28.md) | Whether cancelling an unfilled maker at two seconds and taking the offer instead would have beaten the live rule |
| [`maker-miss-fallback-v8-incident-2026-08-27`](maker-miss-fallback-v8-incident-2026-08-27.md) | Whether v8 executed its one-maker-then-taker-only lifecycle, what the refusal-routing defect affected, and what correction the fixed production cohort authorized — **cited by current status** |
| [`maker-restriction-v1-fixed-review-2026-08-26`](maker-restriction-v1-fixed-review-2026-08-26.md) | Whether either prospective maker restriction cleared its fixed count, cash, clustered-return, Holm, and simultaneous-track gates — **cited by current status** |
| [`kalshi-order-size-and-fill-mechanics-2026-08-20`](kalshi-order-size-and-fill-mechanics-2026-08-20.md) | How order size affects fills on Kalshi |
| [`maker-adverse-selection-and-exit-depth-2026-08-19`](maker-adverse-selection-and-exit-depth-2026-08-19.md) | Whether maker adverse selection or exit depth is the larger cost |
| [`execution-direction-sizing-review-2026-08-19`](execution-direction-sizing-review-2026-08-19.md) | Whether direction-aware execution and 30pp reduced sizing are supported |
| [`positive-edge-execution-review-2026-08-19`](positive-edge-execution-review-2026-08-19.md) | How positive-edge buys fare across maker/taker execution and early exits |
| [`fill-selection-robustness-2026-08-18`](fill-selection-robustness-2026-08-18.md) | Whether the fill-selection effect survives stress-testing, and how it conflates with window selection |
| [`loss-decomposition-2026-08-18`](loss-decomposition-2026-08-18.md) | Where the edge policy's money goes — and the correction of a double-counted earlier headline |
| [`take-the-ask-2026-08-18`](take-the-ask-2026-08-18.md) | Whether taking the ask beats resting, weighing the discount against missed fills |
| [`maker-fill-adverse-selection-2026-08-18`](maker-fill-adverse-selection-2026-08-18.md) | Whether adverse selection on resting quotes is detectable at all — a stated null result |
| [`swing-trading-2026-08-18`](swing-trading-2026-08-18.md) | Whether the intra-window swing is real and whether it can be captured |
| [`execution-observation-instrumentation-2026-08-14`](execution-observation-instrumentation-2026-08-14.md) | What the execution and position-path instrumentation records |

## Exits

| Report | Question it answers |
| --- | --- |
| [`strict-value-hold-review-2026-08-27`](strict-value-hold-review-2026-08-27.md) | What exact cash and clustered return change when profitable strict-value sales are held to settlement, and whether current prospective sentinels support disabling the exit |
| [`exit-sentinel-preclose-availability-diagnosis-2026-08-26`](exit-sentinel-preclose-availability-diagnosis-2026-08-26.md) | Whether exit-sentinel v2 conflates a fresh zero bid with missing evidence — **cited by current status** |
| [`exit-sentinel-v2-coverage-diagnosis-2026-08-25`](exit-sentinel-v2-coverage-diagnosis-2026-08-25.md) | Where exit-sentinel v2 coverage breaks down before close |
| [`prospective-exit-sentinel-v1-review-and-v2-repair-2026-08-24`](prospective-exit-sentinel-v1-review-and-v2-repair-2026-08-24.md) | What prospective exit-sentinel v1 showed and what v2 changed about its evidence |
| [`strict-value-exit-review-2026-08-23`](strict-value-exit-review-2026-08-23.md) | How the production strict-value exit performs prospectively |
| [`exit-cost-vs-save-2026-08-20`](exit-cost-vs-save-2026-08-20.md) | Whether the live strict-value exit cost or saved money over a bounded window |
| [`exit-counterfactual-analysis-2026-08-14`](exit-counterfactual-analysis-2026-08-14.md) | How alternative exit rules would have scored against the live rule |

## Paper/live mirror fidelity

| Report | Question it answers |
| --- | --- |
| [`paper-live-exact-v7-mirror-review-2026-08-26`](paper-live-exact-v7-mirror-review-2026-08-26.md) | How far paper fills undercapture live fills on exact mirror pairs — **cited by current status** |
| [`paper-execution-timing-100-window-review-2026-08-27`](paper-execution-timing-100-window-review-2026-08-27.md) | Whether paper timing F2 cleared 100 exact-maker windows without violating its fixed execution horizon — **cited by current status** |
| [`paper-execution-timing-10-window-review-2026-08-25`](paper-execution-timing-10-window-review-2026-08-25.md) | Whether paper execution timing Phase F2 is collecting completely at 10 windows |
| [`paper-execution-timing-smoke-2026-08-25`](paper-execution-timing-smoke-2026-08-25.md) | Whether the paper execution timing shadow path runs without interfering |
| [`paper-settlement-health-2026-08-25`](paper-settlement-health-2026-08-25.md) | Whether paper positions settle and resolve correctly |
| [`paper-live-mirror-fidelity-2026-08-21`](paper-live-mirror-fidelity-2026-08-21.md) | Where paper and live diverge once entry decisions are held identical |

## Forecast model and evaluation

| Report | Question it answers |
| --- | --- |
| [`forecast-candidate-phase2-100-window-coverage-review-2026-08-26`](forecast-candidate-phase2-100-window-coverage-review-2026-08-26.md) | Whether forecast-candidate Phase 2 cleared its fixed 100-window coverage gate and why rows remained unscoreable — **cited by current status** |
| [`forecast-candidate-phase2-wiring-review-2026-08-25`](forecast-candidate-phase2-wiring-review-2026-08-25.md) | Whether forecast-candidate Phase 2 collection is wired correctly and covering its windows |
| [`walk-forward-model-candidate-review-2026-08-20`](walk-forward-model-candidate-review-2026-08-20.md) | How walk-forward model candidates score on unseen windows after fees |
| [`kalshi-forecast-weight-analysis-2026-08-11`](kalshi-forecast-weight-analysis-2026-08-11.md) | What weight, if any, Kalshi's implied probability should carry in the forecast |
| [`forecast-and-exit-review-2026-08-11`](forecast-and-exit-review-2026-08-11.md) | An early joint review of forecast failure, UP/DOWN policy, and exits |
| [`cycle-streak-analysis-2026-08-11`](cycle-streak-analysis-2026-08-11.md) | Whether multi-cycle trend continuation carries signal |

## Retired workstreams

Kept as the evidence behind two retirements. Neither strategy may be revived through roadmap or index wording.

| Report | Question it answers |
| --- | --- |
| [`long-shot-v2-final-review-2026-08-26`](long-shot-v2-final-review-2026-08-26.md) | The final prospective result that retired the long-shot strategy — **cited by current status** |
| [`bounded-taker-pilot-v1-closure-2026-08-25`](bounded-taker-pilot-v1-closure-2026-08-25.md) | What the bounded taker pilot measured before it was closed |
| [`long-shot-roundtrip-2026-08-18`](long-shot-roundtrip-2026-08-18.md) | Whether any exit mark makes the long-shot round trip work |
| [`long-shot-hold-sentinel-2026-08-18`](long-shot-hold-sentinel-2026-08-18.md) | Whether the hold sentinel cleared its bar — and the correction of an earlier misreading |
| [`long-shot-gap-sweep-2026-08-17`](long-shot-gap-sweep-2026-08-17.md) | Whether any buy→sell gap is priced loosely enough to pay |
| [`long-shot-filter-screen-2026-08-17`](long-shot-filter-screen-2026-08-17.md) | Whether any of thirty screened candidate filters is usable — a mostly null result |

## Storage, ledger, and integrity

| Report | Question it answers |
| --- | --- |
| [`object-storage-restore-and-disk-reclamation-2026-08-24`](object-storage-restore-and-disk-reclamation-2026-08-24.md) | Whether an independent restore reproduces every archived file and passes the semantic verifiers — **cited by current status** |
| [`execution-ledger-v9-migration-2026-08-22`](execution-ledger-v9-migration-2026-08-22.md) | Whether the v9 migration preserved money rows and bounded funded reads |
| [`forecast-storage-integrity-repair-2026-08-22`](forecast-storage-integrity-repair-2026-08-22.md) | What the forecast-storage integrity incident was and how it was repaired |
| [`forecast-residency-profile-2026-08-22`](forecast-residency-profile-2026-08-22.md) | What forecast storage costs in residency, and what the bounded projection repair changed |

## Operational and economic monitors

Fixed-window operational reads. Each is a snapshot of a stated past interval, never a live counter.

| Report | Question it answers |
| --- | --- |
| [`live-paper-economic-monitor-2026-08-26`](live-paper-economic-monitor-2026-08-26.md) | Whether the latest fixed day preserved the positive-signal/negative-fill split across live and paper — **cited by current status** |
| [`live-paper-economic-monitor-2026-08-25`](live-paper-economic-monitor-2026-08-25.md) | How live and paper economics compared over the prior fixed 24-hour review |
| [`live-opportunity-review-2026-08-24`](live-opportunity-review-2026-08-24.md) | Which live opportunities appeared over a fixed 24 hours and what became of them |
| [`incremental-reconciliation-monitor-2026-08-23`](incremental-reconciliation-monitor-2026-08-23.md) | Whether incremental background reconciliation activated and behaved as designed |
| [`live-health-monitor-2026-08-23`](live-health-monitor-2026-08-23.md) | Whether the funded desk was healthy across its safety and reconciliation checks |
| [`live-paper-resume-monitor-2026-08-22`](live-paper-resume-monitor-2026-08-22.md) | Whether the live resume and paper mirror behaved correctly after a pause |
| [`open-experiment-status-2026-08-19`](open-experiment-status-2026-08-19.md) | Which experiments and sentinels were open, and what each still needed |
| [`monitoring-review-2026-08-14`](monitoring-review-2026-08-14.md) | Whether monitoring covered the failures it was meant to catch |
| [`live-run-review-2026-08-12`](live-run-review-2026-08-12.md) | What an early full live run showed |
| [`live-run-review-2026-08-11-1622`](live-run-review-2026-08-11-1622.md) | What the first six-hour live run showed about execution mode |

## Venue and contract mechanics

| Report | Question it answers |
| --- | --- |
| [`kalshi-hourly-threshold-contract-revalidation-2026-08-26`](kalshi-hourly-threshold-contract-revalidation-2026-08-26.md) | Whether the planned hourly series currently expose exact one-hour threshold pairs and what identity the first selector must preserve |
| [`contract-comparability-analysis-2026-08-14`](contract-comparability-analysis-2026-08-14.md) | Whether cross-venue contracts settle comparably enough to price one forecast against several venues |

## Time and seasonality

| Report | Question it answers |
| --- | --- |
| [`time-of-day-analysis-2026-08-14`](time-of-day-analysis-2026-08-14.md) | Whether time of day or weekday carries exploitable signal |
| [`time-of-day-analysis-2026-08-11`](time-of-day-analysis-2026-08-11.md) | The earlier time-of-day read, before the weekday cohort was added |
| [`warmup-entry-timing-analysis-2026-08-11`](warmup-entry-timing-analysis-2026-08-11.md) | Whether live entry timing during warm-up systematically differs |
