# Money Noodle

A local-first crypto prediction research terminal built with Next.js, TypeScript, Tailwind CSS, and shadcn/ui.

## Run locally

```bash
npm install
cp .env.example .env.local # optional: add one or more LLM keys
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## What works

- Discovers current Polymarket and Kalshi crypto 15-minute markets.
- Compares venue probabilities while labeling Kalshi contracts as approximate matches because their oracle rules differ.
- Forecasts the condition the contract actually settles on: `P(settlement ≥ cycle-open reference)`, from the live basis, realized volatility, and time remaining, computed within a single price series. The tradeable forecast deliberately contains no venue price, because edge is measured against that price.
- Qualifies buys on expected value after venue fees rather than directional confidence, so a likely outcome at an expensive price is correctly rejected.
- Shows top-ranked positive-edge binary buys that may select UP/YES or DOWN/NO. Calculations refresh every 15 seconds, hard-expire after 15 seconds, display calculation time/age, and require the selected side's executable ask from 5¢ through 97¢ on a venue enabled in Budget.
- Durably records every calculation, not only qualifying signals, and stores compact issuance references into an append-only full-rules Polymarket/Kalshi contract-provenance registry. New outcomes resolve independently by venue and simulated return requires the same contract venue as its entry price; legacy or mismatched real entries cannot contribute walk-forward return. Reports accuracy, Brier/log loss, calibration bins, accuracy by time to settlement, contract-level streaks, and benchmarks against a coin flip, the basis term, Polymarket, and Kalshi. Calibration remains locked until 100 unique resolved settlement timestamps; repeated updates and correlated assets sharing a close count as one window.
- Automatically runs a versioned five-fold expanding-window evaluation at 100 independent windows and every 25 thereafter. Venue-independent `calibration-replay-v1` snapshots preserve issuance-time basis, volatility, clock, slow-term log odds, caps, and production probability; exact replay is verified, legacy reconstruction is labeled, and candidate grids cover volatility scale and probability caps as well as weights/thresholds. It fits only on past windows, scores unseen windows after fees, feature-fingerprints and persists each run, and exposes results in the Walk-forward tab. It never changes production automatically.
- Reports an observation-only maker funnel from submission through post-only race, acceptance, queue fill, and settlement. A strict adaptive maker/taker policy now records shadow taker recommendations and counterfactual returns while live remains maker by default. If explicitly activated later, taker entries are marketable IOC limits capped at the approved ask—not uncapped market orders—and maker, shadow-taker, and actual-taker results remain separate.
- Shows model/market edge, action state, charts, countdowns, and full factor drill-down.
- Runs a local 15-second background collector while the Next.js server is active, even when the browser is closed.
- Caches external data atomically in local `.cache/*.json` files.
- Builds same-month seasonal features from cached Kraken weekly history.
- Provides grounded quick research through OpenAI, Anthropic, Gemini, OpenRouter, Groq, xAI, Mistral, DeepSeek, or a local OpenAI-compatible server.

For a signed Kalshi connection, create a dedicated API key, keep its RSA PEM outside the repository, and set `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, and `KALSHI_BASE_URL` in `.env.local`. Validate against Kalshi demo first. Budget → Account funding → Kalshi signed connection setup can test the connection after restarting the server.

No LLM provider is required for the prediction dashboard. API keys are read only by Next.js server routes. Research → Manage providers shows configured status and lets you enable/disable providers, choose the current provider, and persist model names without exposing credentials. Compatible providers already authenticated in local Pi are discovered automatically and invoked through an isolated, tool-free server-side Pi bridge; Pi OAuth tokens and keys are not copied into the project. Research is a retained multi-turn chat with a fresh dashboard snapshot per answer, automatic fallback, cancellation, and bounded timeouts.

The portfolio dialog can monitor a public Polymarket wallet or use a server-only signed CLOB connector for its collateral/open orders, alongside a signed Kalshi account, when the optional variables in `.env.example` are configured. The Budget dialog persists a total live allocation verified against signed Kalshi cash plus a fixed all-in per-purchase cap that includes fees. Paper and live retain separate ledgers and bankrolls.

## Commands

```bash
npm run dev
npm run typecheck
npm run build
npm start
```

## Data and safety

This is research software, not financial advice. Paper shadow trading runs continuously. Live Kalshi execution is environment-gated, typed-confirmation armed, stake/rate capped, kill-switch protected, and blocked on startup until authoritative cash/position/order/fill/resting-order reconciliation passes, with the same full check repeated every five minutes by default. System safety suspensions retain separately persisted operator intent and may auto-resume only after authoritative reconciliation plus every normal readiness check; manual pauses and the kill switch never auto-resume. A user Pause drains the serialized execution queue and authoritatively reconciles before the UI reports the process restart-safe. It uses durable client IDs, managed post-only v2 selected-side limits (YES bids or signed NO-opening asks), 12-second passive repricing with progressive tick backoff, one live attempt by default (a second is hard-capped and disabled pending validation), grouped retry outcomes, bounded cancellation-confirmation polling, actual fill/fee reconciliation, automatic API resolution with retained reservations for ambiguous outcomes, all-in transaction caps, non-auto-resumable current-budget and lifetime-live loss stops, constrained same-window/correlation-group portfolio selection, no simultaneous opposite-side exposure, persistent loss-aware switching, and side-aware reduce-only standalone exits. A strict exit sells when executable cash beats optimistic model hold value; a separate profit lock arms at +75% executable profit and sells on one fresh joint Kalshi-value/model-probability reversal snapshot. Full exits clear persistence and permit uncapped same-window re-entry generations after a 60-second cooldown and fresh buy qualification. Switches require positive future wealth after costs plus a 15pp replacement probability advantage, increased to 20pp for same-asset UP↔DOWN reversals. Polymarket live placement is not implemented.

See [`SPEC.md`](SPEC.md) for the living product/architecture specification and [`STATUS.md`](STATUS.md) for the current implementation summary. Both documents are updated as the app evolves.
