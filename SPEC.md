# Money Noodle — Living Product Specification

> **Status:** Draft 0.32 · **Updated:** 2026-08-09  
> This is the source of truth for product scope, architecture, model behavior, and safety decisions. Update the decision log whenever a requirement changes. Current implementation progress is tracked separately in [`STATUS.md`](STATUS.md).

## 1. Product statement

Money Noodle is a local-first crypto research and prediction terminal. It combines live prediction-market prices, crypto market data, historical/seasonal features, news, and optional LLM research into transparent forecasts for short- and long-horizon investing decisions.

The primary decision surface is every active crypto **15-minute Up/Down market** shown at `polymarket.com/crypto/15M`, with approximately comparable Kalshi markets alongside it. Account monitoring, continuous paper shadow trading, and explicitly armed Kalshi automation are implemented; longer horizons and live Polymarket execution remain later scope.

### Principles

1. **Evidence before output:** every claim and factor identifies its source, timestamp, and availability.
2. **No false precision:** unavailable data stays neutral and visibly unavailable; it is never replaced with invented history.
3. **Model and market remain distinct:** market-implied probability, model probability, and their edge are always separately labeled.
4. **Local first, portable later:** repository interfaces isolate filesystem cache/storage so MongoDB can replace it.
5. **Safe execution:** research is the default. Trading requires explicit credentials, limits, preview, and confirmation.
6. **Fast to act on, easy to audit:** overview cards support scanning; drill-downs expose every input and calculation.

## 2. Users and jobs

Primary user: a single local investor/researcher.

Core jobs:
- Scan all current 15-minute crypto markets in seconds.
- See whether the model agrees with Polymarket/Kalshi and by how much.
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
- A collapsed-by-default debugging region showing directional-likelihood and model-confidence calculations for every market, including below-gate calculations, current raw venue probabilities, threshold margins, confidence components, and ranking strength.
- Link to the source market.
- For an owned UP/YES or DOWN/NO position, show a separate reduce-only recommendation state: `HOLD`, `EXIT TO CASH`, or `SWITCH`. These are portfolio actions, not new directional entries, and must display executable proceeds plus the no-action comparison.

Global controls:
- Live/stale source status.
- Last-updated timestamp and manual refresh.
- A data-cadence dialog driven by the same runtime constants as polling, caching, recommendation buckets, smoothing, and local snapshots. It reports live collector health, distinguishes 15-second model/venue updates from slower inputs and on-demand account data, and discloses that collection continues with the local Next.js server but pauses when that server stops.
- Ranking by signal strength by default.
- Future filters: venue, asset, signal, confidence, liquidity, horizon.

### 3.2 Prediction detail

- Full price chart and market countdown.
- Model vs. Polymarket vs. Kalshi comparison.
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

- Polymarket and Kalshi order previews, placement, cancellation, and status monitoring.
- Venue quote comparison normalized for contract semantics, fees, spread, and estimated slippage.
- Default order type: limit.
- Required preview displays side, contracts, limit, maximum loss, estimated fee, estimated payout, edge, expiry, and account impact.
- Manual mode requires explicit final confirmation. A separate opt-in automated mode may submit qualified trades without per-order confirmation only while armed, funded, within all risk limits, and not paused.
- Selling is always reduce-only: it may close owned UP/YES or DOWN/NO quantity to cash or as the first leg of a protected switch, but cannot create or reverse exposure. New DOWN/NO exposure is opened only through the separately priced binary buy path.

### 3.6 Budget and automated-trading control

The trading system has an independent durable working-budget ledger. A venue account balance never silently increases this budget; the user explicitly allocates the amount that automation may risk.

#### Budget model

- Store configured budget and conservative reservations as integer cents; retain venue-authoritative principal, fee, fill-price, quantity, and P&L fields at exact fractional-cent precision. UI may display dollars.
- Track starting budget, available budget, reserved/open-trade budget, realized P&L, and current working equity.
- The user configures a **total live budget** and a fixed **all-in amount per purchase**. The purchase amount includes contract principal and venue fees and never exceeds available budget or environment stake limits.
- When Kalshi is enabled, saving verifies the total live budget against the signed available Kalshi cash balance.
- Execution chooses the largest supported quantity whose principal plus conservative fee reserve fits under the per-purchase cap. Kalshi v2 uses 0.01-contract increments; Polymarket remains whole-contract only. Venue-reported fill prices and fees replace estimates, and unused reserve is released without artificial P&L.
- Order placement reserves planned all-in spend; settlement releases payout and applies `payout − actual stake` to realized P&L.
- Budget changes are allowed only while paused and with no unresolved reservation conflict. Every configuration creates a durable budget epoch; reservations, orders, fills, settlements, and reconciliation adjustments retain that epoch ID. Current-epoch P&L may restart, but closed-epoch and lifetime-live results are immutable and remain separately reportable. Every change is audited.

#### Account funding

- Polymarket and Kalshi can be enabled or disabled independently, but at least one venue must remain enabled.
- Automation may resume when at least one enabled venue is trade ready. Because live execution currently supports Kalshi only, signed Kalshi available cash must cover the uncommitted live budget.
- An enabled venue must have an authenticated/readable account connector before it can receive automated orders. Disabled or currently unready venues are never selected for new orders.
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
- Paper mode uses the same sizing, reservation, settlement, and state-machine code as production live execution while retaining a completely separate bankroll, ledger, P&L, and report.

#### Paper execution engine

- The 15-second background cycle settles due paper positions before evaluating new entries, including while automation is paused.
- Entries are binary buy policy-v10 calculations generated no more than 15 seconds ago. Side-specific persistence prevents UP evidence from authorizing DOWN and vice versa; direct portfolio selection cannot hold both sides of one asset/window.
- Venue selection is limited to enabled, authenticated, funded venues and ranks the selected side's executable ask after spread and estimated fees. Missing side-specific bids/asks, asks outside 5¢ through 97¢, spreads above 10¢, entry inside the final 120 seconds, insufficient venue cash, or an inability to buy the venue's minimum quantity fail closed.
- Paper fills mirror venue quantity granularity, including 0.01-contract Kalshi quantities, using the same explicit all-in purchase cap against a separate bankroll, conservative estimated fees, at most three concurrent positions, durable states, and idempotent budget hooks.
- Venue outcomes settle the reserved stake to payout and realized P&L. Unsupported final outcomes return the paper stake as invalid rather than manufacturing a win or loss.
- Paper shadow trading never pauses or resumes live automation. It runs continuously until its independent bankroll is depleted; any paper reset is explicit and cannot mutate the live budget, ledger, intent, or P&L.
- Live Kalshi entry uses managed v2 `post_only` GTC selected-side bids rather than marketable IOC taker orders. YES entries map to Kalshi YES-book bids; NO entries map to signed YES-book asks while all limits, costs, fills, P&L, and UI remain NO-denominated. It joins/improves the selected-side bid over a 12-second management window, amends gradually toward selected ask-minus-one-valid-tick without crossing or exceeding the original edge-approved cap, cancels every remainder, accepts partial fills, and reconciles actual `fee_cost` before releasing unused reserve. A zero-fill/post-only acknowledgement race may receive one new durable retry after a 30-second cooldown only after all current signal, venue-specific edge, maturity, portfolio, quote, budget, rate, and final-120-second gates are revalidated. Each asset/contract has a hard cap of two attempts and never falls back to taker execution. During live validation, the operational default is one live attempt; a second attempt remains paper/observation-only until held-out retry evidence is positive and manually promoted. Each repeated create race backs off one additional valid tapered tick. A rejected post-only amend is definitive and leaves the previously accepted resting order unchanged, so management continues rather than escalating to uncertainty.
- Cancellation confirmation tolerates Kalshi's bounded read-after-delete consistency delay without assuming success. Poll authoritative order status after DELETE for a short bounded window and confirm terminal `canceled` status, zero remainder, absence from the complete resting-order collection, and refreshed fills. Unknown/resting status, nonzero remainder, contradictory fills/positions, or expiry of the confirmation window still fails closed and triggers full reconciliation.
- Persist every maker attempt separately for authoritative recovery and fill-model evidence, but group live-ledger presentation by stable asset/window intent. Distinguish `post-only race` (never accepted, no spend) from `rested · no fill` (accepted, then canceled), and label an intent whose later bounded attempt filled as `recovered on retry`.
- Raw positive-edge signals remain visible and tracked immediately, but paper/live execution uses a durable maturity gate: first 60 seconds blocked; current snapshot qualified; at least 3 qualifying snapshots spanning 30 seconds; median net edge at least 5pp; current quality at least 50%; and no new entry in the final 120 seconds. A failed current snapshot resets persistence, and repeated processing of one timestamp cannot manufacture observations.
- Signal qualification, execution readiness, venue attempt, and actual position are separate UI states. Each current card is joined to the exact live asset/contract order so unfilled/rejected maker attempts are never presented as open positions, and the automation skip reason distinguishes absent edge from already-attempted signals.
- Live execution has a hard startup reconciliation barrier. Before any new live order, fetch complete paginated Kalshi cash, positions, orders, fills, and resting orders; match durable client and venue IDs; cancel and confirm Money Noodle resting remainders; recover missing/partial entry and reduce-only fills; validate current position quantities; and align whole-cent local reservations without manufacturing P&L. Unknown managed orders, unrelated resting orders, malformed/incomplete history, contradictory positions, insufficient venue cash, or unconfirmed cancellation block and pause live automation.
- The same full reconciliation runs periodically every 300 seconds by default, configurable server-side and clamped to 60–3600 seconds. It is queued behind serialized execution, so no active managed order can be mistaken for orphaned resting risk. First periodic failure changes reconciliation to blocked and suppresses new orders, then retries after 30 seconds without changing the persisted automation state; a second consecutive failure safety-suspends and audits. A successful retry restores readiness, and unchanged successful periodic passes do not write redundant audit events.
- Persist explicit operator intent separately from operational state. Manual Pause/kill, reconfiguration, mode changes, depletion, and conservatively migrated legacy pauses withdraw auto-resume permission. System-originated transaction ambiguity or reconciliation failure may preserve active intent only if automation was active beforehand. A successful authoritative reconciliation is the verification trigger, but auto-resume additionally requires all ordinary resume blockers to be clear. A manual pause during suspension cancels pending auto-resume. No free-form pause-reason parsing may grant permission.
- Entry client intent is durable before submission, and the venue ID is persisted immediately after acceptance. Non-definitive request, schema, amend, cancellation, and exit errors use an `uncertain` state, retain the reservation, safety-suspend, and automatically launch authoritative reconciliation after the current serialized engine operation. Reconciliation retries through a 30-second Kalshi consistency window before treating an absent client ID as rejection. A system-originated suspension may guarded-auto-resume only when active operator intent was retained and every ordinary readiness check passes; manual/kill/configuration pauses never auto-resume. Only a definitively rejected post-only cross can release immediately.
- Aligned quarter-hour oracle paths are durably sampled once per 15-second bucket and produce observation-only sign-flip rate, lag-one autocorrelation, trend efficiency, range, cycle-local volatility, and regime labels. Issuance-time path prefixes are attached to forecast records for independent-window outcome analysis but are forbidden from production probability, confidence, ranking, and execution until validated.
- An observation-only settlement-average estimator explicitly models the final 60-second average. Before the window its Brownian effective variance is `σ²(T − 2W/3)`; inside the window it integrates observed log prices and assigns conditional future-integral variance `σ²r³/(3W²)`. It remains a benchmark and does not replace production `P(UP)` before held-out validation.
- A separate observation-only maker model estimates the probability that Kalshi's ask touches a passive bid during the 12-second managed-order horizon using quote-path volatility and Brownian first passage. It is stored on forecasts/orders and evaluated through an execution funnel that separates submission, post-only acknowledgement race, acceptance, rested no-fill, partial/full queue fill, and settlement. First-passage calibration is conditional on accepted orders; post-only races never count as queue non-fills. Resolved forecast outcomes supply counterfactual settlement results for accepted no-fill attempts without changing their zero-spend ledger state. Report `P(UP | fill)` versus `P(UP | accepted, no fill)`, net return, independent windows, and execution-condition segments. Ask touch is not equated with queue fill or profitability, and none of these estimates may affect gating or sizing before validation.
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
- Venue pricing is an independent benchmark and may enter only the separately labeled venue-informed comparison. It has zero weight in tradeable `P(UP)`. Slow regime features (monthly, yearly, seasonal, news) are bounded nudges scaled by their own confidence.
- Model confidence expresses evidence quality from reference/volatility availability, volatility sample depth, clock uncertainty, and broad data health. Agreement with or divergence from venue prices cannot raise or lower confidence in the tradeable estimate.
- Every qualifying calculation and a bounded prospective one-minute sample of non-qualifying calculations are recorded. Metrics solely over signals the policy chose to act on are selection-biased and cannot establish calibration.
- Accuracy reporting must include benchmarks against a coin flip, the basis term alone, Polymarket, and Kalshi. A model that cannot beat those has no demonstrated edge.
- Accuracy must be reported by time to settlement and as calibration bins. Per-asset contract streaks remain diagnostic, but calibration evidence is counted by unique settlement timestamp because correlated crypto contracts sharing a window are not independent.

### 3.7 Positive-edge buy track record

Money Noodle must persist every calculation that passes the active buy policy and summarize its eventual outcome. These are model calculations and trade-selection inputs, not personalized recommendations or guarantees.

#### Issuance policy

- The active policy is binary buy policy v10. A calculation qualifies only when `P(side) − side ask − venue fees` is at least 5 percentage points, estimate quality is at least 50%, and the executable selected-side ask is from 5¢ through 97¢ on at least one live venue enabled in Budget. `P(DOWN)=1−P(UP)` and uses no venue input.
- The price gate uses the actual Polymarket outcome-token ask or Kalshi YES/NO ask for the side being purchased—not market probability, midpoint, last price, the opposite side's ask, or a disabled venue. Missing actionable side quotes fail closed.
- Every new forecast stores the selected entry side and all actionable UP/DOWN venue prices. Historical policy-v9 observations remain immutable legacy UP entries. Reduce-only exits use the owned side's venue-independent probability and executable side bid under a separately versioned exit policy; they cannot manufacture opposite exposure.
- Disabled venues may remain visible for research but are dimmed, excluded from qualification, excluded from tracked actionable prices, and unavailable to execution.
- A calculation is current for no more than one 15-second observation window. Expired calculations must not remain presented as qualifying outputs or be accepted by future execution logic.
- Every qualifying 15-second update is a separate immutable forecast observation. At most one observation is stored per asset/contract/15-second UTC bucket, preventing duplicate browser or manual requests.
- Each observation stores a shared cycle ID plus issue time, close time, direction, UP probability, confidence, model version, tracking-policy version, Polymarket/Kalshi quotes, confidence calculation, and complete factor snapshot. It also stores per-venue contract ID, rules fingerprint, resolution/reference source, reference value, averaging window, and comparability state when available.
- Direction changes within a cycle are retained and scored independently; no update is overwritten or selected with hindsight.
- Forecast observations are durable user data, not disposable response cache data.
- Threshold or policy changes create a new policy/model version and never rewrite historical records.

#### Resolution policy

- Outcomes are resolved separately for every priced venue contract after that venue reports a final result. Multiple observations may share one target contract outcome, but approximately comparable Polymarket and Kalshi outcomes are never assumed identical.
- Each update records venue-specific outcomes and resolution timestamps. Signal-quality Brier/log loss uses the explicitly identified target outcome; simulated return uses the outcome from the same venue as its stored entry ask.
- Unresolved, cancelled, ambiguous, or invalid markets remain separately classified and are excluded from accuracy.
- The system retries delayed resolutions without changing the original forecast.

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

The dashboard marks an entry as a **positive-edge binary buy** when expected value after venue fees clears 5 percentage points, estimate quality clears 50%, and an enabled venue has an executable selected-side ask from 5¢ through 97¢. It may open UP/YES or DOWN/NO. Reduce-only exit recommendations for owned positions remain under the separate HOLD/EXIT/SWITCH policy above. Depth, queue priority, and slippage are not yet modelled. Cards are sorted by edge strength and execution uses additional maturity, freshness, portfolio, funding, and timing gates.

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

### Planned venue adapters

Define a common `PredictionVenue` interface while preserving venue-specific contract semantics:
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

### Contract normalization

Never assume venue contracts resolve identically. A normalized market must retain:
- Venue ID, title, exact rules, resolution source, open/close time, timezone.
- YES/NO or UP/DOWN mapping.
- Tick size, minimum order, fee model, restrictions, and settlement terms.
- A `comparability` state: exact, approximate, or not comparable.

## 6. Storage

### Initial local storage

`.cache/*.json` stores timestamped response envelopes and hourly price history. Writes are atomic (temporary file then rename). Runtime cache is gitignored.

Planned repository boundaries:
- `MarketSnapshotRepository`
- `ForecastRepository` (initial durable local implementation: `data/forecast-history.json`) 
- `NewsRepository`
- `AccountSnapshotRepository`
- `OrderAuditRepository`
- `ResearchSessionRepository`

### MongoDB migration

Replace repository implementations without changing domain/services. Add TTL indexes for raw cache records and durable collections for forecasts, outcomes, trades, and audit events. Credentials do **not** belong in MongoDB documents in plaintext.

## 7. Security and trading controls

- Secrets only in server environment variables or OS keychain/secret manager.
- Separate read-only and trading credentials where venues support them.
- Browser receives capability/status flags, never secret values.
- CSRF protection and same-origin checks on all mutation routes and billable research requests.
- Idempotency key on every order submission.
- Immutable local audit record for preview, confirmation, venue response, fill, cancel, and error.
- Configurable limits: max order loss, daily loss, open exposure, orders/minute, allowed venues/assets, and price slippage.
- Global trading kill switch, off by default.
- Stale quote, stale account state, changed market, or disconnected venue blocks submission.
- Demo/paper mode ships before production order placement.
- LLM output can draft research or a ticket but can never directly submit an order.

## 8. Technical architecture

- **Framework:** Next.js App Router, React, TypeScript.
- **UI:** Tailwind CSS and local shadcn/ui components; Radix primitives for accessibility.
- **Charts:** Recharts initially.
- **Server:** Next.js route handlers and server-only services.
- **Runtime:** local Node.js; architecture remains deployable later.
- **Data flow:** external adapter → cached raw data → normalized domain data → feature/model service → API → client dashboard.
- **Freshness:** every API payload includes generation/expiry and per-source status. Stale cached values are labeled. Runtime cadence constants in `lib/freshness.ts` drive both collection behavior and the in-app cadence disclosure to prevent documentation drift.

Recommended future service boundaries:
- `lib/venues/*` — Polymarket/Kalshi adapters.
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
- [ ] Add explicit averaging-window parsing and Kraken-to-venue reference-drift comparability reports.
- [ ] Harden walk-forward pass/review criteria for Brier, log loss, coverage, drawdown, clustered uncertainty, candidate-grid selection, and separate maker-executable return; add replayable quality inputs before testing a replacement confidence formula.
- [ ] Add an immutable model registry with quiescent, audited manual promotion and rollback; automatic evaluation and LLM research must have no promotion capability.
- [x] Add side-aware DOWN/NO paper and live entries from executable NO asks, with signed Kalshi order translation, side-specific persistence/settlement/reconciliation/reporting, and no implicit reversal through SELL.
- [x] Multi-year Kraken weekly OHLC backfill for same-month seasonality, with neutral output when genuine prior-year samples are insufficient.
- [ ] Stronger news/event pipeline and market microstructure features.

### Phase 3 — Venue/account read integrations
- [ ] Common venue interface.
- [x] Polymarket authenticated CLOB collateral-balance and open-order connector plus public position monitoring.
- [x] Batched public Polymarket CLOB UP/DOWN books for actionable asks.
- [x] Polymarket normalized public CLOB order-book reads.
- [ ] Polymarket private fill reconciliation and live execution.
- [x] Kalshi public 15-minute market reads.
- [x] Approximate cross-venue probability comparison with oracle mismatch labeling.
- [x] Kalshi read-only balance, position, and resting-order monitoring when credentials are configured.
- [x] Initial read-only Polymarket/Kalshi account panel (public wallet positions for Polymarket).
- [ ] Fully normalized unified portfolio, historical fills, and P&L reconciliation.

### Phase 4 — Paper then live trading
- [x] Durable working-budget ledger with signed Kalshi total-budget verification and fixed all-in per-purchase sizing.
- [x] Pause/resume/depleted state machine and audit events.
- [x] Initial account-funding readiness checks for enabled venues.
- [x] Independent Polymarket/Kalshi enablement with at-least-one validation and enabled-only execution guards.
- [x] Budget/trading control UI with explicit execution-capability status.
- [x] Deterministic paper risk engine, actionable venue selection, idempotent order ledger, settlement, and Budget UI.
- [x] Paper mode using durable reservation/settlement hooks and automated 15-second processing.
- [x] Deterministic failure-injection reconciliation tests for lost responses/cancellations, malformed history, amendment chains, partial fills/exits, cash/position contradictions, and restart recovery.
- [ ] Historical execution replay/backtest harness distinct from the prospective walk-forward evaluator.
- [x] Explicitly armed, audited live Kalshi v2 maker limits with fractional sizing, fee reconciliation, stake/rate caps, cancel, and kill switch.
- [x] Reduce-only Kalshi switch exits with liquidation-loss-aware valuation and partial-exit protection.
- [ ] Persist complete position-lifecycle and executable liquidation snapshots, including high-water marks, probability deterioration, reversal features, depth, and sampled HOLD counterfactuals.
- [ ] Add observation-only unified HOLD/EXIT/SWITCH/BUY ranking by risk-adjusted incremental expected cents and report exit-versus-hold outcomes by independent window.
- [ ] Run a separately versioned paper buy-and-hold versus buy-plus-exit policy before changing live behavior.
- [ ] After held-out validation and budget-epoch/loss-gate completion, add tightly limited standalone live Kalshi reduce-only exits with mature signals, durable IDs, IOC price bounds, partial-fill protection, reconciliation, and same-window no-reentry.
- [x] Durable startup, manual, and periodic accepted-request/lost-response reconciliation against complete Kalshi cash, orders, fills, resting orders, and positions.
- [x] Guarded auto-resume for eligible system suspensions plus quiescent Pause/drain with restart-safe verification.
- [x] Reconciliation, periodic-failure, guarded-recovery, and execution-drain status UI.
- [x] Add non-auto-resumable current-budget and lifetime-live loss breakers; deploy with live paused and both limits blocking Resume on the observed ledger.
- [x] Default live maker recovery to one attempt behind a server-side hard maximum of two.
- [ ] Add prospective attempt-2 paper counterfactuals and require held-out manual promotion before restoring live retries.
- [ ] Complete the engine-level regression fixture for bounded post-DELETE polling and the fallback uncertain/reconciliation path; unit polling and fail-closed tests are implemented.
- [x] Correct live execution summary `startingCents` to use configured starting allocation rather than current working equity.
- [x] Correct entry-price report bands below 25¢ and above 75¢ without rewriting raw records.
- [ ] Add durable budget epochs, current-epoch/lifetime-live reporting, loss/drawdown circuit breakers, and explicit evidence gates for any stake increase.
- [ ] Enforce same-origin/CSRF checks on every mutation and billable research route.
- [ ] Operator fill/order/settlement alerts.
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
7. Every qualifying binary policy-v10 expected-value update is durably recorded at most once per contract/15-second bucket with selected entry side and side-specific actionable prices; legacy policy-v9 rows remain immutable UP entries.
8. Final venue outcomes resolve records without altering the original forecast snapshot.
9. Accuracy excludes pending/invalid records and reports sample size beside every metric.
10. A $100 total budget with a $1 all-in purchase size never spends more than $1 on principal plus fees; reservation does not change equity, and unused maker-order reserve returns without changing P&L.
11. New paper orders are blocked while unconfigured, depleted, stale, duplicated, disconnected, underfunded, too wide, too near close, above exposure limits, or unable to buy the venue's minimum supported quantity.
12. Budget configuration, control-state transitions, reservations, settlements, and rejected resumes are durably audited.

## 12. Open decisions

- Redundant fallback for the primary Kraken cycle-reference/current-price/volatility series without introducing cross-source basis offsets.
- Exact Kalshi market set that semantically matches Polymarket 15m contracts.
- Historical backfill vendor and retention/cost target beyond the current Kraken weekly feed.
- Whether live signing should move from file-based Kalshi RSA keys to hardware/OS-keychain custody.
- Whether the global working budget should be explicitly split by venue or allocated dynamically per trade after per-venue funding checks.
- Alert channels (in-app, desktop, email, SMS/Telegram).
- Manual model-promotion criteria after the automatic 100-window walk-forward evaluation.

## 13. Decision log

| Date | Decision |
|---|---|
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
| 2026-08-11 | Rename the application to Money Noodle and rename all server configuration variables from `SIGNAL_DESK_*` to `MONEY_NOODLE_*`. Preserve pre-rename durable order/client IDs and migrate browser-local research chat so the brand change cannot orphan reconciliation state or user history. |
