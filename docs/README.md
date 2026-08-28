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
Every Proposed, Superseded, Retired, or Exploratory document also carries a controlled **Current use** field near
its title. That field governs how an agent may use historical body text; confident old prose cannot restore authority.

Designs explain how and why. They never silently override the canonical specification, current runtime controls,
or code. Apparent conflicts must be resolved explicitly. Current design bodies name canonical modules rather than
using ambiguous root-spec-plus-number citations, and their cited source paths are verified. Run `npm run verify:docs` after
changing this index or a top-level document.

## Domain and workstream routing

Use this view after `SPEC.md` identifies the governing domain. It highlights active or load-bearing context; the
lifecycle tables below remain the complete primary index. Read a linked design completely before changing its
mechanism. A queued or proposed row still grants no implementation authority.

| Workstream | Read when | Active/load-bearing designs |
| --- | --- | --- |
| Forecast and evidence | Forecast formula, replay, calibration, confirmation, or outcome scoring | [`Forecast model/evaluator v3`](forecast-model-and-evaluator-v3-design.md) → [`confirmed signal`](confirmed-signal-evaluation-design.md) |
| Provider and market candidacy | Provider identity, quote feasibility, contract target, or a new market | [`Venue candidacy`](venue-candidate-evaluation-design.md), [`hourly threshold market`](second-market-hourly-crypto-design.md), [`venue traffic`](venue-traffic-and-rate-limits.md) |
| Portfolio through venue outcome | Selection, authorization, durable intent, order/position/cash lifecycle | [`Portfolio selection`](portfolio-selection-evaluation-design.md) → [`live authorization`](live-authorization-evaluation-design.md) → [`attempt/outcome`](attempt-outcome-evaluation-design.md) |
| Paper/live fidelity | Mirror routing, queue simulation, timing, calibration, or exact pair attribution | [`Paper fidelity v2`](paper-execution-fidelity-v2-design.md), [`fill calibration`](paper-fill-calibration-design.md), [`mirror fidelity`](mirror-fidelity-and-skip-attribution-design.md) |
| Funded safety and reconciliation | Signing identity, external ownership, cancellation, reconciliation, or ledger authority | [`Incremental reconciliation`](incremental-background-reconciliation-design.md), [`exchange index`](kalshi-exchange-index-wire-design.md), [`external ownership`](external-venue-position-ownership-design.md), [`ledger v9`](execution-ledger-v9-design.md) |
| Execution and exits | Entry route/episodes/sizing, maker restrictions, or reduce-only exit evidence | [`Maker-to-taker fallback`](maker-miss-two-taker-fallback-design.md), [`execution/exit sentinels`](positive-edge-execution-exit-sentinel-design.md) |
| Storage and runtime | Forecast/execution storage, object archive, bounded reads, or cadence ownership | [`Forecast storage`](forecast-storage-design.md), [`generation repair`](forecast-storage-generation-repair-design.md), [`object retention`](object-storage-retention-and-disk-safety-design.md), [`reporting reads`](reporting-read-path-design.md) |
| Product attribution and observation | Dashboard identity/filtering, signal lifecycle, or observation-only ladders | [`Attribution visibility`](provider-policy-attribution-visibility-design.md), [`order-book monitor`](edge-order-book-monitor-design.md), [`live decision flow`](live-opportunity-decision-flow.md) |
| Future platform shape | Website/engine split, tenants, identity, and connections | [`Engine separation`](execution-engine-separation-design.md), [`multitenancy`](multitenancy-design.md), [`multitenant UI`](multitenant-web-ui-design.md) — all Proposed |

The strict evaluation sequence is forecast → confirmed signal → venue candidacy → portfolio selection → live
authorization → attempt/outcome. The maker-to-taker design's complete implementation is the v9 terminal-refusal
correction; v8 remains historical incident evidence only. Current collection state and scheduling remain in
[`status/roadmap.md`](../status/roadmap.md), not this index.

### Load-bearing supersession chains

| Historical design | Current routing |
| --- | --- |
| [`Adaptive fallback`](adaptive-entry-fallback-design.md) → [`high-edge route/reduced sizing`](high-edge-execution-reduced-sizing-design.md) → [`requalifying episodes`](requalifying-entry-episodes-design.md) | Current boundary is [`maker-to-taker fallback`](maker-miss-two-taker-fallback-design.md); the funded bounded pilot is [`Retired`](bounded-taker-experiment-design.md). |
| [`Edge-proportional sizing`](edge-proportional-sizing-design.md) | Superseded by the fixed reduce-below-30pp sizing recorded in the current execution policy. |
| [`Edge-spike gate`](edge-spike-sentinel-design.md) | Removed as production authority; prospective maker restrictions live in [`execution/exit sentinels`](positive-edge-execution-exit-sentinel-design.md). |
| [`Original maker-post observer`](maker-post-observation-design.md) | Retired; current mirror attribution uses [`paper/live repair`](paper-live-mirror-fidelity-repair-design.md) and [`paper fidelity v2`](paper-execution-fidelity-v2-design.md). |
| [`Long-shot policy`](long-shot-policy-design.md) | Retired and removed; historical strategy identity only. |

## Accepted

| Document | Type | Implementation | Canonical requirements |
| --- | --- | --- | --- |
| [`Maker lifecycle sentinel: short expiry, and whether the taker is what pays`](maker-lifecycle-sentinel-design.md) | Evaluation design | Not started | [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Exit sentinel v3: a frozen hold arm and an honest no-bid state`](exit-sentinel-v3-hold-candidate-design.md) | Evaluation design | Not started | [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
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
| [`Maker miss with two bounded positive-edge taker fallbacks`](maker-miss-two-taker-fallback-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
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
| [`Provider and policy attribution visibility`](provider-policy-attribution-visibility-design.md) | Product design | Complete | [`product-and-surfaces`](../spec/product-and-surfaces.md), [`providers-and-market-data`](../spec/providers-and-market-data.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Quote trajectory and spread signal collection`](quote-trajectory-spread-signal-design.md) | Evaluation design | Complete | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
| [`Bounded dashboard and public-projection read paths`](reporting-read-path-design.md) | Architecture design | Complete | [`product-and-surfaces`](../spec/product-and-surfaces.md), [`storage-and-architecture`](../spec/storage-and-architecture.md) |
| [`Second Market: Kalshi Hourly Crypto (Strike Contracts) — Design`](second-market-hourly-crypto-design.md) | Product design | Partial | [`forecasting-and-evidence`](../spec/forecasting-and-evidence.md), [`providers-and-market-data`](../spec/providers-and-market-data.md), [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md) |
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
| [`Requalifying maker entry episodes`](requalifying-entry-episodes-design.md) | Execution design | Complete | [`trading-risk-and-budget`](../spec/trading-risk-and-budget.md), [`policy-and-track-separation`](../spec/policy-and-track-separation.md) |
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
