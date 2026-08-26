# Execution ledger v9: immutable terminal evidence and a bounded funded hot set

> **Document type:** Architecture design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-22
> **Canonical requirements:** [`spec/storage-and-architecture.md`](../spec/storage-and-architecture.md), [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

**Status:** approved in prose 2026-08-22; implementation gated by this document
**Scope:** storage layout and read models only. No policy, execution, fill, sizing, budget, reconciliation, paper/live, strategy, or accounting semantic change.

This extends [process-global execution-ledger ownership](execution-ledger-runtime-design.md). That design remains
in force: one account ledger, one process-global serializer, isolated mutation working copies, atomic publication,
and fail-closed reload after an ambiguous write. V9 reduces what those safety operations must clone and serialize;
it does not weaken any of them.

## 1. Established trigger

A fresh 2026-08-22 read found `data/paper-orders.json` at 36.4 MB over 3,792 orders. Every row was terminal,
yet the 15-second orchestrator cloned and rewrote the complete historical evidence. The current file consisted
of approximately 36.4 MB of order rows and 9 KB of non-order state. The largest immutable evidence columns were
14.9 MB of `entryDecision`, 7.5 MB of `positionObservations`, and 4.0 MB of
`entryExecutionObservations`.

After the bounded control projection and an owning forecast compaction, warm dashboard reads were 3–51 ms and
the funded control projection was 276–500 ms at about 19 KB. Process RSS nevertheless remained 1.2–2.2 GB and
reached 2.5 GB while the active collector repeatedly cloned and serialized terminal history. These are bounded
runtime observations, not a heap-retention proof; their load-bearing fact is that the only execution-ledger
bytes present were terminal rows and the complete file was still on every mutation path.

## 2. Chosen boundary: retain control rows, archive heavy evidence

V9 does **not** immediately remove terminal identities or money terms from the account ledger. That would require
new sufficient-statistic rollups for every strategy, funding epoch, risk gate, retry rule, and reconciliation
join at once. Instead it makes the smallest schema change that removes the measured allocation source:

- `data/paper-orders.json` remains the one shared account ledger and retains every order's identity, strategy,
  mode, provider, market, status, timestamps, venue/client IDs, quantity, issuance ceilings, exact and whole-cent
  money terms, outcome, funding IDs, retry/switch links, and reconciliation state.
- Large immutable observation/audit fields of seal-safe terminal rows move to immutable content-addressed batch
  files under `data/execution-order-evidence/`.
- Each compact order carries a reference and a deliberately small control/report summary. Full readers hydrate
  the original row by verified ID from the immutable batch. Funded scheduled paths use compact rows.
- New, open, uncertain, current-window, or incompletely resolved rows stay complete in the hot ledger.

This is a terminal-evidence archive/current-state split, not retention. No order and no field is discarded.
It is deliberately narrower than removing terminal rows: reconciliation and all existing account/strategy
aggregations continue to see the same order population without depending on a new rollup implementation.

## 3. Durable schema and publication

### 3.1 Current ledger

The canonical file advances from version 8 to version 9. A compact order may carry:

```ts
archivedEvidence: {
  version: 'execution-order-evidence-ref-v1';
  file: 'batch.<sha256>.json';
  sha256: string;
  rowKey: string; // per-row SHA-256; legacy history contains a few duplicate logical order IDs
  summary: {
    entryDecisionNetEdge?: number;
    entryExecutionStyle?: 'maker' | 'taker';
  };
}
```

The summary contains only values proven necessary on a scheduled compact-row path. It is not a second decision
snapshot and cannot gain policy authority. Full `entryDecision`, execution decisions, sizing decisions, maker
estimates, entry-management observations, position lifecycle observations, trajectory evidence, settlement
estimates, and direction observations remain in the immutable evidence object.

Direct issuance fields (`issuanceAskPrice`, `issuanceBidPrice`, `issuanceSpread`, and
`approvedMaximumPrice`) are populated from their existing compatibility fallbacks before archiving. A safety
comparison therefore never begins depending on an archived reporting field.

### 3.2 Immutable evidence batches

A batch is compact JSON:

```ts
{
  version: 'execution-order-evidence-batch-v1';
  createdAt: string;
  orders: Record<string, { orderId: string; evidence: ArchivedOrderEvidence }>;
}
```

Batches are grouped by UTC creation day, execution mode, and strategy to bound selective reads. Their filename
is their SHA-256. The writer creates a PID/random temporary file, renames to the immutable filename, reads it
back, verifies bytes/hash/schema/IDs, and only then may publish a ledger referencing it. Existing content with
the same hash is verified and reused, never overwritten.

The current ledger remains the sole publication pointer. A crash before its atomic rename leaves the prior v8
or v9 ledger complete; newly written unreferenced evidence is harmless. A crash after rename leaves every
referenced immutable file already durable. The daily off-machine archive includes the new `.json` files under
`data/`, and local deletion remains forbidden under the existing archive phase-one rules.

### 3.3 Seal eligibility

An order can be compacted only when all of these hold:

1. its status is terminal for execution (`won`, `lost`, `invalid`, `sold`, `unfilled`, or `rejected`);
2. its UTC `closesAt` is not in the future, so retry, re-entry, rate, and current-window selection cannot need
   a stripped observation;
3. it has no pending entry or exit uncertainty;
4. a sold parent has an authoritative hold counterfactual; if it switched, switch-versus-hold is complete and
   its replacement is terminal;
5. no archived field is still being appended by entry or position management.

The pure eligibility function takes `nowMs`; new statuses fail closed. A compacted row can still receive a
late reconciliation correction because its control, identity, money, and issuance-ceiling fields remain hot.
If a later operation creates new lifecycle evidence on that row, hot fields override the older immutable
field during hydration; no immutable batch is rewritten.

## 4. Whole-system reader and writer contract

### Funded orchestration and policy

`paper-execution` continues to mutate one `Ledger.orders` array. Side/window identity, entry generations,
retry cooldowns, current exposure, hourly rate limits, budget funding, long-shot equity/loss, and portfolio
selection read retained compact fields. Historical maker-cohort telemetry reads
`archivedEvidence.summary.entryExecutionStyle` when the full decision is absent. This telemetry remains
reporting-only under `entry-execution-policy`; the differential gate must nevertheless prove identical output.

No archived field may become a forecast, buy-policy, sizing, order-body, fee, budget, or authorization input.
A source/invariant test records the complete allowed compact-row access boundary.

### Reconciliation and live risk

Reconciliation still receives every local order and every venue/client identity. It retains
`reservedStakeCents`, exact fill terms, status, contract, side, quantities, exit IDs, and all fields used by
`reconcileExecutionLedger`. Legacy issuance fallbacks are materialized before stripping. A recovered late fill
can update the compact row; a venue contradiction still blocks execution and reconciles rather than consulting
reporting evidence.

`live-risk-store` must use the v8/v9 storage reader rather than parse the file independently. Risk evaluation
uses compact money/status/time fields and must not hydrate evidence.

### Reporting, UI, and projections

- Fixed dashboard/control/performance-summary polling consumes compact orders or already bounded summaries.
- The control dialog and trade-history pages hydrate only if the fields they render require it; basic recent
  order rows stay compact.
- Full authenticated performance, public full-report replication, and explicit analysis readers hydrate
  immutable evidence on demand.
- Hosted/stateless routes remain Postgres projection readers and never acquire local archive authority.
- Exact `actualPnlCents`/`payoutCents` and whole-cent `pnlCents`/budget controls remain separate; compaction does
  no arithmetic.

### Scripts and corrections

No script may parse `paper-orders.json` directly after v9. Read-only analyses use one compatibility reader that
hydrates v8 and v9 uniformly. TypeScript tools use the authoritative storage module; `.mjs` analyses use a
small schema-compatible reader pinned by cross-reader tests.

Money correction tools must either use an owning v9-aware writer while the worker is stopped and paused or
refuse v9 explicitly. They may not materialize a partial skeleton and overwrite the account ledger. The
migration tool also provides a verified monolith restore that hydrates the current generation before atomically
publishing v8, preserving orders written after migration.

## 5. Migration and rollback

Migration is an owning operation and requires operator-paused control, paused operator intent, zero reserved
budget, and a stopped worker.

1. Parse and validate v8; calculate status/mode/strategy/funding/money totals and a SHA-256 of its canonical
   fully hydrated order list.
2. Build seal-safe evidence batches in staging and verify every batch by read-back.
3. Build v9, rehydrate it through the production reader, and compare every order field to v8. Comparison is
   structural, not selected counters.
4. Re-run account-wide and strategy-scoped reconciliation/report/risk projections over old and hydrated-new
   inputs. Computed floats use their existing named tolerances; durable integer money and identities match
   exactly.
5. Atomically write and verify a content-addressed legacy v8 copy without moving or editing the source.
6. Atomically rename the verified v9 candidate over `paper-orders.json` last.
7. Run the standalone verifier, typecheck, invariant tests, complete tests, and production build before the
   worker restarts.
8. Startup reconciliation must be READY with unchanged cash, positions, IDs, resting orders, and reservations.
   Operator intent remains paused; migration never resumes trading.

Rollback never copies the frozen migration input over newer orders. It reads current v9 plus all referenced
batches, verifies and hydrates every row, writes a complete v8 candidate, and atomically publishes that
monolith. Evidence batches and the frozen legacy copy remain for audit.

The first migration is manual. Automatic compaction is intentionally disabled until the migrated worker has
been observed through startup reconciliation and repeated collector cycles. A later automatic owner must run
inside the existing process-global serializer and use this same publication protocol.

## 6. Verification gates

Implementation is wrong unless all gates pass:

1. v8 and v9 full readers return structurally identical orders after migration;
2. compact funded-path replay gives identical entry identity, retry/generation, portfolio, risk, budget,
   strategy isolation, execution style, and reconciliation results over a grid and the frozen live ledger;
3. malformed refs, path traversal, missing files, bad hashes, wrong IDs, duplicate evidence, or an unsupported
   version fail closed;
4. a crash before ledger publication leaves the old generation readable; a referenced batch is always already
   verified; orphan batches do not affect reads;
5. failed writes preserve/invalidate committed memory exactly as the v8 runtime design requires;
6. full reports and read-only scripts retain evidence fields; bounded polling cannot hydrate the archive;
7. mirror-invariant, strategy-isolation, venue-target-integrity, budget-ledger, policy-manifest, reconciliation,
   pause/drain, typecheck, full tests, and production build pass unchanged;
8. post-restart measurement reports hot-ledger bytes, evidence bytes/files, endpoint payload/latency, RSS/peak,
   sample interval, and the caveat that allocator high-water marks are not retained-heap measurements.

## 7. Explicit non-goals

V9 does not prune order history, split the account ledger by strategy or execution mode, change a policy
version, alter paper/live mirroring, add a database dependency, modify venue mechanics, promote an evaluator,
or automatically compact on its first deployment. Removing terminal control rows and replacing them with
sufficient-statistic rollups may be evaluated later, but it is not necessary to remove the measured heavy
observation columns from the funded hot path.
