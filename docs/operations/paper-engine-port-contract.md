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
loss pays0c. These are authored arithmetic expectations, not an executed-case count, persistent idempotency or authority proof.

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
A pure authority/configuration DTO and reducer now exist (described below). Their caller-supplied snapshot facts are not database proof; no paper runtime wiring is implemented.

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
exact-contract admission and bounded maker scheduler remain unimplemented. IOC quote requalification, sale/exit accounting and switch arithmetic now have pure helpers/plans, but their runtime composition and persisted current authority remain unimplemented and independently unqualified. Settlement-backoff
claims in the inventory are not yet confirmed by the inspected implementation.
No full historical closure execution or complete paper-engine parity is claimed.

## Explicit boundary/evidence corrections (still unwired)

The queue evidence version `paper-queue-evidence-microseconds-v1` replaces inherited v7 millisecond sorting with accepted microsecond timestamps, then locale-independent lexical id ordering for exact ties. This intentionally changes causal fill identity for same-millisecond, different-microsecond prints; it does not change fee or valid quantity economics and is NOT a calibration adoption. Full historical chronology parity is not claimed.

Pricing rejects nonfinite/noninteger/excessive counts, over64 ranges and submicro-dollar/unrepresentable ranges. At most1000 ticks and64 ranges bound each walk to64000 candidate checks; each rounded step must actually progress. These are code work/representation limits, not a venue capability claim or current money authority. Accounting refuses off-lattice filled quantity (whole Polymarket, .01 Kalshi) before payout; fractional displayed public depth remains a proxy, not admissible fractional filled inventory. Book normalization accepts at most1000 total levels, finite nonnegative bounded quantities and finite observation timestamp, failing closed instead of manufacturing missing queue zero.

Four literal hardening regression groups accompany these changes, authored but not locally executed. A typed current authority/config reducer exists; genuine database source proof and immutable bundle closure, forecast-record→paper→forecast-resolution split, storage approval and hosted paper transactional proof remain outstanding. Paper refusal remains intact.

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

## Regime evidence arithmetic slice (unwired)

`paper-regime.ts` ports fully read historical weighted rank-decay/prior/normal-CDF/hysteresis arithmetic behind required explicit settings and a bounded provenance snapshot. The versioned `paper-regime-explicit-evidence-v1` wrapper deliberately refuses missing, stale, disabled or insufficient evidence rather than inheriting permissive warm-up/disabled admission. This is a restrictive proposal, not unchanged warm-up parity or current runtime policy. Four synthetic regression groups are authored, not locally executed.

A current hot forecast can supply a prospective exact-contract candidate and bounded underlying path inputs, but cannot recreate historical selected-candidate issuance quotes/outcomes or persisted hysteresis. The historical gate updater is awaited, unlike other detached collectors; importing it would still create active candidate evidence/settlement writes. No collector/store/network import is ported. A minimal within-run candidate adapter needs proven restored/current evidence identity and an explicit scope/storage decision; ordinary forecast/trade outcomes are not interchangeable samples. Missing evidence continues to refuse, and compiled bundle availability remains false.

## Isolated fallback IOC requalification and terminal plans

`paper-ioc-policy.ts` ports one selected Kalshi maker-miss block: exact contract/side, explicit quote age, structural 1.25-price ceiling, two-tick cushion, predecessor midpoint and strictly positive worst-limit taker-fee edge. All variable settings/identities are mandatory inputs; no environment or SDK/account imports. Five literal regression groups accompany it. This does not supply initial admission, nonfallback route requalification, current persisted authority, asset/window integrity or public book provenance.

Pure accounting plans distinguish unavailable data (rejected/full release), quote refusal, observed zero IOC miss and positive partial fills at taker fees. Zero terminal plans retain issuance economics by emitting no replacement stake/quantity/payout; positive inconsistent/off-lattice/overreserved evidence throws. Plans do not mutate orders or budgets and provide no lease/idempotency/transaction proof. Exact requested-quantity/book/config binding remains a composition requirement. Paper mode and compiled bundle remain unavailable.

## Selected pure switch/hysteresis boundary

`paper-switch.ts` isolates future-wealth/probability-gap arithmetic and bounded persistence with explicit maximum gap, cooldown clock/duration and required readiness inputs. Historical readiness constants are three snapshots across thirty seconds of fifteen-second buckets; no environment settings are selected. Four literal groups cover value, reversal gap, persistence and cooldown. IOC entry accounting now additionally requires explicit issued quantity and refuses excess fills.

Actual sale/reentry mutation is not implemented: source missing exit book defers, observed zero disables automatic retry while retaining inventory, partial sale prorates exact cost and ceilings retained reserve, full sale clears entry persistence. Future concrete order identity must retain restored ledger position, funding/epoch and episode attribution; logical string id alone is insufficient. Sale-child exclusions and exact cost/proceeds rounding are represented by the pure standalone-sale plans below; composed accounting qualification and atomic storage proof remain required, not a fabricated reentry identity. No sale/store/SDK wiring or bundle admission occurs here.

## Independent scope correction and strict-review fixes

Independent accepted-scope review classifies bounded awaited paper-admission candidate/outcome/phase bookkeeping as covered by the original port, unlike detached diagnostic collectors. Accepted restore targets exclude regime candidates/phase: **no restored gate history is proved**. Future code may accumulate one first qualified exact Kalshi candidate per buy-policy/close inside the existing permitted run even while entry admission is closed. No adapter/evidence writes are implemented here; migration-file approval still waits.

Restrictive regime evidence now binds the exact buy sample policy, gate formula, explicit settings descriptor, generation/config/epoch and distinct restrictive proposal identity. Its source kind is prospective engine run, not restored gate evidence. Caller completeness/read time/identity remain assertions, not database provenance, outcome truth or coverage proof. Authority requires epoch at least one. Paper diagnostic text is sanitized. Fractional half-life2..500 remains valid, and sample rank weights do not become elapsed-wallclock decay.

The separate profile paper-blend04-neutralv7-maker-regime12-warmallow-v1 is **proposal only**: regime enabled true differs from source unspecified-environment fallback false. Its genuine persisted initialization/warming lineage is distinct from missing/corrupt state. A separate historical warm-lineage reducer is now implemented below; its lineage DTO is not genuine initialization or persisted coverage proof, and the coherent persisted coverage protocol remains unimplemented. Neither is supplied by this restrictive wrapper. Restrictive snapshot-age checks are new proposed semantics, not historical sample-expiry rules. All compiled bundle availability remains false.

## Pure standalone sale cost-rounding plans

`paper-sale.ts` ports the completely read standalone paper sale function as plans only. Unavailable book defers without recording an attempt; observed zero retains inventory and disables automatic retry. Positive partial sale prorates actual purchase/fee/stake, ceilings retained reserve, releases only the reserve difference, subtracts taker fees and floors nonnegative integer cash credit. Raw net proceeds and actual P&L are separate from integer budget accounting. Full sale has no remainder and requests entry-persistence clearing; partial child does not count toward reentry generation.

Five literal groups include207c stake/four contracts/sell one at60c: fee2c, credit58c, remaining reserve156c, released stake51c and realized gain7c; cash plus reserve becomes1007c from1000c. Fractional and negative net proceeds never round credit upward. Exact cost planes, issued inventory lattice/quantity, contract/side/time and bounded identities are required. Original ledger position/funding/epoch and caller sale event identity are carried, but no conditional provenance FK, idempotency, budget/order mutation or runtime authority is supplied. The adapter must obtain and prove those facts from genuine records. Compiled bundle and paper runtime remain unavailable.

## Separate historical warm-lineage reducer (unwired proposal)

`evaluateHistoricalPaperRegime` preserves explicit disabled/warming admission and warmed rank-based arithmetic separately from the restrictive wrapper. It requires matching sample/formula/settings/config/epoch/generation plus an explicit initialized-empty or persisted-state lineage DTO. Missing/corrupt lineage refuses; an initialized generation must be empty/warming with no asserted prior generation. Previously closed state with truncated insufficient history refuses instead of reopening as warm. These DTO checks do **not** prove genuine database provenance or authorize a reset/new generation.

Historical resolved history has no elapsed-wallclock expiry; fractional half-life remains supported. Current-run coverage and permitted due-outcome work still require coherent persisted reads and fences, not a fabricated read timestamp. Five authored groups compare empty initialization,3-vs-4 warming, explicit disabled versus malformed, independent H2 hysteresis/restart/generation and elapsed-time/fractional behavior. The separate restrictive contract continues withholding disabled/insufficient evidence.

Profile name `paper-blend04-neutralv7-maker-regime12-warmallow-v1` and frozen regime settings true/12/12/.99/.75 are **code proposals only**; enabled true differs from source fallback false. No configuration decoder admits that profile, and compiled availability remains false. The generic pure historical reducer accepts explicit valid settings for independent fixtures; it is not an immutable bundle resolver. Other tuple/source choices and unknown trajectory/caller coverage remain unclosed. No actual candidate bookkeeping, phase initialization, controls, or sale/budget writes occur.

Finite remaining integration: approved0006 schema/provenance and atomic conservation/config/lease/idempotency/concurrency proof; coherent persisted authority and first-per-window prospective candidate/outcome/phase coverage; selected audited immutable tuple and exact fresh adapters/bounded manager/switch composition; forecast-record→paper→bounded resolution and fresh whole-head review. No further helper expansion is implied by this checkpoint.

## Persisted coverage read attestation — 2026-10-17

The statements above that the coherent persisted coverage protocol "remains unimplemented" record the position when they were written and are kept as the historical record; they are not rewritten here. What changed since: a **read-only** attestation now exists. `paper-gate-coverage.ts` with `postgres-gate-coverage-store.ts` reads one scoped generation's head, the phase event it points at, that event's persisted inputs, an independently enumerated candidate universe and the newest control row inside ONE repeatable-read transaction, under the existing `engine.job_lease` owner/token/expiry fence, and verifies that the event's persisted captured counts, universe bounds and input set agree with the enumeration. Lineage is read from the constrained persisted genesis or evaluated row, with a genesis row required to be bound to the generation's own `initialization_run_id`.

Its limits are part of the contract. Coverage means the persisted universe visible in that one transaction, bounded by the receipt's cutoff — not external or historical completeness, and not proof that no later row exists. The returned receipt is a historical read attestation delivered after its transaction ended: it does not assert the lease is still live when a caller reads it and grants no write capability. The head is the generation's declared latest event, not proof that no higher revision exists. A genesis row is evidence of a constrained persisted row, not proof that a genuine initialization or reset protocol was executed by whoever wrote it.

**Write composition is not done.** Phase and head writing, genuine initialization/reset mutation, current-authority admission, transaction replay and compare-and-set, and the fenced atomic write adapter all remain unimplemented; a coherent fenced read proves none of them. Measured during this work on PostgreSQL 16: a `select … where expires_at > clock_timestamp() … for update` that waits for a lock on an otherwise unchanged row evaluates its qualification before the wait, so a lease expiring during the wait is still returned; the adapter therefore re-validates liveness in a separate statement once the lock is held. Compiled bundle availability remains false and the runtime paper refusal is unchanged.

### Lock-wait proof bounding and harness controls — 2026-10-18

The expiry-during-lock-wait proof in `checks/paper-gate-coverage-postgres.mjs` is a direct observation, not a callback or elapsed time: a dedicated observer connection must see, in ONE statement, the adapter's own backend id blocked by the holder's backend id on the final locking statement against `engine.job_lease` while the lease is still live on the database clock. Two harness-only defects in that vector are fixed here, with no change to the adapter, the domain, migrations, grants or any runtime timeout.

- The holder's failure handler settled only the observation gate, so a holder that failed BEFORE acquiring the lock left the barrier's lock gate pending: the adapter sat in an open transaction, the original fault was lost, and the run ended only when the adapter's own idle-in-transaction bound tore the connection down. The handler now settles both gates on every failure path, hands the original error back, and fails promptly.
- The observer was bounded by iteration count only. Two hundred polls at 25ms is 5000ms of sleep before query duration, which outlives the adapter's 3000ms lock timeout, so a non-matching run could end in a cancelled locking statement rather than its own diagnosis. The observer now stops on a real elapsed deadline, each poll is additionally capped by its own connection statement timeout, the holder releases promptly when nothing was observed, and the last polled row, poll count, elapsed milliseconds and any error are surfaced for diagnosis.

**Bounding is an engineered margin, not a hard real-time guarantee.** Every wait has a real elapsed deadline, so no path can hang; the blocked span the adapter experiences is anchored to the fixture lease's absolute expiry instant, because the holder releases as soon as the database clock passes it, rather than to the sum of the diagnostic deadlines. Host scheduling can stretch any of it. The deliberate property is that when it does, the vector fails with those diagnostics instead of hanging or passing vacuously, and the measured blocked span is itself asserted to stay inside the adapter's unchanged lock timeout.

**Dated control record** (hosted disposable PostgreSQL 16, approved workspace, synthetic rows only; no raw logs or captures retained).

| Date | Mutation (never committed) | Assertion exercised | Outcome |
| --- | --- | --- | --- |
| 2026-10-17 | adapter: remove only the fresh post-lock database-clock check | expiry-during-lock-wait must refuse `lease-lost`/`final-boundary` | failed: a verified receipt was returned under the same observed blocked-while-live sequence; restored by precise edit |
| 2026-10-18 | adapter: same removal, re-run against the rewritten vector | same | failed the same way under the changed oracle, so the rewritten vector still discriminates the fix |
| 2026-10-18 | harness copy: holder failure handler no longer settles the lock gate | holder-fault vector must fail promptly with the original error | failed after about ten seconds with a closed connection in place of the original fault, which is the defect this fix removes |
| 2026-10-18 | harness copy: observer bounded by iteration count only | non-matching observer must stay inside the adapter lock timeout | failed with a cancelled statement due to lock timeout, which is the defect the elapsed deadline removes |

Authored cases are not executed cases, and a passing fenced read still proves none of the write composition listed above.

## Persisted paper-authority snapshot reader — 2026-10-18

The statement above that `paper-authority.ts` has "no store/query" accompanying it records the position when it was written and is kept as the historical record. What changed: a **read-only** snapshot reader now feeds the existing pure reducer. `postgres-paper-authority-store.ts` with `paper-authority-evidence.ts` reads, inside ONE repeatable-read transaction under the existing `engine.job_lease` owner/token/expiry fence, the standing control intent for the capability, the configure intent a request could bind, the reset barrier, and the funding/budget root pair. SELECT only; no statement in either file writes, and no new grant was needed — verified against the migrations, not assumed: 0001 grants `engine_writer` select on `engine.control_intent`, 0004 select/update on `engine.job_lease`, 0006 select on both paper roots.

**PostgreSQL computes the facts, not the caller and not a JS `Date`.** Ordering and the reset barrier are row comparisons over `(epoch, recorded_at, id)` — the ordering ADR-0013 §3 names and `control_intent_latest_idx` indexes. Clock validity is compared against `clock_timestamp()` using the existing approved `MAX_INTENT_CLOCK_SKEW_MS`; no freshness tolerance is invented. Timestamps cross as exact signed epoch-microsecond text and whole cents as text, so nothing is truncated to millisecond precision and no money value becomes a JS float. The conservation identity is recomputed in exact arbitrary-precision `numeric`. The standing intent is read **globally** for the capability, never filtered to the requested epoch; `order by … limit 1` is "the newest row", never a page of history, and a malformed newest row is reported as the newest row rather than skipped so an older well-formed one can stand in.

**Lifetime is stated in the result.** A successful read returns `protocol`, `validity: single-transaction-snapshot-only`, `lifetime: historical-read-evidence-after-commit` and `admission: none`. It is evidence of what the persisted record said under a live fence during one transaction — not live write-admission, not a capability, and not a claim that the lease is still held when the caller reads it. The decision it carries is computed with the reducer's own default availability, which is `COMPILED_PAPER_BUNDLE_AVAILABLE === false`, so paper admission refuses `bundle-unavailable`. Neither the adapter nor the evidence builder accepts an audited-bundle override; the positive reducer path is reached only by a caller that passes the flag to the pure function itself, which the hosted contract does with a known-audited fixture alongside an explicit production-unavailable assertion.

**Two facts no constraint enforces** are checked because 0006's own comments assign them to the adapter: that the funding root's birth-config intent really is a `configure` for this capability with the same epoch and actor, and that the root pair joins on the full primary key. The conservation identity and the birth-config composite key are also schema constraints, so their independent value is limited and the reader says so rather than presenting them as discoveries. A funding root at another epoch is recorded as audit information only; no epoch policy is invented, and the root lookup is actor-derived, so a configuration naming a budget the actor does not own is rejected by the reducer rather than by an empty lookup.

**Caller claims are never authority.** Completeness, ordering, the reset barrier and conservation reach the reducer only as values the server produced; a representation the evidence builder cannot recognise makes the snapshot incomplete and fails closed. `control_intent.recorded_at` carries no `isfinite` check, so a non-finite newest row is genuinely reachable: it is reported as unrecognisable rather than allowed to raise on the numeric cast or quietly replaced by an older row.

### The twelve-field configure proposal, in plain terms — for approval, not assumed

`PaperConfigurationV1` remains a **design proposal**. It is not an approved operator API, not current configuration, and nothing here chooses a default or writes a configure, resume or funding row outside disposable synthetic fixtures. In plain terms a configure intent's parameters would carry: a format version; which funding pot and which paper budget it belongs to (the budget must be the actor's own); four whole-cent ceilings — a total cap, a per-entry cap, and one cap each for the two venues, none above the total; two whole-percent venue shares; which venues are switched on at all; the single market family; and the exact policy bundle identifier. A resume intent would carry just two fields: the format version and the id of the configure intent it is resuming. Approval of this shape, of any specific numbers, and of who may record such an intent all remain the maintainer's to give.

**Not delivered by this reader, and not renamed as delivered:** the atomically composable current-authority writer, initialization and reset mutation, phase and head writing, replay and compare-and-set, and runtime wiring. A coherent fenced read proves none of them. A future writer must use the ACTUAL genesis revision in this repository, which is **0** — an earlier reviewer sketch suggesting 1 is unverified and is not propagated here. Compiled bundle availability remains false and the runtime paper refusal is unchanged.

### Dated control record — 2026-10-18

No raw logs or private captures retained; hosted disposable PostgreSQL 16, synthetic rows only.

| Mutation (never committed) | Assertion exercised | Outcome |
| --- | --- | --- |
| authority adapter: lower the transaction to READ COMMITTED | the mid-read barrier vector must still read one state | failed — the concurrently committed newer configure was picked up, so the vector discriminates one snapshot from two |
| authority adapter: remove only the fresh post-lock database-clock check | expiry during the final lock wait must refuse `lease-lost`/`final-boundary` | failed — full evidence was returned under the same observed blocked-while-live sequence; restored by precise edit |
| none — defect found by the new vectors during development | the standing intent must be ordered by the integer epoch | an output column aliased `epoch` shadowed the table column, so `order by epoch desc` compared epochs as TEXT and ranked epoch 9 above epoch 10; the alias is now `epoch_text` and the newer-epoch vector covers it |

## Atomic persisted gate writer — 2026-10-18

The statements above that phase and head writing "remain unimplemented" record the position when they were written and are kept as the historical record. What changed: a persisted gate writer now exists. `postgres-paper-gate-writer.ts` with `paper-gate-write.ts` creates a generation, appends a phase event and its ordered inputs, and moves the head, all in ONE transaction, under the existing `engine.job_lease` fence. It is persistence only: it does not activate paper mode, does not touch funding, control, intents or settings, and writes no money value. No new grant was needed — verified against the migrations, not assumed: 0006 already grants `engine_writer` select/insert on the generation, candidate, outcome, event and input tables and select/insert/update on the head; 0001 grants select and update on `control_intent`; 0004 grants select/update on `job_lease`.

**Authority is read inside the writing transaction**, from the real control and funding/budget rows, through the same shared statements the reader uses. A historical read receipt, a caller completeness or conservation boolean, and a caller-supplied config id are never accepted in its place; the scope must be the identity the control record itself names. The **production factory takes no availability argument at all** and the writer core is module-private, so an otherwise valid record refuses `bundle-unavailable`. **An earlier version of this paragraph overstated the boundary and is corrected here:** it claimed a differently named exported core plus an excluded test-support wrapper was enforcement, when that core shipped in `dist` and therefore in the runtime image, and a scan that excluded the defining module could not catch it. The boundary is now the ABSENCE of an admission token from the production build — see the artifact boundary section below.

**Contract inputs versus claimed evidence.** The generation's settings, labels, event key, run id and reset barrier are *contract inputs*, bounded against exactly the 0006 domains, with decimals carried as text to a `numeric` cast rather than as JS floats. The coverage receipt id and the observed/cutoff boundary are *claimed evidence*: bounded and ordered, never believed. Counts, universe bounds, the ordered input set, the lineage and the resulting phase are **derived** from persisted rows at that boundary, so a false boundary can only move the boundary — it cannot inflate a count or invent a phase. The phase itself comes from the qualified `paper-regime` arithmetic, fed by a mechanical mapping of persisted outcome columns onto its observation DTO; an evaluation whose own shape does not match the derived universe is refused rather than persisted.

**Genesis is revision EXACTLY 0**, warming, with the event's run id equal to the generation's `initialization_run_id` — the binding the coverage reader requires, and the reader is driven in the same contract to confirm it accepts the lineage. A reset creates a properly barriered FRESH generation (`reset_origin='post-reset'` with a real `reset` intent that orders strictly after the prior generation's configure) and never mutates history; the prior generation, event and head are asserted unchanged. An earlier reviewer sketch suggesting genesis revision 1 is unverified and is not propagated.

**Rollback discipline.** DELETE is revoked on all these tables, so rollback is the only thing that can undo a partial write. Every refusal decided *after* the first mutation throws an internal control sentinel and is mapped to a refusal outside the transaction; a normal return would COMMIT and is therefore forbidden on that path. `40001`, deadlock and unique violations are mapped specifically; any other database failure is re-thrown and never turned into a success. No receipt escapes before commit.

**Replay** is compared field by field against what a fresh write would have persisted — microseconds as exact integers, counts as integers, the input list in order, never as parsed JSON or by property order. A replay derives from the event's own RECORDED revision, not from the present head, reads no present authority, and reports `authority: not-evaluated-on-replay`, so it can never be mistaken for present write admission. A caller's expected revision is compared against the recorded `revision_before`; a different one is a mismatch, not a stale-revision refusal.

### Linearization: what this writer does and does not guarantee

The transaction runs at SERIALIZABLE, which is stronger than the reader's REPEATABLE READ and needs no schema, grant or API change. Measured on the hosted contract rather than argued:

- A concurrent UPDATE of the exact control row the decision bound is caught by the `for share` revalidation after the mutations and aborts with `40001`.
- Two writers against the same head produce exactly one transition. The loser was observed refusing with `unique-violation` — the schema's `unique (generation_key, revision_after)` on the event fires before the head UPDATE is even reached. A control that removed the head CAS predicate left every vector green, so the CAS is belt-and-braces at this isolation level and is **not** presented as proven by these tests; it is kept as the protection at any weaker isolation level.
- Two writers with no head at all also produce exactly one generation, event and head.
- **The open gap.** A NEWER control intent inserted by a read-committed recorder after this transaction's snapshot and committed before its COMMIT is NOT ordered against the write. The hosted vector measured this and the write **committed under the superseded intent**. PostgreSQL's serializable guarantee holds only among transactions that are all serializable, and the control recorder's isolation is outside this batch's allowed surface.

So this writer linearizes against the lease and against other writers, and its authority check means "the control record as of this transaction's snapshot", **not** "no superseding intent exists at commit". **This batch therefore does not claim current write admission.** Closing the gap needs a lock both sides take, or a row both sides contend on.

**One option previously listed here was wrong and is withdrawn:** raising every control writer to SERIALIZABLE does NOT close it. An insert-only recorder creates a single read-write dependency edge against the writer, not a cycle, so SSI has nothing to abort — which is exactly what the hosted vector measured when it saw the writer commit under a superseded intent. The remaining options are the control recorder taking the per-capability advisory lock the writer now takes (`pg_advisory_xact_lock` needs no grant, but needs the recorder side), or a per-capability control-generation row the recorder bumps and the writer locks `for update`, which is a schema change. Historical attestations do not cure a stale write, and the product stays disabled meanwhile.

### Known dependency limit

The restrictive-proposal bundle is refused with `evidence-producer-unavailable`: its regime entry point takes a maximum evidence age, and choosing one would be inventing a freshness tolerance this batch has no authority to pick. Only the historical warm-lineage bundle, whose own contract states that resolved sample history does not expire by wall clock, is reachable.

### Dated control record — 2026-10-18

No raw logs or private captures retained; hosted disposable PostgreSQL 16, synthetic rows only.

| Mutation (never committed) | Assertion exercised | Outcome |
| --- | --- | --- |
| writer: remove the head CAS predicate | two writers on one head must produce one transition | **passed** — so the CAS is not the discriminator here; the unique event constraint and `40001` are, and the documentation now says so instead of claiming the CAS is proven |
| writer: return instead of throwing on a post-mutation lease failure | a refusal after mutations must leave persisted state byte-identical | **failed** — the event committed and the state comparison caught it, so the rollback discipline is what protects atomicity |
| none — defect found by the new vectors during development | the universe bounds must be persisted | `universe_first_closes_at` and `universe_last_closes_at` were derived but never inserted, so any evaluated event with candidates violated 0006's universe-bounds check; both columns are now written as exact microseconds |

## Artifact boundary and write-lock preparation — 2026-10-18

### The audited-policy boundary, corrected

The earlier claim that an exported `createPaperGateWriterCore(connectionString, auditedBundleAvailable)` was safely fenced off was **wrong**: that function shipped in `dist`, the Dockerfile copies `services/engine-jobs/dist` into the runtime image, and the hosted contract imported it from `dist` with `true`. A distinctive name, an unused excluded wrapper, and a source scan that excluded the defining module are not enforcement. What is now in place:

- The core is **module-private**. `dist/adapters/engine-store/postgres-paper-gate-writer.js` exports exactly `createPostgresPaperGateWriter` and nothing that takes availability — asserted by an executable check against the built artifact, not by reading the source.
- The factory takes an opaque `admission` value, never a boolean and never a loader, and asks `paper-gate-audited-policy-gate.js` whether it is THIS artifact's token. **The production gate has no token at all** (`AUDITED_POLICY_ADMISSION` is `undefined`), so the answer is always `false`.
- The identity-bound fixture is a unique `Symbol` in `src/test-support/`, which `tsconfig.build.json` excludes, so it is **physically absent from `dist`**: importing it from the production artifact fails with `ERR_MODULE_NOT_FOUND`.
- The positive path lives in a **separate artifact**, `dist-test-support`, built by `build-test-support` from the same adapter source with that one gate file replaced. It is the same real adapter, not a surrogate, and it is excluded from git and from the Docker build context.
- Handing the production factory the **genuine** fixture still refuses `bundle-unavailable`; a forged symbol of the same description, a `Symbol.for` of the same key, a plain object, a string and `true` are all refused by identity.

### Per-capability write lock, as preparation only

The writer can now take a session-level advisory lock, keyed by `hashtextextended('money-noodle/paper-gate-capability-write/v1:' || capability, 0)`, on a connection it opens for that one call, **before** `BEGIN` — so its snapshot is taken after the wait — holding it through COMMIT or ROLLBACK, releasing it on that same session, then closing the connection so no release failure can leave a lock behind. Acquisition is bounded by the connection's existing `lock_timeout`; a `55P03` arrives before any mutation and becomes a `conflict`/`write-lock-timeout` refusal. A hash collision can only over-serialize. A per-call connection is required rather than a `max: 1` pool because session advisory locks are re-entrant per session, and because postgres.js reserved handles expose no `begin`.

The mode defaults to **off**, so the measured non-participating behaviour is unchanged. It is exercised against a **synthetic participating recorder** — a single `insert … select … from pg_advisory_xact_lock(<same key>)` run as the real `engine_control_recorder` role — in both orders, with the advisory wait observed directly in `pg_locks` joined to `pg_stat_activity`, never by a sleep: with the recorder holding, its row is invisible and the writer is seen waiting, and once the recorder commits the writer snapshots after the wait and refuses `paused`; with the writer holding, the recorder is seen waiting and its row stays invisible until the writer finishes, after which the next write refuses `paused`.

**The real recorder in `services/platform-api` does not participate**, and this batch is not authorized to change it; approval for recorder participation has been requested and is **not yet granted**. Until real recorders participate, none of this is current write admission.

### Accuracy note on the CAS control

The earlier control that removed the head CAS predicate **passed**, and the reason is now stated precisely rather than as "belt-and-braces": the loser's event insert violates `unique (generation_key, revision_after)` before the head UPDATE is reached, which the hosted vector records as `unique-violation`. The CAS predicate is kept because it is the protection at any weaker isolation level; no test here discriminates it, and none is claimed to.

## Independent F1/F7 IOC corrections

`paper-ioc-conservative-microprice-v2` intentionally corrects inherited quantity/price epsilon behavior. Shared bounded book normalization, finite request/side/time validation and conservative hundredth-quantity flooring prevent overflow or rounding .0099999999 displayed units up to .01. Re-sweeping best-to-worst at the reduced quantity trims excess from the worst consumed level. Integer micro-dollar comparison rejects .500001 buys above a .5 cap and .499999 sells below a .5 minimum; only sub-tick representation dust is normalized. Entry and sale accounting require explicit authorized maximum/minimum prices and bind actual average/cash to them. Missing book remains unavailable, not an observed IOC miss. Four literal groups are authored; no unchanged-all-float parity or runtime authority is claimed. The F2–F6 guards are now implemented in pure code as summarized below, awaiting fresh independent confirmation and current hosted CI qualification.

## Independent F2/F3/F5 boundary corrections

Exit validation now bounds quantity/cost/fee/uncertainty and requires nonnegative finite gain, valid side/time/high-water DTOs and finite derived money before any HOLD/SELL result. Large finite inputs producing infinity refuse; ordinary98c liquidation versus90c optimistic hold remains SELL. These are numerical safety limits, not selected spending authority.

Switch persistence deduplicates equal parsed instants (including Z versus .000Z aliases) and rejects prior firstSeen after lastSeen. It intentionally retains the source fifteen-second **bucket** span rather than imposing thirty elapsed seconds; two genuine0/30 observations are not three, while0/15/30 retains minimum-gain semantics.

Managed repricing requires0<currentPrice<1, a supported ladder price and no more than the immutable issuance maximum (representation-only tolerance). A resting price is not required below a moving new ask: ask crossing still does not imply a fill. Normal .41→.42 repricing and terminal .41 retention remain. Four new literal groups are authored; F4/F6 guards were added subsequently as summarized below. No runtime wiring or current configuration is changed.

## Current accumulated checkpoint — not whole-engine qualification

All seven independent F1–F7 guard fixes have implementations and authored literal regressions; independent confirmation and exact-current-head hosted qualification remain pending. Episode inputs are capped before sorting, require bounded unique IDs and explicit finite zero fills with coherent terminal completion; omitted fills refuse without an authoritative zero decoder. Portfolio work is capped at ten positions with bounded inputs; persistence validates four prior observations before copying, coherent identity/window/time and quality/edge domains, and resets a different symbol. These are pure numerical/work guards, not runtime admission or principal spending selections.

**71 reported authored cases is not 71 executed or passed cases.** On code head0f22cdc, CI38107395722 failed typecheck with TS2375 in the new malformed-fill test fixture (explicit undefined under exactOptionalPropertyTypes); hosted lint/build/test/contract targets reported success, but their individual counts were suppressed. A fixture-only correction preserves the omitted-fill refusal assertion; subsequent exact-head checks must qualify it. No local tests/builds/database runs or paper SQL transaction proofs are claimed.

The restrictive evidence wrapper and historical warm-lineage proposal remain distinct. Historical rank-decay/warming does not prove current coverage, genuine database lineage or complete immutable tuple closure; permissive OPEN/DISABLED truncated-history lineage remains an adapter coherence concern. Queue microsecond ordering and conservative IOC microprice/quantity rules intentionally correct inherited chronology/epsilon seams, not unchanged full historical parity.

Runtime paper refusal and compiled availability **false** remain. Migration0006 author/test scope is unapproved and no0006 is authored; migrations0001–0005/API/grants remain unchanged. Existing forecast PostgreSQL checks are not real paper order/budget/event atomicity, fault, duplicate, concurrency or lease/config-fence proof. Stage3 goal remains OPEN and PR275 DRAFT; documentation completion does not make the whole path review-ready.
