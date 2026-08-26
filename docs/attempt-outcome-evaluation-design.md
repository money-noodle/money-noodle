# Attempt-and-outcome evaluation design

> **Status:** Approved analysis plan, queued strictly after the live-authorization final review in
> [`docs/live-authorization-evaluation-design.md`](live-authorization-evaluation-design.md). No lifecycle manifest,
> transition journal, or candidate generation is collecting. This document changes no forecast, buy policy,
> confirmation, venue candidacy, portfolio selection, authorization, route, order management, retry, exit, capital,
> reconciliation, settlement, accounting, or live authority.

## 1. Question

The final decision layer starts with one exact authorized order and has two different outcomes:

1. **execution outcome:** whether the instruction was reserved, submitted, accepted, refused, rejected, partially or
   fully filled, confirmed zero-fill, or left uncertain; and
2. **economic outcome:** whether acquired exposure was later reduced, sold, won, lost, invalidated, or remained
   unresolved, and how exact venue cash and whole-cent budget control changed.

The primary engineering question is:

> Can every authorized live instruction be replayed through one exact causal lifecycle—from durable intent and
> reservation through venue events, reconciliation, position ownership, terminal outcome, and cash—without
> inferring authority from prose, losing partial-fill or recovery provenance, or counting one event twice?

The safety and accounting question is:

> Under every crash, delayed response, duplicate event, cancellation race, partial fill, and settlement race, do the
> venue, shared order ledger, position view, reservation ledger, and exact/whole-cent P&L views converge without
> unauthorized exposure or manufactured cash?

The economic question is separate:

> Conditional on the frozen upstream order and route, which post-authorization lifecycle choices preserve
> deployable value, and how much value is lost at pre-submit refusal, acceptance, queue fill, partial fill, exit, and
> settlement?

A safety or accounting repair succeeds by closing a contradiction. It does not need to increase return. An economic
management candidate must be scored on every authorized intent, including zero-spend refusals and no-fills.

## 2. Current production boundary

Current production stores entry execution and position outcome in one `PaperOrder` row. Its status union combines:

```text
attempt lifecycle:  pending_reservation / uncertain / unfilled / rejected
position lifecycle: open / sold / won / lost / invalid
```

Several load-bearing states are represented by supporting fields rather than the status itself:

- reservation success or refusal;
- submission started;
- venue acceptance and working state;
- cancellation requested and confirmed;
- partial entry fill, inferred from `filledCount < requestedQuantity`;
- partial reduce-only exit, represented by a sold child plus an open remainder;
- authoritative recovery after a lost response; and
- exact venue money versus adversely rounded whole-cent control money.

The production path is intentionally conservative:

1. write the durable local intent before a signed request;
2. reserve whole-cent authority;
3. refresh the exact contract and either refuse before submit or send a bounded maker/IOC instruction;
4. persist the venue order ID immediately after acceptance;
5. aggregate authoritative fills and fees, cancel and confirm any remainder, and release unused reservation;
6. retain reservation, mark `uncertain`, suspend, and reconcile when venue state is ambiguous;
7. settle or reduce only the acquired quantity; and
8. reconcile cash, positions, orders, fills, resting orders, and local ownership before new exposure continues.

Current typed no-fill reasons distinguish `pre_submit_quote_moved`, `post_only_race`, `rested_no_fill`, and
`ioc_no_fill`. These are not interchangeable denominators: the first two never became accepted working orders,
while the latter two did.

This design does not replace `PaperOrderStatus` or approve the venue-neutral order-management system proposed in
[`docs/execution-engine-separation-design.md`](execution-engine-separation-design.md). It first builds a detached,
exact-control projection and tests whether a later normalized lifecycle is justified.

## 3. Measure classes and ownership

### 3.1 Safety and ownership invariants

These prevent unowned, duplicated, malformed, oversized, or ambiguous exposure:

- durable intent and unique client identity before signed submission;
- at most one local owner for each venue order/fill and one bounded venue intent for each authorized instruction;
- exact provider, variant, market, contract, side, and UTC-close identity;
- positive reservation before submission and fill cost no greater than captured authority;
- fill quantity no greater than submitted quantity within the existing lattice tolerance;
- authoritative cancellation of every managed remainder;
- retained reservation and system suspension for uncertain state;
- reduce-only, side-aware exits that never exceed owned quantity;
- exact reconciliation of orders, fills, positions, resting orders, and cash before recovery; and
- idempotent replay after a crash, delayed response, or duplicated venue page.

These are decided by pure invariants, fault injection, deterministic concurrency schedules, and authoritative
account ties. They are never relaxed by a higher-return cohort.

### 3.2 Accounting invariants

These preserve two intentionally different money views:

- exact purchase, fee, proceeds, payout, and `actualPnlCents` for reporting;
- adversely quantized whole-cent reservation, settlement, and `pnlCents` for budget control;
- costs rounded up and proceeds rounded down exactly once at the control boundary;
- idempotent reserve, release, settle, and reconciliation adjustment identities;
- proportional basis and fee allocation on partial reduce-only exits;
- no payout for a confirmed zero-fill or pre-submit refusal; and
- no cross-strategy, cross-market, cross-provider, or cross-budget-epoch attribution.

Exact and whole-cent totals are reported side by side. Their difference is not called drift unless each view first
fails its own arithmetic.

### 3.3 Economic lifecycle decisions

These require prospective intent-to-treat return evidence if a later generation proposes changing them:

- managed-maker initial price, amendments, resting horizon, and cancellation timing after route selection;
- whether an authoritative maker zero-fill may open another fully requalified episode;
- any post-authorization refusal or cancellation rule based on a fresh quote;
- treatment of a partial fill's unfilled remainder beyond the mandatory no-overexposure rule;
- lifecycle timing of a non-safety reduce-only exit; and
- any policy that trades acceptance probability, fill probability, adverse selection, or capital reuse.

Upstream route choice remains owned by execution style, and exit value remains owned by the exit policy. This
program may attribute their realized paths but cannot silently move or combine those owners.

### 3.4 Capital and risk ceilings

Reserved stake, per-purchase authority, provider/market allocations, global exposure, and loss/rate
limits arrive frozen from live authorization. This program verifies that the captured ceilings were obeyed; it
cannot loosen or resize them. Any such change requires its own downside and capital design.

### 3.5 Diagnostics

These observe and never authorize, refuse, reserve, reconcile, or settle:

- complete funnel counts with explicit denominators at authorized, durable, reserved, submitted, accepted,
  working, partial/full fill, confirmed zero-fill, uncertain, recovered, exited, and settled boundaries;
- event, acknowledgment, resting, amendment, cancellation, fill, reconciliation, and settlement latency;
- typed terminal disposition and all simultaneous causes rather than one mutable prose reason;
- displayed depth, queue-ahead proxy, public trades, quote movement, and implementation shortfall;
- filled-versus-accepted-no-fill outcomes and competing-risk hazards;
- whether an order's final row retained partial-fill and recovery provenance;
- unsupported or delayed provider outcomes and provider-cash credit timing; and
- explicit missing events, observation gaps, historical inference, and policy-generation mismatch.

## 4. Normalized lifecycle projection

The first generation projects current behavior into four orthogonal dimensions without changing the production
ledger:

```text
intentState:
  durable / reservation_refused / reserved

venueOrderState:
  not_submitted / submitting / accepted / working /
  accepted_zero_fill / partially_filled / fully_filled /
  create_rejected / uncertain

positionState:
  none / open / partially_exited / closed / settled / invalid

cashState:
  no_reservation / reserved / partially_released / released /
  partially_settled / settled / reconciled
```

Typed outcomes remain orthogonal rather than recreating the current conflation:

```text
executionDisposition:
  reservation_refused / pre_submit_refused / post_only_create_rejected /
  accepted_maker_zero_fill / accepted_ioc_zero_fill / partial_fill /
  full_fill / ambiguous

recoveryDisposition:
  not_needed / pending / reconciled_absent / reconciled_zero_fill /
  reconciled_fill / contradiction

economicDisposition:
  no_position / open / partially_exited / sold / won / lost /
  invalid / unresolved
```

These are read-model names, not new production statuses. A control projector derives them from authoritative
fields and events under current semantics. Unknown or contradictory combinations become `unavailable` or
`contradiction`; they are never forced into the nearest favourable state.

Each transition observation carries:

```text
lifecycle generation and schema version
strategyId / marketId / providerId / providerVariantId
contract registry identity / exact contractId / symbol / side / closesAt UTC
logicalOrderId / orderId / entryEpisode / attemptNumber
clientOrderId / venueOrderId / venue fill IDs where known
budget epoch and reservation/settlement related IDs
reconciliation trigger, generation/checkpoint and completedAt where applicable
source event kind and stable typed reason
occurredAt / observedAt / persistedAt
causal parent and per-lifecycle sequence
production policy and execution generations
```

Timestamps alone do not establish causal order. Stable identities, source sequence where available, and declared
parentage do. Secret material and unrestricted signed responses are never copied.

## 5. Detached evidence and authority

Add an append-only observation journal plus bounded rollup owned by one compactor. It references authoritative
ledger revisions/events; it does not become a second order, position, reservation, or cash ledger.

Required properties:

- one deterministic idempotency key per normalized transition;
- append before outcome resolution where the observer receives a decision-time event;
- corrections append a superseding observation rather than rewriting history;
- lifecycle gaps and observer write failures remain explicit in coverage;
- a crash may reduce diagnostic coverage but cannot change production behavior;
- no report, candidate, or journal status is importable by policy, authorization, budget, reconciliation, order,
  exit, or settlement modules;
- stateless hosts have no writer; and
- archive/restore manifests include the journal before activation.

The authoritative proof that intent preceded the venue request remains the production ledger write, not the
observation journal's timestamp. The journal records and verifies that proof rather than duplicating it.

## 6. Relation to existing evidence

Existing execution observations, ledger rows, budget audits, reconciliation audits, provider history, and reports
remain authoritative for what they currently record. They are not rewritten or backfilled into a prospective
normalized generation.

The mixed-policy live edge-entry snapshot read at 2026-08-25T04:57Z contained 2,103 attempts, 1,865 rows with venue
order IDs, 846 rows with fills, and 23 inferred partial fills. Its typed no-fill reasons included 948 rested
zero-fills, 170 post-only races, 35 pre-submit quote refusals, and 21 IOC zero-fills; legacy rows required some
prose inference. The ledger was actively changing and spans several execution generations, including 452 rows
without an execution-policy version, so these counts motivate a clean prospective cohort and cannot evaluate a
new lifecycle rule.

A fresh `npm run analyze:live-opportunities` run generated at 2026-08-25T04:58:34Z used resolved data through
04:45Z. In its preceding 24 hours, 101 attempts produced 81 venue acceptances, 33 fills, 65 unfilled outcomes, and
3 rejected/other outcomes. The 33 fills spanned only 24 independent windows; this is a current funnel snapshot,
not evidence for a lifecycle change.

The proposed normalized lifecycle in `docs/execution-engine-separation-design.md` is useful architectural context,
but that broader runtime design remains proposed. This evaluation stands independently and does not approve engine
extraction, generic instruments, or a money-store migration.

## 7. Phase A — exact-control lifecycle and parity

Implement a pure projector and detached observer for every live instruction that completed the preceding frozen
authorization generation, including reservation refusal and pre-submit refusal. Record explicit absence where no
venue request or fill ID should exist.

Parity must prove:

- the normalized states and separate execution, recovery, and economic dispositions match current production
  semantics;
- submitted, accepted, partial/full fill, and zero-fill denominators agree with authoritative IDs and fills;
- every critical reservation, release, fill, position, exit, settlement, and reconciliation amount ties to its
  owning store under the correct exact or whole-cent view;
- final status never erases the detached recovery or partial-fill provenance;
- historical/prose inference is excluded from prospective exact-control claims; and
- observer failure cannot alter latency, route, submission, budget, reconciliation, or outcome.

A pure grid covers every valid transition and rejects impossible combinations. Live-runtime parity uses only
observation; it sends no additional order and makes no signed request solely for evaluation.

## 8. Phase B — fault, recovery, accounting, and current-rule attribution

### 8.1 Required fault matrix

Test at least:

- crash before and after durable intent, reservation, submit start, venue acceptance persistence, local fill
  commit, reservation release, exit commit, settlement commit, and reconciliation checkpoint;
- accepted create with lost response, malformed response, delayed client-ID visibility, and response duplication;
- duplicate, delayed, out-of-order, malformed, partial, and over-quantity fills across an amendment chain;
- fill cost exactly on and one cent beyond the captured authority boundary, including float-representation edges;
- cancellation accepted but response lost, temporary `not_found`, terminal status with remainder, fill during
  cancel, and resting remainder after local terminal projection;
- one venue order matching two local owners, one local intent matching multiple amendment records, unrelated
  resting orders, and cross-provider/contract outcome mismatch;
- partial entry followed by settlement, partial reduce-only exit, duplicate exit fill, and attempted over-sell;
- reconciliation immediately before, inside, and after the 30-second visibility boundary;
- provider outcome delayed, unsupported/invalid, contradictory, or visible before the corresponding cash credit;
- duplicated reserve/release/settle/reconciliation events and exact-versus-whole-cent arithmetic edges; and
- pause, system suspension, guarded recovery, and process restart at each active transaction boundary.

No fault test sends a funded order. Critical races use deterministic barriers and at least 1,000 seeded schedules
per declared race.

### 8.2 Attribution questions

The current-rule report asks:

- where authorized instructions stop and which denominator applies at each boundary;
- which dispositions are independently typed, historically inferred, duplicated, or unavailable;
- whether any transition or final row loses venue acceptance, partial-fill, cancellation, uncertainty, or recovery
  provenance;
- whether every acquired quantity has exactly one local owner and every budget movement one idempotent cause;
- how long reservation and uncertainty remain outstanding;
- whether maker fills are outcome-selected relative to accepted zero-fills;
- how issuance, submitted, fill, exit, and terminal value disagree;
- whether retries and later episodes change complete intent-to-treat value rather than only fill-conditioned return;
- whether settlement result, local budget payout, and provider cash become visible at materially different times;
  and
- which finding is safety, accounting, economic, capital, or merely diagnostic.

Attribution may nominate one later repair or economic family. The inspected cohort cannot promote what it selects.

## 9. Phase C — at most one focused generation

After the attribution report, write an amendment freezing at most one generation:

- one normalized lifecycle/provenance repair;
- one fail-closed recovery, ownership, cancellation, or settlement repair;
- one exact/whole-cent accounting repair;
- one focused post-authorization economic management family; or
- exact production control when no change is justified.

A repair amendment declares its state machine, migration boundary, fault cases, expected dispositions, idempotency,
rollback, and availability effect. An economic amendment declares every arm, public evidence requirement,
intent-to-treat metric, material margin, downside bound, and family-wise correction before new outcomes accrue.
They cannot be combined in one generation.

An economic arm receives the same frozen upstream authorized order, route, captured cents ceiling, and initial
quote. It maintains its own causal management state after divergence and cannot read the production fill to decide
what it would have done. Public depth/trade evidence may score a comparable path; missing evidence is
`unavailable`, never a manufactured fill. It cannot send an order, reserve money, or alter production cancellation
or retry behavior.

No generation in this program may loosen reservation, exposure, rate, reconciliation, reduce-only, or live-
authority controls. A production status/schema migration or order-management change remains a separate reviewed
implementation and manual rollout even after a successful evaluation.

## 10. Milestones

| Milestone | Requirement | Nominal planning duration |
| --- | --- | --- |
| Lifecycle engineering | Pure valid/impossible transition grid plus 25 terminal live-runtime controls with zero normalized state, disposition, identity, quantity, or money mismatch | Before evidence clock |
| Lifecycle smoke | 10 independent closed settlement timestamps containing an authorized live instruction; exact identities, transition sequence, separate dispositions, and explicit absence complete | Opportunity-dependent; wiring only |
| Exact-control coverage | 100 closed authorized-intent timestamps; at least 95% complete diagnostic transition coverage, 100% coverage for every applicable accepted order, fill, reservation, release, position, and settlement event, and every unavailable class explained | Multi-day; authorized-intent frequency controls |
| Fault/recovery/accounting gate | Every declared fault passes plus at least 1,000 deterministic seeded schedules per critical submit/accept/fill/cancel/reconcile/settle race; zero unowned exposure, duplicate money movement, false cancellation, or false recovery | Engineering-dependent |
| Current-rule attribution | 300 closed authorized-intent timestamps and at least 100 windows containing a pre-submit refusal, create rejection, accepted zero-fill, partial fill, uncertainty/recovery, or early exit—or a documented insufficient-activity finding; exact and whole-cent views each tie | Multi-day to multi-week |
| Focused safety/accounting generation | New cohort: 300 closed authorized-intent timestamps, at least 95% complete diagnostics and 100% critical ownership/money coverage, targeted fault matrix and seeded races repeated, plus seven continuous days without an unexplained lifecycle/accounting gap | At least seven days; opportunity frequency may extend it |
| Focused economic generation | New cohort: 300 closed authorized-intent timestamps, 100 materially divergent windows, then 200 execution-scoreable windows with at least 90% required public-evidence coverage and 100 divergent windows | Multi-day to multi-week |
| One final review | Applicable focused gate, exact account tie, declared correction/downside test, rollback, and all invariant checks complete | Manual, once |

Only one of the two focused-generation rows applies. If no repair or economic family is justified, Phase C runs the
exact production control through the safety/accounting gate and records the null result. Repeated assets, episodes,
orders, fills, or calculations sharing one UTC close count as one independent window.

A genuine production ambiguity, invalid settlement, or partial exit is never required merely to satisfy a count.
Deterministic fault evidence decides rare safety paths; runtime absence is reported rather than manufactured.

## 11. Review and change boundary

The final review reports separately:

- lifecycle completeness and impossible-state findings;
- safety, identity, ownership, cancellation, uncertainty, and recovery correctness;
- exact venue, local position, reservation, budget, and provider-cash agreement;
- exact reporting P&L versus whole-cent control P&L;
- complete funnel counts and stage-specific latency;
- pre-submit, create-rejection, accepted-zero-fill, partial/full-fill, and recovered cohorts;
- filled-versus-missed outcome selection and complete intent-to-treat return;
- issuance-to-submission-to-fill-to-exit implementation shortfall;
- exact, unavailable, legacy-inferred, and contradiction cohorts; and
- availability or economic cost of the focused generation.

A safety/accounting repair succeeds only if its declared faults close without creating another contradiction. An
economic management family must beat frozen production on the prospectively declared intent-to-treat execution
comparison without violating downside or safety bounds. Counts, uptime, a clean funnel, or higher fill rate alone
never promote anything.

A successful review permits only a separate written lifecycle/order-management design, version/schema change,
immutable evidence link, stopped/quiescent migration plan where needed, rollback, and manual approval. A null result
retains production and records what evidence would change the answer.

## 12. Serial placement

This is the seventh and final decision-layer evaluation. It starts only after live authorization freezes. An
authorization change alters which instructions exist, their captured authority, and whether an apparent refusal is
upstream or part of venue execution; concurrent unsettled cohorts would invalidate the funnel.

The complete serial handoff is:

1. freeze base signal;
2. freeze confirmed signal;
3. freeze venue candidacy;
4. freeze portfolio selection;
5. freeze live authorization;
6. implement exact-control lifecycle projection and detached transition evidence;
7. complete fault/recovery/accounting tests and current-rule attribution;
8. freeze at most one focused safety/accounting or economic generation in a new cohort;
9. perform one final attempt-and-outcome review; and
10. consider a separate manual implementation proposal, or record the null result.

No milestone starts the next phase automatically. Funded execution retains every current status, route, retry,
reservation, cancellation, uncertainty, reconciliation, exit, settlement, and accounting rule while this program
is queued or collecting.
