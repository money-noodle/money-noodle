# Process-global execution-ledger ownership

> **Document type:** Architecture design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-22
> **Canonical requirements:** [`spec/storage-and-architecture.md`](../spec/storage-and-architecture.md), [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md)
> **Decision record:** [`DEC-20260822-02`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

**Status:** implemented 2026-08-22; extended by [execution-ledger v9](execution-ledger-v9-design.md)
**Scope:** runtime ownership and storage cost only; no policy, execution, sizing, budget, reconciliation, or order semantic change

## 1. Problem

`data/paper-orders.json` is one account ledger shared by every strategy and both execution modes. It was about
48 MB at the 2026-08-22 profile and held 3,606 orders. The persistent worker changed it roughly every 15
seconds. More importantly, `longShotExitTick` parsed the entire file every second before it could discover
whether any long-shot position was open.

Next 16 emitted at least seven distinct server chunks containing `paper-execution.ts`. Each emitted copy has
its own module-local `engineQueue`, while every copy reads and atomically replaces the same file. The
forecast-storage incident proved that module-local exclusion is not process exclusion under this bundle
model. Disk reloads avoid a permanently stale cache, but they neither prevent two copies from reading the
same generation and replacing each other's changes nor make pause/drain's local queue barrier account-wide.

This is both a safety ownership defect and the dominant remaining scheduled allocation source. A naive cache
would make the safety defect worse and is forbidden.

## 2. Decisions

### 2.1 One process-global serializer

All ledger mutations and consistent ledger reads use one runtime held under
`Symbol.for('money-noodle.execution-ledger-runtime')` on `globalThis`. Independently emitted module copies
therefore share one promise queue. The queue remains process-local because the supported stateful topology is
one persistent worker; forecast writer lease/runtime gating continues to fail closed against a second worker.

The queue serializes the collector cycle, long-shot entry and exit mutations, reconciliation, reset, and API
control mutations. Pause/drain waits on this global queue rather than one bundle's local tail.

### 2.2 Durable disk remains authoritative

The JSON ledger remains the restart source and account audit. A cache is never a second ledger and never
changes the atomic commit boundary:

1. serialize the complete candidate ledger using compact JSON;
2. write `${target}.${pid}.${rand}.tmp`;
3. atomically rename over the target;
4. only after rename may the operation publish that value as committed memory.

A failed write never publishes. If an operation throws after any successful intermediate commit, memory is
invalidated and the next queued operation reloads the last complete disk generation. There is no journal,
retention, archive, schema, or ledger-history rewrite in this change.

### 2.3 Immutable committed snapshot, isolated mutation working copy

The runtime retains one parsed committed snapshot. A mutating operation receives a `structuredClone` working
copy, never the committed object. This matters because observation-only detached tasks can retain the prior
cycle's ledger reference; the next cycle must not mutate underneath them.

Existing pre-wire and acknowledgement commits remain exactly where they are. Every write must receive the
active operation's working copy or fail closed. On successful operation completion, a working copy that had
at least one successful rename becomes the committed snapshot. A no-write operation is discarded. The
existing control-flow invariant remains explicit: after its last ledger mutation, a successful operation
must perform its final existing commit. Tests pin the normal cycle/control shapes; any thrown operation with
a prior commit invalidates and reloads rather than guessing which in-memory fields reached disk.

### 2.4 Reads derive while serialized

A consistent read waits behind the same queue, derives its result from the immutable committed snapshot, and
returns a detached result before releasing the queue. Small scalar/aggregate views are copied directly;
order lists clone only rows matching the requested execution-mode/strategy filter.

The one-second long-shot exit poll reads only cloned open long-shot positions. It never receives or parses the
whole ledger merely to answer an existence question. Public paper and long-shot projections request their
own strategy/mode slices. The authenticated full performance report may still request a complete detached
order list on demand; that cost is explicit and unscheduled.

### 2.5 Cache invalidation and restart

The first queued operation after process start parses disk once. Successful local commits keep memory
current. Any malformed read, ambiguous failed write, or post-commit operation failure clears committed
memory. The next queued operation reloads disk. Restart naturally discards memory and reads the durable file.
No mtime polling is needed because running correction scripts against the active worker is unsupported; an
owner tool must stop or exclude the worker before changing this funded ledger.

### 2.6 Polling and detail projections

The authenticated dashboard polling resource is an aggregate/open-intent projection, not an order-history
resource. It derives paper/live counters, current execution signals, and the small set of genuinely open or
uncertain orders while it holds the serialized committed view; `structuredClone` receives only that result.
It must never return 30 terminal orders merely so a component can filter them out in the browser.

The trading-control dialog may explicitly request its bounded recent terminal detail when opened. That
on-demand response can be larger, but it still derives inside `readLedgerView` and clones only the resulting
summary rows rather than the complete ledger. The dashboard owns one polling request and passes the same
response to the automation and execution-signal panels; independently polling the same funded read model from
two components is prohibited.

## 3. Fail-closed boundaries

- A mutation outside the global serializer is an error.
- A write of anything other than the active working copy is an error.
- API and collector operations cannot overlap ledger replacement.
- Live wire callbacks retain their existing pre-wire/acknowledgement durability points.
- Reconciliation still owns venue truth and can block execution; the cache cannot make a blocked state ready.
- Operator pause remains separate from operational state and never auto-resumes.
- Paper/live and strategy scoping remain unchanged; all strategies still share one ledger without sharing
  their money aggregations.

## 4. Tests

Implementation is gated by:

1. two independently imported runtime module copies serialize rather than overlap;
2. the second operation sees the first operation's committed value;
3. publication occurs only after rename;
4. a failed rename retains/reloads the prior durable generation;
5. a throw after an intermediate commit invalidates and reloads disk;
6. read results are detached and mode/strategy filters cannot leak live or another strategy;
7. the one-second long-shot precheck cannot call the full-ledger reader;
8. existing reconciliation, budget-ledger, strategy-isolation, mirror-invariant, and pause/drain tests remain
   unchanged and pass.

## 5. Explicit non-goals

This ownership change did not prune or rewrite order history, split the ledger by strategy, introduce a
terminal-order archive, change JSON fields, alter public payload meaning, or change any execution decision.
The separately approved [v9 design](execution-ledger-v9-design.md) later added immutable terminal evidence
batches while retaining every control/money row in this same account ledger. It does not weaken any ownership,
clone, serialization, atomic-publication, or failure-invalidation invariant defined here.
