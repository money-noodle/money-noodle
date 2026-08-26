# Forecasting and evidence

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-25  
> **Canonical for:** profit objective, forecast target/model, positive-edge evidence, resolution, performance, calibration, and learning policy.  
> **Read with:** [`policy-and-track-separation.md`](policy-and-track-separation.md) for candidate promotion and lane separation.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

## 3. Product surfaces

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
