# Website / extensible execution-engine separation

> **Status: proposed for maintainer review; not approved or implemented.**
> Written 2026-08-22; broadened 2026-08-22 after architecture review. This design changes runtime,
> data-plane, and control-plane boundaries, not trading policy. No funded behavior should change until each
> migration gate below is accepted and verified with live execution paused. The extensibility sections define
> contracts for later work; they do not approve any new venue, market, instrument, model, strategy, or live
> capability.

## 1. Decision proposed

Run Money Noodle as separate runtime roles:

1. **Web** — a stateless Next.js UI and backend-for-frontend (BFF). It renders public research and an
   authenticated operator surface. It has no venue credentials, local-ledger access, timers, execution queue,
   reconciliation authority, or order functions.
2. **Engine** — one supervised, persistent Node.js process. It owns collection, normalized market data,
   point-in-time snapshots, models, strategies, paper execution, live execution, evidence collection, local
   durable stores, venue credentials, reconciliation, and every scheduler currently started through
   `instrumentation.node.ts`. It is internally layered (§4.3); “one process” must not mean “one collector loop”
   or “one crypto-shaped dashboard object.”
3. **Control plane** — a narrow Postgres command inbox plus sanitized engine-status/read projections. It is a
   transport and read model, not a cash, order, fill, position, policy, or execution ledger.

The web app appends validated operator commands; it never applies them. The engine is the only component that
may validate a command against authoritative local/venue state and mutate execution configuration. Results are
asynchronous: the web reports **requested**, **applying**, **succeeded**, or **rejected**, never success merely
because a route accepted a request.

The engine is **compiled and registry-driven**, not a runtime plug-in host. Adding code is a reviewed deploy;
configuration may only narrow compiled capability. A new adapter or strategy can never make itself live by
appearing in a directory, database row, or package.

This is the recommended topology if controls must be available from a hosted UI. If controls will remain on a
private machine or private network, a Unix-socket/private-HTTP variant is simpler (§12), but it does not provide
an offline durable Pause request and should not be exposed to the public internet.

## 2. Why separate now

The current code already has a partial deployment split, but not a process boundary:

- `instrumentation.node.ts` runs startup reconciliation and then starts `startBackgroundCollector`; therefore a
  stateful Next.js server is also the execution engine.
- `startBackgroundCollector` calls dashboard calculation, `processPaperTradingCycle`, settlement, and public
  projection from one loop. Periodic reconciliation now has an independent process-global timer, and walk-forward
  evaluation is an explicit paused/stopped offline command; both still share the host until engine extraction.
- `app/api/trading/control/route.ts`, `app/api/trading/allocations/route.ts`, and
  `app/api/trading/providers/route.ts` call worker-local stores and process-local queues directly.
- `engineQueue`, reconciliation state, execution-drain state, collector state, and task-cadence health are all
  process-local. A web restart resets the operational observations and restarts the funded runtime.
- Hosted/stateless mode correctly refuses private controls and serves only bounded paper projections. It cannot
  currently know whether the funded engine is alive except indirectly from stale published data.

Separating the process has material benefits:

| Impact | Expected result |
| --- | --- |
| Web deploy/restart | No engine restart, reconciliation cycle, timer reset, or managed-order interruption. |
| Resource isolation | Browser/API load, Next rendering, and public traffic cannot contend with the engine event loop or heap. |
| Security | Venue signing credentials and durable money state disappear from the internet-facing process. |
| Engine lifecycle | A service supervisor can restart crashes and boot the engine without starting a web server. |
| Operator clarity | Heartbeats distinguish engine availability from automation intent, drain state, and reconciliation readiness. |
| Remote control | Pause/resume/configuration become durable commands with explicit acknowledgement and audit. |

The costs are also material:

- this introduces a distributed protocol, asynchronous UI, schema/version compatibility, database roles,
  heartbeat/lease semantics, and new failure modes;
- remote control gives a hosted component narrow write authority, intentionally changing the current
  stateless/read-only boundary;
- control-plane availability becomes a live-entry safety dependency under the recommended fail-closed rule;
- local-disk or host loss is not solved merely by splitting the process (§10);
- current multi-file configuration operations need idempotent recovery before they are safe as remote commands.

The recommendation is still to proceed, in stages, because the current coupling makes routine web lifecycle
work part of a funded-account lifecycle.

### 2.1 Architecture-review findings

The original separation proposal had a strong process and trust boundary but deliberately retained the current
engine internals. That is safe for extraction, but insufficient as the target architecture:

- `startBackgroundCollector` still makes one crypto-15m dashboard calculation the unit of collection,
  strategy evaluation, settlement, and projection; periodic reconciliation has an independent timer and model
  evaluation is offline, but collection and funded execution still share the web worker;
- current registries identify providers, markets, and strategies, but their TypeScript unions and normalized
  records still assume binary UP/DOWN contracts, a fixed asset list, and one horizon clock;
- a `Dashboard` is a presentation read model, not a durable, point-in-time strategy input contract;
- market data, forecast history, strategy evidence, and sentinels use separate purpose-built stores without a
  common provenance/catalog contract, making cross-strategy reuse and unbiased replay harder;
- provider capability is currently summarized as market-data/paper/live booleans, which is too coarse for
  equities, spot, perpetuals, options, and futures with different order types, sessions, margin, expiry,
  corporate actions, and reconciliation support;
- models, policy components, and sentinels do not yet have complete registries or declared input/output
  contracts; adding one usually adds orchestration branches;
- optional observation work can share event-loop, request, and signed-read capacity with production work unless
  each design builds a custom isolation boundary.

The improved target below keeps the conservative process-extraction plan while making the engine a small
kernel around explicit catalogs, normalized events, immutable snapshots, strategy/model/policy contracts,
and a one-way evaluation lane. It rejects a “universal trading abstraction” that hides instrument mechanics:
common orchestration is generic, but payoff, calendar, quantity, margin, settlement, and venue wire semantics
remain explicit and exhaustive.

## 3. Authority and trust boundaries

### 3.1 Authority stays with the engine

| Concern | Authority after separation |
| --- | --- |
| Venue cash, orders, fills, positions | Venue responses, reconciled by the engine. |
| Budget control and audit | Engine-local durable control store. |
| Execution order ledger | Existing shared engine-local ledger; never split by strategy. |
| Provider permissions and allocations | Engine-local versioned stores. |
| Policy/model code and manifests | Versioned application artifact. |
| Operator request | Immutable control-plane command row. It is intent, not applied state. |
| UI status | Sanitized engine projection plus heartbeat age. It is not execution authority. |
| Public paper data | Existing bounded paper-only projection. |
| Instrument/listing identity and semantics | Versioned engine catalog plus authoritative venue specifications. |
| Normalized research observations | Append-only engine data plane with source provenance and schema versions. |
| Strategy/model/sentinel definitions | Compiled registries and immutable manifests in the application artifact. |

The control-plane database must never be queried by `qualifiesAsBuyEdge`, policy evaluation, sizing, fill math,
budget arithmetic, venue order-body construction, model inference, or sentinel evaluation. A database row
cannot directly arm live trading, reserve money, place an order, settle P&L, install code, or promote a
strategy/policy/model/sentinel. Future research-data repositories are also non-authoritative for cash and
orders: the execution ledger and venue reconciliation remain separate even if both eventually use Postgres.

### 3.2 Capability matrix

| Capability | Public web | Operator BFF | Engine |
| --- | ---: | ---: | ---: |
| Read public research/paper projection | yes | yes | publish only |
| Read sanitized private status | no | yes | publish only |
| Append an allowed command | no | yes | claim only |
| Read/write local `data/` | no | no | yes |
| Hold venue credentials/private keys | no | no | yes |
| Call signed venue mutations | no | no | yes |
| Schedule collection/execution/reconciliation | no | no | yes |
| Change env kill switch/hard ceilings | no | no | local deployment only |

The preferred deployment puts the operator BFF behind an identity-aware private access layer with MFA. It may
share the Next.js codebase with the public site, but it should use a separate deployment/hostname and database
role. If it remains on the public hostname, stronger authentication is a prerequisite; the current shared
password and 14-day HMAC session are not sufficient authority for remote funded controls.

## 4. Runtime shape

```text
browser
   |
   v
stateless Next.js web/BFF
   |  SELECT private projection
   |  INSERT allowed command through constrained DB function
   v
Postgres control plane
   ^             |
   | heartbeat,  | claim pending command
   | lease,      v
   | projection  one supervised engine process
   |                  |
   +------------------+-- local atomic stores/journals
                      +-- market/read adapters
                      +-- signed venue API
```

There is no browser-to-engine connection and no inbound public engine endpoint. Polling is sufficient for v1;
WebSockets add lifecycle complexity on serverless hosts and are not required for one operator.

### 4.1 Engine contents

The engine process retains, initially without semantic changes:

- startup reconciliation;
- `startBackgroundCollector` and dashboard calculation;
- the shared paper/live orchestration in `processPaperTradingCycle`;
- the one-second and bounded fast strategy pollers that are lazily owned by that orchestration;
- `engineQueue`, control serialization, reconciliation serialization, execution drain, and task health;
- local archive scheduling and safe stale-temp cleanup;
- public paper/long-shot replication.

This design separates Next.js from the engine. It does **not** split forecasting, paper, and live into separate
workers. Those lanes currently share snapshots and orchestration deliberately, and splitting them would be a
second design with mirror and ordering risks.

### 4.2 Runtime roles

Introduce an explicit runtime role during migration:

- `web`: never imports or starts worker bootstrap code;
- `engine`: starts the standalone engine entry point and no HTTP UI;
- `combined`: temporary rollback/transition role only, never run concurrently with `engine` against one data
  directory or account.

The final state removes engine startup from `instrumentation.node.ts`. Build-time and stateless-environment
heuristics should no longer decide whether money-moving code starts; the selected runtime artifact/role should.

The engine gets its own production build/start commands and reports its source commit, build identifier,
protocol version, and store-schema versions. It should run compiled, pinned application code under `launchd`
for the current macOS host or `systemd` on Linux, with restart-on-failure and bounded backoff. `npm run dev` is
never an engine runtime.

### 4.3 Internal architecture: a small kernel, not a new monolith

The extraction phase may initially call existing orchestration unchanged, but the target dependency flow is:

```text
compiled catalogs + adapter capabilities
                 |
                 v
source adapters -> normalized event journals -> as-of snapshots -> features/models
                                                              |          |
                                                              +----------+
                                                                   |
                                                production strategy/policy plans
                                                   |               |
                                           paper execution     live risk/OMS
                                                   |               |
                                                   +------ shared account ledger
                                                                   |
                                                        venue execution adapters

as-of snapshots + production plans/outcomes -> evaluation/sentinels -> evidence journals/reports
                                                                   X
                                                     no dependency back to decisions
```

The **kernel** owns startup/shutdown, clocks, task queues, dependency wiring, registry validation, health,
fencing, and lifecycle barriers. It does not know a symbol list, a settlement formula, a forecast algorithm,
or a venue order body. Those belong to compiled modules registered through typed descriptors.

Use static imports and an explicit composition root. Do not use dynamic `import()` by database value, package
scanning, `eval`, or third-party strategy code in the funded process. Registry membership proves only that code
exists; production capability remains the intersection of compiled implementation, per-market/listing
capability, durable operator permission, environment ceilings, account readiness, and reconciliation.

### 4.4 Domain catalog: asset, instrument, listing, market, and target are different axes

The current `MarketId` meaning — instrument class plus horizon and settlement semantics — remains authoritative
for existing records. Broader asset classes need additional identities rather than overloading `symbol` or
stretching `PositionSide = UP | DOWN` to mean every position:

| Identity | Meaning | Examples (illustrative, not approved registry rows) |
| --- | --- | --- |
| `assetId` | Economic underlying or issuer; not an orderable symbol. | BTC, an equity issuer, a rates index. |
| `instrumentId` | Economically distinct claim with currency, payoff, multiplier, expiry, and settlement terms. | USD spot pair, common share, a dated future, a binary contract. |
| `listingId` | One provider's exact orderable encoding of an instrument. | Venue symbol/ticker plus environment and contract-spec version. |
| `marketId` | Registered family sharing instrument/payoff, horizon, and settlement semantics. | Existing `crypto-15m`, `crypto-spot`; later families require separate approval. |
| `targetId` | The exact quantity a model predicts, including horizon and units. | Event probability, forward return distribution, volatility, or fair value. |
| `strategyId` | A complete entry/exit decision process consuming declared targets/data. | Existing edge and long-shot strategies. |

A versioned `InstrumentDescriptor` must include, where applicable: asset class, base/quote or settlement
currency, payoff kind, long/short directions, price scale, tick ladder, quantity step, contract multiplier,
minimum notional, expiry, trading calendar/session timezone, settlement method/source, margin model, and
corporate-action/roll behavior. Fields that do not apply are represented by a discriminated instrument kind,
not magic zeroes. Wire precision is provider-listing data and remains validated by its adapter.

A `ListingDescriptor` maps a provider's symbol to exactly one versioned instrument definition and records rule
provenance. Cross-provider comparability is an explicit relation (`exact`, `approximate` with reasons, or
`incomparable`), never inferred from matching symbols. Delistings, futures rolls, stock splits, symbol changes,
and contract-rule changes create effective-dated catalog events or new versions; historical observations keep
the identity known when written.

This taxonomy prevents category errors:

- equities require sessions, holidays, halts, dividends/splits, currency, and short-sale semantics;
- spot crypto is continuous and has no contract settlement, so a strategy must declare a holding/exit horizon;
- perpetuals add funding, mark/index prices, leverage, and liquidation/margin terms;
- futures add expiry, multiplier, initial/maintenance margin, roll policy, and physical/cash settlement;
- binary contracts use side probabilities and bounded payout, not share/futures P&L arithmetic.

The common engine may route these kinds, but money, payoff, margin, settlement, and quantity calculations use
exhaustive discriminated cases with no permissive default. Adding an instrument kind must break compilation at
every control boundary that needs semantics.

### 4.5 Provider adapters and capability negotiation

“Provider” is a deployment endpoint; its roles must be declared independently. One provider may supply public
market data, reference/index data, account custody, and execution, while another supplies only one of them.
Split adapter contracts accordingly:

- `MarketDataAdapter`: catalog discovery plus typed quote, book, trade, bar, funding, open-interest, status,
  reference-rate, and corporate-action observations supported by that source;
- `AccountAdapter`: balances, buying power/margin, positions, orders, fills, transfers where read-only support
  is explicit, and paginated authoritative snapshots;
- `ExecutionAdapter`: preview/validate, place, amend, cancel, and query by durable client identity for explicit
  order types and time-in-force values;
- `ReconciliationAdapter`: complete snapshot boundaries and ownership matching required to reconcile an
  account/listing without guessing;
- `OutcomeAdapter`: settlement, expiry, exercise/assignment, and invalidation facts where applicable.

The current `marketData` / `paper` / `live` capability triple stays as a fail-closed UI and migration
projection. The underlying descriptor grows into a per-`(providerId, marketId, listing kind, environment)`
capability matrix covering read channels, order types, cancel/replace, reduce-only, fractional quantity,
shorting, margin, corporate actions, settlement, and reconciliation completeness. A capability may be
*implemented*, *verified*, *paper-promoted*, or *live-promoted*; configuration can only disable it.

Adapters normalize and validate ingress immediately but do not choose strategies, calculate edge, reserve a
budget, or call policy code. Execution adapters accept an already-authorized typed order instruction; they
alone translate normalized price/quantity into fixed-decimal wire fields. Every adapter stamps provider,
environment, adapter version, request/response correlation, source timestamps, and listing version. Raw
secret-bearing signed responses stay in restricted diagnostics and are never copied into research events.

### 4.6 Reusable research-data plane

Strategies should consume durable observations, not call feeds and not depend on the dashboard response shape.
The normalized data plane is append-only and point-in-time reproducible.

Every normalized event has a common envelope:

```ts
interface ObservationEnvelope<TKind extends string, TPayload> {
  eventId: string; schemaVersion: string; kind: TKind;
  sourceId: string; providerId?: string; adapterVersion: string;
  marketId?: string; assetId?: string; instrumentId?: string; listingId?: string;
  eventTime: string;       // when the source says it happened
  receivedAt: string;      // when this engine could first have known it
  sourceSequence?: string; // venue sequence/cursor where available
  payload: TPayload;
  quality: { valid: boolean; staleAt?: string; flags: string[] };
  rawProvenance?: { contentHash: string; locator?: string; termsClass?: string };
}
```

Payloads are discriminated schemas, not a bag of nullable columns: top-of-book, depth snapshot/delta, trade,
bar, reference/index value, funding, open interest, instrument-definition event, venue status, FX rate,
corporate action, and final outcome. Both `eventTime` and `receivedAt` are load-bearing: replay must use only
facts available at the historical decision time and may not gain hindsight from a later correction or
backfill. Corrections append a superseding event; they never rewrite what a prior decision knew. Derived
bars/features carry the exact source event IDs or input watermarks, algorithm version, and `computedAt`.
Unadjusted prices remain durable. Split/dividend-adjusted equity series, continuous futures rolls, FX-converted
values, and consolidated cross-source books are versioned derived datasets; a synthetic continuous future is
never an orderable `listingId`.

The repository exposes bounded typed queries: current state, events in an event-time range as known by a given
`receivedAt` watermark, and versioned derived series/features. Strategies do not receive arbitrary SQL or file
paths. This keeps live evaluation bounded while allowing offline replay and research scripts to use the same
normalized facts without depending on an execution process.

Collection is driven by declared **data demands**, not by strategies launching requests:

```text
(strategy | model | sentinel) -> required event kinds, universe selector, freshness, cadence,
                                 history depth, priority, retention class
planner -> deduplicated adapter subscriptions/polls under source and resource budgets
```

The planner may combine identical public demands, but it must not let an optional sentinel increase signed
request load or mutate a production cache silently. An observation-only demand has its own quota/priority and
may be dropped with a coverage record; its failure cannot stale otherwise healthy production data. A new
strategy that needs unavailable data remains not-ready rather than receiving neutral/fabricated values.

An immutable `AsOfSnapshot` is assembled from event IDs and source watermarks for one clock instant. It states
freshness and missing requirements per consumer. Models, strategies, and sentinels receive that value plus an
explicit clock; they receive no adapter or store handle. Exact pre-submit quotes remain an execution-stage
refresh, are stamped separately, and rerun the approved gates as today.

#### 4.6.1 Storage layout and repository boundary

Keep research evidence separate from money authority:

```text
data/catalog/                 versioned instrument/listing metadata and effective dates
data/observations/<utc-date>/ append-only normalized event partitions + checksummed indexes
data/current/                 bounded current-state indexes; rebuildable from events
data/derived/                 versioned bars, features, forecasts, and rollups
data/evidence/                candidate/sentinel journals and coverage markers
data/execution/               existing authoritative shared order/control ledgers (separate owner)
```

Exact names are deferred to a store design. Required properties are not:

- partitions are by UTC/event identity, never a local label; storage boundaries are never statistical windows;
- normal event/evidence writes append, and only the owning compactor seals or rewrites a partition;
- checksummed indexes and per-partition rollups answer summaries without loading sealed raw shards;
- hot current state is bounded and rebuildable; sealed research partitions are immutable;
- raw payload retention is source-terms-aware and bounded, while normalized decision evidence needed for audit
  is retained under an explicit policy;
- repository interfaces support local files first and object storage or a research database later without
  moving order authority into the control plane;
- backup/restore reports separate RPO for execution state, normalized observations, derived features, and
  experiment evidence.

Do not build one universal JSON event file. Different event kinds have different volume and replay needs;
shared envelope/catalog/index contracts provide reuse while typed stores may optimize depth, trades, bars, and
low-volume metadata independently.

### 4.7 Models, features, policies, and strategies

#### Model and feature registry

A `ModelDescriptor` declares immutable model version, compatible `targetId`/markets/instrument kinds, required
feature-set versions, output schema and units, calibration version, artifact/code hash, and status
(`observation`, `paper`, `production`, `superseded`). Outputs are typed: event probability, expected return or
return distribution, volatility, fair value, and rank are not interchangeable numbers.

Feature builders are pure reducers over as-of observations and stamp availability, provenance, and version.
Model execution has no budget/order capability. Promotion remains a separate immutable manual ledger. The
existing venue-independent forecast invariant remains part of the edge strategy's model/target contract; it is
not weakened merely because another future strategy may legitimately consume venue microstructure.

#### Policy bundle

A strategy points to a versioned `PolicyBundle`, not scattered constants. Its independently versioned parts
cover signal admission, portfolio selection, sizing, entry execution, exit/switch, and risk overlays. Each part
declares applicability by strategy, market, provider/listing when venue mechanics matter, and instrument kind.
Normalized venue terms (fees, ticks, quantity, sessions) are inputs; policy modules never call adapters.

Paper and live evaluate the same immutable rule, portfolio action, and relative-sizing plan for a strategy.
Track enters only at the capital and execution boundary, where actual bankroll, quantity, fills, rate limits,
risk stops, and reconciliation may differ as required by SPEC §12.3. Policies that intentionally differ define
separate `strategyId` or policy versions; they are never smuggled through a `mode` argument.

#### Strategy contract

A strategy module declares:

- compatible market/instrument/target kinds and a versioned universe selector;
- data/model dependencies and freshness requirements;
- event/cadence trigger and deterministic state reducer;
- pure construction of candidate actions and reasons, including explicit no-action output;
- policy bundle and portfolio/risk dimensions;
- lifecycle needs for exits, expiry, settlement, and counterfactual evaluation.

Its output is a typed `DecisionPlan` containing snapshot/model/policy identities, strategy/market/instrument/
listing identity, proposed action, side or position effect, limit semantics, validity window, and complete
reason/provenance. It is not an order. The live authorization path independently joins current account state,
shared exposure, budget, provider capability, lease, operator intent, reconciliation, rate limits, and a fresh
execution quote before producing an `OrderInstruction`.

Strategies share one account-level order ledger, execution queue, kill switch, venue rate ceilings, and
reconciliation. Every reservation, order, fill, position, and P&L row retains `strategyId`, `marketId`,
`instrumentId`, and `listingId`; all strategy-local money aggregation re-narrows by strategy. Global risk views
use explicit instrument relationships, never matching a symbol string, and hard aggregation follows each
market's approved policy. This does not reverse the current decision to keep `crypto-15m` and `crypto-1h` caps
separate. A design for cross-asset margin/netting is required before leveraged instruments can be live.

### 4.8 Sentinels and investigation as a first-class evaluation lane

A sentinel is not an arbitrary callback. It is a compiled, immutable `ExperimentDescriptor` with:

- hypothesis, owner/reason, version, registration/start time, and status;
- eligible universe and decision-time sampling rule, including explicit no-candidate/no-action markers;
- production comparator and one or more frozen candidate model/policy/strategy versions;
- exact required observation/feature fields and optional extra data demand;
- decision and outcome schemas, settlement/path resolver, cluster key, and first-to-fire rule where relevant;
- coverage requirements, exclusions, review floor, deciding metric, multiple-comparison family/correction, and
  promotion/retirement criteria fixed before collection.

The engine evaluates production and candidate arms against the same immutable as-of snapshot. It writes the
candidate decision before fills or outcomes are known, follows every eligible position/window rather than the
surviving cohort, and later appends resolution/path evidence. The sentinel journal records missing data and
observation gaps; it never carries stale values forward to make a path complete. Settlement-window clustering
is a descriptor property and cannot default to row independence.

Three useful experiment shapes share this contract without sharing result arithmetic:

1. **Decision sentinel** — candidate admits/refuses/chooses differently from production.
2. **Path sentinel** — candidate exit or management reducer follows every eligible position first-to-fire.
3. **Execution sentinel** — compares observable issued attempts, fills, and no-fills without inventing a fill.

Sentinels may request additional **public, read-only** observations through the data-demand planner. Such work
runs at evaluation priority, writes a separate provenance stream, and records lost coverage when its quota is
exhausted. A sentinel cannot request a signed endpoint unless a separately approved design proves that the
read is required, quota-isolated from reconciliation/execution, and still read-only. It can never reserve,
place, amend, cancel, arm, resume, or alter a production cache.

Dependency direction is mechanically enforced: experiments may import domain schemas, snapshots, production
decision evidence, and pure evaluators; policy, model, portfolio, sizing, execution, budget, and reconciliation
modules may not import experiment stores, statuses, reports, or candidate decisions. Promotion copies a
reviewed candidate into a new production artifact through the existing manual manifest/promotion process; it
does not flip a sentinel status that execution reads.

### 4.9 Scheduling, backpressure, and resource classes

The single interval in `startBackgroundCollector` is a migration shim, not the target scheduler. The engine
kernel runs a supervised task registry whose entries declare trigger (cadence/event/deadline), dependencies,
maximum concurrency, timeout, retry policy, resource class, source request cost, and degraded behavior.
Schedules remain owned by each task; the registry observes and dispatches but does not centralize policy clocks
or recompute market windows.

Priority is explicit:

1. live order management, cancellation/confirmation, and reconciliation;
2. account/risk freshness and required pre-submit data;
3. production market collection and decision snapshots;
4. paper mirror and settlement;
5. sentinel/optional research collection;
6. projections, reports, archives, and compaction.

Per-provider token buckets distinguish public reads, signed reads, and mutations. Bounded queues coalesce only
work whose semantics permit it (for example, replace a pending current-quote refresh, never drop an order or
journal event). Optional work sheds load and records a gap before required work misses a deadline. One failed
market/source degrades only consumers that declared it; it does not blank unrelated strategies.

V1 remains one process to preserve ordering and shared account safety. Internal task queues are not permission
boundaries. If CPU-heavy feature/model work later needs worker threads or another process, it receives immutable
snapshots and returns typed outputs; the fenced live authorizer, account ledger, and order manager remain one
writer. Measurement, not extensibility aesthetics, authorizes that split.

### 4.10 Execution core across instrument kinds

The order-management system owns a venue-neutral lifecycle (`planned`, `reserved`, `submitting`, `working`,
`partially_filled`, terminal, or `uncertain`) and durable client identity. Venue adapters map that lifecycle to
explicit supported order instructions. It must not pretend all products share one `buy side / payout` model.

Before an instrument kind can become paper- or live-capable, it supplies tested implementations for:

- position effect (open/increase/reduce/close), side awareness, and short/reverse restrictions;
- quantity lattice, tick ladder, notional/multiplier, fees, and adverse budget rounding;
- cash versus margin reservation, buying-power impact, and worst-case loss;
- fill normalization, partial fills, cancellation, expiry, and session behavior;
- mark/P&L, settlement or continuous position lifecycle, corporate actions/roll/assignment where applicable;
- complete account/order/fill/position reconciliation and stable client-order identity.

Paper execution is also instrument-specific: a stock/future/spot fill model needs spread, depth, sessions,
partial fills, fees, and latency; a binary settlement simulator is not reused by renaming fields. Every paper
simulator has a version and evidence describing what it approximates. Live remains false until both the venue
adapter and instrument semantics are independently promoted.

### 4.11 Extensibility acceptance tests

The architecture is extensible only if these changes are additive and fail closed:

| Addition | Required proof |
| --- | --- |
| Venue/data source | Add descriptor and adapters; undeclared market/listing actions remain unavailable; conformance tests pin pagination, precision, throttling, identity, error ambiguity, and reconciliation. |
| Market/instrument kind | Add catalog schema and exhaustive payoff/calendar/money cases; no existing market clock, symbol list, or default capability is inherited. |
| Model | Register target/features/artifact; replay identical as-of snapshots deterministically; observation status cannot reach policy without a manual production promotion. |
| Policy | Immutable version + manifest history + production/candidate comparison; mirror grid proves no track-dependent decision. |
| Strategy | Register dependencies and policy bundle; shared-ledger and `strategy-isolation` tests cover every money aggregation; no direct adapter/store/order import. |
| Sentinel | Freeze descriptor before first row; dependency test proves no path to money or production decisions; complete-population, clustering, coverage, and multiplicity tests pass. |
| Storage backend | Repository conformance, checksums, idempotent replay, point-in-time availability, rollup equivalence, and restore drill; no authority migration by accident. |

A representative paper-only “vertical slice” for the first genuinely different asset class must prove catalog
identity → collection → normalized events → as-of replay → model/strategy plan → paper fill/lifecycle → evidence
and reporting before any generic API is declared stable. Do not generalize only from two binary-contract
strategies.

## 5. Control-plane protocol

Use a separate private schema and credentials from the existing public paper projection.

### 5.1 Database roles

- **Migration/admin role:** DDL only; held outside both runtimes.
- **Engine role:** acquire/renew the engine lease, claim/read commands, and write command outcomes and sanitized
  projections. It cannot create operator commands through the web function.
- **Operator-web role:** select sanitized status/results and execute one constrained command-insert function. It
  cannot update/delete commands, write outcomes, acquire a lease, or read public/private keys or local stores.
- **Public-web role:** existing bounded public projection `SELECT` only.

Database permissions are an invariant test, not deployment documentation alone.

### 5.2 Engine lease and fencing

A singleton lease identifies the only engine allowed to make new live exposure. It contains at least:

- engine instance and boot IDs;
- monotonically increasing fencing token;
- engine/build/protocol version;
- lease acquisition, heartbeat, and expiry timestamps using database server time.

Proposed initial timing is a 2-second heartbeat and 10-second lease. The exact values must be constants with
boundary tests, not scattered literals.

Two protections are required:

1. an OS/data-directory single-writer lock prevents two local processes writing the same files;
2. the Postgres lease prevents engines on different hosts/copies from both acquiring new exposure.

Every new live entry and every replacement leg must recheck a locally unexpired lease, control-channel health,
and absence of an unprocessed Pause before pre-submit authorization. A process that wakes after its fence has
expired cannot submit merely because it used to own the lease. Lease loss blocks new exposure immediately.
Reduce-only position management, cancellation/confirmation, settlement, and reconciliation continue where
safe.

### 5.3 Command envelope

Each immutable command contains:

- UUID and monotonic database sequence;
- command kind and schema version;
- validated payload hash and JSON payload;
- authenticated operator identity and session/request audit metadata;
- idempotency key;
- request time, optional expiry, and current status;
- expected engine boot ID where required;
- expected control/provider/allocation revision(s);
- claim engine/fencing token and start/completion timestamps;
- sanitized result or stable rejection code/message.

The BFF validates input for security and usability. The engine validates it again against current registries,
local stores, venue state, environment gates, and revisions. Browser amounts become integer cents before they
enter the command envelope; wire formatting remains engine-only.

### 5.4 Initial command set

| Command | Offline request allowed? | Expiry/target | Engine rule |
| --- | --- | --- | --- |
| `pause_and_drain` | **yes** | no expiry; not boot-pinned | Withdraw intent first, drain, reconcile, then acknowledge restart-safe or blocked. |
| `reconcile` | no | short expiry; boot-pinned | Serialize behind execution and return authoritative status. |
| `resume` | no | short expiry; boot- and revision-pinned | Re-run every existing readiness check; never trust web-computed `canResume`. |
| `configure_budget` | no | revision-pinned | Paused + quiescent + no reservation conflict; opens audited budget epoch under existing rules. |
| `configure_allocations` | no | control/allocation revisions | Same current open-position, reservation, and funding-epoch guards. |
| `configure_provider` | no | provider/control revisions | Capability intersection, typed live-enable phrase, paused/quiescent guards. |
| `set_execution_mode` | no | control revision | Typed `TRADE LIVE`, env opt-in, no reservations, paused/quiescent. |
| `reset_paper_bankroll` | no | short expiry | Paper-only existing no-open-paper-position guards. |

Remote direct order submission, ledger correction, credential changes, kill-switch disengagement, hard-ceiling
changes, runtime code/module installation, catalog mutation, and strategy/policy/model/sentinel parameter
changes are permanently excluded. Promotion remains a separate reviewed, artifact-producing control and should
not be migrated as part of this work.

### 5.5 Ordering and Pause priority

Normal mutating commands are applied one at a time in database sequence and serialized through the existing
engine/control queues. Pause is different:

- the control listener/poller observes and durably applies paused operator intent before waiting behind queued
  execution work;
- a Pause invalidates any older pending Resume and any command whose expected revision no longer matches;
- its command is not `succeeded` until the queue is drained, managed remainders are canceled and confirmed,
  authoritative reconciliation passes, and `restartSafe` is true;
- if the engine is offline, the command remains pending and the UI says **Pause requested — engine has not
  acknowledged**. On startup it is consumed before active intent can authorize an order.

Remote Pause is not a venue emergency stop when the engine is unreachable. The UI must retain explicit local
kill-switch/venue-cancel guidance rather than displaying an unacknowledged request as safety achieved.

### 5.6 Crash-safe command application

Claiming a row is not enough. A crash can occur after a local mutation and before the database outcome update.
The engine therefore needs an append-only local command-receipt journal owned by its compactor, and affected
local audit events must carry the external command ID and payload hash.

On retry/restart:

- a matching completed local audit marks the database command succeeded without applying it twice;
- a received but unapplied command is revalidated and applied;
- a partially completed multi-store command resumes deterministic stages or fails closed for operator review;
- the same command ID with a different payload hash is rejected as corruption.

Provider compatibility projection and allocation/funding changes currently span stores. They must not become
remote commands until failure injection proves convergence after a crash at every write boundary.

## 6. Status and UI semantics

### 6.1 Do not collapse status into one “running” flag

The operator surface presents these independent facts:

1. **Observation:** control plane reachable or unavailable.
2. **Engine:** online, stale/unobserved, or lease lost, with last heartbeat and build ID.
3. **Lifecycle:** starting, reconciling, ready, degraded/suspended, draining, quiescent, or stopping.
4. **Operator intent:** active or paused.
5. **Automation state:** unconfigured, paused, active, or depleted.
6. **Reconciliation:** pending, running, ready, or blocked.
7. **Drain:** active, draining, quiescent/restart-safe, or blocked.
8. **Task/data health:** bounded cadence and queue health plus required-versus-optional data coverage per active
   module; an optional sentinel gap is not a production outage.
9. **Command:** requested, claimed/applying, succeeded, rejected, expired, or recovery-required.

No heartbeat means **engine unobserved**, not “engine stopped,” “paused,” or “safe.” A persisted paused intent may
be shown beside it, but the UI must state that the engine has not recently confirmed it.

### 6.2 Status projection

The engine publishes a bounded, sanitized projection on change and at the ordinary cycle cadence. A separate
small heartbeat row advances every two seconds so a large JSON document is not rewritten at heartbeat rate.
The projection includes:

- engine/boot/build/protocol identity, projection revision, and compiled catalog/module manifest hashes;
- lifecycle, lease/fence summary, start time, and last graceful-shutdown state;
- control state/revision, mode, operator intent, pause origin/reason;
- budget/equity/reservation figures needed by the authenticated UI;
- provider/market/listing capability and readiness summaries without credentials;
- reconciliation, drain, live-risk, scheduler queues, required data freshness, optional evidence coverage, and
  task-cadence status;
- latest command summaries and sanitized audit references;
- source-generated timestamp from the engine and observed timestamp from database server time.

Do not project private-key paths, key IDs where unnecessary, signed request bodies/headers, unrestricted venue
responses, raw environment values, or errors that may contain secrets.

### 6.3 UI command behavior

A mutation route returns `202 Accepted` with a command ID. The dialog remains open and follows that command
until a terminal result or a timeout. A browser timeout does not cancel a command. Refreshing the page reloads
its status by ID.

Controls fail closed as follows:

- Resume and configuration are disabled when heartbeat/lease/protocol compatibility is stale.
- Pause remains available while the control database accepts writes, even if the engine is unobserved.
- Conflicting revisions require reload; the UI never silently retries with a newer revision.
- The page distinguishes **Pause requested**, **Draining**, **Paused but blocked**, and **Paused · quiescent ·
  restart-safe**.
- `Cache-Control: private, no-store` remains mandatory for private status and command routes.

The existing public research dashboard may continue request-driven read calculations during migration. Those
calculations must not be labeled as engine health and cannot feed engine policy/execution. Publishing the full
engine dashboard snapshot can be considered later; it is not required for process separation.

## 7. Engine startup, shutdown, and recovery

### 7.1 Startup state machine

The standalone engine must complete these stages in order:

1. acquire the local data-directory lock;
2. validate the compiled composition root: unique catalog/module IDs, supported schema versions, dependency
   graph, capabilities, and manifest hashes; unknown or contradictory live semantics fail closed;
3. open/validate durable stores and command-receipt journal; malformed money state fails closed rather than
   being reconstructed;
4. acquire a new fenced engine lease and publish `starting`;
5. ingest all outstanding Pause commands, and expire stale boot-pinned commands;
6. publish `reconciling` and run the existing complete startup reconciliation barrier;
7. recover any interrupted command by local command/audit identity;
8. verify ordinary readiness, lease, provider/listing capability, required data, risk, and control intent;
9. mark the drain quiescent or blocked and publish the resulting state;
10. start required collectors and conditional schedulers only after the barrier; optional research/evaluation
    tasks start last and cannot make the engine ready.

An active operator intent surviving an unexpected crash may become active again only after the new boot owns
the lease, startup reconciliation is ready, no newer Pause exists, and every normal readiness check passes.
Manual/configuration/risk pauses remain non-auto-resumable exactly as today.

### 7.2 Graceful stop

On `SIGTERM`/`SIGINT`, the engine:

- stops admitting/scheduling new entries;
- publishes `stopping` and blocks new exposure;
- lets current bounded management reach cancellation/confirmation, or marks ambiguity for startup recovery;
- flushes local writes and command receipts;
- releases the lease only after it can no longer submit;
- preserves operator intent so a planned service restart does not fabricate a manual Resume.

The service manager timeout must exceed the bounded managed-order and reconciliation drain. `SIGKILL` remains
recoverable only through durable intent/order IDs and startup reconciliation.

### 7.3 Failure policy

| Failure | Engine behavior | UI behavior/recovery |
| --- | --- | --- |
| Engine process crash | Supervisor restarts with backoff; startup reconciliation is mandatory. | Heartbeat becomes stale, then a new boot ID appears as recovering. |
| Web deploy/outage | Engine continues. | Controls temporarily unavailable; no engine restart. |
| Venue/read failure | Existing fail-closed suspension/retry rules remain. | Show blocked source/reconciliation reason. |
| Control DB/lease loss | Block new live exposure; continue safe cancellations, reduce-only lifecycle, settlement, paper, and reconciliation. | Show control unavailable or stale. Recovery requires lease plus authoritative reconciliation before guarded auto-resume. |
| Engine host reboot | Supervisor starts engine; same-disk stores and venue reconciliation recover. | Same as process crash, with longer heartbeat gap. |
| Local disk corruption | Do not trade or reset journals; quarantine only under owning store rules. | Recovery-required; restore/repair is manual and audited. |
| Host/disk loss | No automatic v1 failover. | Restore a verified backup to one standby, acquire lease, reconcile, then manually resume. |
| Two engine starts | Local lock or DB lease rejects the second. | Surface duplicate-start/lease-owner evidence. |

The fail-closed database rule reduces live availability, but remote status/control cannot be safety-relevant while
the engine is allowed to ignore loss of that channel. Paper and advisory collection need not stop during a
control-plane outage.

## 8. Security requirements before remote Resume/configuration

1. Put the operator surface behind MFA/identity-aware access; use short-lived sessions and reauthentication for
   live mode, live provider enablement, budget epoch reset, and Resume.
2. Retain same-origin/CSRF checks, strict content type/body-size validation, durable rate limiting, idempotency
   keys, and typed confirmation phrases.
3. Record operator identity, command ID, reason, prior/expected revision, engine boot/fence, and terminal result
   in both control-plane and local audit evidence.
4. Use separate least-privilege database roles and rotate them independently. The public deployment never gets
   the operator-write role.
5. Keep every venue credential/private key only on the engine host. Do not proxy signed venue reads through
   the web. Compiled adapters run with least-privilege credentials; read-only sources should use keys that
   cannot mutate even if adapter code is defective.
6. Sanitize projected errors and structured logs. Never project signed payloads or secret-bearing environment
   diagnostics.
7. Preserve environment opt-in, typed live arming, stake/rate ceilings, kill switch, provider capability
   intersection, risk stops, and reconciliation. UI configuration may narrow these controls but cannot widen a
   compiled/environment ceiling.
8. Add an operator alert outside the UI for stale heartbeat/restart loop, lease loss, blocked reconciliation,
   and failed Pause drain. A dashboard cannot alert while nobody is looking at it.

## 9. Code boundaries proposed

Exact filenames can change during implementation. The layers and dependency direction may not:

```text
lib/domain/*                         ids, discriminated instruments/events, money/time primitives
lib/catalog/*                        compiled asset/instrument/listing/market/capability registries
lib/data/adapters/<source>/*         ingress and normalization; no strategy or money authority
lib/data/events/*                    typed journals, indexes, rollups, current state, as-of snapshots
lib/features/*                       pure versioned reducers over as-of observations
lib/models/*                         typed targets, inference, calibration, model registry
lib/policies/*                       pure versioned rule/portfolio/sizing/execution/exit policy values
lib/strategies/<strategy>/*          pure state + DecisionPlan construction; no adapter/order imports
lib/experiments/*                    sentinel descriptors, reducers, evidence stores, reports; one-way only
lib/execution/*                      shared risk, budget, OMS, live adapters, reconciliation, account ledger
lib/engine/*                         composition root, scheduler, lease, commands, status, lifecycle
lib/control-plane/protocol.ts        client-safe command/status schemas and versions
lib/control-plane/web.ts             web role: read projection, append command
lib/control-plane/engine.ts          engine role: lease, claim, publish outcome/status
app/api/engine/status/route.ts       authenticated BFF read
app/api/engine/commands/route.ts     authenticated BFF append/read result
engine/main.ts                       standalone persistent entry point
```

This is a target map, not an instruction to move every current `lib/*.ts` file at once. First wrap existing
behavior behind contracts; move it only with characterization tests and no semantic change.

Mechanically enforce at least these forbidden edges:

- web/BFF → engine stores, adapters, execution, reconciliation, or bootstrap;
- strategies/models/policies → adapters, mutable stores, control plane, budgets, or order functions;
- execution/adapters → experiment stores or candidate reports;
- production decision modules → sentinel status/results;
- public projections → private raw events, credentials, account evidence, or unrestricted errors.

Engine-only modules import `server-only` (or a stronger engine-only boundary) and must not be reachable from an
App Router dependency graph. Add invariant tests for both web/engine separation and the experiment one-way
boundary. Next.js Route Handlers are public endpoints and a BFF, not a durable worker; current Next
documentation explicitly warns that hosted handlers cannot share request state, rely on writable files, run
long-lived work, or hold WebSockets reliably.

## 10. Durability limits and follow-up

This design materially improves **process** and **same-host reboot** recovery. It does not create high
availability for loss of the engine host.

Current off-machine archive is daily, does no local deletion, and does not yet provide an independently tested
standby restore. That means v1 can have up to roughly one archive interval of non-venue local evidence at risk
if the disk is lost. Venue reconciliation can recover authoritative cash/orders/fills/positions, but it cannot
reconstruct every forecast, paper fill, operator audit, policy sentinel, or local configuration decision.

Before claiming host-loss resilience:

- define RPO/RTO separately for execution money state, normalized source observations, derived model/feature
  data, and sentinel evidence; execution and research loss have different recovery authorities;
- increase protected frequency for execution-critical stores without putting arbitrary remote latency inside
  the order wire path;
- verify manifests and perform an independent restore drill;
- document standby takeover: old lease expired, restored data checksums pass, startup reconciliation ready,
  operator reviews differences, manual Resume;
- do not add automatic failover while local state can diverge between hosts.

Migrating the execution repositories themselves to transactional Postgres could later improve this boundary,
but that is a separate store/schema design. The command/status database must not quietly become the money
ledger in this project.

## 11. Delivery plan and acceptance gates

All phases begin with live manually paused and a quiescent, restart-safe drain. Invariant tests are never
weakened.

### Phase 0 — approve boundaries, vocabulary, and threat model

- Decide whether controls live on a separate private operator hostname/deployment.
- Approve Postgres command transport and the rule that lease/control loss blocks new live exposure.
- Approve which commands are remotely available.
- Approve the catalog identities in §4.4, the one-way experiment boundary, and static compiled registration.
- Define heartbeat thresholds, process RTO, and host-loss RPO by durability class.

**Gate:** this document and the corresponding `SPEC.md` architecture/security/decision-log changes are agreed
before structural code.

### Phase 1 — extract the engine, no remote mutation

- Add standalone engine build/start and supervisor unit.
- Add explicit runtime roles and single-writer local lock.
- Move startup orchestration out of Next instrumentation without changing task scheduling.
- Run paper-only, compare forecast/paper/order outputs and task timing with the current combined runtime.

**Gate:** web restart/deploy does not change engine boot ID, collector cadence, drain, or reconciliation; only
one process writes `data/`; full typecheck/test/build pass.

### Phase 2 — lease, heartbeat, and read-only status

- Add migrations/roles, fenced lease, heartbeat, protocol versions, and sanitized projection.
- Add authenticated status UI with stale/unobserved semantics.
- Make lease mandatory for new live exposure only after forced lease-loss tests pass.

**Gate:** stop/restart/duplicate-engine/database-partition tests show correct status and no new live order after
lease loss. No remote command exists yet.

### Phase 3 — Pause and manual reconciliation commands

- Add immutable command inbox, local receipt journal, asynchronous UI, and command audit.
- Implement offline durable `pause_and_drain` first, then boot-pinned manual reconciliation.

**Gate:** crash injection before/after claim, intent write, drain, reconciliation, local completion, and database
acknowledgement never resumes, duplicates, or falsely reports restart-safe.

### Phase 4 — Resume

- Deploy stronger operator authentication/MFA and durable mutation rate limits.
- Add short-lived boot/revision-pinned Resume.

**Gate:** stale, replayed, duplicated, expired, wrong-boot, wrong-revision, blocked-risk, blocked-reconciliation,
and manual-pause cases all reject. A successful Resume still passes every current readiness check.

### Phase 5 — budget and other configuration

- Migrate one command at a time: budget, allocation, provider permission, mode, then paper reset.
- Add deterministic local recovery stages for every command touching more than one store.
- Remove direct route imports of engine stores only after UI parity.

**Gate:** exact money/revision/epoch tests and crash injection at every store boundary; configuration cannot arm
or resume; current typed confirmations and quiescent guards remain.

### Phase 6 — remove combined authority and drill recovery

- Remove the transition role/direct controls.
- Document operator runbooks, alerts, deploy, rollback, and backup restore.
- Perform process crash, host reboot, database outage, venue outage, and restore drills.

**Gate:** measured RTO/RPO and exact caveats are recorded in `STATUS.md`; funded activation is a separate manual
act after build, quiescent drain, and startup reconciliation.

### Extensibility track — staged independently after Phase 1

Remote controls (Phases 2–6) are not a prerequisite for better data/strategy boundaries. The following track
may proceed after the standalone engine exists, but it must not be folded into Phase 1: process extraction needs
a small, reversible diff and exact behavioral comparison.

#### Phase E1 — catalogs, envelopes, and characterization

- Define versioned domain/catalog schemas and adapter/model/strategy/experiment descriptors.
- Inventory every current input and durable output; map it without changing existing stores or policy.
- Add import-boundary tests and a replay fixture with event-time/received-time availability.
- Wrap the current collector as the first statically registered module; retain its cadence and outputs.

**Gate:** all current crypto-15m decisions, policy identities, durable rows, money arithmetic, task timing, and
public projections are unchanged; unknown catalog/capability/schema values fail closed.

#### Phase E2 — normalized data and as-of replay, dual written

- Emit normalized events alongside current feed/dashboard structures with source timestamps and provenance.
- Build bounded current indexes and immutable as-of snapshots; keep the old path authoritative.
- Replay current model and strategy from the snapshot and compare complete decision plans over a grid and a
  sustained paper-only dual run.
- Add partition/index/rollup verification before any reader switches.

**Gate:** no look-ahead under delayed/backfilled events; direct and replayed plans agree exactly where values are
countable and under existing named tolerances where computed; optional evidence loss does not affect production
freshness or request capacity.

#### Phase E3 — current strategy as the reference module

- Move one existing strategy, its model target, and its policy bundle behind the contracts without changing
  production semantics.
- Keep the shared account ledger/OMS and current live wire untouched; paper first, then shadow comparison.
- Generalize sentinel registration by migrating one observation-only sentinel without changing its cohort.

**Gate:** mirror, strategy-isolation, venue-target-integrity, budget-ledger, and policy-manifest invariants pass
unchanged; sentinel dependency tests prove no return edge into production.

#### Phase E4 — first different asset-class vertical slice

- Choose one market only after a separate approved design covers instrument semantics, official venue APIs,
  licensing, data quality, model target, sessions/expiry/corporate actions or margin, paper fills, and risk.
- Implement market data and deterministic replay first, then a strategy and paper lifecycle. Live capability is
  false and cannot be configured true.
- Measure event volume, retention, replay cost, data gaps, and paper fidelity before stabilizing generic APIs.

**Gate:** the complete §4.11 vertical slice and restore drill pass. A separate promotion design is required for
funded execution; this architecture document supplies no such approval.

## 12. Alternatives considered

### A. Private direct engine API over Unix socket/Tailscale

**Pros:** fewer database semantics, synchronous responses, very small command latency.
**Cons:** needs private routing and engine ingress, commands disappear while the engine is offline, status is
unavailable when the route is unavailable, and safe failover/fencing still needs a lease or equivalent.

Use this only if the operator UI is private and same-host/private-network operation is the actual requirement.
Prefer a Unix socket on one host; do not expose a generic engine HTTP port publicly.

### B. Hosted BFF plus Postgres command inbox — recommended

**Pros:** no inbound engine port, durable offline Pause, auditable asynchronous results, serverless-compatible
web, straightforward heartbeat/staleness.
**Cons:** distributed protocol and DB dependency; the hosted operator role has narrow write authority.

### C. Shared filesystem between Next and engine

Rejected. It preserves direct coupling, does not work on stateless hosts, permits concurrent writers, and makes
process separation mostly cosmetic.

### D. Put the execution ledger and configuration directly in Postgres now

Deferred. It could eventually improve host-loss recovery but combines process extraction with a money-store
migration. The present goal can be reached while retaining the known local ledger and reconciliation behavior.

### E. Browser calls the engine directly

Rejected. It exposes engine reachability and authentication to the browser, complicates CORS/CSRF, and creates
an avoidable path toward venue credentials/order capability.

### F. Queue service instead of Postgres

Not justified for one engine and one operator. A durable table with strict roles, idempotency, and polling has
fewer components. `LISTEN/NOTIFY` may later reduce latency but can only be a wake-up hint; polling/table state
remains authoritative because notifications are not durable.

### G. One service/process per strategy or venue

Rejected for v1. Strategies share an account, order ledger, risk ceilings, venue rate budgets, and
reconciliation authority. Distributing those writers before there is a transactional/fenced account service
creates more ways to double-spend or disagree. Keep modular contracts inside one supervised process; split only
measured CPU/read-only work later.

### H. One universal trading record and one event table

Rejected. A wide nullable schema tends to hide missing futures margin, equity corporate actions, binary
settlement, or continuous spot lifecycle behind defaults. Use a common provenance envelope and catalog IDs with
discriminated event/instrument/order schemas and exhaustive money cases. Storage backends may still colocate
partitions physically without erasing semantic types.

### I. Let strategies fetch their own data

Rejected. It duplicates traffic, makes availability and look-ahead impossible to audit, couples tests to
providers, and lets optional experiments contend with production. Strategies declare data demands and consume
immutable as-of snapshots; adapters and the planner own I/O.

## 13. Non-goals and invariants

This work does not:

- change any forecast, entry, execution-style, exit, switch, regime, sizing, or fill policy;
- approve trading stocks, spot crypto, perpetuals, futures, options, or any new binary market;
- claim one fill, payoff, side, margin, settlement, or risk model works across instrument kinds;
- change the paper/live mirror invariant or add execution mode to the rule layer;
- split the account/order ledger or money by strategy;
- permit dynamic/unreviewed plug-ins, database-installed code, or config-created capability;
- migrate current durable stores merely to make the directory layout resemble §4.6.1;
- let optional collection or a sentinel compete unboundedly with signed execution/reconciliation traffic;
- move LLM output toward any control, budget, forecast, strategy, sentinel, or order path;
- permit direct manual orders from the UI;
- make status/projection/research data authoritative for reconciliation;
- auto-resume a manual/configuration/risk/kill pause;
- make a stale heartbeat proof that the engine is stopped;
- claim automatic cross-host failover or zero data loss.

Every existing live gate remains an intersection: compiled capability, market capability, provider permission,
environment opt-in, kill switch, operator intent, budget/risk ceilings, fresh data, active engine fence, and
ready reconciliation. The separation adds a gate; it removes none.

## 14. Decisions requested in review

1. **Operator surface:** separate private hostname/deployment with MFA (recommended), or the existing public
   deployment with upgraded authentication?
2. **Transport:** approve the Postgres command inbox, or constrain controls to a private direct connection?
3. **Availability tradeoff:** should loss of the control-plane lease block new live entries (recommended), even
   though that makes Postgres availability a live-entry dependency?
4. **Remote scope:** approve Pause, reconcile, Resume, budget, allocations, provider permissions, mode, and paper
   reset as the maximum command set?
5. **Offline behavior:** approve non-expiring offline Pause while all other mutations require a fresh targeted
   engine?
6. **Recovery target:** what process-restart RTO and host-loss RPO are required before this is considered done?
7. **Funded restart:** after an unexpected engine crash, may preserved active operator intent resume after a new
   fenced boot and successful full reconciliation, or should every process crash require manual Resume?
8. **Module model:** approve static compiled registration and reject runtime/database plug-in loading
   (recommended)?
9. **Domain vocabulary:** approve separate asset, instrument, listing, market, target, and strategy identities,
   while retaining existing `MarketId` semantics and historical defaults?
10. **Data plane:** approve append-only typed observation envelopes, immutable as-of snapshots, and separate
    event-time/received-time as the reusable strategy input boundary?
11. **Experiment boundary:** approve optional quota-isolated data demands and the rule that production modules
    cannot import candidate/sentinel state or results?
12. **Sequencing:** approve a behavior-preserving standalone extraction before normalized-data dual writing,
    rather than combining process extraction and engine generalization?
13. **First vertical slice:** after the current strategy is wrapped, which genuinely different paper-only market
    should validate the architecture? Selection requires its own design and official API verification; this
    document recommends making no choice yet.

Until the applicable decisions are answered, implementation should stop at read-only design/prototyping and
must not change the current funded runtime.
