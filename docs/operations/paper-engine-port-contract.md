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
