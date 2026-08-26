# Runtime task cadence observability — design note

> **Document type:** Architecture design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-20
> **Canonical requirements:** [`spec/storage-and-architecture.md`](../spec/storage-and-architecture.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> Status: **approved observability-only implementation.** Written 2026-08-20 after the maintainer asked to
> centralize polling information in the UI. The runtime-loop separation and the no-policy-change boundary
> were agreed in prose before this note and before code.
>
> **2026-08-26 amendment:** the long-shot entry, trailing, and target-exit clocks described historically
> below were removed with that strategy. The active registry now exposes five tasks.

## 1. Decision

Add one shared registry describing runtime tasks and one small in-memory health recorder. Keep every existing
scheduler, queue, activation gate, request cache, and execution path independent.

This does **not** merge the 15-second collector with managed-order polling. It does not promote edge candidates
to a faster watch, add a price/spread gate, change a quote TTL, place an order, or alter paper/live decisions.
Price trajectory and spread remain prospective evidence only until a separate policy review authorizes a
versioned rule.

## 2. Why metadata is centralized but scheduling is not

The current data-freshness dialog mixes input TTLs, calculation cadence, persistence buckets, and execution
work. It therefore cannot answer which clock serves which task. A scheduler merger would answer that display
problem by coupling work with materially different safety and cost constraints:

- dashboard calculation and edge persistence use the ordinary worker cycle;
- an exact contract is refreshed on demand before submission;
- live and paper managed makers independently perform six checks over a bounded 12-second horizon;
- long-shot entry, bounded trailing, and target exit use their own conditional clocks;
- reconciliation is serialized, periodic, and event-triggered.

Slow research reads must not block order management or reconciliation. The registry is descriptive and
observable; it is not allowed to dispatch work.

## 3. Registry shape

Each registered task exposes:

- stable id and readable task name;
- cadence kind, interval where one exists, and a readable cadence label;
- activation condition;
- purpose;
- request-cost description;
- runtime availability (persistent worker or all deployments);
- last start, completion, and success timestamps;
- the latest error and a derived health state.

The first registry contains exactly these task clocks:

1. dashboard calculation prefetch;
2. edge observation and persistence;
3. exact pre-submit quote;
4. bounded managed maker;
5. ordinary long-shot entry watch;
6. bounded long-shot active trailing;
7. long-shot target exit;
8. periodic and event-triggered reconciliation.

Input cache TTLs remain in `lib/freshness.ts` and remain visible in a separate UI table. A cache TTL is not a
runtime task and should not be presented as though it were one.

## 4. Health semantics

Health is process-local operational evidence, not a durable trading ledger.

- `running`: at least one invocation is in flight;
- `healthy`: the latest completed invocation succeeded;
- `degraded`: the latest completion failed, or an always-expected worker task has become stale;
- `idle`: no invocation has yet been observed; conditional tasks may remain idle normally;
- `unavailable`: the deployment has no durable-worker authority for that task.

Only calculation and edge-observation clocks use stale-time health. On-demand and conditionally activated
tasks do not become unhealthy merely because there was no candidate, order, position, or reconciliation
event. Their activation conditions stay explicit in the UI.

The recorder performs no I/O and is never awaited. Process restart intentionally resets it; startup
reconciliation retains its existing authoritative durable role.

## 5. Runtime ownership

`lib/task-cadence.ts` is client-safe registry data and owns shared display constants that otherwise had no
client-safe home. `lib/task-cadence-runtime.ts` is server-only and owns process-local timestamps and health.
Existing loops mark their own starts and outcomes but retain their timers:

- `lib/dashboard.ts` marks calculations;
- `lib/paper-execution.ts` marks edge observations, paper managed makers, long-shot clocks, and reconciliation;
- `lib/live-orders.ts` marks on-demand pre-submit quote reads;
- live managed-maker health is marked at its existing execution call site.

The dashboard serializes a bounded registry snapshot. The client does not import a server store, and the
stateless deployment starts no worker timer.

## 6. UI

The data-freshness dialog gains a **Runtime tasks** table showing cadence, health/last run, activation,
purpose, and request cost. The existing source/cache table remains below it as **Input freshness**. This
makes intervals discoverable without suggesting that input caches and execution managers share one loop.

## 7. Verification and non-goals

Tests pin registry completeness, cadence derivation from runtime constants, configurable reconciliation
bounds, and health transitions. Existing invariant tests remain unchanged.

Out of scope:

- a unified scheduler;
- continuous fast polling of all edge candidates;
- a price-trajectory or spread-growth entry signal;
- a buy-policy or policy-manifest version change;
- durable telemetry history or alert delivery;
- any change to request budgets, order timing, sizing, reconciliation, or track separation.
