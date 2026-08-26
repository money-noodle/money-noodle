# Delivery and acceptance

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-25  
> **Canonical for:** delivery phases, completion markers, and initial acceptance criteria.  
> **Read with:** [`STATUS.md`](../STATUS.md) for current measured implementation state.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

## 10. Delivery plan

### Phase 1 — Read-only prediction dashboard (substantially complete)
- [x] Next.js/TypeScript foundation.
- [x] Tailwind and shadcn/ui component foundation.
- [x] Local atomic JSON cache and accumulating price history.
- [x] Polymarket 15m discovery/quotes.
- [x] CoinGecko trends and CoinDesk news ingestion.
- [x] Transparent Blend 0.2 initial factor service, subsequently superseded by the venue-independent Blend 0.4 contract-basis baseline.
- [x] Complete responsive dashboard and detail UX.
- [x] Add baseline model/signing tests and source-level degraded states.
- [x] Add a 15-second positive-edge binary buy strip ordered by net-edge strength, with selected side, likelihood, and time remaining.
- [x] Add collapsed edge debugging for passing and below-gate markets.
- [x] Show current raw Polymarket/Kalshi probabilities beside positive-edge and debug calculations.
- [x] Add a signed, stateful, on-demand Kalshi selected-side ladder to positive-edge cards without connecting UI reads to execution telemetry; stabilize card/grid heights, default awaiting-confirmation signals visible, retain expired snapshots through market close, and fade only at window expiry.

### Phase 2 — Strong research and history
- [x] LLM provider registry and grounded, cited research.
- [x] Persist every qualifying 15-second positive-edge buy with its complete feature snapshot and cycle ID.
- [x] Resolve tracked positive-edge buys from final Polymarket outcomes.
- [x] Show accuracy, Brier score, log loss, recent outcomes, and calibration readiness.
- [x] Add detailed immutable history and breakdowns by asset, direction, confidence bucket, and model version.
- [x] Add cumulative and rolling-25 accuracy-over-time visualization.
- [x] Record every qualifying calculation plus a bounded prospective one-minute sample of non-qualifying calculations so calibration coverage is not restricted to selected trades.
- [x] Forecast the actual settlement condition using an oracle-reference basis model with realized volatility.
- [x] Report coin-flip/basis/Polymarket/Kalshi benchmarks, calibration bins, lead-time accuracy, and contract-level streaks.
- [x] Persist versioned venue-independent calibration replay inputs and wire temperature, basis log-odds weight, volatility scale, aggregate slow-tilt scale, symmetric probability cap, edge threshold, and quality threshold grids into the dormant evaluator. Exact issuance snapshots must replay production probability within floating-point tolerance; pre-snapshot history must be labeled reconstructed with coverage/error reported.
- [x] Add versioned expanding-window evaluation after 100 unique resolved settlement timestamps, repeating every 25 new windows. It uses five chronological folds, one fixed five-minute snapshot per asset/window, largest-edge selection within each correlated window, fee-aware return/Brier/log-loss/drawdown scoring, dataset fingerprints, and persisted history. Evaluation cannot promote production automatically. Automatic in-process scheduling was retired on 2026-08-23 after the 1,250-window run blocked the funded worker for nearly three minutes.
- [x] Run evaluator v2 checkpoints only through an explicit offline command. The collector has no evaluator dependency, and no same-event-loop timer replaces it. The command refuses active state/intent, reservations, or missing typed offline confirmation; operators pause/drain and stop the worker or use an isolated durable snapshot before invocation. The existing checkpoint sequence, fingerprint, atomic history, and v2 promotion ban remain unchanged. See `docs/offline-walk-forward-evaluation-design.md`.
- [x] Persist an immutable venue-specific contract/rules/reference registry, retain issuance fingerprints, resolve Polymarket/Kalshi independently, and exclude legacy/mismatched venue entries from walk-forward return scoring.
- [x] Prospectively verify provenance-bearing dual-venue resolution, including genuine cross-venue outcome disagreements with venue-specific scoring.
- [x] Parse and fingerprint explicit reference/settlement averaging windows, averaging method, and rounding precision; report Kraken-to-venue reference drift, sparse final-window path proxies against exact venue outcomes, and reasoned exact/approximate/not-comparable labels without changing production.
- [ ] Replace evaluator v2 before any model promotion: freeze a reproducible cohort manifest, replay the exact buy policy with candidate-selected side/provider/cost, add paired clustered return and continuous drawdown, and keep signal-policy return separate from a prospective simulated-execution lane. Quality candidates use only exact confidence-input rows. The 2026-08-20 review showed the current checkpoint fingerprint can drift after late resolution and the scorer inherits production's side while hard-coding stale price bounds.
- [~] Collect the first evaluator-v3 prospective probability foundation under `forecast-candidate-registry-v1`: six immutable production/calibration/settlement/slow-factor arms stamp exact issuance-time probability and funded-capable side/cost/policy decisions into the forecast journal without order or promotion authority. Activation began 2026-08-25; 10/100/300 independent-window wiring, outcome-coverage, and availability gates precede uncertainty-input work. Immutable V3 cohort manifests, candidate quality, paired scoring, and simulated execution remain pending. See `docs/forecast-model-and-evaluator-v3-design.md`.
- [ ] After the complete base-signal program freezes a retained or promoted version, prospectively evaluate confirmed-signal debounce/dwell and exact-provider identity under the five-arm family in `docs/confirmed-signal-evaluation-design.md`. Keep warm-up/cutoff/base policy fixed, classify economic selectors separately from safety invariants and diagnostics, require same-provider contract outcomes, and do not start confirmation collection concurrently with an unsettled base-signal candidate.
- [ ] After confirmed signal freezes, prospectively attribute the venue-candidate layer under `docs/venue-candidate-evaluation-design.md`: separate exact identity/quote/quantity safety from economic spread and implementation-shortfall selection, report every independent/duplicate/unavailable refusal, preserve displayed/construction/pre-submit/submitted/deployable value separately, and move sizing, portfolio, route, funding, and live authorization out of the venue-attractiveness claim. Attribution may choose a later new-outcome family and cannot promote a threshold selected from its own cohort.
- [ ] After venue candidacy freezes, prospectively evaluate portfolio selection under `docs/portfolio-selection-evaluation-design.md`: preserve `portfolio-choice-set-v1` as an issued-order integrity sentinel, add a separate complete no-order-inclusive calculation cohort, prove exact greedy-control parity, compare exhaustive optimization under production's own objective, attribute active/inert penalties and hard ceilings, and measure eligibility ordering plus reranking after later skips. Any focused candidate starts a new cohort whose arms maintain independent causal shadow portfolios; loosening a hard exposure ceiling remains a separate capital/downside decision.
- [ ] After portfolio selection freezes, prospectively evaluate live authorization under `docs/live-authorization-evaluation-design.md`: preserve `live-skip-v1` as a first-blocker journal, add a separate complete simultaneous authority manifest for every portfolio-selected candidate, stamp control/provider/budget/reconciliation generations and authority ages, and fault-test pause, kill, reconciliation, funding, identity, wire, crash, uncertainty, and guarded-recovery boundaries. Safety repairs use fault evidence rather than return; capital loosening and late economic/lifecycle gates remain separate programs.
- [ ] After live authorization freezes, prospectively evaluate attempt and outcome under `docs/attempt-outcome-evaluation-design.md`: project current behavior into separate intent, venue-order, position, and cash states; preserve the shared order and budget ledgers as authority; type every refusal, acceptance, zero/partial/full fill, uncertainty/recovery, exit, settlement, and invalid outcome; and fault-test the complete durable-intent-to-cash lifecycle. Safety/accounting repairs use invariant evidence; any economic management family starts a new intent-to-treat cohort and cannot loosen capital or authority.
- [x] Add an immutable model registry with quiescent, audited manual promotion and rollback; automatic evaluation and LLM research must have no promotion capability. `POST /api/model/promotion` is the only write path, guarded as in [`trading-risk-and-budget.md` §7](trading-risk-and-budget.md#7-security-and-trading-controls), and may record only the model the running code actually forecasts with.
- [x] Add side-aware DOWN/NO paper and live entries from executable NO asks, with signed Kalshi order translation, side-specific persistence/settlement/reconciliation/reporting, and no implicit reversal through SELL.
- [x] Multi-year Kraken weekly OHLC backfill for same-month seasonality, with neutral output when genuine prior-year samples are insufficient.
- [ ] Stronger news/event pipeline and market microstructure features.

### Phase 3 — Venue/account read integrations
- [x] Add the typed read-only trading-provider registry foundation with explicit market-data/paper/live capabilities, fail-closed planned providers, and immutable provider-variant identities in the dashboard payload. Durable generalized provider configuration and adapter interfaces remain below.
- [x] Add `TradingProviderAdapter` normalized contract/quote/account/order interfaces with explicit capability checks, plus an atomic durable `data/trading-providers.json` configuration mirrored fail-closed from the legacy Budget execution authority and a distinct read-only `/api/trading/providers` route.
- [x] Promote the provider store to `provider-registry-v1` authority through a one-time legacy migration. Provider mutations require authentication, same-origin, paused quiescent/restart-safe execution, explicit capability, exact variant identity, immutable audit, and typed confirmation for live enablement. Paper and live permissions are enforced separately; disabling live preserves paper and reduce-only lifecycle handling. The legacy Budget venue field is now a compatibility projection only.
- [ ] Versioned provider/model variants for contract semantics, fees, quote normalization, paper fill assumptions, and execution/reconciliation behavior; provider prices remain excluded from tradeable probability.
- [~] Crypto.com event-contract adapter is **not viable** and is withdrawn from this phase: Strike Options has no programmatic interface, no order book, and non-comparable settlement. See [`providers-and-market-data.md` §5 Crypto.com](providers-and-market-data.md#cryptocom). A spot/perpetual adapter belongs to a future market, not to `crypto-15m`.
- [ ] Add ForecastEx read/paper-first adapter after official exchange/broker API and eligibility verification.
- [~] Robinhood event-contract adapter is **not viable** and is withdrawn from this phase: the only official interface is a crypto-only Trading API, and its prediction markets are reported to route to Kalshi, which Money Noodle already trades directly. See [`providers-and-market-data.md` §5 Robinhood](providers-and-market-data.md#robinhood). Its crypto API belongs to a future market.
- [ ] Fan every configured provider variant into an isolated continuous paper track with exact provider-contract settlement and variant-specific P&L.
- [x] Polymarket authenticated CLOB collateral-balance and open-order connector plus public position monitoring.
- [x] Batched public Polymarket CLOB UP/DOWN books for actionable asks.
- [x] Polymarket normalized public CLOB order-book reads.
- [ ] Polymarket private fill reconciliation and live execution.
- [x] Kalshi public 15-minute market reads.
- [x] Approximate cross-venue probability comparison with oracle mismatch labeling.
- [x] Kalshi read-only balance, position, and resting-order monitoring when credentials are configured.
- [x] Initial read-only Polymarket/Kalshi account panel (public wallet positions for Polymarket).
- [ ] Fully normalized unified portfolio, historical fills, and P&L reconciliation.
- [ ] Dashboard filters for live/paper track, provider, provider/model variant, and policy version across signals, open orders, performance, and decision history.
- [x] Add the initial read-only Policy surface with an always-visible v13 badge, active forecast/buy/execution/exit/switch/regime/provider-variant versions, exact thresholds, activation times, evidence links, and immutable v11–v13 buy-policy history.
- [ ] Back the Policy surface with a durable generalized policy registry containing complete parameter diffs, dataset fingerprints, operator promotion/rollback audit events, and all pre-v11 legacy versions.

### Phase 4 — Paper then live trading
- [x] Durable working-budget ledger with signed Kalshi total-budget verification and fixed all-in per-purchase sizing.
- [x] Pause/resume/depleted state machine and audit events.
- [x] Initial account-funding readiness checks for enabled venues.
- [x] Independent Polymarket/Kalshi enablement with at-least-one validation and enabled-only execution guards.
- [x] Generalize authoritative research/paper/live permissions to each registered trading provider, with separate Budget UI toggles and fail-closed planned providers. Current capability still permits live only on Kalshi; adding a provider capability remains a separate adapter/promotion task.
- [x] Budget/trading control UI with explicit execution-capability status.
- [x] Deterministic paper risk engine, actionable venue selection, idempotent order ledger, settlement, and Budget UI.
- [x] Paper mode using durable reservation/settlement hooks and automated 15-second processing.
- [x] Deterministic failure-injection reconciliation tests for lost responses/cancellations, malformed history, amendment chains, partial fills/exits, cash/position contradictions, and restart recovery.
- [ ] Historical execution replay/backtest harness distinct from the prospective walk-forward evaluator.
- [x] Start a prospective observation-only `persistence-two-consecutive-v1` candidate: two qualifying snapshots over 15 seconds versus production's three over 30, with exact Kalshi terms, production catch-up delay, ask outcome, empirical fill-weighted maker benchmark, policy-version scoping, and a 100-independent-incremental-window review floor. It cannot place an order, reserve budget, or promote itself.
- [x] Add `calendar-effects-v1`: a non-pruned fixed-five-minute forecast for every exact Kalshi asset/window plus one current-policy candidate or explicit no-candidate marker per settlement window, with policy-scoped time-band/weekday reporting and manual review locks. It cannot gate, size, reserve, trade, or promote.
- [x] Explicitly armed, audited live Kalshi v2 maker limits with fractional sizing, fee reconciliation, stake/rate caps, cancel, and kill switch.
- [x] Reduce-only Kalshi switch exits with liquidation-loss-aware valuation and partial-exit protection.
- [x] Persist prospective entry quote/reprice/cancel/fill paths plus complete open-position executable liquidation snapshots, including immutable issuance/submission/fill prices, displayed-depth queue proxies, high-water state, probability/quality, basis/regime/clock, and sampled HOLD counterfactuals.
- [~] Add observation-only unified HOLD/EXIT/SWITCH/BUY ranking by risk-adjusted incremental expected cents and report exit-versus-hold outcomes by independent window. `action-counterfactual-v1` reports every action against the alternative it rejected, per policy and per independent window. The unified live ranking of candidate actions is not implemented.
- [~] Run a separately versioned paper buy-and-hold versus buy-plus-exit policy before changing live behavior. The comparison is implemented and reported over both paper and live history; a separately versioned parallel paper policy track that trades buy-and-hold alongside buy-plus-exit does not exist, so the comparison remains a counterfactual on one executed track rather than two independently executed ones.
- [ ] After held-out validation and budget-epoch/loss-gate completion, add tightly limited standalone live Kalshi reduce-only exits with mature signals, durable IDs, IOC price bounds, partial-fill protection, reconciliation, and same-window no-reentry.
- [x] Durable startup, manual, and periodic accepted-request/lost-response reconciliation against complete Kalshi cash, orders, fills, resting orders, and positions.
- [x] Guarded auto-resume for eligible system suspensions plus quiescent Pause/drain with restart-safe verification.
- [x] Reconciliation, periodic-failure, guarded-recovery, and execution-drain status UI.
- [x] Add non-auto-resumable current-budget and lifetime-live loss breakers; deploy with live paused and both limits blocking Resume on the observed ledger.
- [x] Replace the v4 whole-window maker-miss lock with at most three v5 entry episodes. Every later episode requires the ordinary persistence checks entirely after authoritative maker completion, without requiring a nonqualifying gap; any fill or non-maker terminal result ends rearming.
- [x] Apply the same episode identity and post-completion persistence boundary to the independent paper maker simulation. A 2026-08-21 audit found that v4 production rows carried paper-simulator and shared route identities while generation validation read the latter, suppressing every paper episode after episode 1. `paper-managed-execution-route-ioc-requalify3-v5` now validates lane-owned generation, and production-shaped tests retain both fields; see `reports/paper-live-mirror-fidelity-2026-08-21.md`.
- [ ] Complete the engine-level regression fixture for bounded post-DELETE polling and the fallback uncertain/reconciliation path; unit polling and fail-closed tests are implemented.
- [x] Correct live execution summary `startingCents` to use configured starting allocation rather than current working equity.
- [x] Correct entry-price report bands below 25¢ and above 75¢ without rewriting raw records.
- [ ] Add durable budget epochs, current-epoch/lifetime-live reporting, loss/drawdown circuit breakers, and explicit evidence gates for any stake increase.
- [ ] Enforce same-origin/CSRF checks on every mutation and billable research route.
- [ ] Operator fill/order/settlement alerts.
- [~] New paper/live entry orders now store provider, provider-variant, forecast-model, buy-policy, and execution-policy identities. Remaining work adds these identities consistently to exit/switch/regime audit and evaluation records, with safe legacy migration labels.
- [ ] Demo/sandbox venue testing where supported.

### Phase 5 — Portability
- [ ] MongoDB repositories and migrations.
- [x] Local in-process 15-second background collector with singleton startup, health state, and browser-polling fallback.
- [ ] Durable production workers/queues for ingestion and model evaluation.
- [ ] Versioned backups and tested restore procedures for forecast, execution, audit, configuration, and evaluation data.
- [ ] Authentication and deployment hardening if moved off local machine.

## 11. Initial acceptance criteria

1. Landing page lists all currently discoverable Polymarket crypto 15m markets without hardcoded probabilities.
2. Each card separately shows venue and model probability, edge, confidence, close time, price chart, and action state.
3. A drill-down exposes all six initial factors and marks unavailable seasonality honestly.
4. Refresh updates server data and local cache; stale use is visible.
5. An upstream partial failure degrades locally rather than producing invented values.
6. The production build and TypeScript check pass.
7. Every qualifying active-policy expected-value update is durably recorded at most once per provider variant/contract/15-second bucket with selected entry side and side-specific actionable prices; legacy rows remain immutable and version-labeled.
8. Final venue outcomes resolve records without altering the original forecast snapshot.
9. Accuracy excludes pending/invalid records and reports sample size beside every metric.
10. A $100 total budget with a $1 all-in purchase size never spends more than $1 on principal plus fees; reservation does not change equity, and unused maker-order reserve returns without changing P&L.
11. New paper orders are blocked while unconfigured, depleted, stale, duplicated, disconnected, underfunded, too wide, too near close, above exposure limits, or unable to buy the venue's minimum supported quantity.
12. Budget configuration, control-state transitions, reservations, settlements, and rejected resumes are durably audited.
