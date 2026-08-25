# Live-authorization evaluation design

> **Status:** Approved analysis plan, queued strictly after the portfolio-selection final review in
> [`docs/portfolio-selection-evaluation-design.md`](portfolio-selection-evaluation-design.md). No authorization
> manifest or candidate is collecting. This document changes no forecast, buy policy, confirmation, venue
> candidacy, portfolio selection, sizing, route, capital, reconciliation, control state, or live authority. Its
> retained/repaired handoff is the prerequisite for the separately approved attempt-and-outcome lifecycle program.

## 1. Question

A portfolio-selected candidate still has no right to spend money. Live authorization must prove that the worker,
operator, exact provider/market, account state, capital, exposure, order identity, and bounded wire command all
remain authorized at the moments that matter.

The primary engineering question is:

> For every portfolio-selected exact order, can production reconstruct one complete, contemporaneous proof that
> every required authority remained valid through durable intent, reservation, and submission?

The reliability question is:

> Do pause, kill, reconciliation, configuration, funding, duplicate-identity, stale-state, and ambiguous-response
> races always fail closed without creating unreserved or unowned venue exposure?

Availability is reported separately:

> How often does a safety, capital, or operational authority withhold a candidate, for how long, and was the block
> genuine, duplicated, stale, or unavailable?

Safety is not optimized against investment return. A safety invariant may remain economically costly when its
fault model is real. Capital ceilings and misplaced economic selectors receive separate ownership and evidence.

## 2. Current production boundary

Live authority is distributed across `readiness` in `lib/trading-control.ts`, `runLive`, `buildOrder`,
`executePreparedLiveBuy`, budget reservation, and `placeKalshiBuy` / `placeKalshiTakerBuy`. There is no single
current authorization object.

The current path may check, in order:

1. persistent-worker environment arming and kill-switch state;
2. provider configuration intersected with implemented provider/market live capability;
3. authoritative reconciliation phase;
4. active automation, operator intent, and live execution mode;
5. current-epoch and lifetime live loss limits;
6. adaptive regime, calculation freshness, and the hourly filled-order ceiling;
7. current position, switch, asset, classified-regime, retry, confirmation, and provisional portfolio state;
8. per-placement global exposure and filled-order usage after earlier orders in the drain;
9. provider/market funding, per-purchase and maximum-live-stake ceilings, quantity, fee reserve, and cash;
10. unique durable order/client identity and route-specific bounded price authority;
11. durable ledger intent before budget reservation and signed submission;
12. exact pre-submit quote, price lattice, quantity lattice, order-body bounds, and environment recheck;
13. authoritative fill cost against reserved and per-purchase ceilings; and
14. retained reservation plus system suspension when venue state is ambiguous.

Pause withdraws operator intent before draining the serialized execution queue. Startup, manual, and drain
reconciliation are full barriers; ordinary reconciliation is checkpointed and incremental. A system suspension may
guarded-auto-resume only with retained active operator intent and every ordinary readiness check passing. A manual
pause, configuration pause, kill switch, or economic loss stop cannot auto-resume.

## 3. Measure classes and ownership

### 3.1 Safety and authority invariants

These prevent unauthorized, malformed, stale, duplicated, or contradictory venue exposure:

- stateful worker only; environment live opt-in and kill switch;
- typed live-mode arming plus current active operator intent;
- implemented and enabled exact provider, variant, market, contract, side, and UTC close;
- authoritative reconciliation agreement and admission fence;
- valid control, provider, budget, ledger, and reconciliation generations;
- unique durable logical/client identity and one venue order per local owner;
- durable intent and positive whole-cent reservation before signed submission;
- finite quote, ordered bid/ask, valid price and quantity lattices, and bounded limit order;
- cancellation confirmation and fail-closed ambiguous transaction handling;
- quiescent pause/drain and guarded recovery semantics;
- exact fill cost not exceeding the authorization ceiling captured at issuance.

These use pure invariants, fault injection, deterministic concurrency tests, and operational reliability evidence.
They do not need to improve return. Removing or weakening one is outside this program.

### 3.2 Capital and risk ceilings

These cap loss or resource use and require explicit loss-envelope and operator-intent justification:

- all-in per-purchase amount and maximum live stake;
- provider, market, and strategy funding allocations;
- available cash and whole-cent working-budget headroom;
- global positions and correlated exposure;
- hourly filled-order ceiling;
- current-epoch peak-to-settled-equity drawdown stop;
- strategy-specific lifetime realized-loss stop.

Names must match behavior. The current hourly ceiling counts venue orders with fills, not submissions. The current
epoch breaker does not mark open positions to executable liquidation value. Those may be valid choices, but reports
must not describe them as controls they are not.

Loosening a capital/risk ceiling requires a separate capital design, downside scenarios, and manual approval. A
higher-return cohort cannot promote a looser safety boundary.

### 3.3 Economic or lifecycle decisions encountered late

These remain recorded but are not account authority:

- adaptive and classified regime admission;
- asset admission;
- signal persistence, requalification, cooldown, and episode limits;
- economic spread and venue-edge rechecks;
- maker/taker route selection;
- protected switch economics.

Their current checks remain fail-closed until separately changed. Attribution may identify misplaced ownership but
cannot move or relax them.

### 3.4 Diagnostics

These cannot authorize or refuse during attribution:

- every simultaneous pass, fail, duplicate, unavailable, and not-applicable result;
- age of calculation, quote, account read, and reconciliation authority;
- a hypothetical bounded reconciliation lease result;
- control/provider/budget/reconciliation revisions and a live-ledger authority fingerprint;
- time from portfolio selection through intent, reservation, pre-submit quote, acceptance, and terminal state;
- first-blocker versus all-blocker disagreement;
- blocked duration, affected settlement windows, and paper-only opportunity during the block;
- reservation release/recovery latency and guarded-auto-resume path;
- effective runtime values, recorded without credentials or secret material.

## 4. Exact identity and authorization generations

Every candidate and result retains:

```text
strategyId
marketId
providerId
providerVariantId
contractRegistryId / exact contractId
symbol
side
closesAt UTC
logicalOrderId / clientOrderId
```

Every authorization observation additionally stamps:

```text
control revision
provider configuration revision
provider-budget revision
reconciliation trigger, generation/checkpoint and completedAt
ledger live-authority fingerprint
calculationAt and observedAt
captured authorization ceiling cents
```

A later revision does not rewrite an earlier decision. Secret keys, signatures, tokens, and credential contents are
never persisted; only configured/available booleans and non-secret version identities may be recorded.

The first generation reconstructs current behavior exactly. A proposed fencing token, reconciliation lease, or
ownership correction receives a new generation and cannot use the attribution cohort as promotion evidence.

## 5. Relation to existing evidence

`live-skip-v1` remains an immutable first-blocker episode journal. It is useful for paper-minus-live attribution but
records only the first reason returned by `runLive`; it cannot prove simultaneous authority or infer that an absent
class never bound.

At the 2026-08-25T04:45:58Z replay it contained 4,938 episodes. Distinct windows included 427 `none`, 375
`persistence`, 233 `regime`, 96 `reconciliation`, 66 `operator`, and 9 `staleness`. No environment, rate, budget,
funding, exposure, or risk-stop class appeared as the first blocker. Overlapping windows and first-blocker ordering
are the principal caveats. These rows motivate complete attribution and cannot promote an authorization change.

The 2026-08-23 incremental-reconciliation monitor observed 12/12 READY passes lasting 0.444–11.722 seconds during
one funded hour, including active transactions. It observed six live attempts, three fills, three confirmed
no-fills, and no uncertainty. The uncertain-response recovery branch therefore remained test-backed rather than
production-observed.

## 6. Phase A — complete exact-control manifest

Add one observation-only manifest for every portfolio-selected exact candidate, including candidates that produce
no durable intent. It records the complete authority vector rather than returning after the first blocker.

For each check, preserve:

- owner and class: safety, capital/risk, economic/lifecycle, or diagnostic;
- current production result and exact reason;
- input source, observation time, age, revision, and unavailable state;
- whether it independently blocks under production;
- every simultaneous blocker and the first blocker production reported;
- final disposition: no intent, rejected before reserve, reserved, submitted, accepted, filled/no-fill, or
  uncertain;
- reservation, release, suspension, reconciliation, and recovery evidence.

The manifest writer is detached and observation-only. Failure to construct or persist it cannot delay, authorize,
or refuse an order. No policy, control, budget, reconciliation, or order module may import a manifest report.

The exact-control implementation must match production's first blocker, order terms, reserved amount, and final
disposition on a pure grid and live-runtime observations. A disagreement blocks efficacy reporting.

## 7. Phase B — fault, concurrency, and current-rule attribution

### 7.1 Required fault matrix

Test at least:

- environment disable or kill switch before selection, reservation, and signed request;
- operator Pause before selection, between selection and reserve, and while a request is active;
- reconciliation moving READY→RUNNING at every authorization boundary;
- a READY record whose completion/cadence age is arbitrarily old;
- provider permission, variant, market capability, or budget revision changing mid-path;
- provider cash falling below local uncommitted budget or exact reservation;
- duplicate logical/client ID and one venue order matching multiple local owners;
- malformed quote, lattice, quantity, fee, fill, cursor, and checkpoint evidence;
- signed create accepted with response lost; cancellation response lost; partial fill; overfill; unrelated resting
  order; and exact fill cost above reserved authority;
- crash after intent, after reservation, after venue acceptance, after local fill commit, and before checkpoint;
- first and second periodic reconciliation failures plus guarded recovery;
- manual/configuration/risk pauses proving ineligible for automatic recovery;
- every registered strategy proving it cannot spend another strategy's allocation.

Each race uses deterministic barriers and repeated seeded schedules. No fault test sends a funded order.

### 7.2 Attribution questions

The prospective report asks:

- which authorities independently block and which are duplicate or inert;
- whether every issued order had a complete contemporaneous proof;
- whether any status or quote exceeded its stated freshness boundary;
- whether current reconciliation READY can outlive its scheduler without a separate expiry;
- whether reservation and provider/strategy funding ownership match configured allocations;
- whether the filled-order throttle and settled-equity drawdown are named and dimensioned for their actual purpose;
- whether a late economic/lifecycle decision is incorrectly presented as operational safety;
- how much availability each genuine authority costs, without treating cost as permission to remove it.

A proven fail-open or cross-strategy funding fault authorizes only a separate fail-closed repair proposal. It does
not require or receive an economic A/B test. A proposed loosening remains outside this cohort.

## 8. Phase C — one focused authorization generation

After the attribution and fault report, write an amendment selecting at most one focused generation:

- a fail-closed repair for one proven safety/concurrency defect;
- an immutable authorization-token/fencing-generation improvement;
- an explicit bounded reconciliation-readiness lease;
- a strategy-funding ownership correction; or
- exact production control when no repair is justified, used only to validate complete observation and uptime.

The amendment freezes its state machine, revisions, clocks, fault cases, expected dispositions, operational
availability ceiling, and rollback before activation. It starts a new prospective cohort. It does not combine a
capital-ceiling change, economic gate move, or execution experiment.

Passing requires both deterministic fault evidence and held-out runtime observation. A safe repair may deliberately
increase refusal; the review reports that availability cost rather than treating it as a regression by itself.

## 9. Milestones

| Milestone | Requirement | Nominal planning duration |
| --- | --- | --- |
| Exact-control engineering | Pure boundary/fault grid plus 25 live-runtime portfolio-selected calculations with zero first-blocker, authority-vector, order-term, reservation, or disposition mismatch | Before evidence clock |
| Manifest smoke | 10 independent settlement timestamps; exact identity, all authority revisions/clocks, simultaneous checks, and explicit no-intent outcome complete | About 2.5 hours after activation |
| Manifest coverage | 100 closed timestamps; at least 95% complete authority/outcome coverage and 100% coverage of durable live intents and reservations; every unavailable class explained | About 25 hours |
| Fault/concurrency gate | Every predeclared fault passes plus at least 1,000 deterministic seeded schedules across each pause/reconciliation/reservation critical race with no unauthorized submission, unreserved exposure, duplicate ownership, or false recovery | Engineering-dependent |
| Current-rule attribution | 300 closed timestamps and at least 100 windows where an authority independently blocks or differs from first-blocker reporting, or documented inert/insufficient activity; all effective values and ownership seams reported | At least 75 hours; blocking frequency may dominate |
| Focused-generation runtime gate | New cohort: 300 closed timestamps, 100 portfolio-selected authorization opportunities, at least 95% complete manifests, 100% issued-intent/reservation coverage, and seven continuous days at the configured reconciliation cadence without an unexplained authority gap | At least seven days; opportunity frequency may extend it |
| One final review | Fault matrix, runtime gate, availability attribution, cash/reservation tie, recovery semantics, and declared rollback all pass | Manual, once |

A genuine rare network ambiguity is not required in production. Deterministic lost-response and crash recovery are
the deciding safety evidence; production observations remain additional evidence and are never manufactured.
Repeated calculations and assets sharing one UTC close count as one independent window.

## 10. Review and change boundary

The final review reports separately:

- safety/fault correctness;
- complete-manifest and issued-intent coverage;
- simultaneous and first-blocker attribution;
- authority age and cadence gaps;
- reservation, cash, exposure, and provider/market/strategy allocation agreement;
- pause, drain, suspension, uncertainty, reconciliation, and auto-resume transitions;
- availability withheld by each authority;
- misplaced economic/lifecycle checks;
- exact and unavailable cohorts.

A fail-closed repair succeeds by closing its stated fault without creating a new contradiction. It does not need to
increase return. A capital/risk or economic change requires a separate predeclared program and cannot be promoted
by this review. Dates, counts, uptime, or a complete manifest never change production automatically.

A successful review permits only a separate written ownership/policy change, versioned authority generation,
immutable evidence link, operational rollout plan, and manual approval. A null result retains production and
records the remaining uncertainty. In either case, freeze the exact authorization generation before the
attempt-and-outcome program begins.

## 11. Serial placement

This program starts only after portfolio selection freezes. A portfolio change alters which candidates request
account authority and how much capacity they consume, so concurrent unsettled cohorts would confound authorization
availability and funding evidence.

The serial handoff is:

1. freeze base signal;
2. freeze confirmed signal;
3. freeze venue candidacy;
4. freeze portfolio selection;
5. implement exact-control authorization manifests;
6. complete fault/concurrency and current-rule attribution;
7. freeze at most one focused authorization generation;
8. complete its held-out runtime and operational-cadence monitor;
9. perform one final authorization review;
10. complete any separately approved repair/ownership rollout, or record the null result, then freeze that exact
    retained or repaired authorization generation; and
11. only then permit the attempt-and-outcome parity phase in
    [`docs/attempt-outcome-evaluation-design.md`](attempt-outcome-evaluation-design.md) to start.

No milestone starts the next phase automatically. Funded execution retains every current fail-closed control while
this observation program is queued or collecting.
