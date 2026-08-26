# Design document index

This is the discovery and lifecycle index for every top-level design, evaluation plan, reference, and exploration
in `docs/`. It is not a requirement authority. Start with [`SPEC.md`](../SPEC.md) for normative product
requirements and [`STATUS.md`](../STATUS.md) for current implementation state. Code and versioned registries remain
authoritative for current behavior.

## Lifecycle contract

- **Accepted** means the design was approved; its linked `spec/*.md` module remains canonical for requirements.
- **Proposed** means review is pending and no implementation is authorized.
- **Superseded** preserves historical reasoning but cannot authorize current behavior.
- **Retired** preserves a completed or removed workstream and its evidence.
- **Reference** explains a current system or external constraint without proposing a change.
- **Exploratory** is pre-specification work and authorizes no product behavior.

Implementation is a separate axis: **Not started**, **Partial**, **Complete**, **Removed**, or **Not applicable**.
A document can be accepted while implementation remains partial, or retired after a completed experiment.

Designs explain how and why. They never silently override the canonical specification, current runtime controls,
or code. Apparent conflicts must be resolved explicitly. Run `npm run verify:docs` after changing this index or a
top-level document.

## Accepted

| Document | Type | Implementation | Canonical requirements |
| --- | --- | --- | --- |
| [`Attempt-and-outcome evaluation design`](attempt-outcome-evaluation-design.md) | Evaluation design | Not started | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Confirmed-signal evaluation design`](confirmed-signal-evaluation-design.md) | Evaluation design | Not started | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Edge order-book monitor and stable signal transitions`](edge-order-book-monitor-design.md) | Product design | Complete | [`product-and-surfaces`](../spec/product-and-surfaces.md), [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`Window-consensus direction gate: data collection and evaluation plan`](edge-window-consensus-evaluation-design.md) | Evaluation design | Complete | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`The entry gate charges a fee the desk does not pay`](entry-gate-fee-design.md) | Policy design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Process-global execution-ledger ownership`](execution-ledger-runtime-design.md) | Architecture design | Complete | [`storage-and-architecture`](../spec/storage-and-architecture.md), [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`Execution ledger v9: immutable terminal evidence and a bounded funded hot set`](execution-ledger-v9-design.md) | Architecture design | Complete | [`storage-and-architecture`](../spec/storage-and-architecture.md), [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`External venue position ownership boundary`](external-venue-position-ownership-design.md) | Safety design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`Forecast model boundary and evaluator v3 design`](forecast-model-and-evaluator-v3-design.md) | Evaluation design | Partial | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Forecast storage redesign — sharding and rollups`](forecast-storage-design.md) | Architecture design | Complete | [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Forecast storage single-writer and generation repair`](forecast-storage-generation-repair-design.md) | Architecture design | Complete | [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Incremental background reconciliation`](incremental-background-reconciliation-design.md) | Safety design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Kalshi dynamic exchange-index wire identity`](kalshi-exchange-index-wire-design.md) | Safety design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`providers-and-market-data`](../spec/providers-and-market-data.md) |
| [`Live-authorization evaluation design`](live-authorization-evaluation-design.md) | Evaluation design | Not started | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Collision-resistant live entry identity and HYPE ledger correction`](live-order-identity-correction-design.md) | Safety design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`Mirror fidelity and skip attribution`](mirror-fidelity-and-skip-attribution-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Object-storage retention and local-disk safety`](object-storage-retention-and-disk-safety-design.md) | Architecture design | Partial | [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Offline walk-forward evaluation design`](offline-walk-forward-evaluation-design.md) | Evaluation design | Complete | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Paper bankroll fundings`](paper-bankroll-fundings-design.md) | Architecture design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`Paper execution fidelity v2 design`](paper-execution-fidelity-v2-design.md) | Execution design | Partial | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Paper fill calibration design`](paper-fill-calibration-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Paper/live mirror fidelity repair`](paper-live-mirror-fidelity-repair-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Paper is charged a taker fee on maker fills`](paper-maker-fee-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`Prospective portfolio choice-set journal`](portfolio-choice-set-journal-design.md) | Evaluation design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Portfolio-selection evaluation design`](portfolio-selection-evaluation-design.md) | Evaluation design | Not started | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Positive-edge maker restriction and exit-policy sentinels`](positive-edge-execution-exit-sentinel-design.md) | Evaluation design | Partial | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Quote trajectory and spread signal collection`](quote-trajectory-spread-signal-design.md) | Evaluation design | Complete | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Bounded dashboard and public-projection read paths`](reporting-read-path-design.md) | Architecture design | Complete | [`product-and-surfaces`](../spec/product-and-surfaces.md), [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Requalifying maker entry episodes`](requalifying-entry-episodes-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Second Market: Kalshi Hourly Crypto (Strike Contracts) — Design`](second-market-hourly-crypto-design.md) | Product design | Not started | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`providers-and-market-data`](../spec/providers-and-market-data.md), [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
| [`Runtime task cadence observability — design note`](task-cadence-observability-design.md) | Architecture design | Complete | [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Venue-candidate evaluation design`](venue-candidate-evaluation-design.md) | Evaluation design | Not started | [`providers-and-market-data`](../spec/providers-and-market-data.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |

## Proposed

| Document | Type | Implementation | Canonical requirements |
| --- | --- | --- | --- |
| [`Website / extensible execution-engine separation`](execution-engine-separation-design.md) | Architecture design | Not started | — |
| [`Multi-tenant identity, API, and execution-cell design`](multitenancy-design.md) | Architecture design | Not started | — |
| [`Multi-tenant web identity, profile, and venue-connection UI`](multitenant-web-ui-design.md) | Product design | Not started | — |

## Superseded

| Document | Type | Implementation | Canonical requirements |
| --- | --- | --- | --- |
| [`Adaptive entry execution and one-miss taker fallback`](adaptive-entry-fallback-design.md) | Execution design | Removed | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Edge-proportional entry sizing — design note`](edge-proportional-sizing-design.md) | Policy design | Not started | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Edge-spike gate and its sentinel`](edge-spike-sentinel-design.md) | Policy design | Removed | [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`High-edge taker routing and reduce-only sizing`](high-edge-execution-reduced-sizing-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |

## Retired

| Document | Type | Implementation | Canonical requirements |
| --- | --- | --- | --- |
| [`Bounded taker execution pilot`](bounded-taker-experiment-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Long-shot round-trip policy — design`](long-shot-policy-design.md) | Policy design | Removed | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Observing whether the sentinel's entries would have filled`](maker-post-observation-design.md) | Evaluation design | Removed | [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |

## Reference

| Document | Type | Implementation | Canonical requirements |
| --- | --- | --- | --- |
| [`Live opportunity decision flow`](live-opportunity-decision-flow.md) | Reference | Not applicable | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Venue Traffic, Rate Limits, and Throttle Recovery — Canonical Reference`](venue-traffic-and-rate-limits.md) | Reference | Not applicable | [`providers-and-market-data`](../spec/providers-and-market-data.md), [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |

## Exploratory

| Document | Type | Implementation | Canonical requirements |
| --- | --- | --- | --- |
| [`Noodle progression naming options`](noodle-progression-naming-options.md) | Exploration | Not applicable | — |
| [`Noodle Land and whimsical gamification — design direction`](whimsical-gamification-design.md) | Product design | Not applicable | — |
