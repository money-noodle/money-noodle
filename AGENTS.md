<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Money Noodle

Research dashboard, continuous paper shadow trader, and live trading desk across multiple prediction-market
venues, in one Next.js app. Real money moves through `lib/live-orders.ts`. Treat every change as though it
executes against a funded account tonight.

## Where authority lives

Read the relevant source before proposing anything. Never reconstruct current behavior from memory — read it.
Code is authoritative for what the system *does*; `SPEC.md` for what it is *meant* to do and why.

| Source | Authority |
| --- | --- |
| `SPEC.md` | Decisions and *why*. §12 governs track separation and policy evaluation. |
| `STATUS.md` | What is implemented and currently measured. |
| `lib/trading-provider-registry.ts` | Which venues exist and what each may do. |
| `lib/strategy-registry.ts` | Which strategies exist; which is default. |
| `lib/policy-manifest.ts` | Every buy policy that has been live. |
| `reports/*.md` | Every measurement, dated, with caveats. |
| `docs/*.md` | Designs written before the code they describe. |

**Design before code.** For anything structural — a new policy, store, lane, or schema — agree the design in
prose with the maintainer, then write the doc, then the code.

**Venues, markets, and strategies are registry data.** Never enumerate them in this file, a comment, or a commit
message; read the versioned registry (`TRADING_PROVIDER_REGISTRY_VERSION`). Capability is a provider's
`implementation` level intersected **per market** by `productionMarketCapability`, per lane (research, paper,
live) — one market's capability never unlocks another's, and configuration alone never makes an unimplemented
adapter live. New providers and markets **fail closed**. Name a venue only for venue-specific behavior — fee
models, signing, tick ladders, adapters; elsewhere refer to as "the live venue" or "the specified venue" etc...

## 0. The shape of the code

| Stage | Entry point |
| --- | --- |
| Collection | `startBackgroundCollector` (`lib/background-collector.ts`) |
| Forecast | `buildPrediction`, cached behind `getDashboard` (`lib/dashboard.ts`) |
| **Entry rule layer** | `lib/prediction-policy.ts` — `qualifiesAsBuyEdge`, `hasTradableEdge`, `bestEntry`. This is the layer the mirror invariant protects: it takes no execution mode. |
| Execution style | `evaluateEntryExecutionPolicy` (`lib/entry-execution-policy.ts`) |
| Both lanes | `processPaperTradingCycle` (`lib/paper-execution.ts`) — the orchestrator |
| Live wire | `lib/live-orders.ts` |
| Exits | `lib/exit-policy.ts` (strict-value, profit-reversal), `lib/target-exit-policy.ts` (reduce-only IOC) |
| Fills and fees | `estimatePaperFill`, `venueFeeCents` (`lib/venue-fill.ts`) |
| Reconciliation | `reconcileExecutionLedger` (`lib/execution-reconciliation.ts`), scheduled by `maybeRunPeriodicReconciliation` (`lib/periodic-reconciliation.ts`) |

Sizes and thresholds are not in this table on purpose — read them from the symbol.

## 1. Money arithmetic

**Durable money is integer cents. Do not add `big.js`, `decimal.js`, or `bignumber.js`.**

| Layer | Representation | Rule |
| --- | --- | --- |
| **Wire** (venue I/O) | fixed-decimal **strings** at the venue's precision | `toFixed` at that precision (order-body builders, `lib/live-orders.ts`). Never send a raw float; validate inbound immediately. |
| **Exact** (in flight) | float cents, deliberately fractional | Fills and fees are legitimately sub-cent. Never round one into an integer here. |
| **Ledger** (durable, budget) | integer cents | Quantize once at the boundary, with a direction and an epsilon. Budgets, loss stops, and caps see only integers. |

Guards are sized to current venues' wire precision; **a finer-precision venue means re-deriving them.**

### Rounding and comparison

- **Round against us**: costs up, proceeds down — `Math.ceil(cost - 1e-9)`, `Math.floor(proceeds + 1e-9)`
  (`reconcileExecutionLedger`, `lib/execution-reconciliation.ts`). Never `Math.round` a cost or a fee.
- Fees round **up** with a 1¢ floor (`venueFeeCents`, `lib/venue-fill.ts`); quantity rounds **down** until
  `price × count + fees` fits the all-in cap.
- **Never `toFixed()` for arithmetic** — formatting only: wire, error messages, display.
- **Quantize once**, at the ledger boundary, per order; then sum integers. Aggregates never add floats.
- **Never `===` a computed money or price value.** Tolerances: `1e-12` for probability and edge gates
  (`evaluateEntryExecutionPolicy`), `1e-9` for prices and cents (`lib/live-orders.ts`), `1e-6` for book levels
  (`quantityAt`, `lib/order-book-depth.ts`). **Every tolerance fails safe**: `if (limit + 1e-9 < quote.ask)
  throw`. One that eases a gate is a bug.
- **Reach a tick by index**: `start + floor((target - start) / step) * step`, then round onto the ladder
  (`lib/managed-maker.ts`). Never `price += step`.

### Validation and standing rules

- **Validate at ingest.** `Number.isFinite` every parsed venue number before it reaches a ledger; throw on
  malformed fill terms. Check the lattice: `Math.abs(count * 100 - Math.round(count * 100)) > 1e-8`. Keep the
  `Number.isSafeInteger` assertions on the order paths, and **do not reach for `BigInt`**.
- **The per-trade cap is all-in**, fees included; reserve fees when sizing.
- **Fee models live only in `venueFeeCents`** (`lib/venue-fill.ts`). Extend it, never fork it. A fee can depend
  on price, not just on stake.
- **Do not mix the two P&L views.** `actualPnlCents` / `payoutCents` are exact and reporting-only; budgets use
  whole-cent `pnlCents`. When the ledgers seem to disagree, suspect the view.
- **Never assume quantity granularity** — read `quantityStep` in `estimatePaperFill`. Widening the venue union
  must break the compiler at every site that has to grow a case; no `default` branch.
- **Every money path gets an exact-arithmetic test** pinning rounding direction, the fee floor, and a value
  landing on a float-representation edge.

## 2. Time

- **UTC is authoritative.** Local labels are derived for reading only; never a key, never compared.
- **Pure functions take the clock as a parameter** (`nowMs = Date.now()` default) so tests can pin it.
- **Never recompute a slot boundary inline** — `CONTRACT_SLOT_SECONDS` (`lib/feeds.ts`), `contractSlot`, and the
  venue's aligned-market selector own that math.
- **Freshness expiries are hard.** A stale quote fails the calculation; it is never used with a warning.

## 3. Data and storage

- `data/` and `.cache/` are worker-local durable state, not artifacts. Never commit them, hand-edit a ledger, or
  delete a journal to "reset". Move corrupt files to `data/*.corrupt-*`.
- **Writes are atomic**: `${target}.${pid}.${rand}.tmp`, then `rename` (`lib/cache.ts`).
- **Journals (`*.journal.jsonl`) are append-only**, compacted by age or size. Never rewrite history.
- **Never load a sealed shard to answer a summary question** — `forecast-history` keeps per-shard rollups.
- **Server-only modules import `'server-only'`** (vitest alias in tests, `JITI_ALIAS` in scripts). Never import a
  store from a client component to dodge the boundary.
- **Stateless hosts must not reconcile, execute, collect, or write ledgers** — `lib/runtime-environment.ts`,
  `MONEY_NOODLE_STATELESS`. Hosted reads the bounded, sanitized, paper-only Postgres projection: no credentials,
  no write authority.

## 4. Anything that can move real money

Do not relax any of these to make a change land.

- **Fail closed.** Ambiguous venue state suspends the desk. A ledger-versus-venue contradiction stops execution
  and reconciles.
- **Live execution stays environment-gated, typed-confirmation armed, stake- and rate-capped, and kill-switch
  protected**, blocked until cash/position/order/fill/resting-order reconciliation passes, repeated every five
  minutes.
- **Operator intent is separate from operational state.** Manual pause, kill switch, and config changes never
  auto-resume; only a *system* suspension may, after full reconciliation and every readiness check.
- **Pause is a quiescent drain**: withdraw intent, serialize behind execution, cancel and confirm managed
  remainders, reconcile, then report restart-safe.
- **Sell paths are reduce-only and side-aware.** An exit never opens reverse exposure; partial or uncertain exits
  stop and reconcile rather than chase.
- **Safety ceilings read `reservedStakeCents` captured at issuance**, never a live-updating field.
- **Exposure and correlation caps are global**, counted across the whole account. Local caps summing above the
  global one are not a cap.
- **Strategies share one account and one order ledger, and must not share money.** Never split the ledger per
  strategy. Re-narrow every money aggregation by `strategyId`, and add each new strategy to
  `lib/strategy-isolation.test.ts`.

## 5. Analysis discipline

Worked examples for these rules: `reports/edge-policy-margin-review-2026-08-16.md`.

1. **Cluster intervals on the settlement window, never on the row.** Rows in one window share a single coin flip;
   scoring them as independent trials manufactures significance.
2. **Score a candidate on every position, not the surviving cohort.** Run both cohorts, first-to-fire winning,
   with the live rule alongside.
3. **State the multiple-comparison cost.** One t above 2 among tens of candidates is not evidence; report whether
   a *group* of related rules moves together.
4. **A candidate must beat the live rule**, including its exits — not beat doing nothing.
5. **Retroactive screening never promotes anything.** Promotion needs committed sentinels written at decision time
   and followed to settlement, a minimum count of independent windows, a clustered return clearing a stated
   threshold, and a written reason. See the withdrawn DOWN/NO suspension in `lib/policy-manifest.ts`.
6. **A null result is a result.** Write it up with equal care and say what would change the answer.
7. **Name what a gate actually does.** Some entry gates are inert — removing them changes no admitted row. Do not
   describe those as risk controls.

Analysis scripts are `scripts/analyze-*.mjs`, run via `npm run analyze:*`, and read durable data read-only — never
writing to `data/`, never placing an order. Open each with a comment stating what it measures, the correction that
decides the answer, and its biases. Write findings to `reports/<topic>-<YYYY-MM-DD>.md`, stating whether a policy
change is made and what the evidence authorizes. Never delete a superseded report.

## 6. Claims, citations, and uncertainty

- **"I don't know" is often the required answer.** Say what you checked and what would settle it. Never offer a
  confident reconstruction.
- **Quote before you assert.** Read every threshold, version, figure, or gate effect out of its source as you
  write it — never from session memory, never from what such a system "usually" does.
- **Cite the symbol, not the line** — function, constant, or type plus its file; `SPEC.md §N` and
  `reports/<name>.md` for prose. Line numbers belong only in messages to the user.
- **Cite `STATUS.md` and `reports/` figures with their date, in the past tense.** For a current number, read the
  durable file or run the analysis script.
- **Cite every claim**, to the bar the `evidence` array in `lib/policy-manifest.ts` enforces.
- **Verify after drafting.** Reread and find the quote behind each claim; retract the rest or rewrite it as open.
- **Show method, cohort, and correction before the number.**
- **Report disagreements; do not smooth them.** The exact ledger and the whole-cent budget may legitimately
  differ, as may the live and paper books. Say which view you used.
- **Restrict to evidence in this repo.** Take venue mechanics — fees, settlement, increments, rate limits — from
  code, docs, or a live API response. Label load-bearing outside knowledge inline.
- **Instability is a hallucination signal.** If a different route or framing gives a materially different answer,
  report that; do not pick the better-looking one.

**The app's own research surface.** `lib/llm.ts` is imported only by `app/api/research/route.ts` and
`app/api/providers/route.ts`: research is **advisory and terminal**, and no LLM output may reach a forecast,
policy, budget, or order. The dashboard's probabilities must never become model-generated text. Any edit to the
`callProvider` prompt keeps every constraint it already encodes, and temperature stays 0.2.

## 7. Changing the policy

- **Bump the version and add the matching `history` entry** in `lib/policy-manifest.ts` — full version, what it
  changed, and an `evidence` link. `lib/policy-manifest.test.ts` fails until it exists.
- **Hold the mirror invariant** (SPEC §12.3): the entry decision is identical for live and paper. The rule layer
  takes no execution-mode parameter, and `lib/mirror-invariant.test.ts` asserts arity so a `mode` argument fails
  loudly. Tracks differ **only** in execution and capital — fill model, budget and sizing, rate limits, risk
  stops, reconciliation.
- **Walk-forward evaluation never changes production automatically.** Promotion is a manual act recorded in an
  immutable ledger.
- **New venues, providers, markets, and strategies fail closed**, per lane and per market, intersected with what
  the adapter implements.

## 8. Tests

- Vitest, colocated as `lib/<module>.test.ts`; `npm test` runs everything. **Start server-touching tests with
  `vi.mock('server-only', () => ({}))`.**
- **Test pure rule modules over a grid of inputs**, not a fixture — the claim is "no input reaches a different
  answer".
- **A failing invariant test** (`mirror-invariant`, `strategy-isolation`, `venue-target-integrity`,
  `budget-ledger`, `policy-manifest`) **means the change is wrong until proven otherwise.** Never adjust one of
  those assertions without saying so explicitly and getting agreement.

## 9. Commands

```bash
npm run dev          # dashboard + the background collector
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build
```

**Run `npm run typecheck` and `npm test` before reporting a change complete**, and report a failure with its
output rather than a summary. §8's rule applies to whatever they say: a failing invariant test means the change
is wrong until proven otherwise.

Read `package.json` for `analyze:*` and `verify:*`; each script's opening comment states what it measures and its
biases. Deploys are **manual**: `npx vercel --prod`. Pushing to `main` deploys nothing.

## 10. Writing it down

- **Commit subjects state the finding or the change in the imperative**, not the file touched — "Replay 26
  alternative exit rules; none beats strict-value-v1", not "update analysis script".
- **Update `STATUS.md` in the same change** when work changes what is true about the system; update `SPEC.md` and
  its decision log when it changes a decision.
- **Never report a measurement without its date, its sample size, and the caveat that most threatens it.**
- Nothing here is financial advice, and the app says so. Keep it that way in anything user-facing.
