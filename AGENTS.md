<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Money Noodle

Research dashboard, continuous paper shadow trader, and live trading desk across multiple prediction-market
venues, in one Next.js app. Real money moves through `lib/live-orders.ts`. Treat every change as though it
executes against a funded account tonight.

Orient before touching money paths: `SPEC.md` §12 (track separation) → `STATUS.md` (current measurements) → the
§0 table below.

## Where authority lives

Read the relevant source before proposing anything. Never reconstruct current behavior from memory — read it.
Code is authoritative for what the system *does*; `SPEC.md` for what it is *meant* to do and why.

| Source | Authority |
| --- | --- |
| `SPEC.md` | Decisions and *why*. §12 governs track separation and policy evaluation. |
| `STATUS.md` | What is implemented and currently measured. |
| `lib/trading-provider-registry.ts` | Which venues exist and what each may do. |
| `lib/market-registry.ts` | Which markets exist and what each may do per lane (market data / paper / live). |
| `lib/strategy-registry.ts` | Which strategies exist; which is default. |
| `lib/policy-manifest.ts` | Every buy policy that has been live. |
| `reports/*.md` | Every measurement, dated, with caveats. |
| `docs/*.md` | Designs written before the code they describe. |

**Design before code.** For anything structural — a new policy, store, lane, or schema — agree the design in
prose with the maintainer, then write the doc, then the code.

**Venues, markets, and strategies are registry data.** Do not copy registry enumerations here or into generic
comments; read the versioned registry (`TRADING_PROVIDER_REGISTRY_VERSION`). A provider's `implementation` is
intersected per market and lane with `productionMarketCapability` (`lib/market-registry.ts`): one market never unlocks another, and config
cannot make an unimplemented adapter live. New providers and markets **fail closed**. Name a venue only for
venue-specific mechanics; otherwise use role-based language.

## 0. Shared orchestration and the default-strategy path

Start at `lib/strategy-registry.ts` for every registered strategy. This table maps shared orchestration and the
default strategy's forecast and entry path; strategy-specific engines and policies live outside that path.

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

**Budget-control money is durable integer cents; durable reporting fields may be fractional. Do not add
arbitrary-precision number libraries.**

| Layer | Representation | Rule |
| --- | --- | --- |
| **Wire** | fixed-decimal strings at venue precision | Format with `toFixed` only in order-body builders; validate inbound immediately. |
| **Exact** | float cents in flight and reporting | Preserve legitimate sub-cent fills and fees until a whole-cent control boundary. |
| **Budget control** | durable integer cents | Quantize once, with a direction and epsilon; budget counters see only integers. |

Guards are sized to current venues' wire precision; **a finer-precision venue means re-deriving them.**

### Rounding and comparison

- **Round against us**: costs up, proceeds down — `Math.ceil(cost - 1e-9)`, `Math.floor(proceeds + 1e-9)`
  (`reconcileExecutionLedger`, `lib/execution-reconciliation.ts`). Never `Math.round` a cost or a fee.
- Nonzero modeled fees round **up** with a 1¢ floor (`venueFeeCents`, `lib/venue-fill.ts`); quantity rounds
  **down** until `price × count + fees` fits the all-in cap.
- **Never `toFixed()` for arithmetic** — formatting only: wire, error messages, display.
- **Quantize once**, at the whole-cent control boundary, per order; then sum integers. Budget aggregates never
  add floats.
- **Never `===` a computed money or price value.** Use only the named tolerances: `1e-12` for probability and edge
  gates (`evaluateEntryExecutionPolicy`), `1e-9` for prices and cents (`lib/live-orders.ts`), and `1e-6` for book
  levels (`quantityAt`, `lib/order-book-depth.ts`). Within epsilon is equal; beyond it fails closed. Never widen or
  misapply one.
- **Reach a tick by index**: `start + floor((target - start) / step) * step`, then round onto the ladder
  (`lib/managed-maker.ts`). Never `price += step`.

### Validation and standing rules

- **Validate at ingest.** Reject non-finite venue numbers and malformed fill terms. Check the lattice with
  `Math.abs(count * 100 - Math.round(count * 100)) > 1e-8`; retain order-path `Number.isSafeInteger` assertions
  and **do not use `BigInt`**.
- **The per-trade cap is all-in**, fees included; reserve fees when sizing.
- **Fee schedules live only in `venueFeeFraction`** (`lib/venue-fee-schedule.ts`). Charged whole-cent fill fees
  live in `venueFeeCents` (`lib/venue-fill.ts`), which applies adverse rounding and the fee floor. Extend the
  schedule; never duplicate it. A fee can depend on price, not just on stake.
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
- Normal writes to **journals (`*.journal.jsonl`) are append-only**. Only the journal's owning compactor may
  rewrite or truncate it; never manually rewrite history.
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
  protected**, blocked until cash/position/order/fill/resting-order reconciliation passes, repeated on the
  configured cadence (`configuredReconciliationIntervalMs`, `lib/task-cadence.ts`; default five minutes).
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
8. **Evaluate; do not advocate.** Separate findings, assumptions, unknowns, tradeoffs, and options. Before
   concluding, test materially different formulations without relaxing safety.

Analysis scripts (`scripts/analyze-*.mjs`, `npm run analyze:*`) read durable data without writing `data/` or placing
orders. Their opening comment states the measure, deciding correction, and biases. Write findings to
`reports/<topic>-<YYYY-MM-DD>.md`, including whether policy changes and what the evidence authorizes. Never delete
a superseded report.

## 6. Claims, citations, and uncertainty

- **Recalculate before asserting.** Reload durable inputs for every quantitative evaluation and rerun it in the
  current session. Report method, cohort, correction, inputs, exclusions, auditable totals, and result.
- **Label uncertainty and judgment.** Say what you checked and what would settle an open question. Evaluative terms
  need current support; otherwise identify them as hypotheses.
- **Cite auditable claims.** Ground current behavior, policy, results, and venue mechanics in repo evidence or a
  live API response. Cite symbols and files, `SPEC.md §N`, or reports—not source lines—and label load-bearing
  outside knowledge. Date `STATUS.md` and report figures in the past tense; recalculate current numbers.
- **Expose disagreement.** Verify the source behind each claim. Report exact-versus-whole-cent, live-versus-paper,
  and materially different route results instead of smoothing or cherry-picking them.

**The app's research surface is advisory and terminal.** Only the research and provider routes import `lib/llm.ts`;
its output must never reach a forecast, policy, budget, or order, and dashboard probabilities never become generated
text. Preserve `callProvider` prompt constraints unless the maintainer agrees otherwise; temperature stays 0.2.

## 7. Changing the policy

- **Bump the version and add matching `history`** in `lib/policy-manifest.ts`: full version, change, and evidence
  link. `lib/policy-manifest.test.ts` enforces this.
- **Hold the mirror invariant** (SPEC §12.3): live and paper entry decisions are identical. The rule layer takes no
  execution mode; `lib/mirror-invariant.test.ts` asserts arity. Tracks differ **only** in execution and capital:
  fills, budget and sizing, rate limits, risk stops, and reconciliation.
- **Walk-forward evaluation never changes production automatically.** Promotion is a manual act recorded in an
  immutable ledger.

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
npm run build        # compile; run before starting or restarting the server
npm run start        # how the server is run: the dashboard and the background collector
npm run dev          # testing only — never the way the server is left running
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

Do not stop or restart the server to edit, typecheck, or test. Restart only when the maintainer asks or a change
must take effect in the running process; build first, then start. Never leave `npm run dev` serving.

**Run `npm run typecheck` and `npm test` before reporting a change complete.** On failure, report the command and
relevant exact output, not only a summary. A failing invariant test remains wrong until proven otherwise under §8.

Read `package.json` for `analyze:*` and `verify:*`. Deploys are **manual** (`npx vercel --prod`); pushing `main`
deploys nothing.

## 10. Writing it down

- **Commit subjects state the finding or the change in the imperative**, not the file touched — "Replay 26
  alternative exit rules; none beats strict-value-v1", not "update analysis script".
- **Update `STATUS.md` in the same change** when work changes what is true about the system; update `SPEC.md` and
  its decision log when it changes a decision.
- **Never report a measurement without its date, its sample size, and the caveat that most threatens it.**
- Nothing here is financial advice, and the app says so. Keep it that way in anything user-facing.
