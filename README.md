# Money Noodle

<p align="center">
  <a href="https://noodle.money"><img src="public/brand/money-noodle-social.png" alt="Money Noodle — open the live research dashboard" height="260"></a>
</p>

A personal crypto prediction research and trading tool built with Next.js, TypeScript, Tailwind CSS, and shadcn/ui. **[Open the live research dashboard →](https://noodle.money)**

**Conceptual tour:** [`docs/live-opportunity-decision-flow.md`](docs/live-opportunity-decision-flow.md) is the short,
ordered introduction to how an observation becomes a signal, candidate, authorization, and venue outcome.
**Contributors start with [`AGENTS.md`](AGENTS.md), then [`SPEC.md`](SPEC.md)** and its routed canonical modules before
using the tour's cited symbols. Code remains authoritative for current behavior.

**What this file is.** Orientation and setup for a human arriving at the repository. It is not implementation,
requirement, or operational authority, and it is deliberately light on current thresholds and behavior so it
cannot drift against the records that are governed. [`STATUS.md`](STATUS.md) is the dated implementation
projection, [`SPEC.md`](SPEC.md) and its [`spec/`](spec/) modules are canonical for requirements, and code plus
the versioned registries remain authoritative for what the system does right now.

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

- Discovers current Polymarket and Kalshi crypto 15-minute markets and compares venue probabilities, labeling
  Kalshi contracts as approximate matches because their oracle rules differ.
- Forecasts the condition the contract actually settles on — `P(settlement ≥ cycle-open reference)` — from the
  live basis, realized volatility, and time remaining, within a single price series. The tradeable forecast
  deliberately contains no venue price, because edge is measured against that price.
- Qualifies buys on expected value after venue fees rather than directional confidence, so a likely outcome at
  an expensive price is correctly rejected, and ranks positive-edge binary buys that may select UP/YES or
  DOWN/NO.
- Durably records every calculation, not only qualifying signals, resolves outcomes per venue, and reports
  accuracy, Brier/log loss, calibration bins, lead-time slices, streaks, and benchmarks — plus a versioned
  expanding-window walk-forward evaluation that never promotes a model automatically.
- Runs a continuous paper shadow trader and an observation-only maker execution funnel alongside an
  environment-gated, explicitly armed live Kalshi desk. Paper and live keep separate ledgers and bankrolls.
- Runs a local 15-second background collector while the server is up, caches external data atomically under
  `.cache/`, and builds seasonal features from cached Kraken weekly history.
- Provides grounded quick research through OpenAI, Anthropic, Gemini, OpenRouter, Groq, xAI, Mistral, DeepSeek,
  or a local OpenAI-compatible server. Research is advisory and terminal: it never reaches a forecast, policy,
  budget, or order.

Current policy versions, thresholds, entry bands, sizing, and the latest measurements with their caveats live in
[`STATUS.md`](STATUS.md); [`src/lib/policy-manifest.ts`](src/lib/policy-manifest.ts) is authoritative for entry policy.

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
npm run verify:agents
npm run verify       # all documentation integrity gates
npm run check        # verify, typecheck, lint, test, production build
npm run archive:local
npm run restore:local -- --destination /tmp/money-noodle-restore/data
npm run cleanup:next-cache
npm run check:disk
```

`check:disk` exits nonzero unless blocks available to the local worker are at least 10% of total filesystem capacity. `restore:local` refuses to overlay active `data/` and publishes a new restore tree only after every manifest object passes its original SHA-256 and byte count. `cleanup:next-cache` removes only rebuildable `.next/cache` and `.next/dev` content and refuses a running development/build process; it does not touch production output or durable data.

## Data and safety

This is research software, not financial advice.

Research is the default and paper shadow trading runs continuously. Live execution is environment-gated, armed
only by typed confirmation, stake- and rate-capped, kill-switch protected, and blocked at startup until
cash/position/order/fill/resting-order reconciliation passes, with a periodic incremental pass afterward. Sell
paths are reduce-only and side-aware, so an exit can never open reverse exposure. Operator intent is stored
separately from operational state: a manual pause or the kill switch never auto-resumes. Ambiguous venue state
suspends the desk rather than guessing. Polymarket live placement is not implemented, and every unimplemented
provider fails closed.

`data/` and `.cache/` are worker-local durable state, not build artifacts — never commit them, hand-edit a
ledger, or delete a journal to reset. The exact controls, their current parameters, and the evidence behind them
are in [`spec/trading-risk-and-budget.md`](spec/trading-risk-and-budget.md) and [`STATUS.md`](STATUS.md).
Present funded state comes only from the authenticated Automation surface and `data/trading-control.json` —
never from this file.

Start with [`SPEC.md`](SPEC.md) for the product principles and canonical specification map, then read its
indexed [`spec/`](spec/) domain modules for detailed normative requirements and decision history. See
[`STATUS.md`](STATUS.md) for the compact current implementation projection,
[`status/README.md`](status/README.md) for roadmap/history discovery, and [`docs/README.md`](docs/README.md) for the
controlled lifecycle index of designs, evaluation plans, references, and explorations.

## License

[MIT](LICENSE) © 2026 Rai Phairow.
