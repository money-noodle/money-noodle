# Incremental background reconciliation

> **Status: approved direction; implementation design.** Written 2026-08-23 after a one-hour funded-runtime
> observation and current Kalshi API verification. This changes reconciliation scope and scheduling, not entry,
> exit, sizing, budget, or fail-closed policy. Activation still requires a quiescent build/restart and successful
> startup reconciliation.

## 1. Problem

The current five-minute pass calls `fetchKalshiReconciliationSnapshot`, paginates the complete Kalshi live-tier
order and fill collections at 200 rows per page, and holds the shared execution-ledger serializer while every
network request completes. `startBackgroundCollector` awaits that pass. In the 2026-08-23 02:53–03:53 UTC
monitor, routine successful passes took 57.9–65.2 seconds, five of twelve passes timed out, collector success
fell to 154 of about 240 nominal ticks, and eight of 58 authenticated control reads exceeded 20 seconds.

The work is also broader than the safety question. Kalshi now partitions terminal orders and fills at a moving
historical cutoff, so `/portfolio/orders` and `/portfolio/fills` are not lifetime collections. Re-reading the
whole live tier neither proves lifetime completeness nor confines work to venue state that can still alter the
account.

## 2. Verified venue capabilities

Kalshi OpenAPI 3.28.0 and read-only production responses were checked on 2026-08-23:

- `/portfolio/orders` supports `min_ts`, `max_ts`, `status`, cursor pagination, and `limit <= 1000`;
- order `min_ts` filters creation time, not `last_update_time` (verified with an order created at
  05:16:40Z and updated at 05:16:44Z; a 05:16:42Z lower bound excluded it);
- `/portfolio/fills` supports `min_ts`, `max_ts`, `order_id`, cursors, and `limit <= 1000`;
- `/portfolio/orders/{order_id}` returns one authoritative known order;
- resting orders and unsettled positions remain in live endpoints regardless of the historical cutoff;
- `/historical/cutoff` reported 2026-06-23 for orders, fills, markets, and positions.

A bounded two-hour production read returned 10 orders in 178.7 ms, four fills in 79.5 ms, zero resting orders
in 77.1 ms, and three nonzero positions in 95.9 ms. Exact order and order-scoped fill reads took 141.3 ms and
87.9 ms. These are one current-account slice, not latency distributions. Unfiltered first pages each returned
1,000 rows plus a cursor, confirming why repeated full-live-tier pagination scales with account age.

## 3. Decision

Split reconciliation by purpose while retaining one account authority.

### 3.1 Startup/manual full current-account audit

Startup, operator manual reconciliation, and pause/drain continue to block readiness until an authoritative
current-account audit passes. It reads:

- venue cash;
- all nonzero/unsettled positions;
- every resting order, canceling and confirming only Money Noodle-managed remainders and blocking on unrelated
  resting orders;
- the complete current Kalshi live tier of orders and fills, paginated at the venue's 1,000-row maximum;
- exact known local active/pending order identities when absent from the collection response.

“Full” means complete current account authority, not lifetime reporting history. Historical terminal rows cannot
become resting or unsettled again. If an unresolved local transaction predates the venue's live cutoff, the audit
fails closed for explicit recovery rather than silently declaring it absent.

### 3.2 Periodic incremental account audit

The ordinary five-minute pass reads only:

1. current cash;
2. all current nonzero/unsettled positions;
3. all current resting orders;
4. orders created in a closed time interval from a durable checkpoint through the task's fixed start time;
5. fills created in that same interval;
6. exact order and order-scoped fill state for every locally active, pending, uncertain, or exit-pending live
   transaction.

The lower bound includes a fixed overlap wider than Kalshi's existing 30-second visibility grace. Order and fill
IDs deduplicate the overlap. Because order `min_ts` is creation-based, every known nonterminal order is refreshed
by exact ID; the creation delta is used to discover unknown new orders and lost-response orders without a venue
ID. A lost-response intent is matched by the existing bounded durable client IDs within the interval.

### 3.3 Event-triggered targeted recovery

An uncertain create, amend, cancellation, or exit schedules the same incremental pass immediately. Its lower
bound also reaches back before the earliest unresolved transaction's durable `createdAt`, regardless of the
ordinary checkpoint. The reservation and worst-case exposure remain durable until the result commits.

An uncertain funded transaction continues to block **new live exposure**. Collection, paper execution,
settlement, control/status reads, cancellation, reduce-only lifecycle handling, and reconciliation continue.
This preserves the existing fail-closed rule; “background” does not mean trading through unknown account state.

## 4. Durable checkpoint

`data/kalshi-reconciliation-checkpoint.json` is an atomic, server-only control record:

```ts
interface KalshiReconciliationCheckpointV1 {
  version: 'kalshi-reconciliation-checkpoint-v1';
  completedThroughTs: number; // whole Unix second used as the prior closed interval maximum
  completedAt: string;
  trigger: 'startup' | 'manual' | 'automatic' | 'periodic';
}
```

The checkpoint advances only after all pages and targeted reads pass, the local/venue matcher reports no issue,
the reconciled ledger and whole-cent reservation update commit, and any recovered settlement commits
idempotently. A failed or partial pass never advances it. Missing or malformed state escalates the next pass to
the full current-account audit. The overlap means a crash between the ledger commit and checkpoint write re-reads
already committed venue rows safely by ID.

The checkpoint is not a venue-order ledger, does not replace immutable order/fill evidence, and cannot authorize
an order. Its sole claim is that discovery was complete through one bounded venue timestamp.

## 5. Scheduling and serialization

Periodic reconciliation gets its own process-global, unref'ed scheduler started by the persistent Node runtime.
The collector no longer imports, calls, or awaits it.

A pass has three phases:

1. **Fence and snapshot (short serialized phase).** Set reconciliation `running`, which immediately blocks new
   live exposure; wait behind any already-started managed transaction; capture the required local live identities
   and a deterministic live-authority fingerprint.
2. **Venue reads (outside the execution-ledger serializer).** Perform bounded account/delta/target reads. Paper
   and evidence ledger operations, dashboard collection, and read surfaces remain available. Existing live
   cancellation/reduce-only work may continue where safe.
3. **Compare and commit (short serialized phase).** Re-read the current ledger. If its live-authority fingerprint
   changed, discard the stale calculation and retry from a fresh snapshot. Otherwise run the pure reconciler on
   the current ledger, atomically write it, reconcile whole-cent reservations, apply idempotent recovered
   settlements, then advance the checkpoint.

A venue snapshot is not atomic across endpoints. The live-admission fence plus fingerprint retry prevents a
new entry or local live mutation from being validated against a snapshot taken before that mutation. Network
I/O never sits inside the shared ledger serializer.

## 6. Failure and readiness semantics

- First periodic failure sets reconciliation blocked and suppresses new live entries, then retries after 30
  seconds without withdrawing active operator intent.
- Second consecutive periodic failure safety-suspends exactly as today.
- A successful authoritative retry may guarded-auto-resume only a system suspension with retained active intent
  and every normal readiness check clear.
- Startup/manual/drain failures remain blocking and never fabricate restart safety.
- Paper, research, and terminal settlement do not inherit live reconciliation failure.
- Current cash, positions claimed by a local open/pending/uncertain/exit-pending lifecycle, resting orders,
  malformed rows, incomplete cursors, duplicate venue ownership, overfill, reservation-ceiling violations, and
  unrelated resting orders retain fail-closed checks. A terminal or authoritatively rejected local row does not
  claim an exact ticker until close; acceptable external position activity remains outside the local ledger. See
  `external-venue-position-ownership-design.md`.

## 7. Scope boundaries

This change does not alter:

- forecast, buy policy, execution route, price, size, fee, exit, switch, or strategy behavior;
- durable order/client identity or one-venue-to-one-local ownership;
- account-wide cash, reservation, position, exposure, rate, loss, or kill-switch controls;
- startup/Resume authority or quiescent pause/drain semantics;
- paper/live mirror policy separation;
- immutable historical order, fill, correction, or audit rows.

Authenticated WebSocket order/fill streams are not required. They may later improve latency only with REST
backfill and the same durable checkpoint; a socket message can never by itself establish reconciliation
completeness.

## 8. Acceptance gates

1. Pure grid tests prove incremental and full snapshots produce identical reconciliation results for every
   combination of no fill, full/partial fill, amendment chain, lost response, exit, unrelated resting order,
   duplicate ownership, and account contradiction.
2. Boundary tests pin fixed `min_ts`/`max_ts`, overlap deduplication, order-creation versus update behavior,
   pagination, malformed cursors, checkpoint crash windows, and an unresolved transaction older than the live
   cutoff.
3. A concurrency test holds venue reads open while collector/paper/read operations complete, proves a new live
   entry is blocked, mutates live authority, and verifies compare-and-commit retries rather than overwrites.
4. Existing reconciliation, budget-ledger, mirror-invariant, strategy-isolation, venue-target-integrity, and
   policy-manifest invariants remain unchanged and pass.
5. Production build, typecheck, and full tests pass while live remains on the old built runtime.
6. Activation requires build first, quiescent pause/drain, one successful full startup audit, explicit operator
   Resume, then a monitored hour showing collector cadence, reconciliation duration, control latency, checkpoint
   advancement, and no account discrepancy.
