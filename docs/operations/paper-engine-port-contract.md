# Paper-engine port contract — partial implementation, unresolved authority

Refs #243. This document describes the remaining implementation boundary; it
**does not authorize paper execution**. The runtime still refuses paper mode.
Current migrations, production dry mode, scheduler and secret bindings are unchanged.

## Pure historical interfaces implemented

- Selected-side exact tick-ladder pricing and five possible amendments within the
  six-check, two-second, twelve-second manager horizon.
- Displayed depth at or better than the paper bid, explicitly a queue proxy.
- Historical fee-model terms: separate continuous edge rate and charged cents;
  integer-cent ceiling with representation epsilon; maker versus taker role.
  These are versioned simulation assumptions, not verified current venue charges.
- Largest affordable quantity under an explicit all-in cap: fractional 0.01
  contracts for Kalshi, whole contracts for Polymarket. Reservation uses taker
  fees; maker accounting returns the unused reserve. A monotonic binary search
  replaces historical decrement iteration without inventing a spending cap.
- Reduce-only sizing below the historical thirty-percentage-point edge threshold.
- Pure maker accounting and edge-bankroll settlement terms. These return plans,
  not effects: SQL must apply order/budget/event transitions exactly once.

The synthetic money oracle specifies literals independently: four half-dollar
Kalshi taker contracts cost200c plus7c fee, reserving207c. A1.25-contract maker
partial at58c costs72.5c, rounded73c;134c unused reservation returns. From1000c,
a125c winning payout leaves1052c cash and52c realized P&L. Invalid returns73c;
loss pays0c. This proves arithmetic only, not persistent idempotency or authority.

## Current control surface and precise unresolved questions

The existing API records control_intent parameters as at most twelve scalar
fields, keys up to39 characters and text values up to120 characters. It validates
structure, not paper policy. Budget identities live in platform; engine roles
must not gain platform-schema access. Jobs currently read action/epoch/time/id
without parameters. The engine-jobs port can extend that DTO/read query while
using existing control_intent columns, without changing API source.

A resume/configure action alone is insufficient paper budget authority. Before
removing the paper refusal, resolve and independently review:

1. The exact versioned paper configuration carried by current-epoch persisted
   configure intent: explicit total/per-trade/provider/market caps, funding
   identity, enabled paper providers and exact model/policy/calibration identities.
   Missing/malformed configuration is refusal; no historical/default amount grants
   authority. The twelve-field constraint must be met without encoded arbitrary
   documents or new API paths.
2. How a bare resume binds the last valid configure in the SAME epoch, and how
   configure/pause/reset/provider-enable rows supersede it. Latest action ordering
   remains(epoch,recorded_at,id); current DB-clock authority is revalidated before
   effect phases and transaction writes. Configuration cannot be inferred from
   future, retired-epoch or overwritten intent.
3. Provider-enable remains inert under the current API contract. Historical
   paperEnabled/liveEnabled flags and promotions are evidence, not new authority.
   Select explicit paper-only configure admission without activating that request
   or auto-promoting restored model/calibration generations.
4. Funding control versus historical accounting: restored provider allocation
   limits may preserve evidence but cannot grant additional headroom. Source
   funding computes percentage of working equity bounded by provider ceiling,
   minus that provider/market pair's own commitments, then bounded by cash.
   Source treats a zero historical provider limit as uncapped; the current port
   must not interpret missing/zero control caps as new uncapped authority.

These are explicit design questions, not a silently selected control schema.
No authority DTO or paper runtime wiring is added in this checkpoint.

## Additive SQL needed — pending narrow scope approval

A new paper-overlay migration requires separate explicit permission; stage2's
0005 exception is not that permission. The proposed hot-state tables need:

- New or restored order identity retaining legacy duplicate ledger positions;
  restored-order references use the existing composite(order_id,ledger_position).
- Origin run XOR origin restore-run foreign keys; current mutation run FK,
  positive revision, immutable epoch/funding/model/policy/exact-contract binding.
- Unique new entry episode key(epoch,funding,logical order,attempt), fill identity,
  and one settlement per concrete order; no duplicate-credit retry behavior.
- Atomic order/reservation/budget/fill/settlement/revision-event transitions.
  Every write and final commit guard verifies DB-clock live lease owner/token and
  current persisted authority. Final guard failure rolls the whole transaction back.
- Append-only events get SELECT/INSERT, not UPDATE/DELETE; mutable overlays get
  narrowly scoped engine_writer SELECT/INSERT/UPDATE. engine_reader gets selected
  reads; engine_control_recorder gets no paper-table access. No runtime DDL or
  platform/public-schema grant. Restored seed and migrations0001–0005 stay immutable.

Exact column-level DDL awaits the remaining policy closure and scope approval.

## Ordering and remaining source work

Actual historical source settles due paper orders BEFORE new entry/maker work.
Keep forecast recording first, then signal persistence, settlement,
counterfactuals/standalone exits, portfolio decisions, orphan expiration,
persisted entry reservation, awaited maker work and final accounting. Replace
historically detached forecast resolution with bounded awaited resolution.
Never add live/reconciliation/drain, detached sentinels or projection dependencies.

Full entry-execution, signal persistence, portfolio, adaptive retry, taker fallback,
exit/switch and funding closure remains to be ported/reviewed. Settlement-backoff
claims in the inventory are not yet confirmed by the inspected implementation.
No full historical closure execution or complete paper-engine parity is claimed.
