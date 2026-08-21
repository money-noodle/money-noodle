# Money Noodle — Living Product Specification

> **Status:** Draft 0.44 · **Updated:** 2026-08-20
> This is the source of truth for product scope, architecture, model behavior, and safety decisions. Update the decision log whenever a requirement changes. Current implementation progress is tracked separately in [`STATUS.md`](STATUS.md).

## 1. Product statement

Money Noodle is a personal, self-hosted crypto research and prediction terminal. It combines live prediction-market prices, crypto market data, historical/seasonal features, news, and optional LLM research into transparent forecasts for short- and long-horizon investing decisions.

The primary decision surface is active crypto **15-minute Up/Down markets** normalized across supported trading providers. Polymarket and Kalshi are implemented; Crypto.com, ForecastEx, and Robinhood are planned as read/paper-first provider integrations. Account monitoring, continuous paper shadow trading, and explicitly armed Kalshi automation are implemented; every additional provider remains live-disabled until its official API, eligibility, contract semantics, signing, funding, order lifecycle, and reconciliation behavior pass the same safety gates.

### Principles

1. **Evidence before output:** every claim and factor identifies its source, timestamp, and availability.
2. **No false precision:** unavailable data stays neutral and visibly unavailable; it is never replaced with invented history.
3. **Model and market remain distinct:** market-implied probability, model probability, and their edge are always separately labeled.
4. **Personal by default, portable later:** the persistent worker keeps cache/storage under the operator’s control, while repository interfaces can later move it to a durable database.
5. **Safe execution:** research is the default. Trading requires explicit credentials, limits, preview, and confirmation.
6. **Fast to act on, easy to audit:** overview cards support scanning; drill-downs expose every input and calculation.

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

## 3. Product surfaces

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
- Filters: execution track (`live`, `paper`, or both), trading provider, provider/model variant, asset, signal, confidence, liquidity, horizon, and policy version. Provider filters must apply consistently to current cards, open orders, decision history, and performance without combining live and paper results.
- An always-visible active-policy badge shows the current buy-policy version and selected-side floor. Expanding it opens a Policy view with the complete active forecast, buy, execution, exit, switch, regime-gate, and provider-variant versions; exact thresholds; activation time; rationale/evidence; and whether each component is production, paper, or observation-only.
- Policy history is immutable and chronological. It shows superseded versions, parameter diffs, activation/deactivation times, evidence reports and dataset fingerprints, operator promotion/rollback events, and linked order/performance cohorts. Viewing history cannot promote, roll back, arm, or trade.

### 3.2 Prediction detail

- Full price chart and market countdown.
- Model versus every comparable trading-provider quote, with provider and variant identifiers visible.
- Every factor with direction, normalized score, weight, confidence, probability-point contribution, source, timestamp, and explanation.
- Relevant news with direct links.
- Model version and calculation notes.
- Historical forecast calibration and prior similar windows (future).
- Trade ticket (future, gated).

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

### 3.4 Accounts and portfolio (post-initial)

Per venue and consolidated:
- Available balance, buying power, positions, resting orders, fills, fees, realized/unrealized P&L.
- Exposure by asset, direction, venue, and expiry.
- Account synchronization health and last event timestamp.
- Alerts for fills, nearing expiry, stale orders, limits, and source disconnects.

### 3.5 Trading (post-initial)

- Provider-normalized order previews, placement, cancellation, and status monitoring. Kalshi is the only currently live-enabled provider; Polymarket, Crypto.com, ForecastEx, and Robinhood require separate capability promotion.
- Trading-provider quote comparison normalized for exact contract semantics, fees, spread, quantity granularity, and estimated slippage.
- Default order type: limit.
- Required preview displays side, contracts, limit, maximum loss, estimated fee, estimated payout, edge, expiry, and account impact.
- Manual mode requires explicit final confirmation. A separate opt-in automated mode may submit qualified trades without per-order confirmation only while armed, funded, within all risk limits, and not paused.
- Selling is always reduce-only: it may close owned UP/YES or DOWN/NO quantity to cash or as the first leg of a protected switch, but cannot create or reverse exposure. New DOWN/NO exposure is opened only through the separately priced binary buy path.

### 3.5a Trading-provider and variant controls

- Distinguish trading providers from LLM research providers in navigation and labels.
- List Polymarket, Kalshi, Crypto.com, ForecastEx, and Robinhood with separate read health, paper capability, live capability, account readiness, environment, and last reconciliation state.
- Allow each provider's live eligibility to be enabled or disabled independently while quiescent. Newly added providers default disabled; a visible quote, paper history, or configured credential is never sufficient to enable live.
- List every provider/model variant with its semantic/execution version, paper status, resolved windows, return, drawdown, and promotion state. All variants run in paper; only manually promoted provider/variant combinations may become live-eligible.
- Dashboard and history filters may select one or many providers/variants but must retain separate denominators and never merge paper and live P&L into one performance number.

### 3.6 Budget and automated-trading control

The trading system has an independent durable working-budget ledger. A venue account balance never silently increases this budget; the user explicitly allocates the amount that automation may risk.

#### Markets and keying rules

A **market** is an instrument class plus a horizon and settlement semantics — currently one: `crypto-15m`, the 15-minute Up/Down contract settling against the cycle-open reference. Every budget, order, policy row, and reported summary carries an explicit `marketId`, so a second market is additive rather than a migration.

Four things vary along four different axes, and each is keyed to what it actually depends on:

| Concern | Keyed by | Why |
| --- | --- | --- |
| Budget | provider, allocated by percentage across that provider's enabled markets | Cash is not fungible across providers. Funds physically sit in a provider account and cannot fund an order elsewhere, so a combined spendable pool would authorize trades that cannot settle. |
| Forecast model and calibration | market | The diffusion engine takes threshold, horizon, and volatility as parameters and is shared, but fitted parameters, drift assumptions, and settlement corrections are horizon-specific. Every provider in a market reports the **identical** probability, which is what makes one probability against several prices a meaningful comparison. |
| Policy — entry thresholds, sizing, execution style | provider × market | These depend on that venue's fees, tick/quantity rules, and market structure. |
| Position and correlation caps | market, global across providers | Risk is exposure to the underlying, not to a venue. Keying these per provider would let each provider hold a full allowance of the same correlated window, silently multiplying intended exposure. |

Market allocations are a percentage of **current provider equity** (available plus reserved plus realized P&L), so a market's cap compounds with wins and contracts in drawdown without manual edits. Allocations are hard caps, must sum to no more than 100% of a provider's enabled markets, and any unallocated remainder stays uncommitted. A market's spendable amount is its own cap minus its own reservations, never the provider's total available cash.

Provider capability is declared per **(provider, market)** pair. A single capability triple per provider cannot express a provider that supports live trading on one market and nothing on another, which is the normal case rather than the exception.

Live candidate selection treats funding as a feasibility filter and price as the objective, in this order: shared forecast; per-provider policy gates; per-provider hard readiness gates; per-(provider, market) funding; global exposure caps; then rank surviving candidates by expected dollar contribution **at the size each provider can actually fill**. Narrowing to a single best-priced venue before the funding check would forfeit trades another provider could have taken, and comparing edge per contract rather than expected profit at fundable size prefers a fatter edge on a stake that cannot be placed. Provider reliability is a hard gate, never a ranking weight; an explicit cents margin expresses venue preference so a negligible price difference cannot flip venues on noise.

#### Budget model

- Store configured budget and conservative reservations as integer cents; retain venue-authoritative principal, fee, fill-price, quantity, and P&L fields at exact fractional-cent precision. UI may display dollars.
- Track starting budget, available budget, reserved/open-trade budget, realized P&L, and current working equity **per provider**, and report each market's allocated cap and its own reservations within that provider.
- The user configures a **live budget per provider**, a **percentage allocation per enabled market** within that provider, and a fixed **all-in amount per purchase**. The purchase amount includes contract principal and venue fees and never exceeds the market's allocated cap, the provider's available budget, or environment stake limits.
- When Kalshi is enabled, saving verifies the total live budget against the signed available Kalshi cash balance.
- Execution chooses the largest supported quantity whose principal plus conservative fee reserve fits under the per-purchase cap. Kalshi v2 uses 0.01-contract increments; Polymarket remains whole-contract only. Venue-reported fill prices and fees replace estimates, and unused reserve is released without artificial P&L.
- Order placement reserves planned all-in spend; settlement releases payout and applies `payout − actual stake` to realized P&L.
- Budget changes are allowed only while paused and with no unresolved reservation conflict. Every configuration creates a durable budget epoch; reservations, orders, fills, settlements, and reconciliation adjustments retain that epoch ID. Current-epoch P&L may restart, but closed-epoch and lifetime-live results are immutable and remain separately reportable. Every change is audited.

#### Account funding

- Every trading provider has an independent durable `liveEnabled` control. Research visibility and paper tracking remain separate controls; disabling live must not hide quotes or stop paper variants.
- At least one provider must remain visible for research/paper operation, but zero providers may be live-enabled. Automation may resume only when at least one explicitly live-enabled provider is trade ready. Because live execution currently supports Kalshi only, signed Kalshi available cash must cover the uncommitted live budget.
- A live-enabled provider must have an authenticated/readable account connector plus an independently verified placement, cancellation, fill, position, cash, and reconciliation path. Disabled or currently unready providers are never selected for new live orders.
- Live enablement is fail-closed and provider-specific: adding credentials does not enable live, enabling one provider never enables another, and provider/variant changes require quiescent pause plus authoritative reconciliation.
- Global and correlation exposure limits apply across providers. The same economic contract cannot be bought twice merely because two providers or variants expose it, and opposite exposure still requires the protected reduce-only switch path.
- Saving a Kalshi budget verifies the total allocation against venue cash. Before each order, Kalshi must also cover the planned all-in reservation.
- Public profile or position data alone does not count as a trade-ready connector. Signing capability, collateral/allowance state, and venue environment must be validated.
- Funds remain at the venues; Money Noodle stores a risk allocation ledger, not custody.
- Kalshi setup uses a dedicated API key ID plus an RSA private-key PEM path held outside the repository. The Budget UI reports demo/production environment, signed connectivity, cash balance, setup steps, and a connection retest without returning credentials to the browser.

#### Pause/resume state machine

- States: `unconfigured`, `paused`, `active`, and `depleted`.
- Automation starts paused and is off by default.
- Pause immediately withdraws active operator intent and blocks new candidate selection, then enters `draining`: wait behind the serialized execution queue, cancel and confirm every managed remainder, run authoritative order/fill/position/cash/reservation reconciliation, and verify zero pending/uncertain entry or exit intents. Only then may the API/UI report `paused · quiescent · restart safe`. Filled positions may remain durably open and reserved while monitoring and settlement continue.
- Resume requires configured total/per-purchase budgets, fresh account balances, connector health, risk-limit checks, and an available execution engine.
- When working equity reaches zero, automation enters `depleted`, blocks all new orders, and cannot resume until the user pauses/reconfigures with a new positive budget.
- A global kill switch supersedes resume. Stale market/account data, failed reconciliation, venue disconnect, or a configured current-epoch/lifetime realized-loss or drawdown limit blocks new trading. Reconfiguration cannot silently erase the evidence used by lifetime safety limits.
- Paper mode uses the same buy rule and relative sizing policy as production live execution while retaining track-specific execution/fills and a completely separate bankroll, ledger, P&L, and report. It is not serialized to live's one-order execution path: each cycle may submit every paper-selected candidate that fits the same portfolio, correlation, bankroll, and provider-funding constraints.
- Kalshi paper maker execution refreshes the exact contract independently at submission, uses the same pure initial-price and progressive-repricing state machine as live, and polls every two seconds over the same six-check managed horizon concurrently with live order management. It keeps live's issuance-sized quantity rather than buying extra paper quantity at the cheaper bid. Fill simulation consumes opposite-outcome public taker trade prints against displayed queue-ahead volume; a sampled ask touch by itself is never a fill. Missing terminal trade evidence excludes the attempt instead of manufacturing a miss. A separate matched-live overlay records authoritative live quantity, price, and fee on contemporaneous paper intents, capped at both observed live fill and paper-requested quantity, without changing independent paper status, bankroll, or P&L.
- Every configured provider/model variant runs continuously in paper, even when that provider is live-disabled. Variant bankroll/accounting is logically isolated so one variant cannot consume another's opportunity or conceal its return; an additional consolidated view may aggregate only after preserving provider, variant, policy, and independent-window labels.

#### Paper execution engine

- The 15-second background cycle settles due paper positions before evaluating new entries, including while automation is paused.
- Entries use the active versioned buy policy and calculations generated no more than 15 seconds ago. Side-specific persistence prevents UP evidence from authorizing DOWN and vice versa; direct portfolio selection cannot hold both sides of one asset/window.
- Paper evaluation fans each normalized market observation out to every eligible provider/model variant. Each paper order stores `providerId`, `providerVariantId`, contract-target version, forecast-model version, buy-policy version, execution-policy version, and exact provider contract provenance. Variants may share the same independent forecast inputs but must settle and score against their own exact provider contract.
- Venue selection is limited to enabled, authenticated, funded venues and ranks the selected side's executable ask after spread and estimated fees. Missing side-specific bids/asks, asks outside 5¢ through 97¢, spreads above 10¢, entry inside the final 30 seconds, insufficient venue cash, or an inability to buy the venue's minimum quantity fail closed. The entry cutoff was 120 seconds until buy policy v20.
- Paper fills mirror venue quantity granularity, including 0.01-contract Kalshi quantities, using the same explicit all-in purchase cap against a separate bankroll, conservative estimated fees, the configured open-position and correlation caps, durable states, and idempotent budget hooks.
- Venue outcomes settle the reserved stake to payout and realized P&L. Unsupported final outcomes return the paper stake as invalid rather than manufacturing a win or loss.
- The ordinary paper ledger never pauses or resumes live automation. It runs continuously until its independent bankroll is depleted; any paper reset is explicit and cannot mutate the live budget, ledger, intent, or P&L. A separately approved, bankroll-independent adaptive regime sentinel may soft-gate **new live entries only**; this does not mutate paper/live cash, operator intent, or the automation state.
- The adaptive regime sentinel records at most one highest-edge, exact-Kalshi-contract policy-v11 recommendation per correlated settlement timestamp after every ordinary probability, quality, price, persistence, warm-up, spread, and final-cutoff gate passes. It measures bounded fee-aware realized edge per $1 payout, exponentially discounts older settlement windows with a configurable evidence half-life, learns empirical variance/effective sample size, and remains permissive during a configurable current-policy warm-up. At 99% default confidence of negative recent return it closes the soft entry gate; it automatically reopens below 75% negative confidence. Policy changes start a fresh evidence generation. Closed state retains active operator intent and continues sentinel collection, reconciliation, position monitoring, and reduce-only exits, but prohibits entries and switches that require replacement exposure. Manual Pause and hard economic loss breakers retain their stricter non-auto-resume semantics.
- Live Kalshi entry receives at most three episodes per asset/side/window. Below 30pp issuance net edge an episode uses the managed v2 `post_only` GTC selected-side bid: YES entries map to Kalshi YES-book bids; NO entries map to signed YES-book asks while limits, costs, fills, P&L, and UI remain selected-side denominated. Maker joins/improves the selected-side bid over 12 seconds, amends without crossing the issuance cap, confirms remainder cancellation, accepts partial fills, and reconciles exact fees. An authoritative current-policy maker zero-fill ends that episode but may rearm the next one after the ordinary two qualifying snapshots over 15 seconds are observed strictly after maker completion. No intervening nonqualifying observation is required. Any fill, working or uncertain state, rejection, taker result, stale-policy row, or episode 3 ends rearming.
- The v5 maker/taker policy reruns routing for every episode. It spends the spread only when both current issuance and refreshed taker net edge are at least 30pp after fees, persistence-median edge is at least 10pp, quality at least 65%, and selected-side spread no wider than 2¢. The old maker-sample and `makerNetEdge × fillRate` comparative gates are reporting-only because measured maker fills are outcome-selected rather than random capture. The taker is a marketable IOC **limit**, never an uncapped market order; it accepts at most 1.0¢ ask movement from issuance, capped again at the 97¢ entry ceiling, and reserves quantity plus fees at the worst permitted price. A fresh gate failure, movement beyond 1¢, or accepted IOC no-fill ends the whole logical sequence; there is no taker fallback. Paper retains its independent managed-maker simulation under its own v3 identity but uses the same three-episode requalification boundary. See `docs/high-edge-execution-reduced-sizing-design.md` and `docs/requalifying-entry-episodes-design.md`.
- Edge-entry sizing is `entry-sizing-reduce30-below-edge30-v1`: below 30pp, quantize the track's current base all-in ticket to `ceil(base × 0.30 − 1e-9)`; at 30pp+ retain 1× base. There is no arbitrary minimum and no multiplier above one. If the sized cap cannot fund the venue minimum quantity plus conservative fee reserve, refuse the order. Every new order stamps base cap, issuance edge, multiplier, and sized cap. Existing funding, stake, cash, rate, position, correlation, live-risk, and reconciliation ceilings remain binding.
- `entry-direction-observation-v1` records the issuance ask, fresh pre-submit ask, and first zero-fill management ask on maker paths, classifying the precommitted one-cent refusal/cancel candidates. Those fields are prospective reporting evidence only: production pricing, sizing, routing, management, cancellation, budgets, and reconciliation may neither import nor read the candidate decisions.
- Cancellation confirmation tolerates Kalshi's bounded read-after-delete consistency delay without assuming success. Poll authoritative order status after DELETE for a short bounded window and confirm terminal `canceled` status, zero remainder, absence from the complete resting-order collection, and refreshed fills. Unknown/resting status, nonzero remainder, contradictory fills/positions, or expiry of the confirmation window still fails closed and triggers full reconciliation.
- Persist every entry episode separately for authoritative recovery and execution evidence, but group live-ledger presentation by stable asset/window intent. Episode 1 retains the base ID and later v5 episodes use `:episode:2` and `:episode:3`, stamping the predecessor and episode number. Distinguish `post-only race` (never accepted, no spend), `rested · no fill` (accepted, then canceled), pre-submit refusal, and accepted IOC no-fill. Historical multi-attempt generations retain their immutable `:retry:` linkage and labels but cannot authorize a current episode.
- Every new paper/live order durably captures an immutable `entry-decision-v1` snapshot joining edge-buy evidence to execution: provider/variant identity, policy/calculation identity, UP/DOWN and selected-side probabilities, confidence breakdown, actionable bid/ask, fee, spread, net edge, persistence count/median edge, contract-basis inputs, calibration replay, settlement-average observation, and full factor explanations. Open positions expose this evidence inline. A separately loaded, paginated `/api/trading/history` view combines the same decision snapshot with attempts, fill terms, current/terminal status, outcome, and P&L without inflating the dashboard polling payload. It supports execution-track, provider, variant, and policy-version filters. Legacy orders reconstruct core values and are labeled when richer issuance evidence predates persistence.
- Raw positive-edge signals remain visible and tracked immediately, but paper/live execution uses a durable maturity gate: first 90 seconds blocked; current snapshot qualified; at least 2 qualifying snapshots spanning 15 seconds (3 over 30 until v21); median net edge at least −5pp; current quality at least 50%; and no new entry in the final 30 seconds. **v21 promoted `persistence-two-consecutive-v1`: two qualifying snapshots spanning 15 seconds, not three spanning 30.** **v20 widened all three of the edge bounds and the cutoff**: the floor moved from 5pp to −5pp, the 35pp ceiling was disarmed, and the cutoff from 120 to 30 seconds, on a measured increment of 686 decisions returning +20.2% stake-weighted and positive on 8 of 8 days. The operational risk the measurement does not cover — a maker order placed with 30 seconds left cannot reprice, retry, or exit — is recorded in the manifest entry. A failed current snapshot resets persistence, and repeated processing of one timestamp cannot manufacture observations. The warm-up increased from 60 to 90 seconds after the 2026-08-11 timing review found the 60–90-second live cohort materially weak; the change does not alter the model or persistence requirements.
- Signal qualification, execution readiness, venue attempt, and actual position are separate UI states. Each current card is joined to the exact live asset/contract order so unfilled/rejected maker attempts are never presented as open positions, and the automation skip reason distinguishes absent edge from already-attempted signals.
- Live execution has a hard startup reconciliation barrier. Before any new live order, fetch complete paginated Kalshi cash, positions, orders, fills, and resting orders; match durable client and venue IDs; cancel and confirm Money Noodle resting remainders; recover missing/partial entry and reduce-only fills; validate current position quantities; and align whole-cent local reservations without manufacturing P&L. Unknown managed orders, unrelated resting orders, malformed/incomplete history, contradictory positions, insufficient venue cash, or unconfirmed cancellation block and pause live automation.
- The same full reconciliation runs periodically every 300 seconds by default, configurable server-side and clamped to 60–3600 seconds. It is queued behind serialized execution, so no active managed order can be mistaken for orphaned resting risk. First periodic failure changes reconciliation to blocked and suppresses new orders, then retries after 30 seconds without changing the persisted automation state; a second consecutive failure safety-suspends and audits. A successful retry restores readiness, and unchanged successful periodic passes do not write redundant audit events.
- Persist explicit operator intent separately from operational state. Manual Pause/kill, reconfiguration, mode changes, depletion, and conservatively migrated legacy pauses withdraw auto-resume permission. System-originated transaction ambiguity or reconciliation failure may preserve active intent only if automation was active beforehand. A successful authoritative reconciliation is the verification trigger, but auto-resume additionally requires all ordinary resume blockers to be clear. A manual pause during suspension cancels pending auto-resume. No free-form pause-reason parsing may grant permission.
- Entry client intent is durable before submission, and the venue ID is persisted immediately after acceptance. Non-definitive request, schema, amend, cancellation, and exit errors use an `uncertain` state, retain the reservation, safety-suspend, and automatically launch authoritative reconciliation after the current serialized engine operation. Reconciliation retries through a 30-second Kalshi consistency window before treating an absent client ID as rejection. A system-originated suspension may guarded-auto-resume only when active operator intent was retained and every ordinary readiness check passes; manual/kill/configuration pauses never auto-resume. Only a definitively rejected post-only cross can release immediately.
- Aligned quarter-hour oracle paths are durably sampled once per 15-second bucket and produce observation-only sign-flip rate, lag-one autocorrelation, trend efficiency, range, cycle-local volatility, and regime labels. Issuance-time path prefixes are attached to forecast records for independent-window outcome analysis but are forbidden from production probability, confidence, ranking, and execution until validated.
- An observation-only settlement-average estimator explicitly models the final 60-second average. Before the window its Brownian effective variance is `σ²(T − 2W/3)`; inside the window it integrates observed log prices and assigns conditional future-integral variance `σ²r³/(3W²)`. It remains a benchmark and does not replace production `P(UP)` before held-out validation.
- A separate observation-only maker model estimates the probability that Kalshi's ask touches a passive bid during the 12-second managed-order horizon using quote-path volatility and Brownian first passage. It is stored on forecasts/orders and evaluated through an execution funnel that separates submission, post-only acknowledgement race, acceptance, rested no-fill, partial/full queue fill, and settlement. First-passage calibration is conditional on accepted orders; post-only races never count as queue non-fills. Resolved forecast outcomes supply counterfactual settlement results for accepted no-fill attempts without changing their zero-spend ledger state. Report `P(UP | fill)` versus `P(UP | accepted, no fill)`, net return, independent windows, and execution-condition segments. Ask touch is not equated with queue fill or profitability, and none of these estimates may affect gating or sizing before validation.
- Entry execution audit is prospective and immutable: preserve issuance bid/ask/spread and approved maximum separately from first submitted price, every refreshed quote and accepted/rejected reprice, cancellation timing, and authoritative average fill. Kalshi YES/NO ladders supply optional 20-level displayed-depth observations; selected-side size at the submitted level and better is a queue-ahead proxy, never exact priority. Missing depth cannot block an order. Every fresh open-position cycle records executable liquidation after fee, exact cost, unrealized return, independent probability/quality, basis/regime/clock, and displayed best-level depth. These paths are observation-only and cannot alter price, retry, size, selection, exit, or gate behavior.
- Standalone qualification and constrained portfolio selection are separate. Paper/live candidates are ranked by expected dollar profit after principal and fees, then constrained by a server-side configurable global position cap (default 3, hard maximum 10), a default two-position same-window cap, a default one-position-per-correlation-group/window cap, and configurable expected-cent penalties for correlated exposure. Live Kalshi selection requires the Kalshi quote itself to pass policy; edge available only on Polymarket cannot authorize a Kalshi order.
- Switches require hold-versus-liquidate-and-replace gain after all costs, configurable minimum gain plus uncertainty margin, a replacement-side probability at least 15pp above the owned side, three distinct qualifying snapshots spanning 30 seconds, minimum-delta hysteresis across that streak, a completed-switch cooldown, and no replacement after zero/partial exit. Same-asset UP↔DOWN reversals require at least a 20pp probability advantage as well as positive net future wealth. Completed switches retain the incumbent's eventual hold outcome and compare counterfactual hold P&L with combined exit-plus-replacement P&L.
- When all live slots are occupied, a new qualified candidate may replace an incumbent only if net liquidation value plus replacement expected profit exceeds the incumbent's current expected hold value by at least 1¢ after exit spread, exit fee, entry principal, and entry fee. A same-asset opposite-side candidate may enter this protected switch path before the portfolio is full, but can never be added alongside the incumbent and still must clear the stricter probability and future-wealth gates. Original entry cost is treated as sunk for the decision but retained for realized P&L.
- Switch exits are Kalshi v2 reduce-only IOC orders at the owned side's actionable bid: YES closes through a YES ask and NO closes through the complementary YES bid. A zero fill keeps the incumbent; a partial fill is reconciled and blocks the replacement; only a complete close may submit the replacement. Switching is disabled inside the final 120 seconds and limited to one completed switch per settlement window.
- The rolling hourly order ceiling counts unique Kalshi entry and exit orders with a nonzero fill. Local candidates, budget failures, schema/venue rejections, and accepted maker orders canceled with zero fill do not consume the ceiling. Switch execution requires room for two potential filled orders: reduce-only exit and replacement entry.

#### Reduce-only sell recommendations

`SELL` means reducing the side already owned; it never means opening or reversing exposure. A new DOWN/NO position is a separately qualified buy at the actionable NO ask. The recommendation engine evaluates four portfolio actions under one expected-wealth scale:

- **HOLD:** retain the incumbent to settlement.
- **EXIT TO CASH:** initially attempt to close the full remaining held quantity without replacement; partial fills are reconciled execution outcomes, not an invitation to reverse or over-sell.
- **SWITCH:** sell the incumbent and conditionally buy a superior selected replacement.
- **BUY:** add a selected position when budget and exposure capacity allow.

For held quantity `q` and owned-side probability `P(side)` (`P(UP)` or `1 − P(UP)`), expected hold payout is `H = q × 100¢ × P(side)`. Executable liquidation is `L = q × owned-side actionable bid − exit fee`, adjusted for available depth and partial-fill risk. Entry cost is sunk for choosing future action, but remains in realized-P&L and profit/loss labels. With venue-independent probability uncertainty `u`, optimistic hold value is `H⁺ = q × 100¢ × min(1, P(side) + u)`. A strict alpha exit requires `L − H⁺` to exceed a minimum-cent improvement after spread, fee, persistence, and freshness. Therefore `P(owned side) < 50%`, current unrealized profit, or a recent winning streak alone cannot trigger a sell.

Use three sell families:

1. **Upgrade switch:** existing liquidation-plus-replacement future-wealth comparison. Switches retain their three-snapshot/30-second persistence and probability-advantage gates.
2. **Thesis-break/value exit:** one fresh snapshot may sell when executable Kalshi net cash exceeds uncertainty-adjusted optimistic model hold value by at least 1¢, without requiring a replacement.
3. **75% profit-reversal exit:** arm—do not sell—when net executable profit reaches +75%. Persist the highest executable net liquidation value and owned-side model probability. One later fresh snapshot may sell when both values have declined from that high-water observation. Kalshi supplies the executable bid; it never enters the independent probability.

Winning streaks across prior trades are forbidden as inputs. Recommendations rank by risk-adjusted **incremental expected cents versus no action**, so buys, exits, and switches remain comparable.

Standalone exits use a fresh quote, reduce-only Kalshi IOC quantity no greater than held amount, bounded owned-side bid, durable exit/client ID before submission, and exact fill/fee reconciliation. Zero or partial fill never authorizes replacement or automatic exit retry. Ambiguity retains the reservation/position state and safety-suspends for authoritative reconciliation.

A completed standalone exit clears prior entry persistence and starts a 60-second cooldown. After that, any number of same-asset/window re-entries may occur, but every one requires three newly collected qualifying buy snapshots and all normal edge, spread, fee, timing, portfolio, budget, reconciliation, and hourly-order gates. Each generation has a new durable logical/client ID.

#### Auditability

- Persist every budget configuration, pause/resume, reservation, settlement, P&L adjustment, depletion, and connector failure.
- Every event records timestamp, reason, previous/new state, related forecast/order IDs, venue, and model/policy versions where applicable.
- LLM output cannot configure, resume, or place trades.

### 3.6a Objective: profit, not forecast accuracy

The desk exists to buy contracts the venue has mispriced. Accuracy and profit are different objectives
and the design must serve the second.

- **The tradeable forecast must contain no venue price.** Edge is `P(model) − ask`, so blending the ask
  into the forecast shrinks the exact disagreement being traded. A separate venue-informed figure is
  produced for comparison and benchmarking only.
- **Qualification is expected value, not confidence.** A buy qualifies on `P(side) − side ask − fees ≥ margin`, where `P(DOWN)=1−P(UP)`.
  A directional-likelihood threshold permits buying a 57% outcome at 96¢, which is a guaranteed loss.
- **Venue fees are subtracted before judging edge**, using a quadratic per-contract estimate for Kalshi
  and a proportional estimate for Polymarket.
- **Confidence measures our own estimate only.** Agreement with the venue is deliberately excluded:
  penalising disagreement would suppress precisely the mispricings the desk targets.
- **Disagreement between venues is treated as opportunity, not noise.** When two venues price the same
  event far apart, at least one is wrong.
- **The primary metric is realized versus predicted edge**, reported as cash per $1 staked net of fees.
  A model may be well calibrated and still lose money on every trade.
- Live Kalshi execution is permitted only through explicit environment opt-in and typed arming under the current tight all-in cap. Paper evidence is tracked independently, and weak live profitability or maker-selection evidence prohibits increasing stakes.

### 3.6b Forecast target and accuracy measurement

Both venues settle a 15-minute contract by comparing a settlement average near close against a
reference price fixed at cycle open. The model must therefore forecast `P(settlement ≥ reference)`,
not general asset bullishness.

- The **contract basis** term is primary: log distance from the venue oracle reference, scaled by realized volatility over the remaining time, assuming zero drift.
- The reference price and the live price must come from **one price series**. The signal is a fraction of a percent, so a cross-source basis offset would swamp it. The reference is the exchange close at the instant the cycle opened; venue oracle levels are compared against it only to detect series drift.
- Realized volatility is measured on that same series, and the widest available estimate is used. Volatility is additionally widened by its own estimation error and a documented provisional safety multiplier.
- The basis probability is capped short of certainty until the calibration gate reports a measured edge.
- Venue pricing is an independent benchmark and may enter only the separately labeled venue-informed comparison. It has zero weight in tradeable `P(UP)`. Exact-contract replay of direct Kalshi weights improved probability scoring but failed fee-aware order profitability and every expanding held-out fold; therefore Kalshi remains an execution cost/benchmark rather than a forecast input. A separately versioned Kalshi-disagreement veto may be observed without changing independent probability. Slow regime features (monthly, yearly, seasonal, news) are bounded nudges scaled by their own confidence.
- Model confidence expresses evidence quality from reference/volatility availability, volatility sample depth, clock uncertainty, and broad data health. Agreement with or divergence from venue prices cannot raise or lower confidence in the tradeable estimate.
- Every qualifying calculation and a bounded prospective one-minute sample of non-qualifying calculations are recorded. Metrics solely over signals the policy chose to act on are selection-biased and cannot establish calibration.
- Accuracy reporting must include benchmarks against a coin flip, the basis term alone, Polymarket, and Kalshi. A model that cannot beat those has no demonstrated edge.
- Accuracy must be reported by time to settlement and as calibration bins. Per-asset contract streaks remain diagnostic, but calibration evidence is counted by unique settlement timestamp because correlated crypto contracts sharing a window are not independent.

### 3.7 Positive-edge buy track record

Money Noodle must persist every calculation that passes the active buy policy and summarize its eventual outcome. These are model calculations and trade-selection inputs, not personalized recommendations or guarantees.

#### Issuance policy

- The active policy is binary buy policy **v22**; `lib/policy-manifest.ts` is authoritative for its identity and full history. A calculation qualifies only when independent `P(side)` is at least 55%, `P(side) − side ask − venue fees` is at least 5 percentage points, estimate quality is at least 50%, and the executable selected-side ask is from 10¢ through 75¢ on at least one live venue enabled in Budget. `P(DOWN)=1−P(UP)` and uses no venue input. The 55% floor has applied to both tracks since v13, after the prospectively monitored v12 52.5–55% live-fill cohort lost. The edge floor was 5pp through v19, −5pp under v20–v21, and returns to 5pp at v22; the price band was 5–97¢ through v21. Persistence, warm-up, late cutoff, execution, sizing, and exits are unchanged by v22.
- The price gate uses the actual Polymarket outcome-token ask or Kalshi YES/NO ask for the side being purchased—not market probability, midpoint, last price, the opposite side's ask, or a disabled venue. Missing actionable side quotes fail closed.
- Every new forecast stores the selected entry side and all actionable UP/DOWN venue prices. Historical policy-v9 observations remain immutable legacy UP entries. Reduce-only exits use the owned side's venue-independent probability and executable side bid under a separately versioned exit policy; they cannot manufacture opposite exposure.
- Disabled venues may remain visible for research but are dimmed, excluded from qualification, excluded from tracked actionable prices, and unavailable to execution.
- A calculation is current for no more than one 15-second observation window. Expired calculations must not remain presented as qualifying outputs or be accepted by future execution logic.
- Every qualifying 15-second update is a separate immutable forecast observation. At most one observation is stored per asset/contract/15-second UTC bucket, preventing duplicate browser or manual requests.
- Each observation stores a shared cycle ID plus issue time, close time, direction, UP probability, confidence, model version, tracking-policy version, Polymarket/Kalshi quotes, confidence calculation, and complete factor snapshot. It also stores per-venue contract ID, rules fingerprint, resolution/reference source/value, opening-reference and closing-settlement averaging windows, averaging method, rounding precision, and a reasoned cross-venue comparability state when available.
- Direction changes within a cycle are retained and scored independently; no update is overwritten or selected with hindsight.
- Forecast observations are durable user data, not disposable response cache data.
- Threshold or policy changes create a new policy/model version and never rewrite historical records.

#### Resolution policy

- Outcomes are resolved separately for every priced venue contract after that venue reports a final result. Multiple observations may share one target contract outcome, but approximately comparable Polymarket and Kalshi outcomes are never assumed identical.
- Each update records venue-specific outcomes and resolution timestamps. Signal-quality Brier/log loss uses the explicitly identified target outcome; simulated return uses the outcome from the same venue as its stored entry ask.
- Unresolved, cancelled, ambiguous, or invalid markets remain separately classified and are excluded from accuracy.
- The system retries delayed resolutions without changing the original forecast.
- A separate target-integrity report joins immutable rules and aligned Kraken paths: direct reference drift only when the venue publishes its reference value; final-window proxy averages only with bounded path coverage; and proxy-versus-exact outcome agreement without substituting the proxy for resolution. Close or known-window mismatch is `not-comparable`; `exact` additionally requires the same oracle and averaging method; aligned windows with different oracles/methods remain `approximate`.

#### Performance summary

Show:

- Issued, pending, resolved, correct, and invalid update counts plus unique-cycle counts.
- Update-level accuracy, Brier score, and log loss across every qualifying 15-second observation.
- Cycle-balanced accuracy: calculate accuracy within each cycle, then average cycles equally so cycles with more qualifying updates do not dominate.
- Accuracy and sample size by asset, direction, model version, and confidence bucket.
- Recent positive-edge outcomes and current streak.
- Calibration readiness and progress toward the minimum sample requirement.
- Simulated return after venue price, fees, spread, and slippage once cost data is available.

#### Learning policy

- Stored outcomes and `calibration-replay-v1` issuance inputs feed automatic, local, versioned model evaluation and calibration. Replay inputs include raw reference/current price, clock, volatility, basis weight/probability, aggregate and individual slow-term log odds, production caps, and production probability, but never venue price. Formal runs begin at 100 independent windows and repeat every 25 windows; each run is immutable and feature-fingerprinted, reports exact/reconstructed input coverage and replay error, and requires an explicit separate production-promotion action.
- No automatic live weight changes from a small or in-sample dataset.
- At least 100 unique resolved **15-minute settlement timestamps** are required before applying a probability calibration candidate. Repeated updates and correlated asset/venue cycles sharing a close timestamp count as one window. Prospectively recorded non-qualifying forecasts contribute to calibration-window coverage but remain excluded from the positive-edge trade track record.
- Candidate models use chronological train/validation/test windows and must outperform the current version without material regression in held-out Brier score, log loss, coverage, or drawdown. Promotion review reports window-clustered uncertainty and protects against selecting across a large candidate grid.
- Signal-policy return and maker-executable return are separate evidence tracks. A model-only backtest cannot by itself authorize a stake increase or execution-policy change.
- Confidence/quality candidates require replayable issuance-time quality inputs; a stored production confidence value may test thresholds but cannot validate a replacement formula.
- A model promotion creates a new immutable registry version and records its dataset fingerprint, training range, folds, features, metrics, parameters, operator action, and prior version. Promotion requires a quiescent paused state and can never be triggered automatically or by an LLM.
- Rollback to a prior immutable model version must remain possible through the same explicit audited workflow.

## 4. Forecast model

### 4.1 Current model: Blend 0.4 contract basis

The production forecast is a venue-independent log-odds model for `P(settlement average ≥ cycle reference)`:

1. Use one Kraken series for the aligned cycle-open reference, current price, and realized volatility.
2. Compute a zero-drift basis probability from log distance to reference divided by realized volatility over the remaining clock.
3. Apply a provisional `0.55` basis log-odds weight.
4. Add confidence-scaled intraday, monthly, yearly, same-month seasonal, and news log-odds nudges, with their aggregate capped to `±0.4` log odds.
5. Transform back through the logistic function and cap production probability to `[0.03, 0.97]`.

`P_tradeable(UP) = clamp(sigmoid(0.55 × logit(P_basis) + bounded slow tilt), 0.03, 0.97)`

Venue prices have zero weight in this tradeable probability. A separate labeled benchmark adds a smoothed venue term for comparison and calibration diagnostics only. Venue asks, spreads, and fees enter qualification as execution costs, never as forecast inputs.

This remains a provisional production baseline rather than a validated calibrated model. Exact issuance-time replay inputs are persisted, automatic expanding-window evaluation starts at 100 independent settlement timestamps, and any production promotion is manual and versioned.

The dashboard marks an entry as a **positive-edge binary buy** when independent selected-side probability is at least 55%, expected value after venue fees clears 5 percentage points, estimate quality clears 50%, and an enabled venue has an executable selected-side ask from 10¢ through 75¢. It may open UP/YES or DOWN/NO. Reduce-only exit recommendations for owned positions remain under the separate HOLD/EXIT/SWITCH policy above. Depth, queue priority, and slippage are not yet modelled. The signed selected-side ladder is operator observation only and does not narrow or enrich this rule. Cards are sorted by edge strength and execution uses additional maturity, freshness, portfolio, funding, and timing gates.

### 4.2 Required factor evolution

- Tick/order-book momentum, spread, imbalance, recent trades, and liquidity.
- Returns for 5m, 15m, 1h, 4h, day, month, quarter, and year.
- Realized/implied volatility, RSI, volume anomalies, cross-asset beta, funding, open interest, and liquidations.
- Same month/season across multiple prior years, with sample count and dispersion.
- Scheduled macro events and crypto-specific catalysts.
- Entity-aware news/event sentiment with source quality and recency decay.
- Venue divergence between Polymarket, Kalshi, and reference spot feeds.

### 4.3 Calibration and evaluation

Every issued prediction should eventually be persisted with feature snapshot, model version, venue quote, resolution, and costs. Report:
- Brier score and log loss.
- Reliability/calibration curve.
- Accuracy by confidence bucket, asset, regime, and horizon.
- Simulated P&L after fees, spread, and slippage.
- Coverage/pass rate and maximum drawdown.
- Walk-forward tests only; no future-data leakage.

A candidate may only be scored on inputs production actually saw. Both the tradeable probability and estimate quality are therefore expressed as explicit versioned parameter sets with replay functions that must reproduce the stored production value at issuance to floating-point tolerance, and every issuance snapshot persists the raw inputs each one reads. A rule left inside an expression is not evaluable: the candidate inherits production's version of it and silently scores itself against a constant. Where an input was never persisted, the row is labeled as such and excluded rather than reconstructed — a value that cannot be uniquely recovered from what was stored would be invented. Each evaluation reports exact-versus-unavailable coverage and maximum replay error separately for probability and quality.

## 5. Data sources and integrations

### Current initial sources

| Source | Use | Auth | Cache target |
|---|---|---|---|
| Polymarket Gamma API | Active 15m market metadata/probability | Public | 12 seconds |
| Kraken 1m OHLC + ticker | Single-series cycle-open reference, live price, and realized volatility | Public | 10 seconds |
| Polymarket CLOB books | Batched UP/DOWN bid/ask liquidity for actionable gating | Public | Every live market refresh |
| CoinGecko | Spot, returns, 7d sparkline | Public | 60 seconds |
| CoinDesk RSS | Recent headlines | Public | 10 minutes |
| Kraken OHLC | Multi-year weekly seasonal baseline | Public | 24 hours |
| Local price history | Supplemental long-term baseline | Local | Hourly snapshots |

### Trading-provider registry and variants

“Provider” in trading surfaces means a prediction-market venue or broker, distinct from an LLM research provider. The registry initially contains Polymarket and Kalshi and will add **Crypto.com**, **ForecastEx**, and **Robinhood** through official, permitted APIs only. Consumer web scraping or browser automation cannot authorize live trading.

Each provider exposes one or more immutable, versioned **provider/model variants**. A variant is the provider-specific interpretation and execution layer around Money Noodle's common venue-independent forecast, including:

- contract discovery and normalized asset/window mapping;
- exact rules, oracle/reference source, averaging window, timezone, and UP/YES mapping;
- quote/book normalization, tick size, quantity granularity, fee schedule, and settlement handling;
- execution style, fill assumptions, slippage/depth treatment, and reconciliation version;
- comparability classification and contract-target fingerprint.

Provider variants **must not blend provider prices into tradeable probability or confidence**. Prices remain benchmark and execution-cost inputs. A genuinely different forecast formula is a separate forecast-model variant and follows immutable evaluation/manual-promotion rules.

All provider variants run in isolated paper tracks from the same issuance stream. At most one explicitly promoted variant per provider may be live-enabled initially. Every order and evaluation row retains `providerId`, `providerVariantId`, `forecastModelVersion`, `buyPolicyVersion`, and `executionPolicyVersion`, so variants never share outcomes or P&L accidentally.

Define a common `PredictionVenue` interface while preserving provider-specific contract semantics:
- `listMarkets(filter)`
- `getMarket(id)` / `getOrderBook(id)`
- `getAccount()` / `listPositions()` / `listOrders()` / `listFills()`
- `previewOrder(order)`
- `placeOrder(order, idempotencyKey)`
- `cancelOrder(id)`
- `subscribe(listener)` for quotes, orders, fills, and account events

#### Polymarket

Read path: Gamma API plus CLOB market/order-book APIs.  
Private path: CLOB authentication/signing, allowance/funding checks, orders, fills, and positions. Network/chain IDs and collateral semantics must be validated before enabling trade controls.

#### Kalshi

Read path: market/event and order-book APIs.  
Private path: signed API requests for balance, positions, orders, fills, placement, and cancellation. Environment (demo vs production) must be visually unmistakable.

#### Crypto.com

**Verified 2026-08-13: not viable for `crypto-15m`. Retains research-only status; capabilities stay false.**

The binary product is **Strike Options**, offered by Crypto.com | Derivatives North America (CDNA) under CFTC oversight, US only. Durations are 5 minutes, 20 minutes, 2 hours, daily, and weekly — there is no 15-minute contract. Three findings independently block integration:

1. **No programmatic access.** The Exchange API v1 covers spot, margin, perpetual swaps, and standard futures. Strike Options and Up/Down are not tradeable through it, and the Predictions API exposes data only with execution restricted on event-based elements. CDNA is a separate entity from Crypto.com Exchange. Scraping or browser automation cannot authorize live trading, so there is no path.
2. **No order book, and the venue is the counterparty.** Orders are market orders with protection on an immediate-or-cancel basis against a platform-quoted price; the trader sees an indicative amount and may fill anywhere within a slippage tolerance. Money Noodle's live edge is managed post-only maker placement, which cannot exist here, and no two-sided book means no observable spread from which to derive implied volatility. The counterparty sets the price knowing its own index.
3. **Not comparable.** Settlement uses CDNA's own indicative index price, taken from BID/ASK midpoints once per second, against a predetermined strike rather than a cycle-open reference, with a fixed US$10 payout. Under contract normalization this is `not comparable` to the 15-minute target, so it could not serve even as a benchmark price.

Even treated as its own market, the gap is structural rather than a recalibration: a dealer-quoted IOC binary needs a different execution model entirely — slippage tolerance, indicative-versus-fill reconciliation, no maker path, and no cancellation lifecycle.

**Connectivity verified 2026-08-13.** Public Exchange v1 reads require no credentials at all and are broad: 930 instruments comprising 577 spot pairs and 343 perpetual swaps, with real order-book depth and a $0.01 spread on BTC around $63.7k. Signed private reads also work: HMAC-SHA256 over the sorted key-value concatenation `method + id + apiKey + params + nonce` authenticated on first attempt, validating the construction against the live API. This is the strongest research surface of any candidate provider, and it needs no account to use.

What the API *does* support — spot, margin, perpetual swaps, futures — maps onto a **future** market rather than this one. Perpetual funding rates are an observable drift signal, unlike the current zero-drift model, so that work is gated behind directional-alpha research and not adapter plumbing. Before reversing this finding, confirm with CDNA or Crypto.com institutional support whether Strike Options market data and order placement are available programmatically; absence of public documentation is not proof that no interface exists.

#### ForecastEx

Planned read/paper-first adapter using official ForecastEx/authorized broker interfaces. Normalize exchange contracts separately from any introducing-broker account layer; verify participant eligibility, market-data access, settlement authority, fees, quantity/tick rules, order lifecycle, and authoritative fills/positions before live work.

#### Robinhood

**Verified 2026-08-13: no event-contract API. Not viable for `crypto-15m`.**

The only documented official interface is the **Crypto Trading API** at `trading.robinhood.com`: crypto only, US only, authenticated per request with an API key plus an Ed25519 signature carried in `x-api-key`, `x-timestamp`, and `x-signature`. Read-only actions cover accounts, holdings, orders, products, and quotes; order types are market, limit, stop-loss, and stop-limit. The official crypto-API article makes no mention of event contracts, prediction markets, equities, or options.

Two consequences for event contracts. There is no programmatic path, so live and paper are both unreachable. And Robinhood's prediction markets are widely reported to route to the Kalshi-regulated exchange with data sourced through Kalshi's API — if that holds, a Robinhood event-contract adapter would duplicate contracts Money Noodle already trades directly on Kalshi, adding a broker hop without adding a market. Treat the routing claim as reported rather than officially confirmed; it is a reason to deprioritize, not a verified fact.

**Connectivity verified 2026-08-13.** Signed reads of accounts and holdings work — Ed25519 over `apiKey + timestamp + path + method + body`, authenticated on first attempt. Market data, however, is spread-inclusive and has **no order book**: `best_bid_ask` returns `bid_inclusive_of_sell_spread` and `ask_inclusive_of_buy_spread` with an explicit spread of ~0.945% each way, roughly 1.9% round trip, against $0.01 on Crypto.com for the same asset. Robinhood is therefore usable as an account data source and unusable as a price reference or execution venue; no edge measured against a 1.9% round trip survives.

The crypto API is a genuine interface for a **future** `crypto-spot` market. Note that even quotes are account-authenticated, so unlike Crypto.com there is no unauthenticated market-data path: an adapter cannot be exercised at all without operator credentials. Market data appears limited to best bid/ask, estimated fill prices, and supported pairs, with no documented full-depth book or historical candles, so it is thinner than the Kalshi and Polymarket books the current policy assumes.

### Contract normalization

Never assume venue contracts resolve identically. A normalized market must retain:
- Venue ID, title, exact rules, resolution source, open/close time, timezone.
- YES/NO or UP/DOWN mapping.
- Tick size, minimum order, fee model, restrictions, and settlement terms.
- A `comparability` state: exact, approximate, or not comparable.
- Provider and provider-variant IDs plus immutable contract-target and rules fingerprints.
- Whether the capability is `research`, `paper`, or independently promoted `live`; unsupported capability must fail closed.

## 6. Storage

### Initial local storage

`.cache/*.json` stores timestamped response envelopes and hourly price history. Writes are atomic (temporary file then rename). Runtime cache is gitignored.

Planned repository boundaries:
- `MarketSnapshotRepository`
- `ForecastRepository` (durable local snapshot `data/forecast-history.json` plus append-only `data/forecast-history.journal.jsonl`; process-cached replay and bounded compaction avoid full-history rewrites on each observation) 
- `NewsRepository`
- `AccountSnapshotRepository`
- `OrderAuditRepository`
- `ResearchSessionRepository`

The single-array forecast snapshot is now a memory-residency and startup risk, not the event-loop culprit it was first reported to be. Direct measurement found that parsing the roughly 190 MB snapshot costs about 1.2 seconds once per process behind a promise cache; the observed ten-second stalls came from quadratic copy-on-append grouping in `summarizePerformance`, now fixed at roughly 0.6–0.7 seconds. The process still retains roughly 396 MB of parsed history to serve a hot set near 100 rows and grows about 40 MB per day. `ForecastRepository` therefore moves to a small open set, sealed immutable daily shards, and per-shard rollups. `summarizeFromRollups` is implemented beside the direct path and must reproduce the complete summary under a field-by-field gate before any reader switches. Counts and identities are exact; floating aggregates use a `1e-12 × max(1, |left|, |right|)` combined absolute/relative bound for unavoidable summation-order noise. Policy-scoped statistics retain policy identity in their compact rollup keys: an unscoped legacy counterfactual may never be attributed to the active buy policy, and the verifier fails if excluding it would hide active-policy sealed rows. A worker boundary is deferred because it relocates work without reducing retained memory. Retention is deliberately unchanged — making unbounded history affordable is not the same decision as choosing what to discard. See [`docs/forecast-storage-design.md`](docs/forecast-storage-design.md).

The persistent local worker also maintains an optional S3-compatible off-machine archive. Every 24 hours a detached, low-priority process compresses durable JSON/JSONL files into SHA-256-addressed immutable blobs, uploads only missing content, reads every new blob back through gzip while verifying its original checksum and byte count, and commits a timestamped manifest only after all files pass. Vercel/stateless workers cannot start it. Archive v1 never deletes or mutates local source data; rolling local removal remains locked behind repeated successful archives and a separate restore test. Credentials belong only to a dedicated object-read/write application in local environment configuration, never Vercel or the repository.

The persistent worker also performs best-effort startup reclamation of orphaned atomic-write temp files under
`data/` and `.cache/`. A `${target}.<pid>.<rand>.tmp` may be removed only when it is older than 60 seconds
and the real rename target already exists; an absent target, fresh file, symlink, hidden subtree, malformed
name, or stateless host is never touched. This housekeeping cannot rewrite a ledger or be the only owner of
durable content, and it never delays startup reconciliation or collector activation.

### MongoDB migration

Replace repository implementations without changing domain/services. Add TTL indexes for raw cache records and durable collections for forecasts, outcomes, trades, and audit events. Credentials do **not** belong in MongoDB documents in plaintext.

## 7. Security and trading controls

- Secrets only in server environment variables or OS keychain/secret manager.
- **No private key may live inside the repository working tree, even ignored.** Keys live under `~/.config/money-noodle/` and are referenced by path (`KALSHI_PRIVATE_KEY_PATH`), never inlined into an env file. A key inside the tree was committed once and had to be rotated; `.gitignore` covers `*.pem`, `*.key`, `*.p8`, `id_rsa*`, and `.env*.bak*` so a credential or credential backup cannot be re-added, but the ignore rules are a second line of defence rather than the control.
- Rotating a key requires restarting the worker. Replacing the key file alone leaves the previous key ID loaded in memory, which pairs an old ID with a new key and fails every signed request at the next venue call rather than at startup.
- Separate read-only and trading credentials where venues support them.
- Read-only provider connectors contain no order, cancellation, or position-mutation function at all, so a bug cannot exceed the capability the registry grants. Prefer a venue-side read-only key as well, so a defect in this code also cannot trade.
- The sign-in endpoint must throttle failed attempts. A fixed per-failure delay is the control that bounds guessing, because it needs no shared state and therefore survives serverless instance fan-out and source-address rotation; a per-process lockout counter is an optimisation for the single-source case and is weak wherever requests are spread across instances.
- Browser receives capability/status flags, never secret values.
- CSRF protection and same-origin checks on all mutation routes and billable research requests.
- Idempotency key on every order submission.
- Immutable local audit record for preview, confirmation, venue response, fill, cancel, and error.
- Configurable limits: max order loss, daily loss, open exposure, orders/minute, allowed venues/assets, and price slippage.
- Global trading kill switch, off by default.
- Stale quote, stale account state, changed market, or disconnected venue blocks submission.
- Demo/paper mode ships before production order placement.
- LLM output can draft research or a ticket but can never directly submit an order.
- Recording a model promotion or rollback is a real-money control and carries the same guards as a trading mutation: authenticated same-origin session, paused automation, quiescent restart-safe drain, zero reserved budget, a written reason, and an exactly typed confirmation phrase. A promotion must cite the newest walk-forward run by id and clear every eligibility criterion. A rollback is deliberately not eligibility-gated — reverting must stay available exactly when the evidence for the current model has fallen apart. The route may only record a model version and parameter set the running code actually forecasts with, so the published `unrecorded` flag cannot be made to lie.

## 8. Technical architecture

- **Framework:** Next.js App Router, React, TypeScript.
- **UI:** Tailwind CSS and local shadcn/ui components; Radix primitives for accessibility.
- **Charts:** Recharts initially.
- **Server:** Next.js route handlers and server-only services.
- **Runtime:** local Node.js; architecture remains deployable later.
- **Data flow:** external adapter → cached raw data → normalized domain data → feature/model service → API → client dashboard.
- **Freshness and cadence:** every dashboard payload includes generation/expiry, per-source status, and a bounded runtime-task snapshot. Input TTLs remain client-safe data in `lib/freshness.ts`; task metadata and shared cadence constants live in `lib/task-cadence.ts`; process-local run health lives only in server-side `lib/task-cadence-runtime.ts`. Existing loops mark their own outcomes but the registry cannot schedule, await, gate, price, size, or trade. Conditional and on-demand tasks do not become unhealthy merely because no candidate, order, position, or event activated them.

**Aspirational, not current.** `lib/` is flat; none of the directories below exist. They record an intended
future decomposition, not a map of the code — for that, see the table in `AGENTS.md` §0. Do not cite this list
as evidence of where anything lives.

Recommended future service boundaries:
- `lib/venues/*` — normalized trading-provider registry and Polymarket/Kalshi/Crypto.com/ForecastEx/Robinhood adapters.
- `lib/market-data/*` — spot, derivatives, historical feeds.
- `lib/news/*` — retrieval, dedupe, entity matching, sentiment.
- `lib/models/*` — feature generation, versions, calibration.
- `lib/llm/*` — provider adapters and grounded research orchestration.
- `lib/repositories/*` — filesystem then MongoDB implementations.
- `lib/trading/*` — risk checks, previews, idempotency, audit.

## 9. Non-functional requirements

- Landing data appears within 3 seconds from warm cache.
- One failed asset/source does not blank the full dashboard.
- All timestamps are stored UTC; UI clearly renders local/market timezone.
- Responsive from mobile to wide desktop; keyboard-accessible controls and dialogs.
- No silent fallback to fabricated data.
- Structured server logs without credentials or signed payloads.
- Unit tests for normalization, factor math, risk checks, and venue signing; integration tests against demo/sandbox APIs; end-to-end tests for confirmation flow.
- GitHub CI runs dependency installation, typecheck, Next/React/TypeScript lint, the full Vitest suite, and a production build on every push to `main` and pull request. Lint warnings remain visible, but any lint error fails the gate.

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
- [x] Add automatic versioned expanding-window evaluation after 100 unique resolved settlement timestamps, repeating every 25 new windows. It uses five chronological folds, one fixed five-minute snapshot per asset/window, largest-edge selection within each correlated window, fee-aware return/Brier/log-loss/drawdown scoring, dataset fingerprints, and persisted history. Evaluation cannot promote production automatically.
- [x] Persist an immutable venue-specific contract/rules/reference registry, retain issuance fingerprints, resolve Polymarket/Kalshi independently, and exclude legacy/mismatched venue entries from walk-forward return scoring.
- [x] Prospectively verify provenance-bearing dual-venue resolution, including genuine cross-venue outcome disagreements with venue-specific scoring.
- [x] Parse and fingerprint explicit reference/settlement averaging windows, averaging method, and rounding precision; report Kraken-to-venue reference drift, sparse final-window path proxies against exact venue outcomes, and reasoned exact/approximate/not-comparable labels without changing production.
- [ ] Replace evaluator v2 before any model promotion: freeze a reproducible cohort manifest, replay the exact buy policy with candidate-selected side/provider/cost, add paired clustered return and continuous drawdown, and keep signal-policy return separate from a prospective simulated-execution lane. Quality candidates use only exact confidence-input rows. The 2026-08-20 review showed the current checkpoint fingerprint can drift after late resolution and the scorer inherits production's side while hard-coding stale price bounds.
- [x] Add an immutable model registry with quiescent, audited manual promotion and rollback; automatic evaluation and LLM research must have no promotion capability. `POST /api/model/promotion` is the only write path, guarded as in section 7, and may record only the model the running code actually forecasts with.
- [x] Add side-aware DOWN/NO paper and live entries from executable NO asks, with signed Kalshi order translation, side-specific persistence/settlement/reconciliation/reporting, and no implicit reversal through SELL.
- [x] Multi-year Kraken weekly OHLC backfill for same-month seasonality, with neutral output when genuine prior-year samples are insufficient.
- [ ] Stronger news/event pipeline and market microstructure features.

### Phase 3 — Venue/account read integrations
- [x] Add the typed read-only trading-provider registry foundation with explicit market-data/paper/live capabilities, fail-closed planned providers, and immutable provider-variant identities in the dashboard payload. Durable generalized provider configuration and adapter interfaces remain below.
- [x] Add `TradingProviderAdapter` normalized contract/quote/account/order interfaces with explicit capability checks, plus an atomic durable `data/trading-providers.json` configuration mirrored fail-closed from the legacy Budget execution authority and a distinct read-only `/api/trading/providers` route.
- [x] Promote the provider store to `provider-registry-v1` authority through a one-time legacy migration. Provider mutations require authentication, same-origin, paused quiescent/restart-safe execution, explicit capability, exact variant identity, immutable audit, and typed confirmation for live enablement. Paper and live permissions are enforced separately; disabling live preserves paper and reduce-only lifecycle handling. The legacy Budget venue field is now a compatibility projection only.
- [ ] Versioned provider/model variants for contract semantics, fees, quote normalization, paper fill assumptions, and execution/reconciliation behavior; provider prices remain excluded from tradeable probability.
- [~] Crypto.com event-contract adapter is **not viable** and is withdrawn from this phase: Strike Options has no programmatic interface, no order book, and non-comparable settlement. See §5 Crypto.com. A spot/perpetual adapter belongs to a future market, not to `crypto-15m`.
- [ ] Add ForecastEx read/paper-first adapter after official exchange/broker API and eligibility verification.
- [~] Robinhood event-contract adapter is **not viable** and is withdrawn from this phase: the only official interface is a crypto-only Trading API, and its prediction markets are reported to route to Kalshi, which Money Noodle already trades directly. See §5 Robinhood. Its crypto API belongs to a future market.
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

## 12. Track separation and policy evaluation

### 12.1 Why this exists

Three lanes are needed and only two exist. Live runs the active policy with real money. Paper is supposed to run the *same* policy with a simulated version of live's maker execution, so that `paper − live` isolates real queue, venue, reconciliation, and capital effects rather than mixing in a taker fill assumption. The always-fills benchmark belongs in a separate ask-fill shadow. There is no lane for a change the desk is considering but has not adopted.

Before buy policy v17 unified the tracks on 2026-08-17, the missing third lane let speculative changes leak into paper — paper traded XRP that live withheld, and paper ignored the adaptive regime gate that live obeyed — while one-off evaluations were written three separate times and thrown away (`missedBuyCounterfactual`, `buildMakerShadow`, and the regime-gate sentinel loop in `data/regime-gate.json`). The historical failure motivates this section; the current rule layer now enforces the mirror invariant below.

Both failures are the same mistake. Paper's entire value is that exactly one variable differs from live. Add a second and the subtraction stops meaning anything: when the books disagree, nothing distinguishes a policy difference from a fill difference from a cohort live never traded.

### 12.2 The three lanes

| Lane | Policy | Money | Execution | Answers |
|---|---|---|---|---|
| **Live** | active | real | current versioned execution policy: managed maker by default, with a narrowly gated fresh-quote IOC route; real fills | What did the desk actually earn? |
| **Paper mirror** | active, *identical* | simulated | independent maker simulation with the same versioned episode boundary and route decision | Was the decision right under comparable execution, and what did real execution/capital cost? |
| **Evaluation** | candidate, non-production | none | never places an order | Should this change be adopted? |

### 12.3 The mirror invariant

**For any prediction snapshot, the entry decision is identical for live and paper. The tracks may differ only in execution and capital.**

This is structural, not a convention to remember: the rule layer takes no execution-mode parameter, so a divergence cannot be expressed. Concretely, `qualifiesAsBuyEdge`, `hasTradableEdge`, `bestEntry`, `bestEntryForSide`, `bestVenueEntry`, `qualifiesVenueBuyEdge`, `downEntryEnabled` and `assetAdmitted` lose their `mode` argument; the paired environment variables collapse to `MONEY_NOODLE_ALLOW_DOWN_ENTRY` and `MONEY_NOODLE_EXCLUDED_ASSETS`, one rule set for both tracks; and the adaptive regime gate, previously checked only in `runLive`, applies to both.

Portfolio selection was expected to need merging and does not: `runLive` and `runPaper` already call the same `selectPortfolio` with the same `portfolioConstraints()`, differing only in which book's exposures they pass, which is correct because the books are separate. The surrounding differences — maker retry accounting, live stake caps, funding headroom — are execution, and forcing them into one path would push live-only concerns into the mirror.

**What remains per-track, deliberately:**

| Differs | Why |
|---|---|
| Fill model — real venue execution vs simulated execution | Paper originally filled at the ask, then used a static dashboard bid and ask-touch rule. Neither represented live. *(Maker simulation implemented 2026-08-14: independent paper management uses live's shared pricing transitions, exact quote/depth, public aggressor trade prints, displayed queue-ahead depletion, issuance-sized quantity, and concurrent two-second management. Ask touch is telemetry only. Authoritative matched-live fills are retained as a separate overlay rather than replacing the independent simulation.)* *(Extended 2026-08-20 under `paper-managed-execution-route-ioc-v4`: paper now takes the route `evaluateEntryExecutionPolicy` chooses rather than always resting, and the standalone exit simulates its own immediate-or-cancel sweep of displayed depth under `paper-ioc-exit-depth-v1` instead of completing unconditionally. Live's `post_only_race`, venue errors, and reconciliation contradictions remain unmirrorable and are not invented. See `docs/mirror-fidelity-and-skip-attribution-design.md`.)* |
| Budget, stake sizing, bankroll | Paper is not capital-constrained; matching it would hide policy outcomes behind sizing noise. |
| Hourly filled-order limit, live risk stops, reconciliation gate | Venue and capital protections, not predictions. |
| Position and correlation caps | Same constants, counted separately, because the books are separate. |

The consequence is intended: `paper − live` is the desk's total execution and capital cost. To make that decomposable rather than inferred, every live skip is recorded durably per settlement window with its reason **and a typed class named by the gate itself**, beside the single `lastLiveSkip` slot the dashboard still renders. *(Implemented 2026-08-20, `live-skip-v1`.)* Records are episodes rather than per-cycle rows, operator intent separates a system `stop` from an `operator` pause, and `none` — nothing qualified — is excluded from the withheld classes so it cannot inflate a drag figure. The comparison then attributes each missing live trade to fill drag, limit drag, or stop drag.

### 12.4 The policy as data

Candidates cannot be expressed while the rules are module constants. The buy policy becomes a value:

```ts
export interface BuyPolicy {
  version: string;
  minNetEdge: number; maxNetEdge: number; minEstimateQuality: number;
  minSelectedSideProbability: number; minEntryPrice: number; maxEntryPrice: number;
  downEnabled: boolean; excludedAssets: string[];
  requiredSnapshots: number; observationSpanMs: number; warmupMs: number; lateCutoffMs: number;
}
export const PRODUCTION_BUY_POLICY: BuyPolicy = { /* the current constants */ };
```

Rule functions take a `BuyPolicy`, defaulting to production. The exported constants remain as the fields of that object so existing readers and the published manifest keep working. This is what turns an ad-hoc analysis script into production code: the same evaluator scores production and every candidate, so a candidate's number can never come from a different implementation than the one that trades.

### 12.5 Candidates and their evidence

A **candidate** is an immutable, named parameter set with a status. It never places an order, never touches a budget, and cannot affect either trading lane.

| Status | Meaning |
|---|---|
| `screening` | Retroactive scoring only. Cheap, instant, recomputable, and never sufficient for promotion. |
| `collecting` | Committed sentinels are accumulating forward evidence. |
| `promotable` | Sentinel evidence meets the stated criteria; promotion remains a manual act. |
| `production` | The active policy. Exactly one at a time. |
| `retired` | Superseded or refuted; the record and its evidence are retained. |

**Two kinds of evidence, and the distinction is load-bearing:**

*Retroactive screening* replays a candidate's rules over recorded snapshots. The forecast journal already carries what this needs — every 15-second snapshot with both sides' actionable asks, and settlement outcomes patched in on resolution. It answers "what would a 4pp floor have done?" over all history in seconds, which is how a dozen ideas get filtered down to one. It is re-derived by code each time it runs, so it is labelled as such and can never, by itself, promote anything.

*Committed sentinels* are written at decision time: when a candidate qualifies a window the production policy does not, or refuses one it takes, an immutable record captures the contract, side, ask, fee, predicted edge and timestamp, and is followed to settlement. This is the existing regime-gate sentinel pattern generalized from one implicit candidate to many. It cannot be re-derived favourably later, and it accrues only from the moment it starts.

**Promotion requires committed sentinel evidence**, a minimum number of independent settlement windows, a clustered return clearing a stated threshold, and a written reason — mirroring the model promotion ledger already in `lib/model-promotion.ts`. Nothing reaches production on a number that was only ever computed after the fact. That failure mode is not hypothetical: the DOWN suspension of 2026-08-13 was adopted on retroactive figures that later failed to reproduce, and was withdrawn a day later.

**First committed candidate implemented 2026-08-14.** `persistence-two-consecutive-v1` changes only entry maturity: two consecutive qualifying observations spanning 15 seconds against production's three spanning 30. Every current probability, edge, quality, price, asset, side, warm-up, late cutoff, Kalshi-specific quote/spread, classified-path, and adaptive-regime rule remains fixed. It records every signal-level candidate intent, whether production was already eligible, when production later catches up, exact ask/bid/fees, a prospectively captured empirical fill-weighted maker benchmark, and exact Kalshi settlement. **Observed fills added 2026-08-18.** The fill-weighted benchmark multiplies an unconditional settlement return by a modelled fill probability, which prices the fill as a random draw the desk's own adverse-selection measurements refute, and which — being a positive scaling — can never disagree with the ask benchmark beside it. Each intent now also carries a simulated resting post scored against observed trade prints: one order-book snapshot at post time because depth is not historical, the reprice ladder reconstructed from the 2-second contract path, and one print fetch after the 12-second managed-maker horizon. A post fills only when volume traded at or through its price exceeds the size displayed ahead of it, never on a touch. The review figure is the return **conditional on an observed fill**. The modelled benchmark is retained unchanged because the store is committed evidence, and is no longer reported as the maker benchmark. Observation sources are never pooled. See docs/maker-post-observation-design.md. Capital, current positions, and reconciliation are deliberately excluded because they are operational state rather than evidence about persistence. Evidence is scoped to the active production buy-policy version and resets on a production policy change. The first review remains manual and locked until 100 resolved **incremental** settlement windows; reaching that count is not promotion eligibility. **Retired 2026-08-19:** v21 adopted the candidate's two-snapshot/15-second rule, and all 80 active-policy intents in the final store were already production-eligible, leaving zero incremental intents. Runtime collection and its detached maker observer are removed; historical intents, observations, resolution, and reporting remain read-only. The invalid 60-second depth instrument and its backfill fail closed and have no package commands. A future candidate requires a new versioned prospective design.

**Calendar-effects collection implemented 2026-08-14.** `calendar-effects-v1` fixes the selection-bias and retention problems in the original time-of-day replay. For every exact Kalshi asset/window it commits the first collector update at or below five minutes remaining within a 30-second tolerance, regardless of qualification, with probability, confidence, both side books/fees, selected side/edge, compact factor values, cycle regime, model version, buy-policy version, and exact outcome. It separately records one first actionable highest-edge current-policy candidate per correlated settlement window, or finalizes an explicit no-candidate marker. Candidate outcomes report bounded fee-aware ask return and a decision-time empirical fill-weighted maker benchmark. Superseded policy cohorts remain durable but are never blended. Six four-hour `America/Los_Angeles` bands are predeclared to preserve the existing review definition; UTC timestamps remain authoritative and local labels are derived. Time review is locked until every band has 30 dates and 100 resolved candidate windows. Individual-weekday review additionally requires 12 occurrences and 100 candidate windows per weekday. Those counts only open manual held-out review and cannot change production.

### 12.6 Storage and modules

| Path | Role |
|---|---|
| `lib/buy-policy.ts` | `BuyPolicy` type, `PRODUCTION_BUY_POLICY`, pure rule evaluation |
| `lib/policy-candidate.ts` | Candidate definition, retroactive scoring, promotion criteria (pure) |
| `lib/policy-candidate-store.ts` | Server-only durable candidate and sentinel records |
| `data/policy-candidates.json` | Candidate definitions and statuses; append-only history |
| `data/policy-sentinels.json` | Immutable per-window sentinel records keyed by candidate |
| `lib/live-skip.ts` | `LiveSkipClass`, episode folding, per-class attribution and the window join (pure) |
| `lib/live-skip-store.ts` | Server-only durable skip journal and compactor; no execution authority |
| `data/live-skips.json` / `.journal.jsonl` | Worker-local live skip episodes; journal compacts at 50 MB |
| `lib/ioc-fill-model.ts` | Immediate-or-cancel fills against displayed depth, shared by the simulated exit and taker entry (pure) |
| `lib/persistence-candidate-store.ts` | Implemented narrow first candidate, durable scoring, exact settlement, and read-only report |
| `data/persistence-candidate.json` | Worker-local prospective intents for the two-snapshot candidate; no execution authority |
| `lib/calendar-evaluation-store.ts` | Append-journaled, non-pruned fixed-snapshot/calendar collection and pure policy-scoped report |
| `data/calendar-evaluation.json` / `.journal.jsonl` | Worker-local calendar evidence; no execution authority; journal compacts at 50 MB |

The regime gate is a special case of this mechanism — one implicit candidate, the production policy, scored forward on its own sentinels. Unifying them is a follow-up, not a prerequisite; the gate works and retrofitting it earns nothing immediately.

### 12.7 Surfaces

The Policy dialog gains a candidates section beside the production policy: each candidate's status, its parameter delta against production, its screening evidence marked as re-derived, its committed evidence, and its promotion eligibility.

The signed Performance dialog includes a read-only Calendar tab with current-policy four-hour and weekday cohorts, date/window counts, forecast Brier, no-candidate coverage, fee-aware candidate return, and explicit review locks. It is omitted from the public/stateless payload with the other worker-local evaluation evidence.

A side-by-side comparison surface reports the mirror against live per settlement window — the decision each lane made, the outcome, and the aggregate drag decomposed into fill, limit and stop. This is the surface that answers "predicted versus actual" directly, which the current dialogs only approximate.

### 12.8 Delivery order

1. **Unify the rules.** *(Done, buy policy v17.)* Removed the mode parameter from the rule layer, collapsed the per-track environment variables to `MONEY_NOODLE_ALLOW_DOWN_ENTRY` and `MONEY_NOODLE_EXCLUDED_ASSETS`, applied the regime gate to both tracks, and added `lib/mirror-invariant.test.ts`, which asserts the absence of a mode parameter by arity so the divergence cannot return unnoticed.
2. **Record live skips durably** per window. *(Done 2026-08-20, `live-skip-v1`: typed per-gate classes, episode folding, and `windowsWithheldBy` as the join to the paper book.)* The side-by-side comparison surface remains.
3. **Introduce `BuyPolicy`** as a value, with production as its first instance.
4. **Candidate store and retroactive screening**, ultimately published in the Policy dialog. *(Partially implemented: the first persistence candidate is collecting and appears in the signed Performance view; generalized `BuyPolicy` candidates and the Policy surface remain.)*
5. **Committed sentinels and promotion criteria**, reusing the model-promotion shape. *(First committed sentinel implemented with a sample-count review lock and no promotion path; generalized comparative criteria remain.)*

Step 1 had an immediate, intended consequence: **paper stopped trading XRP and began obeying the regime gate.** XRP execution evidence therefore paused until a non-production candidate lane can restore it. That was accepted rather than worked around because the then-current executed evidence cleared −2se on both tracks independently (live −45.7% ±21.5 over 41 windows, paper −35.1% ±13.0 over 81), and a trustworthy mirror was worth more than additional rows from the same policy mixture.

**XRP review updated 2026-08-20.** The historical result reproduced exactly, but its fills end under legacy through v13/v14 and do not measure v21/v5. A current-v21, first-to-fire, ask-priced reconstruction was +1.0% ±12.5 over 59 XRP decisions/windows, with XRP −12.1pp ±12.8 against the same-window non-XRP mean over 58 paired windows. The prospective portfolio journal had only three unique resolved XRP candidates; one completed persistence, lost, and was independently portfolio-blocked, so asset admission alone would have changed zero recorded selections. This less-than-one-day replay contains no current-policy XRP execution and establishes neither harm nor value. The exclusion remains production policy; removing it would be a manual, versioned bounded experiment rather than an evidence promotion. See `reports/xrp-exclusion-review-2026-08-20.md`.

### 12.9 Out of scope

This design does not change any live entry rule, does not let a candidate place an order or hold a budget, does not alter sizing or the fill model, and does not bump the buy policy version when a candidate changes. Only promotion changes the production policy version, and only through the recorded, manual act described in §12.5.

### 12.10 Second production policy: long-shot round trip

A second policy runs beside the edge policy on the same `crypto-15m` market. It buys a side whose executable
Kalshi ask falls to a low mark early in the cycle and sells it through a resting reduce-only limit at a high
mark before settlement. It consumes no `P(UP)`; the trigger is a venue price and a clock. Complete design,
arithmetic, and the screening evidence behind every parameter are in
[`docs/long-shot-policy-design.md`](docs/long-shot-policy-design.md).

The axis being added is a **policy**, keyed `strategyId` alongside `marketId` and `executionMode`. This
preserves §12.3's mirror invariant — the rule layer gains no execution-mode parameter, and the invariant
holds within each policy, so long-shot paper and long-shot live differ only in fill and capital. It also
preserves the 2026-08-13 decision that the forecast model is keyed by market and never by strategy.

Candidates are disjoint from the edge policy's by construction: buy policy v17 requires `P(side) ≥ 55%` with
net edge in `[5pp, 35pp]`, and a 10¢ ask against a 55% probability is a 45pp edge the max-edge ceiling
rejects. These intents are **not** positive-edge buys under §3.7 and must never enter that track record,
which exists to score model calculations and would be corrupted by rows carrying no model probability.

Two approaches, deliberately separated. The **round trip** executes in paper and live. **Buy-and-hold** on
the identical trigger executes nothing: it is recorded as an immutable sentinel at trigger time — not
derived from fills, which would inherit every selection bias of the executing lane — and is the exact HOLD
arm of the round trip's exit decision, priced from the settled venue outcome as `action-counterfactual-v1`
already does.

Budget extends the existing chain by one level of the same shape, **provider → market → policy**, each a
percentage of the level above summing to no more than 100%. Splitting budget does not split risk: position,
same-window and correlation caps remain keyed by market and global across providers and policies, because
risk is exposure to the underlying. The kill switch, reconciliation barrier, quiescent drain, hourly filled
order ceiling and serialized live execution queue are venue and account properties and remain shared.

## 13. Open decisions

- Redundant fallback for the primary Kraken cycle-reference/current-price/volatility series without introducing cross-source basis offsets.
- Exact cross-provider market sets that semantically match each normalized 15-minute target, without assuming equal settlement rules.
- Which official ForecastEx API/product permits event-contract market data, paper modeling, and eventual automated live trading for the operator's account and jurisdiction. *(Crypto.com and Robinhood both resolved 2026-08-13: neither exposes an event-contract API — see §5.)*
- **To investigate: Tradier, Alpaca, IBKR.** Apply the checklist the previous three investigations produced, in this order, because each earlier candidate failed at a different step and the cheap questions come first: (1) is there an official API for the instrument actually traded, since Crypto.com and Robinhood both have crypto APIs and no event-contract API; (2) is there a central limit order book with limit and post-only orders, since Robinhood has none and managed post-only maker placement is where the live edge comes from; (3) what is the measured round-trip spread, taken from the API rather than assumed, since Robinhood's ~1.9% erases any edge while Crypto.com's is $0.01; (4) is market data readable without credentials, which decides whether research can begin before an account exists; (5) does settlement reference make contracts comparable to the 15-minute cycle-open target, or is this a separate market; (6) jurisdiction, eligibility, and whether automated trading is permitted for the operator's account type. Unverified priors to check rather than trust: Tradier appears to be equities and options only; Alpaca appears to be equities plus spot crypto with a documented market-data API; IBKR is already partially known as the ForecastEx route, whose contracts are macro and climate rather than crypto, so the open question there is whether anything else IBKR offers reaches a market Money Noodle can forecast. None of these priors has been checked against official documentation, and every previous investigation contradicted at least one summary that sounded authoritative.
- Whether a `crypto-spot` or `crypto-perp` market is worth pursuing at all, given that the current forecast assumes zero drift and therefore produces no directional signal. Perpetual funding rates are the one observable drift term available from either provider's API and are the natural first candidate.
- Historical backfill vendor and retention/cost target beyond the current Kraken weekly feed.
- Whether live signing should move from file-based Kalshi RSA keys to hardware/OS-keychain custody.
- Whether a market-wide dollar exposure ceiling across providers should complement the existing position and correlation caps, or whether per-trade sizing plus those caps remain sufficient. *(Deferred: unnecessary while one live provider exists.)*
- Whether the signed dashboard should be reachable from the public host at all. Nothing on `noodle.money` requires a session, so `/login` and `/api/auth/*` are pure attack surface there; removing them is stronger than any throttle. The alternatives are a shared-state lockout counter, which would require write access from a role deliberately kept read-only, or edge/WAF rate limiting ahead of the function.
- Whether to pin dependency versions explicitly. 21 of 24 entries in `package.json` are `"latest"`, including `next`, `react`, and `typescript`. The lockfile keeps current installs reproducible, but any lockfile refresh can pull new majors silently and a compromised release of any of those packages would land automatically in a process that signs live orders.
- Alert channels (in-app, desktop, email, SMS/Telegram).
- Manual model-promotion criteria after the automatic 100-window walk-forward evaluation.
- Promotion thresholds for a **policy** candidate: how many independent settlement windows of committed sentinel evidence, and what clustered return margin over production, before a candidate becomes promotable. The model-promotion constants (60 held-out trades, 4 positive folds, 4 beating baseline, 2pp mean-window gap) are the obvious starting point but were tuned for a different question.
- Whether a candidate should also emit sentinels for windows it *refuses* that production takes. Recording only the extra trades measures the upside of a loosening but leaves a tightening with no forward evidence at all, which is the shape of every change adopted on 2026-08-13.
- Whether the adaptive regime gate should keep scoping its evidence to the buy policy version once policies become values. Three version bumps on 2026-08-13 each reset the gate to warming, leaving it inert for most of the day it was most needed.

## 14. Decision log

| Date | Decision |
|---|---|
| 2026-08-21 | Continue the untouched `long-shot-round-trip-buy12-sell97-win600-v2` paper cohort through the precommitted `long-shot-hold-v2` boundary of 60 independent settlement windows, rather than suspend it on the current negative interim read. Do not change the 12¢ entry, 97¢ exit, 600-second window, trailing rule, sizing, or any other cohort identity; do not arm the live lane; and do not promote, tune, or stop on an interim result. The execution report's existing 60-attempt indicator is diagnostic only and cannot substitute for the 60-window sentinel boundary. At the decision read (`2026-08-21T05:35:31.983Z`), v2 had 30 resolved paper attempts across 13 windows, one hold win, zero target exits, and −763¢ exact realized P&L on 1,135¢ staked; hold and round-trip both measured −59.1% ±40.9pp clustered standard error. This broad interval is not formal refutation, and continuing is an evidence-completion decision rather than an endorsement. Existing safety controls may still halt execution, but no economic interim look changes the cohort. |
| 2026-08-21 | Repair and prospectively measure the paper execution mirror without changing funded behavior. Advance to `paper-managed-execution-route-ioc-requalify3-v5`; paper generation validation reads its simulator identity rather than the shared live route identity, restoring the approved three-episode boundary while refusing defective v4 rows as authority. Stamp exact calculation/episode `entry-execution-mirror-pair-v1` IDs and report all four terminal fill cells without nearest-time inference or live-fill conditioning. Retain bounded public print/queue-depletion evidence from the already-authoritative paper fill pass. Do not add authenticated `queue_position_fp` requests yet: they share signed-read capacity with authoritative fill and reconciliation reads, so an unbudgeted observation could affect money-state execution. No buy rule, live route, sizing, gate, order call, budget, reconciliation, exit, or public projection changes. Activated after pause/drain and READY startup reconciliation at `2026-08-21T02:55:42.322Z`; funded control remained operator-paused with zero positions and reservations. Commit `5b7e258` passed CI and Vercel production deployment `dpl_AXognWmXECmYaVBTE2Tfj3BXZ9JG` reached READY with no pair identity in the public projection. See `docs/paper-live-mirror-fidelity-repair-design.md` and `reports/paper-live-mirror-fidelity-2026-08-21.md`. |
| 2026-08-21 | Replace repeated-episode live wire identity with `maker-high30-requalify3-fresh1c-idv2-v6` without changing episode economics. Derive a deterministic 40-character `live:v2:` client ID from the complete final episode ID, append exact `-1`/`-2` create-attempt suffixes without truncation, and fail before reservation on duplicate identity. Remove legacy fuzzy fill matching; v2 lost-response recovery recognizes only exact attempt IDs, and reconciliation blocks before fill application if one venue order owns multiple local entries. Historical 30-character retry records may be recognized only when canceled with zero fill and zero remainder, and never supply fill authority. Apply idempotent ledger-v8 correction `live-order-identity-correction:hype-up:2026-08-20T14:30:00Z`: preserve before/after snapshots, restore HYPE episodes 1 and 2 to their observed zero-fills, retain episode 3 as the sole 0.47 fill, improve exact reporting by 53.58¢, and append a +54¢ whole-cent control audit event (1,755¢/−245¢ → 1,809¢/−191¢). Final v6 startup reconciliation completed READY at `2026-08-21T01:27:47.789Z` with zero positions; operator intent remained paused. Commit `fa1bf7c` passed CI and Vercel production deployment `dpl_9YZhUMmEDRS8Yr16eG4evyvqUCZX` reached READY with the stateless boundary intact. See `docs/live-order-identity-correction-design.md`. |
| 2026-08-20 | Extend collection-only trajectory evidence to `quote-trajectory-spread-observation-v2` and ledger envelope v7 without changing funded behavior. Retain v1 trailing-60-second and cycle-to-date features, and add nullable selected-side ask moves in cents plus canonical Kraken moves in percent over 2/30/60/120/240/360/480/600 seconds, per-window oldest-quote ages, and venue-window coverage. A boundary point may lag by at most the smaller of one requested window or one ordinary observation bucket, so 15-second cadence cannot masquerade as a 2-second reading. Compute private slices from already-fetched quotes only, then stamp one exact provider/contract/side/close-time v2 clone at top-level on every newly issued edge order before placement or fill; this includes later requalified episodes and all terminal outcomes. Preserve legacy absence, omit private slices from the public projection, and add no request, gate, ranking, sizing, execution, fill, exit, reconciliation, or promotion read. Commit `f0bc265` passed CI and deployed as Vercel production deployment `dpl_5qSddRJUJftpS82thaw9bPUYz8Mg`; hosted remains stateless and publishes no trajectory field. See `docs/edge-window-consensus-evaluation-design.md` §2. |
| 2026-08-20 | Add repository verification and narrowly bounded temp-file housekeeping without changing trading behavior. GitHub CI runs `npm ci`, typecheck, ESLint, all tests, and the production build on pushes to `main` and pull requests with read-only repository permission. Next 16 lint uses the ESLint flat config and direct CLI; three inherited React/TypeScript rule families remain warnings, while errors fail CI. At persistent Node startup only, asynchronously reclaim an atomic-write temp older than 60 seconds only if its real rename target already exists; tolerate absent optional roots and skip hidden trees, symlinks, malformed names, and stateless hosts. The sweep never touches durable targets, policy, execution, or evidence. Activated locally after quiescent drain and READY startup reconciliation at `2026-08-20T23:33:34.362Z`; zero temp files remained and live stayed manually paused. Hosted deployment `dpl_HJ3bPFwwzDgv8926nPPjtqU3DBMA` from commit `9c6e45a` reached READY without the prior Edge-runtime instrumentation warnings. |
| 2026-08-20 | Revise the positive-edge display lifecycle for human inspection without changing qualification. A signal observed in the mounted dashboard now keeps its last qualified snapshot, signal-calculation time, expired label, and stateful ladder access after it stops qualifying; current signals remain first and retained signals form a separate section. Requalification replaces the snapshot. Only `market.closesAt` starts the 2.4-second fade and removal. Retention is browser-session-only and cannot feed policy, ranking, execution, or durable evidence. Activated locally after quiescent drain and READY startup reconciliation at `2026-08-20T22:32:44.323Z`. Hosted deployment `dpl_GGRw8SBrPf7SYTx2RyRMQuFGLq5b` from commit `ecfbd93` reached READY and was verified at `noodle.money`; its stateless boundary still excludes the authenticated ladder while the public signal-retention lifecycle is active. See `docs/edge-order-book-monitor-design.md` §4. |
| 2026-08-20 | Add an authenticated, stateful, observation-only Kalshi ladder to signed positive-edge cards. Normalize YES/NO bids to the selected UP/DOWN side, label only displayed level and cumulative quantity, permit one expanded card at a time, poll two seconds after completion, and pause in hidden tabs. Keep the public/stateless surface unchanged and use an uncached read that cannot populate execution depth evidence. Stabilize signal-card and section heights, show awaiting-confirmation signals by default, and retain departing grid slots through a 2.4-second fade whose cancellation replaces stale data on re-entry. No policy, ranking, sizing, fill, reconciliation, or order path changes. Activated locally after quiescent drain and READY startup reconciliation at `2026-08-20T22:20:41.847Z`; live remained manually paused because the separate repeated-episode identity defect was not cleared. Hosted deployment `dpl_HSTsXU9c7ezT9fyeHy2GRbLNHEvP` reached READY with the monitor blocked by its stateless boundary. See `docs/edge-order-book-monitor-design.md`. |
| 2026-08-20 | Treat repeated managed-maker episodes as not mechanically cleared after finding that acknowledgement-race client IDs truncate away the episode suffix and reconciliation accepts the same truncated retry IDs for multiple local rows. One real HYPE fill was consequently attributed to three local episodes; this was a matching defect, not three venue fills. Keep the ordinary position contradiction fail-close, but do not trust settled per-episode ledger/budget attribution or resume repeated-episode execution until collision-resistant bounded IDs, exact matching, and an auditable correction land. No order was submitted during the investigation. See `reports/kalshi-order-size-and-fill-mechanics-2026-08-20.md`. |
| 2026-08-20 | Retain Blend 0.4 after manual review of `walk-forward:975:fnv1a-bccfee60`; record no promotion. Stored ask-and-hold return was +11.38% candidate versus +8.24% baseline over 488 held-out windows, but only 3/5 folds beat baseline. A fresh production-code reconstruction changed the fingerprint to `fnv1a-c9e217a4` and baseline to +8.45%; paired candidate-minus-baseline return was +2.93pp ±1.56pp SE, while Brier/log loss improved. The evaluator also inherits production's side/venue/cost, hard-codes a stale 5–97¢ band, resets drawdown at fold boundaries, and has no execution/exit/capital arm. Before evaluator v3, agree a frozen-cohort, policy-complete, paired and prospective-execution design. Add `maximumEdge` and `minimumSelectedProbability` to promotion request parameter-integrity checking, and make evaluator generation an explicit eligibility gate: v2 continues monitoring but cannot support promotion; only the reserved, not-yet-implemented `expanding-window-v3-policy-complete-prospective` generation may. These close deploy-then-record and repeated-v2-review guard omissions without changing the model. Activated locally after quiescent drain and startup reconciliation at 2026-08-20T15:57Z; hosted deployment `dpl_HKfLWAkwkB18eU7y5XMycBLQNxgd` remained stateless. See `reports/walk-forward-model-candidate-review-2026-08-20.md`. |
| 2026-08-20 | Scope the missed-buy forecast rollup by immutable buy-policy identity. The direct summary already filtered to `BUY_POLICY_VERSION`, but `forecast-rollup-v1` omitted that identity and merged 363 v21 candidates into v22's 8-candidate cohort. `forecast-rollup-v2` carries policy identity in every counterfactual asset/window and filters before nearest-snapshot selection. Untagged v1 counterfactual columns are excluded rather than guessed while their policy-independent statistics remain readable; the verifier fails if a legacy rollup contains active-policy sealed rows. The indexed sealed shards contained zero v22 rows, so the repair loses no active evidence and requires no manual shard, index, rollup, or journal mutation. The owning compactor writes v2 on its next normal seal. Activated in the local runtime at 2026-08-20T06:15:20Z after quiescent drain and successful startup reconciliation; the authenticated summary and full verifier then agreed on the active-policy-only cohort. Hosted deployment `dpl_BWFuwFrd2ExLtny9FCZK9mRvhFMg` reached READY at 2026-08-20T06:17Z with its stateless collector disabled and no forecast-storage write authority. See `docs/forecast-storage-design.md` §4.1. |
| 2026-08-20 | Complete SPEC §12.8 step 2 and close two modelled mirror asymmetries. (a) Every live skip is journalled as a durable episode carrying a class the calling gate names itself — a classifier over the free-text reasons was rejected because a new gate would silently inherit someone else's label. Operator intent separates a system `stop` from an `operator` pause. (b) The paper standalone exit simulates a reduce-only IOC against displayed depth instead of completing unconditionally; the agreed print-based model was corrected before implementation because `placeKalshiSell` is `immediate_or_cancel`/`post_only: false` and returns `liquidityRole: 'taker'`, so it never rests and cannot be modelled by the resting-maker loop. (c) `runPaper` now takes the route `evaluateEntryExecutionPolicy` chooses, closing the §12.2 conformance gap that left the high-edge IOC route with no mirror. Paper deliberately continues to ignore live's risk stops, ceilings and reconciliation gate: that channel must stay open or the measurement of what a stop costs is destroyed. The published paper track record is expected to fall, which is the correct direction — live's 37 exit no-fills retained positions returning +55.5%, so the old costless-exit number was optimistic. No entry rule, threshold, size or gate changed; the mirror invariant is untouched. See `docs/mirror-fidelity-and-skip-attribution-design.md`. |
| 2026-08-20 | Narrow entry admission to buy policy v22: restore `MIN_NET_EDGE` to +5pp and narrow the price band to 10–75¢. **An operator decision, not an evidence promotion, reversing v20 on evidence that still reproduces.** The corrected exact-provider replay over 66,651 resolved snapshots found 3,941 v21 versus 3,373 v22 first-to-fire positions: zero added and 568 omitted (−14.4%). The omitted cohort returned +26.1% ±7.6 over 238 settlement timestamps; the previously stated ±3.8pp was the edge-floor subgroup's standard error, not the whole cohort's settlement-window-clustered uncertainty. Scored on every v21 position, v22 was −3.7pp ±1.3 ask-priced and −1.09pp ±0.31 on bounded payout edge. This weakens rather than supports the economic case; deployment remains an explicit judgment that ask-priced return is an upper bound under adverse maker selection and incomplete exits. Both band ends now bind, `maximumNetEdge()` remains disarmed, and the 10¢ floor is the only gate bounding the documented above-35pp calibration inversion. Activated in the built runtime at 2026-08-20T04:50:15Z. See `reports/entry-admission-v22-review-2026-08-20.md`. |
| 2026-08-20 | Collect `quote-trajectory-spread-observation-v1` without changing funded behavior. Preserve source capture timestamps so cache fallback cannot manufacture flat samples; derive signed underlying and exact provider/side midpoint movement plus spread widening/narrowing over trailing-60-second and contiguous cycle-to-date paths; require four unique observations over 45 seconds; and stamp only new qualified forecasts and immutable entry decisions. Existing tasks supply every quote, the public projection omits the feature, and no policy, ranking, gate, sizing, execution, exit, or promotion path reads it. Any candidate requires a separate precommitted sentinel generation under §12.5. See `docs/quote-trajectory-spread-signal-design.md`. |
| 2026-08-20 | Show changing owned-side venue bid/ask and observation age on signed open-order rows using the execution engine's existing managed-order and open-position observations. Do not add a UI-specific venue poll: the display refreshes with the existing 15-second signed control payload, marks observations older than one calculation window stale, and has no return path into pricing, exits, sizing, or execution. |
| 2026-08-20 | Centralize runtime-task cadence metadata and process-local health without centralizing scheduling. The UI separates eight task clocks from input cache TTLs and reports task, interval, activation, purpose, request cost, last run, and health. Dashboard calculation, the 15-second edge cycle, exact pre-submit reads, bounded two-second managed makers, long-shot entry/trailing/exit watches, and periodic/event reconciliation retain their existing independent loops, queues, activation gates, and request caches. No candidate receives new fast polling and price trajectory/spread remain observation-only. See `docs/task-cadence-observability-design.md`. |
| 2026-08-20 | Retain the edge policy's XRP exclusion after reproducing the old executed loss but finding null current-policy signal evidence. Historical realized return remains −45.7% ±21.5 over 41 live fills/windows and −35.1% ±13.0 over 85 paper fills / 81 windows, all ending under legacy through v13/v14. The v21 first-to-fire ask replay was +1.0% ±12.5 over 59 decisions/windows and −12.1pp ±12.8 against same-window non-XRP peers over 58 paired windows; it spans less than one day and contains no current XRP execution. This neither promotes removal nor proves current harm. Any later removal is a manual bounded experiment requiring a new shared buy-policy version and immutable manifest history. See `reports/xrp-exclusion-review-2026-08-20.md`. |
| 2026-08-19 | Replace v4's whole-window lockout with `maker-high30-requalify3-fresh1c-v5`. An authoritative current-policy maker zero-fill ends one episode, then the same continuously qualifying signal may earn a new episode from the ordinary two snapshots over 15 seconds strictly after maker completion; it need not first become nonqualifying. Cap at three episodes per asset/side/window, rerun sizing, route, quote, portfolio, funding, risk, and reconciliation on each, and let any fill, ambiguity, non-maker terminal result, stale generation, or episode 3 end rearming. Paper uses the same boundary under `paper-managed-maker-requalify3-v3`. This is an explicit operator sequencing decision, not an evidence promotion; v4 supplied only four live attempts at the decision read. See `docs/requalifying-entry-episodes-design.md`. |
| 2026-08-19 | Deploy `maker-high30-one-attempt-fresh1c-v4` with `entry-sizing-reduce30-below-edge30-v1` by explicit operator decision. Below 30pp, commit 30% of the current base ticket to one managed maker and let zero-fill end the sequence. At 30pp+, retain 1× base and submit one capped IOC only if an immediate exact quote still clears 30pp fresh taker edge, 10pp persistence median, 65% quality, 2¢ spread, and the existing 1¢ movement and safety gates. No route upsizes. Direction-based maker refusal/cancellation remains observation-only under `entry-direction-observation-v1`. The 30pp result was retrospective, concentrated, and not promotion-grade; live deployment was chosen because paper cannot establish signed IOC or actual queue fills. See `docs/high-edge-execution-reduced-sizing-design.md`. |
| 2026-08-19 | Replace retroactive contract-selection reconstruction with a prospective, observation-only `portfolio-choice-set-v1` journal. After each positive-edge live intent is durable, detach an immutable record of the exact production candidate states, persistence/retry/cooldown evidence, runtime caps, account-wide exposures, portfolio output, drain actions, issued order, and exact Kalshi outcomes. Pre-register one issued-minus-production-preferred comparison clustered by settlement window; diagnostic review starts at 30 resolved windows and any differing-choice claim requires 60 overall plus 20 differing windows. No historical backfill, automatic promotion, ranking change, or money-path dependency is permitted. See `docs/portfolio-choice-set-journal-design.md`. |
| 2026-08-19 | Resolve mixed maker/taker fee semantics without changing the buy policy. Rename the shared taker-priced quantity `ENTRY_ADMISSION_FEE_ROLE`: it means immediate-execution admission edge before adaptive style selection and remains identical for paper/live. Adaptive execution passes taker and maker roles explicitly; ask and maker counterfactuals do likewise. Do not flip admission to maker without a fresh current-policy replay, version bump, manifest history, and manual decision. Durable calendar-v1 and retired persistence meanings are preserved until versioned collector redesign. See `docs/entry-gate-fee-design.md` §10. |
| 2026-08-19 | Make the refreshed trailing poll the sole long-shot entry owner. The regular 15-second cycle and the one-second poll both called `runLongShot`; only the latter applied `evaluateTrailingEntry`, so queue timing could bypass the stall confirmation for paper and any future armed live lane. Remove regular-cycle entry calls, retain exits and evidence there, and advance `LONG_SHOT_POLICY_SCHEME` to v2 because the set of reachable entries is now deterministic and narrower. Live remains separately disarmed. See `docs/long-shot-policy-design.md` §10c. |
| 2026-08-19 | Replace the inert long-shot hold collector with `long-shot-hold-v2`. The authoritative paper entry decision stamps and writes the exact trigger record; the detached pass only recovers prospectively stamped orders, observes later peak bids, and resolves settlement. The nine active-policy paper orders and two stale v1 sentinels are not backfilled or rewritten. This resets the 60-window review cohort without changing entry, execution, sizing, live arming, or exits. See `docs/long-shot-policy-design.md` §10b. |
| 2026-08-19 | Permit at most 1.0¢ of selected-side ask movement between a taker decision and its signed fresh quote, without relaxing the 2¢ spread or any other applicable gate. Size quantity and fee reserve at the worst permitted price, cap again at the 97¢ entry ceiling, submit only at the fresh ask, and distinguish a pre-submit quote refusal from an accepted zero-fill IOC and a rested maker miss. The first v2 smoke trace had one taker decision refused when 28¢ became 29¢; that n=1 observation identified reporting and cap behavior but did not establish economics. |
| 2026-08-19 | Choose selective `adaptive` execution rather than unconditional taking. Attempt 1 takes only after all six historical strict gates, including the 2¢ spread cost ceiling. One authoritative maker zero-fill may open attempt 2 for that exact logical sequence only: replace the inherited unsupported 30-second cooldown with two new post-completion qualifying snapshots over 15 seconds; retain the four absolute edge, median, quality, and spread gates; waive only maker sample count and comparative advantage; then submit one capped taker IOC. Fill or no-fill ends the sequence, and every other sequence begins adaptive selection anew. See `docs/adaptive-entry-fallback-design.md`. |
| 2026-08-19 | Record, without changing funded behavior, that v21's intended unconditional taker switch was not implemented. `MONEY_NOODLE_ENTRY_EXECUTION_MODE=taker` currently acts on the same strict recommendation as `adaptive` and retains maker when any taker gate fails; a capped IOC may also finish unfilled after quote movement. The v21 manifest and status previously said every accepted decision filled at the ask. They are corrected to describe actual execution. The maintainer must separately choose unconditional taker or the deployed selective semantics before code changes; until then no economic result may be attributed to the arm-C take-every-ask counterfactual. |
| 2026-08-19 | Record the active local long-shot configuration as a new paper collection cohort, not a promotion: 12¢ entry, 97¢ exit, at least 600 seconds remaining, with live arming false. It was selected from the 50-cell retrospective fine-path sweep; that sweep measured +9.0% ±46.3pp sell-at-mark versus +11.5% ±47.3pp hold over 149 entries and therefore did not authorize a parameter change under §12.5. The current cohort must stand on forward evidence under its derived policy version. At the first review it had 8 paper attempts in 4 windows, all losses, and zero matching hold-sentinel records; trigger-time sentinel capture must be repaired before hold-versus-exit evidence can accrue. This row documents existing operator configuration and its evidentiary status; it does not arm live or endorse the parameters. |
| 2026-08-14 | Add a second production policy on `crypto-15m` rather than a second model, market, or provider. It buys a side at a low executable ask early in the cycle and sells through a resting reduce-only limit at a high mark. The durable axis is `strategyId`; the forecast model stays keyed by market, since this policy consumes no probability at all. Its intents are a separate stream and never enter the §3.7 positive-edge track record, which scores model calculations and would be corrupted by rows carrying no model probability. Buy-and-hold on the same trigger executes nothing and is recorded as a decision-time sentinel, because deriving it from fills would measure "hold, conditional on having successfully bought." |
| 2026-08-14 | Extend budget keying to provider → market → policy, each a percentage of the level above. Percentages rather than fixed amounts, so a policy's ceiling compounds with its wins and contracts in its own drawdown without manual edits, and so return on allocated capital becomes comparable across policies. Splitting budget does not split risk: exposure caps stay keyed by market and global across policies, and the kill switch, reconciliation barrier, drain, hourly order ceiling and serialized execution queue stay shared, because they are venue and account properties. |
| 2026-08-14 | Size the long-shot ticket as policy equity ÷ 30 with a 10¢ floor, and take its loss stop as the consequence rather than a chosen percentage. The divisor is the drought the policy must survive — at a 12.5% hit rate, 30 consecutive losses occurs 1.8% of the time. The floor is where Kalshi's `max(1, ceil(...))` fee stops being negligible: a 20¢ and a 10¢ ticket both break even at 12.5%, a 3¢ ticket needs 17.6%. Together they halt the policy below 300¢ of equity. The existing 25% drawdown stop must not be reused; on this policy it would fire after five consecutive losses, which happens 55% of the time. Deriving the ticket from the edge policy's all-in cap was rejected as a hidden dependency — lowering that cap for its own reasons would silently halve this one. |
| 2026-08-14 | Do not reuse `cryptoExposureGroup` for the long-shot policy. It encodes directional correlation — market-cap beta tiers — and this policy trades reversal. Screening separated the two: candidate arrivals are strongly correlated (41% of settlement windows carry more than one, some carry six), but outcomes are close to independent, with co-occurring pairs both missing 75.7% of the time against a fully-independent 74.0%. Group rationing would therefore cost more than it buys, and would concentrate the cost in `alt-beta`, the high-fluctuation assets this policy most wants. Cap at 3 open positions per settlement window with no group restriction, provisionally, until the path recorder measures outcome correlation properly. |
| 2026-08-15 | Keep the current-epoch drawdown stop blended across strategies, and attribute it rather than scoping it. There is one pot of cash: if a strategy loses, the account really is down, and a capital-preservation stop that ignored that would not be preserving capital. Scoping every strategy to itself would also leave nothing watching total account drawdown. What blending costs is attribution — the stop can pause a strategy that did nothing wrong — so `LiveRiskStatus` now carries per-strategy current-epoch P&L and the reason reads `Account live drawdown` with the split, where the previous wording implied the strategy being blocked had caused it. The lifetime stop stays scoped by strategy, because it measures a track record rather than the capital remaining. Per-strategy stops beside a separate account stop is the right end state once the second strategy has evidence; inventing a second threshold before then would bake in an arbitrary constant. |
| 2026-08-15 | Widen the long-shot entry window from the first three minutes to the first five, on measurement rather than intuition. The first hour of live collection suggested the window rather than the price mark was throttling flow — cheap sides were common, cheap sides early were not — and screening confirmed it: at the 10¢ mark, candidates rise from 2.9/day to 15.9/day, turning 60 attempts from roughly three weeks into about four days. Quality does not pay for it. Bucketed by entry time, the rate of reaching 90¢ is flat from three minutes onward (4.2% at 180–300s, 5.0% at 300–420s, 4.6% at 420–600s), so the intuition that a comeback needs more clock is not visible out to ten minutes remaining. The same evidence would support going wider if flow is still short; it does not support going narrower. Every touch rate here remains a floor and all sit below the 12.5% break-even, which is why the policy collects rather than being judged on them. |
| 2026-08-16 | Stop tuning the long-shot marks and wait for unbiased sampling. A sweep of five entry marks against four exit marks over 757 recorded windows put every one of the sixteen combinations between 0.48 and 0.72 of break-even, best 0.72 at 10¢/90¢. The flatness is the finding: lowering the exit raises the touch rate in almost exact proportion to raising the break-even, which is what an efficiently priced book looks like, and a grid that contained an exploitable edge would have shown it. Two caveats keep it from being a verdict — every touch rate is a floor at fifteen-second sampling, and closing the best ratio needs 1.39× more touches against a measured coverage shortfall of 1.36×; and the best cells have the smallest samples, with the largest (n=150) at 0.58. Exit price is now understood as a ratio to entry rather than an absolute, since the two move together. The one-second entry polling added the same day removes the sampling bias, so the sweep is re-runnable via `npm run analyze:long-shot-marks` once enough paths are recorded under it. |
| 2026-08-15 | Enter the long-shot position as a price-capped taker IOC at the mark, an explicit exception to maker-only production execution. The trigger is defined as the executable ask reaching the low mark, so taking that ask is intrinsic to the strategy rather than a choice of execution style, and every break-even figure already assumes paying it. A post-only bid at the mark would cross and be rejected, and one tick below would rest and frequently not fill — the side is cheap precisely because price is moving away from it. `placeKalshiTakerBuy` refuses to submit above the approved cap, so this can never pay more than the mark, and Kalshi charges the same fee either way, so the cost of taking is the spread the mark already bounds. This does not relax the edge policy's maker-only execution or its taker gates. |
| 2026-08-15 | The paper bankroll belongs to the edge policy alone. Live cash is one real Kalshi balance and settles through the shared control whatever strategy spent it, but `ledger.paperBudget` is a counter, and crediting another strategy's paper payout into it would inflate the edge policy's paper equity and the published track record. Other strategies derive paper equity from their own orders, so nothing is credited. Found while wiring the second strategy: `settleDueOrders` had credited every paper settlement unconditionally, which would have been silently wrong rather than failing. |
| 2026-08-15 | Exit the long-shot position by polling the owned-side bid every second (two at first; tightened 2026-08-16 alongside a one-second entry pass and a shared quote cache) and submitting a reduce-only IOC at the mark, superseding the resting GTC limit decided a day earlier. Kalshi refuses that combination: a 0.01-contract probe at 95¢ against a 9¢ bid returned `400 invalid_order: "reduce_only can only be used with IoC orders"`. Reduce-only is the invariant that a sell cannot open reverse exposure, so the resting order gives way rather than the safety property. The original objection to polling was to a 15-second cadence, not to polling: at one second a 90-second excursion is sampled about 90 times and only a sub-second spike is missed. Each tick costs one request per held contract, since the owned-side bid derives from the two YES prices and needs no order book. The cost is that the exit now depends on the process being alive, where a resting order would have survived a restart; an unfilled position simply settles, so the failure mode is a missed profit rather than an unbounded loss. Verify a venue parameter combination against the API before designing on it — the documentation states the constraint nowhere. |
| 2026-08-14 | Exit the long-shot position through a resting reduce-only GTC limit placed as soon as the entry fills, with no stop-loss and no fallback exit. The premise is transient excursions, and polling cannot see them: a round trip inside 90 seconds is invisible to a 15-second poll. A resting order fills on the spike unattended. The absence of a stop-loss has a structural consequence that removes the need for one — the policy is only ever flat after a win, so re-entry within a window can only follow a profitable exit and a trending window produces exactly one loss rather than a compounding series. A second open position on the same asset and window remains forbidden, because that shape is averaging down. |
| 2026-08-14 | Launch the long-shot policy with no prior-cycle filter, after measuring both readings of the proposed rule. "Prior cycle reached the high mark" passes 86–92% of candidates and does not improve the hit rate, because every winner passes through the high mark on its way to settlement, making it "did this side win recently" in disguise. "Prior cycle completed the full round trip" occurs in at most 0.39% of cycle-side pairs and produced zero candidates at the launch mark over 3.6 days. Record instead the last three cycles' peak bid per side, whether each had a cheap entry available, the `cycleRegime` block, and the maximum bid reached while each position was open — so every version of the filter and every candidate sell mark stays evaluable from one dataset without re-running or committing now. |
| 2026-08-14 | Treat the XRP exclusion as policy-specific. It was removed after clearing −2se on both tracks under a directional policy, and unpredictable direction is precisely what would make an asset good for a volatility-harvesting one. The long-shot policy launches with an empty exclusion list. Per-policy exclusion is legitimate; per-track exclusion is what the mirror invariant forbids. |
| 2026-08-14 | The long-shot policy executes from launch under a bounded learning budget rather than accruing sentinel evidence first — an explicit operator decision, taken with the §12.5 doctrine understood. What that doctrine still governs: no parameter of this policy may be changed on retroactive evidence. The launch marks are fixed until forward evidence over independent settlement windows says otherwise. Screening establishes only that buy-cheap-and-hold has no edge, 20.2% ± 3.7pp of 119 candidates against a 22.2% break-even, and it cannot speak to the exit at all — sampling is provably blind there, observing winners reach 90¢ in 68.4% of cases where the true figure must be 100%. |
| 2026-08-14 | A monitored candidate may be read only at the independent unit and under the policy proposed for activation. The missed-buy best-per-window action therefore reports its own window standard error. Maker/taker shadows cluster repeated recommendations by settlement window, compare taker with the same intent's actual maker result (zero spend for a maker no-fill), and show the active buy-policy cohort separately from historical policy mixtures. An all-history unclustered mean may remain context but cannot authorize live activation. |
| 2026-08-14 | Clarify the profit-reversal decision: `profit-reversal-75-v1` continues to arm and record high-water downturns, but execution is withheld by default and explicitly disabled locally. Its 9 exits over 8 live windows support conservative withholding rather than permanent refutation. Strict-value exits remain executable; restoring profit-reversal execution requires a separate manual prospective review. This supersedes the earlier decision-log wording that “stays armed” could be read as “may still sell.” |
| 2026-08-14 | Re-scope forecast sharding around retained memory, not a misattributed parse stall. The ten-second block was quadratic summary grouping; parsing costs about 1.2 seconds once per process. Build and verify sealed-shard rollups before switching readers, compare counts exactly and floats with a combined absolute/relative tolerance, merge every cycle/window/asset-window independently of shard boundaries, and defer a worker because moving work off-thread does not reduce the roughly 396 MB retained heap. |
| 2026-08-14 | Keep settlement off the calculation path, and bound every upstream wait by the cycle it serves. Resolving already-closed windows ran inside the forecast cycle behind a ten-second venue timeout, so a handful of unsettled contracts made every 15-second calculation late; it now runs on its own schedule with its network phase outside the write queue. Feed and resolution timeouts drop to four and three seconds, because an answer arriving later than the window that asked for it is discarded anyway — the cache falls back and the next pass re-asks. The next calculation begins a lead time before the current one expires rather than at expiry, since a build started at the boundary is always late by its own duration. Repeated resolution failures back off exponentially, and a venue silent for six hours is treated as having abandoned the contract: the row becomes `invalid` rather than pending forever, because an outcome the venue never published cannot be graded and taking the other venue's outcome is forbidden substitution. |
| 2026-08-14 | Make estimate quality replayable before attempting to replace its elapsed-time lift. The lift was one term inside the quality penalty — `min(0.12, (secondsRemaining/900) × 0.12)` — so quality rose up to 12pp on the clock alone, and because quality gates entry at 50%, that literal decided which late-window trades passed. It could not be evaluated at all: walk-forward filters candidates on the stored production confidence, so every candidate inherited production's clock term and scored itself against a constant. Quality becomes an explicit parameter set with a replay function verified against production at issuance, and snapshots persist its five raw inputs. Rows predating the change are labeled `absent`, never reconstructed: quality's inputs include a venue count and 24-hour range that were never stored, and one recorded output cannot identify two unknown terms. |
| 2026-08-14 | Give the promotion ledger its first write path, and make promotion a deploy-then-record act rather than a control that changes the model. `POST /api/model/promotion` refuses any entry whose version or parameters differ from what the running code forecasts with, so a recorded promotion cannot describe a model production is not running. Production parameters stay compile-time constants: an HTTP route must not be able to change the tradeable probability. Promotion requires the newest walk-forward run by id plus every eligibility criterion; rollback requires neither, because reverting must stay available exactly when the evidence has collapsed. |
| 2026-08-14 | Report each action against the alternative it rejected under `action-counterfactual-v1`, split by the policy that chose it, clustered by settlement window, and normalized by stake because sizing rose roughly 15x across the recorded history. Replace the single blended standalone-exit-versus-hold figure: it averaged `strict-value-v1` (+30.3% ±14.3pp per paper window) with `profit-reversal-75-v1` (−192.9% ±81.5pp per live window over 8 windows) and read as neutral. EXIT and SWITCH arms price the rejected alternative from the settled venue outcome; HOLD arms price it from an executable bid observed while the position was open and are labeled `approximate` until complete position paths accumulate. Reporting only — `profit-reversal-75-v1` stays armed pending manual review, because 9 live exits over 8 windows cannot carry a suspension. |
| 2026-08-14 | Separate issuance, approved, submitted/amended, and authoritative-fill prices instead of overwriting `askPrice`; record displayed-depth queue proxies, resting/cancellation timing, and every open position's executable liquidation path prospectively. This instrumentation is observation-only and cannot change execution or exits. |
| 2026-08-14 | Keep Polymarket and Kalshi `approximate`, not exact: both currently publish aligned 60-second opening/closing windows, but Polymarket uses a Chainlink TWAP stream while Kalshi uses a simple average of CF Benchmarks RTI observations. Parse and fingerprint those fields, retain exact venue outcomes separately, and use Kraken drift/path agreement only as an observation-only proxy. |
| 2026-08-14 | Calendar effects remain observation-only. Retain an unbiased, non-pruned fixed-five-minute sample and one candidate/no-candidate record per settlement window, scoped by policy. Review time bands only after 30 dates and 100 candidate windows per band; review individual weekdays only after 12 occurrences and 100 candidate windows each. Counts unlock manual held-out review, never a clock gate. |
| 2026-08-14 | Reconciliation treats partial reduce-only exits as already-realized slices of the original entry. Startup and periodic checks compare Kalshi's cumulative entry fills against open remainder plus prior sold partials, and must not replay the same reduce-only exit fill onto the remainder on each run. |
| 2026-08-14 | Budget audits use spendable whole-cent ledger semantics, not exact reporting payouts. Live budget control must roll forward from configured epoch, reservations, releases, settlements, and reconciliation events exactly. Paper bankroll control is scoped to its current reset epoch and uses whole-cent `pnlCents`; exact fractional sold-exit `payoutCents`/`actualPnlCents` remain reporting fields and must not be mistaken for available bankroll drift. |
| 2026-08-14 | Do not reduce production persistence from three snapshots on retrospective results. Start `persistence-two-consecutive-v1` in the evaluation lane, preserving every other rule and collecting exact forward Kalshi outcomes plus a prospectively captured empirical maker-fill estimate. Require 100 resolved incremental settlement windows before the first manual review; sample readiness cannot promote or alter production. |
| 2026-08-14 | Maker retry cooldown begins when an attempt becomes terminal, not when it was submitted, so the 12-second resting horizon cannot consume the requested 30-second pause. Paper uses the same active attempt cap and durable retry identity as live; the cap stays at one pending separate forward attempt-2 evidence, after historical second attempts resolved 1/12 with −79.2% mean return. |
| 2026-08-14 | Paper simulates maker fills rather than filling at the ask. Filling at the ask is taker execution, so paper was paying a spread and fee live does not pay while missing none of the trades live misses; the always-fills benchmark is retained through the existing ask-fill maker shadow instead of through the mirror itself. |
| 2026-08-14 | Replace paper's static dashboard-bid/ask-touch approximation after paired same-signal agreement measured only 29.7% over 37 attempts. Share live's exact-contract managed repricing state machine, run paper concurrently on the two-second cadence, require public opposite-taker prints to consume displayed queue ahead, retain live-sized quantity, and record authoritative matched-live terms only as a separate non-accounting overlay. |
| 2026-08-14 | The maker fill probability is estimated from what comparable attempts did, not from a first-passage model of the quote. Validation on 623 recorded attempts found the first-passage estimate inverted — predictions of 12/41/64/86% against observed fills of 66/61/57/52% — so it is retained as a recorded diagnostic and excluded from the estimate. |
| 2026-08-14 | Paper mirrors live exactly at the rule layer. The rule functions take no execution-mode parameter, so a policy divergence between tracks cannot be expressed; the tracks differ only in fill model, sizing, and the live-only capital protections, making `paper − live` the desk's execution and capital cost. |
| 2026-08-14 | Speculative policy changes never run in paper. They run in a third evaluation lane that places no orders and holds no budget, because a paper track carrying experiments cannot serve as the control that makes predicted-versus-actual readable. |
| 2026-08-14 | Retroactive scoring may screen a candidate but may never promote one. Promotion requires forward evidence committed at decision time, following the regime-gate sentinel pattern, after retroactive figures adopted on 2026-08-13 failed to reproduce a day later. |
| 2026-08-14 | The buy policy becomes a value (`BuyPolicy`) rather than module constants, so production and every candidate are scored by one evaluator and a candidate's number cannot come from a different implementation than the one that trades. |
| 2026-08-08 | Use Next.js to keep UI and server integrations in one portable TypeScript app. |
| 2026-08-08 | Use Tailwind CSS with local shadcn/ui components. |
| 2026-08-08 | Start with local JSON cache/history; isolate storage for later MongoDB. |
| 2026-08-08 | Build seasonality from Kraken weekly OHLC and keep insufficient-history assets neutral instead of fabricating a value. |
| 2026-08-08 | Add Polymarket and Kalshi research/account/trading after the initial read-only dashboard; live execution remains confirmation-gated. |
| 2026-08-08 | Treat Kalshi 15m contracts as approximate comparisons and down-weight them because CF Benchmarks and Chainlink resolution rules differ. |
| 2026-08-08 | Blend 0.2 lowers smoothed prediction-market context from 42% to 15%; BUY/SELL initially required both 60% likelihood and 60% confidence. |
| 2026-08-08 | Initially track the first qualifying recommendation per contract and prohibit automatic model adjustment from a small sample. |
| 2026-08-08 | Recommendation policy v2 kept 60% directional likelihood and lowered minimum model confidence from 60% to 57%. |
| 2026-08-08 | Recommendation policy v3 sets both directional likelihood and model confidence to 57%; historical records retain their original policy version. |
| 2026-08-08 | Keep conviction internals collapsed by default but expose exact likelihood, confidence components, threshold gaps, and ranking strength for debugging every market. |
| 2026-08-08 | Replace first-signal-only tracking with every qualifying 15-second update; report both update-level and cycle-balanced accuracy. The calibration threshold was later corrected to 100 unique settlement windows so correlated assets cannot unlock it. |
| 2026-08-08 | Show raw current Polymarket/Kalshi predictions beside Money Noodle in positive-edge and debug views while retaining smoothed venue context inside the model. |
| 2026-08-08 | Recommendation policy v4 adds a strict under-97¢ recommended-side gate: at least one live Polymarket/Kalshi quote must leave nominal payout room; execution profitability still requires order-book and cost checks. |
| 2026-08-08 | Initially expose runtime-driven cadence and disclose browser-dependent polling. |
| 2026-08-08 | Add a Node-runtime background collector through Next.js instrumentation so collection continues with the browser closed while the local server remains running. |
| 2026-08-08 | Add a durable working-budget control plane with percentage sizing, funding checks, pause/resume/depletion controls, and paper-first validation before automated live execution. |
| 2026-08-08 | Replace percentage sizing with a signed-balance-verified total live budget and a fixed all-in per-purchase cap; principal is reduced for fees, actual venue fees replace estimates, and unused reserve is released. |
| 2026-08-08 | Use managed post-only Kalshi v2 maker limits, passive repricing, final cancellation, and fill-ledger reconciliation instead of marketable IOC taker orders. |
| 2026-08-08 | Use Kalshi v2 fractional quantities in 0.01-contract increments so the current-price goal can fit inside a small all-in purchase cap; retain whole-contract sizing for Polymarket. |
| 2026-08-08 | Permit live reduce-only switching at the position cap only when future-wealth gain remains positive after liquidation loss and all exit/entry costs; withhold replacement after a partial exit. |
| 2026-08-08 | Add a server-only Polymarket CLOB account connector using viem signing, optional derived/existing API credentials, collateral balance, open orders, and public funder positions. |
| 2026-08-08 | Allow Kalshi and Polymarket automation to be enabled independently; resume needs at least one enabled trade-ready venue, and new reservations are rejected for disabled/unready venues. |
| 2026-08-08 | Present positive-edge outputs as UP/DOWN calculations, not BUY/SELL recommendations; keep all below-gate calculations available in the debugger. |
| 2026-08-08 | Buy policy v5 evaluates under-97¢ eligibility only from executable selected-side asks on Budget-enabled venues; disabled venues and missing asks fail closed. |
| 2026-08-08 | Clear positive-edge buys once their 15-second observation window expires, independently of network refresh success, and show calculation time plus live age. |
| 2026-08-08 | Manage LLM enablement, current provider, and model names durably in the UI while keeping credentials environment-only; automatic research falls back only across enabled providers. |
| 2026-08-08 | Expose Kalshi signed-connector setup and retesting in Budget, report demo/production environment, and continue blocking resume until the separate execution-engine requirement is satisfied. |
| 2026-08-08 | Buy policy v6 is buy-only: qualify from UP likelihood/confidence and enabled actionable UP asks; defer a separately designed sell/down policy and preserve historical directions. |
| 2026-08-08 | Discover Pi-authenticated Anthropic, OpenAI Codex, GitHub Copilot, and Google providers through an isolated local Pi bridge rather than duplicating Pi credentials; enable all discovered providers and follow Pi’s default provider/model initially. |
| 2026-08-08 | Replace one-shot research with a browser-local multi-turn chat over fresh snapshots; cap history and enforce 18-second attempt, 45-second automatic, 30-second selected-provider, and 50-second client deadlines. |
| 2026-08-08 | Blend 0.4 removes the venue price from the tradeable forecast and replaces the likelihood gate with an expected-value gate net of venue fees, after review showed the previous gate permitted buying a 57% outcome at 96¢. |
| 2026-08-08 | Contract basis is computed within a single exchange series after a live check found the previous current-price field was stale by 0.06%, larger than the signal itself, and inverted the sign against both venues. |
| 2026-08-08 | Confidence no longer penalises venue disagreement, because suppressing disagreement suppresses the only trades with edge; realized-versus-predicted edge becomes the primary metric. |
| 2026-08-08 | Blend 0.3 replaces momentum-led forecasting with an oracle-reference contract-basis model after review of 156 resolved records showed the previous model was near-constant (P(UP) 0.373–0.430), always DOWN, and worse than a coin flip at update level. |
| 2026-08-08 | Record every calculation for unbiased calibration, sampled once a minute for non-qualifying rows, and benchmark the model against the coin flip, basis term, and both venues. |
| 2026-08-08 | Confidence now measures evidence quality and independent basis/venue agreement instead of correlated factor-sign agreement, which had made confidence anti-informative. |
| 2026-08-08 | Implement paper-only automated execution with enabled actionable venue selection, conservative whole-contract fills/fees, idempotent reservations and settlements, three-position exposure cap, 25% loss stop, and no live mutation route. |
| 2026-08-08 | Derive and query a Kalshi 15-minute series for every configured dashboard asset rather than maintaining an outdated asset allowlist. |
| 2026-08-09 | Keep tradeable probability and confidence independent of venue prices; venue agreement/divergence is benchmark and execution context only. Count calibration evidence by unique settlement timestamps, not repeated updates or correlated asset-cycles; automatically run immutable expanding-window evaluation at 100 windows and every 25 thereafter, with manual production promotion only. |
| 2026-08-09 | Require durable Kalshi identities, complete authoritative startup/manual/periodic reconciliation, guarded auto-resume only for eligible system suspensions, and a quiescent Pause/drain before reporting restart-safe. |
| 2026-08-09 | Use bounded maker recovery, constrained portfolio selection, reduce-only switch protection, and an observation-only maker adverse-selection funnel; queue-depth/priority capture cannot alter live policy before validation. |
| 2026-08-09 | Before the 100-window review, require venue-specific contract provenance and outcomes so a Kalshi price is never scored against a Polymarket result; harden evaluator non-regression/uncertainty checks and add a quiescent manual model registry with rollback. |
| 2026-08-09 | Preserve lifetime live evidence across budget reconfiguration through durable epochs, add loss/drawdown and stake-expansion gates, and complete same-origin plus backup/restore hardening before broader deployment or risk. |
| 2026-08-09 | Add reduce-only sell recommendations for owned UP/YES positions as unified HOLD/EXIT/SWITCH/BUY future-wealth choices. Learn thesis-break and position-specific profit-lock/reversal exits prospectively, compare them with buy-and-hold in a separate paper policy, forbid cross-trade streak inputs and naked DOWN exposure, and require held-out validation before standalone live exits. |
| 2026-08-09 | A 40-minute live observation across three settlement boundaries produced five losses from five fills, moving lifetime live P&L to −87.83¢/−23.0%; attempt 2 stood at 1/11 wins and −77.3% mean return, while five terminal cancellations temporarily became uncertain before reconciling unfilled. Prioritize quiescent live Pause, non-auto-resumable loss gates, one-attempt live default, cancellation/reporting fixes, and continued paper/position-path collection before any live restart or sell rollout. |
| 2026-08-09 | Quiescently paused and deployed P0 containment: 25% current-budget and 50¢ lifetime-live default loss stops, Resume blocked by both observed breaches, one live maker attempt by default, bounded cancellation polling, corrected starting-equity accounting, and truthful low/high price buckets. Final reconciled live ledger was 12/40 and −92.66¢ with no open position. |
| 2026-08-09 | Deployed append-only full-rules contract provenance plus compact issuance fingerprints and independent venue resolvers. New venue entries fail closed on missing/mismatched outcome identity; legacy real entries cannot contribute walk-forward return. Also require Kalshi and Polymarket closes to align after discovering a prior-window Kalshi contract could remain active briefly across a boundary. |
| 2026-08-10 | A 58.6-minute monitor observed four matched paper/live settlements with zero API/reconciliation errors. Live maker execution gained 27.51¢ versus conservative paper's 21¢ due better fill prices/zero fees, but lifetime live remained −100.02¢ and paired maker adverse selection remained negative. Separate approved limits/issuance quotes/fills in reporting and add a distinct maker-execution paper shadow before treating paper/live differences as model evidence. |
| 2026-08-11 | Review after the one-attempt/aligned-contract deployment found lifetime live +57.23¢ and a post-15:23 cohort +202.60¢, but two cheap wins supplied 96.6% of recent profit and clustered uncertainty remained wide. Keep production unchanged; prioritize accepted-order `not_found`, immutable execution-price fields, maker paper shadow, rolling/tail/high-water reports, and asset evidence (notably SOL 0/7) before stake expansion. |
| 2026-08-11 | A subsequent 52-minute/four-boundary monitor had five live fills, all losses (−42.08¢), while reconciliation and execution remained mechanically healthy. Lifetime live fell to +5.90¢ and post-Resume profit excluding the two largest wins to −44.34¢; SOL reached 0/14. This rejects a claim of stable improved profitability and reinforces no model/stake/retry/asset-policy change pending stronger held-out and maker evidence. |
| 2026-08-11 | Promote opening DOWN/NO from deferred research to binary buy policy v10 under the existing small live caps. Use executable side asks and side probabilities, signed Kalshi maker/reduce-only translation, side-specific persistence/settlement/reconciliation/reporting, and forbid simultaneous opposite exposure. A switch must remain net-profitable after all costs and the replacement probability must exceed the owned side by 15pp, raised to 20pp for same-asset UP↔DOWN reversal. |
| 2026-08-11 | Add two standalone reduce-only sell paths: one fresh strict-value snapshot when Kalshi net cash beats optimistic independent hold value by 1¢, and a +75%-armed profit reversal when one later fresh snapshot shows both executable value and owned-side model probability below high water. Full exits clear persistence; permit unlimited same-window re-entry generations after 60 seconds and fresh qualification. Skip exposure-driven exits. |
| 2026-08-11 | Increase the execution warm-up from 60 to 90 seconds after 34 live fills during seconds 60–90 lost 75.52¢ at −28.5% capital ROI across 30 windows. Preserve the three-snapshot/30-second persistence gate and final-120-second entry cutoff. |
| 2026-08-11 | Promote binary buy policy v11 with a symmetric 55% independent selected-side probability floor. Full fixed-snapshot replay across 228 windows raised clustered win rate from 33.27% to 54.11% and mean fee-aware return from 2.95% to 4.68%; both chronological halves remained positive. Venue prices remain excluded from the forecast and continue to act only as execution costs. |
| 2026-08-11 | Manual operator promotion: deploy binary buy policy v12 with a narrowly relaxed 52.5% selected-side probability floor to increase real Kalshi candidate flow. The observed 52.5–55% cohort was only 4 windows (2 wins, +23.5% descriptive mean), so this is a monitored experiment rather than statistical validation. Keep all other v11 gates, maker-only execution, stake/rate caps, and hard risk controls unchanged; report v12 separately and do not relax below 52.5% without unseen clustered evidence. |
| 2026-08-12 | Deploy binary buy policy v13 and restore the 55% selected-side probability floor for both live and paper. Prospective v12 monitoring found 14 near-floor live intents, seven fills, one hold win, −83.38¢ actual P&L after exits, and −115.98¢ hold P&L. Preserve v12 history and retain the rejected 52.5–55% cohort for observation; future quality/timing candidates run in parallel before manual promotion. |
| 2026-08-12 | Plan a normalized trading-provider registry adding Crypto.com, ForecastEx, and Robinhood read/paper-first. Run every versioned provider/model variant in an isolated paper track, enable live per provider only after manual capability promotion and authoritative reconciliation, add provider/live-paper dashboard filters, and expose active policy details plus immutable policy history. Provider variants may adapt contract semantics and execution but may not put venue prices into tradeable probability. |
| 2026-08-11 | Extend authoritative hold counterfactual settlement from switches to every full standalone exit, and report standalone exit-versus-hold totals separately. Initial reconstruction found 16 exits realized +235.04¢ versus +426.27¢ from holding. Add an observation-only principal-recovery shadow that models selling only enough at the realized exit price to recover exact cost while retaining residual payout; do not change the approved strict-value or +75%-reversal behavior without independent evidence. |
| 2026-08-11 | Retain zero Kalshi weight in tradeable probability after exact-contract replay. Positive Kalshi weights improved Brier score but all lost after actionable Kalshi ask/fee; expanding walk-forward candidates were positive in 0/5 folds and beat the independent baseline in 0/5. Observe a ≤15pp independent/Kalshi disagreement veto after a four-trade positive diagnostic, without promotion. |
| 2026-08-11 | Add a permissive adaptive regime gate rather than fixed clock windows or raw loss streaks. A bankroll-independent exact-contract sentinel learns bounded fee-aware return by independent settlement window, warms on the current policy, soft-blocks only new exposure at strong negative evidence, and automatically reopens under a lower confidence threshold without withdrawing active operator intent. Manual pauses and hard economic stops remain non-auto-resumable. |
| 2026-08-11 | Rename the application to Money Noodle and rename all server configuration variables from `SIGNAL_DESK_*` to `MONEY_NOODLE_*`. Preserve pre-rename durable order/client IDs and migrate browser-local research chat so the brand change cannot orphan reconciliation state or user history. |
| 2026-08-11 | Add a guarded maker/taker execution-style policy after 442 maker attempts showed 53.0% accepted-order fills but −9.49% ask-side counterfactual return for accepted non-fills. Keep live maker execution unchanged initially; record strict taker recommendations and resolved counterfactuals. Any later adaptive taker must be a price-capped IOC limit and clear 15pp current edge, 10pp persistent median edge, 65% quality, 2¢ spread, 30 comparable maker samples, and 2pp captured-value advantage. |
| 2026-08-13 | Split the working budget by provider rather than allocating dynamically per trade, resolving the prior open decision. Cash is not fungible across providers: funds sit in a provider account and cannot fund an order elsewhere, so a combined spendable pool would authorize trades that cannot settle, would be non-binding whenever balances are uneven, and would block a well-funded provider once another consumed the shared pool. Each provider holds its own budget and allocates a percentage of current provider equity to each enabled market as a hard cap; a market may spend its own cap less its own reservations, never the provider's total available cash. |
| 2026-08-13 | Key the forecast model and its calibration by market, never by provider. One diffusion engine is shared because threshold, horizon, and volatility are already parameters; fitted parameters, drift assumptions, and settlement corrections are horizon-specific and belong to the market. Every provider in a market therefore reports the identical probability, which is precisely what allows one probability to be compared against several venue prices — divergent per-provider probabilities would make a price difference and a model difference indistinguishable. Per-provider variants remain an A/B lever running a candidate model version in an isolated paper track, not a permanently divergent forecast. |
| 2026-08-13 | Key entry thresholds, sizing, and execution style by provider and market together, since they depend on that venue's fees, tick and quantity rules, and market structure. Keep position, same-window, and correlation-group caps global across providers within a market, because risk is exposure to the underlying rather than to a venue; keying them per provider would grant each provider a full allowance of the same correlated window and silently multiply intended exposure. |
| 2026-08-13 | Declare provider capability per (provider, market) pair rather than per provider, and carry an explicit `marketId` on every budget, order, policy row, and reported summary while only `crypto-15m` exists. A single capability triple per provider cannot express live support on one market and none on another, which Crypto.com demonstrates concretely: its API supports spot and perpetuals but no event contracts. |
| 2026-08-13 | Order live candidate selection as feasibility-then-objective: shared forecast, per-provider policy gates, hard readiness gates, per-(provider, market) funding, global exposure caps, then rank survivors by expected dollar contribution at the size each provider can actually fill. Narrowing to a single best-priced venue before funding forfeits trades another provider could take, and ranking edge per contract prefers a fatter edge on an unplaceable stake. Reliability stays a hard gate rather than a ranking weight, with venue preference expressed as an explicit cents margin so a negligible price difference cannot flip venues on noise. |
| 2026-08-13 | Withdraw the Crypto.com event-contract adapter as not viable after verifying the official product. Strike Options is a CDNA dealer-quoted IOC binary with no programmatic interface, no order book, 5/20-minute rather than 15-minute durations, a predetermined strike, and settlement on CDNA's own per-second index — non-comparable, and structurally incompatible with managed post-only maker execution. Its Exchange API supports spot, margin, perpetuals, and futures, which belong to a future market gated behind directional-alpha research rather than to `crypto-15m`. |
| 2026-08-13 | Withdraw the Robinhood event-contract adapter as not viable. The only official interface is a crypto-only Trading API — API key plus Ed25519 request signing, US only, covering accounts, holdings, orders, products, and quotes — and it documents no event-contract or prediction-market endpoints. Robinhood's prediction markets are additionally reported to route to the Kalshi exchange, so such an adapter would duplicate contracts already traded directly on Kalshi and add a broker hop rather than a market. Its crypto API is a real interface for a future market, but unlike Crypto.com every endpoint including quotes is account-authenticated, so nothing can be exercised without operator credentials. |
| 2026-08-13 | Add `crypto-spot` as a research-only market rather than extending either provider into `crypto-15m`. Both Crypto.com and Robinhood expose crypto trading APIs and no event-contract API, so this is the market their interfaces actually serve. Capabilities are market-data only, with paper and live false: paper execution for a continuous-payoff instrument would require a sizing and exit model and, more fundamentally, a directional expectation the zero-drift forecast does not produce — paper results would measure an unspecified strategy rather than the model. Read-only first proves authentication, quote normalization, and instrument mapping while that research question stays open. |
| 2026-08-13 | Keep private keys outside the repository working tree and reference them by path. The Kalshi signing key had been committed in the first implementation commit and was present in every tree since. It was purged from history and force-pushed, but GitHub retains unreachable objects — the blob remained fetchable at the old commit afterwards — so the key was treated as exposed and rotated rather than considered recovered by the rewrite. Purging history removes a secret from a branch, never from a host's object store; rotation is the only resolution, and the ignore rules added afterwards are a second line of defence rather than the control. |
| 2026-08-13 | Throttle failed sign-ins with a fixed per-failure delay as the primary control and a per-IP lockout as a secondary one. The delay requires no shared state, so it holds under serverless instance fan-out and source-address rotation; production verification confirmed the delay applying to every attempt while the lockout never fired, because requests spread across warm instances and no single process observed the burst. Record the lockout as best-effort rather than a guarantee, and prefer removing the public sign-in surface over strengthening the counter. |
| 2026-08-13 | Reject a login body the route cannot parse with 400 and do not count it as a failed attempt. Parsing never reached the password, so a malformed request proves nothing about it and must not consume an operator's attempt budget; previously such a request threw into an unhandled 500. |
| 2026-08-13 | Do not pursue a `crypto-perp` market on current evidence. Bitstamp — owned by Robinhood — publishes perpetual funding rates and mark/index premia without credentials, which is the only observable drift term any candidate provider exposes and the natural test of whether the zero-drift forecast is leaving money on the table. Across 20 perpetual markets the funding rate did not predict the subsequent interval's return: pooled and timestamp-clustered correlations disagreed in sign (−0.010 versus +0.172), no market cleared two standard errors, and a sign-following rule returned −0.09% per 8-hour interval gross against a 10bps round trip. Treat this as underpowered rather than settled: the history endpoint returns roughly 100 stamps, so 99 independent intervals against a standard that requires 100 windows for `crypto-15m`. Accumulate funding history before revisiting. |
| 2026-08-13 | Treat Crypto.com as the research surface and Robinhood as an account source only, after verifying both live. Crypto.com's public reads need no credentials and expose 930 instruments with real book depth at a $0.01 BTC spread; Robinhood exposes no order book and quotes a ~1.9% round-trip spread, which no measurable edge survives. Both signed schemes were validated against the live APIs — HMAC-SHA256 for Crypto.com, Ed25519 for Robinhood — and both connectors remain read-only by construction, containing no order, cancellation, or mutation function, so a defect cannot exceed the capability the registry grants. Prefer venue-side read-only keys as well, so a defect in this code also cannot trade. |
