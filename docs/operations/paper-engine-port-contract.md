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

Pure entry-route, signal-persistence, explicit portfolio constraints, adaptive
maker-to-IOC episodes, displayed IOC fills, standalone exit and finite-cap
funding reducers are now present. Live-cohort reporting and environment
configuration wrappers were removed at their seams. Their full composition,
exact-contract admission, maker scheduler, IOC quote requalification,
exit/switch accounting and persisted current authority remain unimplemented
and independently unqualified. Settlement-backoff
claims in the inventory are not yet confirmed by the inspected implementation.
No full historical closure execution or complete paper-engine parity is claimed.

## Explicit boundary/evidence corrections (still unwired)

The queue evidence version `paper-queue-evidence-microseconds-v1` replaces inherited v7 millisecond sorting with accepted microsecond timestamps, then locale-independent lexical id ordering for exact ties. This intentionally changes causal fill identity for same-millisecond, different-microsecond prints; it does not change fee or valid quantity economics and is NOT a calibration adoption. Full historical chronology parity is not claimed.

Pricing rejects nonfinite/noninteger/excessive counts, over64 ranges and submicro-dollar/unrepresentable ranges. At most1000 ticks and64 ranges bound each walk to64000 candidate checks; each rounded step must actually progress. These are code work/representation limits, not a venue capability claim or current money authority. Accounting refuses off-lattice filled quantity (whole Polymarket, .01 Kalshi) before payout; fractional displayed public depth remains a proxy, not admissible fractional filled inventory. Book normalization accepts at most1000 total levels, finite nonnegative bounded quantities and finite observation timestamp, failing closed instead of manufacturing missing queue zero.

Four literal hardening regression groups accompany these changes, authored but not locally executed. Typed current authority/config/bundle closure, forecast-record→paper→forecast-resolution split, storage approval and hosted transactional proof remain outstanding. Paper refusal remains intact.

## Pure configuration design — no current authority

`paper-authority.ts` recognizes exactly the twelve scalar fields in the independent control proposal and two-field resume reference. It requires explicit actor-derived paper budget identity, same epoch/actor/config reference, explicit conserved funding match, finite integer caps, closed providers and market, newest malformed configure poisoning, reset barrier and global latest validity. Provider-enable/pause/reset refuse. Dry/forecast reducer is untouched. No store/query or API change accompanies this DTO.

Snapshot completeness, DB-clock validity, ordering and reset booleans must eventually come from a coherent database snapshot using full timestamp precision and bounded latest-by-action queries, NOT a truncated50-row history or JavaScript timestamp sorting. The pure reducer does not prove those booleans or actual funding conservation.

Production compiled bundle availability defaults to **false**. A test-only explicit audited-bundle fixture lets tests exercise reference logic; this is not an audit result, adoption or runtime admission. The recognized bundle identifier remains unavailable pending full immutable tuple closure. No current values are recorded; synthetic test caps are not principal selections.

The conservative1000000-cent guard is a code ceiling, not budget permission. Its integer percentage product is at most100000000 and exact within safe integer arithmetic. With a1c admitted price it bounds quantity to1000000 contracts, at most100000000 Kalshi hundredth units (27 binary halvings, below54). Subcent inputs still require separate venue-lattice/queue bounds before any composition; this decoder does not qualify arbitrary sizing intermediates or replenish a conserved funding root. Hosted boundary vectors are authored, not yet claimed executed.

## Immutable bundle source audit: INCOMPLETE

The recognized bundle remains unavailable. Further read-only source audit identified environment-selectable entry mode/thresholds, spike gate, all five portfolio constraints, asset exclusion/side/max-edge admission, exit reversal/switch settings and regime evidence settings. Historical fallback values are not immutable invariants or current authority, and this port does not silently select them.

Importantly, historical paper admission obeys the adaptive regime gate as well as classified-window eligibility. Its complete sentinel/evidence scope must be audited and isolated; treating it as irrelevant live-only behavior would weaken paper admission. Remaining dependencies include fresh exact-contract IOC requalification, switch/hysteresis/reentry accounting and restored funding/correction scope. Pure helpers and a hash manifest do not establish composed closure.

Source ordering confirms persistence then due paper settlement before exit/portfolio/entry and durable reservation before awaited maker management. The historical maker waits two seconds before each of six checks, with five amend opportunities and a terminal trade-only check. Source settlement retries unresolved due orders each cycle; no paper exponential-backoff rule was established or implemented. Forecast recording precedes awaited paper, and bounded forecast resolution must follow it in the eventual port rather than importing detached historical collectors.

No additional test or runtime implementation is claimed by this audit documentation; the compiled bundle stays unavailable pending complete source choices, literal vectors and independent review.
