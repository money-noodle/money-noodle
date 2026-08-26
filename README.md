# Money Noodle

<p align="center">
  <a href="https://noodle.money"><img src="public/brand/money-noodle-social.png" alt="Money Noodle — open the live research dashboard" height="260"></a>
</p>

A personal crypto prediction research and trading tool built with Next.js, TypeScript, Tailwind CSS, and shadcn/ui. **[Open the live research dashboard →](https://noodle.money)**

**Start here:** [`docs/live-opportunity-decision-flow.md`](docs/live-opportunity-decision-flow.md) is the short, ordered introduction to how a market observation becomes a signal, candidate, live authorization, and venue outcome. Follow its cited symbols before changing the funded-entry path; code remains authoritative and [`SPEC.md`](SPEC.md) records decisions and why.

## Run locally

```bash
npm install
cp .env.example .env.local # optional: add one or more LLM keys
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Vercel deployment

Set these environment variables in Vercel before deploying:

```text
AUTH_PASSWORD=<a long, unique dashboard password>
AUTH_SECRET=<a separate random value, at least 32 bytes>
MONEY_NOODLE_BASE_URL=https://noodle.money
```

The public dashboard remains available for market research and shows the whole paper-trading side of the system: the simulated automation state and its open simulated positions, the positive-edge buy calculations, a read-only paper budget with its newest 30 sanitized simulated execution intents, and the complete paper track record — full forecast scoring with calibration, benchmarks, segments, lead-time slices, cycle regimes, walk-forward evaluations, and the 500-row signal history, alongside the paper trade record with its segment breakdowns and switch/exit counterfactuals. Signing in is required for LLM research, provider management, automation controls, live budget, portfolio, per-candidate live execution and portfolio readiness, the live trade record, and the live maker-execution report; their API routes require the same signed session cookie. Add any provider or Kalshi credentials only as server-side environment variables.

Vercel functions do not keep the local JSON data files or the 15-second background collector alive between invocations. Money Noodle automatically treats Vercel as stateless: it does not reconcile, execute, start a collector, or write ledgers there. Keep live automation and its durable ledgers on an always-on worker with persistent storage. For another stateless host, set `MONEY_NOODLE_STATELESS=true`.

### Optional Postgres paper projection

The database integration replicates bounded, sanitized paper-only projections from the persistent worker to managed Postgres. It lets the hosted dashboard display real paper results — the Budget dialog and the full public track record — without giving Vercel execution capability. Apply [`db/migrations/001_public_paper_projection.sql`](db/migrations/001_public_paper_projection.sql) and [`db/migrations/002_public_paper_performance.sql`](db/migrations/002_public_paper_performance.sql) with an admin/worker role, then configure `MONEY_NOODLE_DATABASE_URL` on the worker and Vercel. Set `MONEY_NOODLE_POSTGRES_PAPER_SYNC=true` **only on the persistent worker** after verifying the projection; use a separate Vercel database role with `SELECT` access only to the three `money_noodle_public_paper_*` tables. Never put Kalshi credentials or a write-capable execution role in Vercel.

The budget projection is written on every ledger write; the track record is scored from the whole forecast log, so its replication is throttled to once a minute from the background collector and is never awaited by a collection or execution path. Until a snapshot arrives, the hosted dashboard reports the public track record as not yet published rather than showing zeros as though nothing had been traded.

## What works

- Discovers current Polymarket and Kalshi crypto 15-minute markets.
- Compares venue probabilities while labeling Kalshi contracts as approximate matches because their oracle rules differ.
- Forecasts the condition the contract actually settles on: `P(settlement ≥ cycle-open reference)`, from the live basis, realized volatility, and time remaining, computed within a single price series. The tradeable forecast deliberately contains no venue price, because edge is measured against that price.
- Qualifies buys on expected value after venue fees rather than directional confidence, so a likely outcome at an expensive price is correctly rejected.
- Shows top-ranked positive-edge binary buys that may select UP/YES or DOWN/NO. Calculations refresh every 15 seconds, hard-expire after 15 seconds, display calculation time/age, and apply the active fee-aware buy policy. The current v22 rule requires at least 55% venue-independent probability for the selected side and an executable ask from 10¢ through 75¢ on an enabled trading venue; the policy manifest remains authoritative for current thresholds.
- Durably records every calculation, not only qualifying signals, and stores compact issuance references into an append-only full-rules Polymarket/Kalshi contract-provenance registry. New outcomes resolve independently by venue and simulated return requires the same contract venue as its entry price; legacy or mismatched real entries cannot contribute walk-forward return. Reports accuracy, Brier/log loss, calibration bins, accuracy by time to settlement, contract-level streaks, and benchmarks against a coin flip, the basis term, Polymarket, and Kalshi. Calibration remains locked until 100 unique resolved settlement timestamps; repeated updates and correlated assets sharing a close count as one window.
- Provides a versioned five-fold expanding-window evaluation at 100 independent windows and every 25 thereafter. Venue-independent `calibration-replay-v1` snapshots preserve issuance-time basis, volatility, clock, slow-term log odds, caps, and production probability; exact replay is verified, legacy reconstruction is labeled, and candidate grids cover volatility scale and probability caps as well as weights/thresholds. It fits only on past windows, scores unseen windows after fees, feature-fingerprints and persists each run, and exposes results in the Walk-forward tab. Evaluator v2 is monitoring-only, never changes production, and runs only through the explicit paused/stopped offline command documented in `docs/offline-walk-forward-evaluation-design.md`; it never runs in the funded collector.
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
npm run verify:spec
npm run verify:docs
npm run verify:status
npm run archive:local
npm run restore:local -- --destination /tmp/money-noodle-restore/data
npm run cleanup:next-cache
npm run check:disk
```

`check:disk` exits nonzero unless blocks available to the local worker are at least 10% of total filesystem capacity. `restore:local` refuses to overlay active `data/` and publishes a new restore tree only after every manifest object passes its original SHA-256 and byte count. `cleanup:next-cache` removes only rebuildable `.next/cache` and `.next/dev` content and refuses a running development/build process; it does not touch production output or durable data.

## Data and safety

This is research software, not financial advice. Paper shadow trading runs continuously. Live Kalshi execution is environment-gated, typed-confirmation armed, stake/rate capped, kill-switch protected, and blocked on startup until authoritative cash/position/order/fill/resting-order reconciliation passes. Startup/manual/drain remain full barriers; the ordinary five-minute pass independently reads current account safety state plus checkpointed order/fill deltas and exact active transactions, escalating gaps to a full audit. System safety suspensions retain separately persisted operator intent and may auto-resume only after authoritative reconciliation plus every normal readiness check; manual pauses and the kill switch never auto-resume. A user Pause drains the serialized execution queue and authoritatively reconciles before the UI reports the process restart-safe. It uses durable client IDs, managed post-only v2 selected-side limits (YES bids or signed NO-opening asks), 12-second passive repricing with progressive tick backoff, one live attempt by default (a second is hard-capped and disabled pending validation), grouped retry outcomes, bounded cancellation-confirmation polling, actual fill/fee reconciliation, automatic API resolution with retained reservations for ambiguous outcomes, all-in transaction caps, non-auto-resumable current-budget and lifetime-live loss stops, constrained same-window/correlation-group portfolio selection, no simultaneous opposite-side exposure, persistent loss-aware switching, and side-aware reduce-only standalone exits. A strict exit sells when executable cash beats optimistic model hold value; a separate profit lock arms at +75% executable profit and sells on one fresh joint Kalshi-value/model-probability reversal snapshot. Full exits clear persistence and permit uncapped same-window re-entry generations after a 60-second cooldown and fresh buy qualification. Switches require positive future wealth after costs plus a 15pp replacement probability advantage, increased to 20pp for same-asset UP↔DOWN reversals. Polymarket live placement is not implemented.

Start with [`SPEC.md`](SPEC.md) for the product principles and canonical specification map, then read its
indexed [`spec/`](spec/) domain modules for detailed normative requirements and decision history. See
[`STATUS.md`](STATUS.md) for the compact current implementation projection,
[`status/README.md`](status/README.md) for roadmap/history discovery, and [`docs/README.md`](docs/README.md) for the
controlled lifecycle index of designs, evaluation plans, references, and explorations.

## License

[MIT](LICENSE) © 2026 Rai Phairow.
