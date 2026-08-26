# Product and surfaces

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-26
> **Canonical for:** users, jobs, prediction/research/account surfaces, trading surface semantics, and provider controls.  
> **Read with:** [`SPEC.md`](../SPEC.md) and the domain module governing any behavior exposed by the surface.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

<a id="req-product-users-jobs"></a>

## 2. Users and jobs

Primary user: a single local investor/researcher.

Core jobs:
- Scan all current 15-minute crypto markets in seconds.
- See whether the model agrees with each normalized trading provider and by how much.
- Understand which factors drive a forecast.
- Research a market or asset with current, cited context across multiple LLM providers.
- Compare venue price, fees, spread, liquidity, and expected value.
- Monitor balances, positions, fills, P&L, and exposure.
- Place a controlled trade without leaving the research workflow.

<a id="req-product-surfaces"></a>

## 3. Product surfaces

<a id="req-product-predictions"></a>

### 3.1 Predictions (initial landing page)

For each active Polymarket crypto 15-minute option:
- Asset, current price, and 24h change.
- Market UP/DOWN probability.
- Money Noodle UP probability.
- Edge: `model probability − venue UP probability`.
- Action state: `UP`, `DOWN`, `WATCH`, or `PASS`.
- Confidence and time to market close.
- Compact seven-day price chart.
- Visible factor strip and full factor drill-down.
- Every qualifying positive-edge buy calculation shows Money Noodle’s venue-independent UP likelihood beside current raw Polymarket and approximately comparable Kalshi UP/DOWN probabilities, then selects either the actionable UP/YES ask against `P(UP)` or DOWN/NO ask against `1 − P(UP)`. Reduce-only HOLD/EXIT/SWITCH actions for owned positions remain a separate portfolio policy.
- Positive-edge calculations clear after one 15-second observation window even if refresh is delayed or fails. The section shows exact calculation time, live age, and an explicit expired state.
- Positive-edge and prediction cards reserve stable minimum height. Once observed in the mounted dashboard, a signal that stops qualifying keeps its last qualified snapshot with an explicit expired indication until its market closes; only the market-window close starts the short opacity/blur removal transition. Re-entry before close replaces the retained snapshot and clears the expired state. This is browser-session display state, not durable evidence. Signed awaiting-confirmation signals are visible by default rather than hidden behind a collapsed count.
- Each signed, stateful positive-edge card with a Kalshi contract may expand an observation-only selected-side ladder showing bid/ask price, displayed level quantity, cumulative displayed quantity, spread, observation time, and age. At most one ladder polls, every two seconds measured after request completion, and reads pause in a hidden tab. The authenticated route is unavailable on stateless hosts; the public dashboard exposes no ladder. UI reads are uncached and isolated from the execution depth cache, so opening a ladder cannot change forecast, edge qualification, ranking, portfolio choice, sizing, fill evidence, reconciliation, or orders.
- A collapsed-by-default debugging region showing directional-likelihood and model-confidence calculations for every market, including below-gate calculations, current raw venue probabilities, threshold margins, confidence components, and ranking strength.
- Link to the source market.
- For an owned UP/YES or DOWN/NO position, show a separate reduce-only recommendation state: `HOLD`, `EXIT TO CASH`, or `SWITCH`. These are portfolio actions, not new directional entries, and must display executable proceeds plus the no-action comparison.

Global controls:
- Live/stale source status.
- Last-updated timestamp and manual refresh.
- A data-freshness and runtime-cadence dialog separates input cache TTLs from task clocks. A shared descriptive registry exposes each task's interval or on-demand/bounded cadence, activation condition, purpose, request cost, last run, and process-local health for dashboard prefetch, 15-second edge observation, exact pre-submit quotes, managed makers, long-shot entry/trailing/exit watches, and reconciliation. The registry never dispatches work: calculation, execution, and reconciliation retain independent timers and queues, and worker-only tasks remain unavailable on stateless hosts.
- Each signed open-order row shows the latest valid owned-side venue bid and ask, its observation age, and a stale state. It reads the execution engine's existing managed-order/open-position observations and refreshes with the existing signed control payload; display adds no venue request, polling loop, durable field, pricing input, or execution authority.
- Ranking by signal strength by default.
- Filters: execution track (`live`, `paper`, or both), trading provider, provider/model variant, asset, signal, confidence, liquidity, horizon, and policy version. Provider filters must apply consistently to current cards, open orders, decision history, and performance without combining live and paper results. Order-attribution filters use one shared identity vocabulary for provider, provider variant, market, forecast model, buy policy, and execution policy; selections within a dimension are OR and dimensions combine with AND. Historical provider and market identities may use their canonical legacy normalization, but a missing variant or policy identity is shown as `unattributed` and is never assigned to the current version. Filtering is presentation-only and cannot change forecast, ranking, eligibility, execution, budget, reconciliation, capability, or promotion state.
- An always-visible active-policy badge shows the current buy-policy version and selected-side floor. Expanding it opens a Policy view with the complete active forecast, buy, execution, exit, switch, regime-gate, and provider-variant versions; exact thresholds; activation time; rationale/evidence; and whether each component is production, paper, or observation-only.
- Policy history is immutable and chronological. It shows superseded versions, parameter diffs, activation/deactivation times, evidence reports and dataset fingerprints, operator promotion/rollback events, and linked order/performance cohorts. Viewing history cannot promote, roll back, arm, or trade.

<a id="req-product-prediction-detail"></a>

### 3.2 Prediction detail

- Full price chart and market countdown.
- Model versus every comparable trading-provider quote, with provider and variant identifiers visible.
- Every factor with direction, normalized score, weight, confidence, probability-point contribution, source, timestamp, and explanation.
- Relevant news with direct links.
- Model version and calculation notes.
- Historical forecast calibration and prior similar windows (future).
- Trade ticket (future, gated).

<a id="req-product-research"></a>

### 3.3 Research workspace

- Natural-language question input.
- Interactive multi-turn research chat with retained recent context, follow-up questions, per-answer provider/model/fallback metadata, cancellation, clear-chat control, and browser-local persistence. Every turn receives a fresh server dashboard snapshot.
- A provider-management view showing every supported provider, server-side configured status, durable enable/disable state, current provider, and editable model name. Secrets remain environment-only and are never returned to the browser.
- Automatic research uses the current enabled provider first and falls back through the remaining enabled providers; explicitly selected disabled providers are rejected server-side. Each automatic attempt has an 18-second limit and the full fallback chain has a 45-second hard deadline; an explicitly selected provider has 30 seconds. The browser cancels after 50 seconds and cancellation terminates Pi bridge children.
- Money Noodle discovers compatible providers authenticated in the local Pi registry and exposes them as server-side Pi bridge providers without copying OAuth tokens or API keys. Each isolated bridge call disables tools, sessions, extensions, skills, prompt templates, and context files; only the grounded research prompt is sent.
- Current dashboard snapshot, selected assets/markets, news, and account context as opt-in inputs.
- Answers contain source links, retrieval timestamps, assumptions, disagreement, and confidence.
- Implemented direct provider adapters: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, xAI, Mistral, DeepSeek, and local OpenAI-compatible Ollama servers, plus isolated Pi bridge providers discovered from the local Pi registry.
- API keys remain server-side and are never returned to the browser.

<a id="req-product-accounts"></a>

### 3.4 Accounts and portfolio (post-initial)

Per venue and consolidated:
- Available balance, buying power, positions, resting orders, fills, fees, realized/unrealized P&L.
- Exposure by asset, direction, venue, and expiry.
- Account synchronization health and last event timestamp.
- Alerts for fills, nearing expiry, stale orders, limits, and source disconnects.

<a id="req-product-trading"></a>

### 3.5 Trading (post-initial)

- Provider-normalized order previews, placement, cancellation, and status monitoring. The UI derives live capability
  from the provider × market registry intersection; every provider/market without independently promoted live
  implementation remains visibly unavailable and fail-closed.
- Trading-provider quote comparison normalized for exact contract semantics, fees, spread, quantity granularity, and estimated slippage.
- Default order type: limit.
- Required preview displays side, contracts, limit, maximum loss, estimated fee, estimated payout, edge, expiry, and account impact.
- Manual mode requires explicit final confirmation. A separate opt-in automated mode may submit qualified trades without per-order confirmation only while armed, funded, within all risk limits, and not paused.
- Selling is always reduce-only: it may close owned UP/YES or DOWN/NO quantity to cash or as the first leg of a protected switch, but cannot create or reverse exposure. New DOWN/NO exposure is opened only through the separately priced binary buy path.

<a id="req-product-provider-controls"></a>

### 3.5a Trading-provider and variant controls

- Distinguish trading providers from LLM research providers in navigation and labels.
- List Polymarket, Kalshi, Crypto.com, ForecastEx, and Robinhood with separate read health, paper capability, live capability, account readiness, environment, and last reconciliation state.
- Allow each provider's live eligibility to be enabled or disabled independently while quiescent. Newly added providers default disabled; a visible quote, paper history, or configured credential is never sufficient to enable live.
- List every provider/model variant with its semantic/execution version, paper status, resolved windows, return, drawdown, and promotion state. All variants run in paper; only manually promoted provider/variant combinations may become live-eligible.
- Dashboard and history filters may select one or many providers/variants but must retain separate denominators and never merge paper and live P&L into one performance number.
