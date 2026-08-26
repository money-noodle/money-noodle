# Delivery and acceptance

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-26
> **Canonical for:** delivery boundaries, phase ordering, and initial acceptance criteria.
> **Read with:** [`STATUS.md`](../STATUS.md) for current implementation and
> [`status/roadmap.md`](../status/roadmap.md) for non-normative sequencing.
>
> This module states required delivery outcomes. Checkmarks, partial-completion markers, dated progress, and active
> sequencing do not belong here: `STATUS.md` projects implementation and the roadmap orders pending work. If this
> module appears to conflict with another canonical module, stop and resolve the specification conflict.

<a id="req-delivery-plan"></a>

## 10. Delivery plan

Delivery is ordered by authority and risk. Read-only research precedes durable evidence; durable evidence precedes
account integration; paper precedes funded placement; every funded capability remains independently promoted and
fail-closed. A later phase may build foundations early, but it cannot acquire the authority gated by an earlier
phase.

<a id="req-delivery-phase-1"></a>

### Phase 1 — Read-only prediction dashboard

The first deliverable is a responsive, degraded-state-safe dashboard that:

- discovers active supported markets without hardcoded probabilities;
- presents venue and model probabilities separately, with edge, confidence, timing, factors, and source freshness;
- exposes positive-edge calculations and below-gate diagnostics without granting execution authority;
- uses atomic local cache/history writes and bounded refresh behavior; and
- includes normalization, model, signing, and source-failure tests appropriate to the read path.

The signed order-book ladder is observation-only. Its polling, cache, and presentation must remain isolated from
forecasting, qualification, ranking, sizing, reconciliation, and orders.

<a id="req-delivery-phase-2"></a>

### Phase 2 — Research, history, and evidence

The evidence phase must:

- provide grounded, cited, terminal LLM research that cannot influence forecasts or trading;
- persist immutable issuance-time forecasts, exact provider provenance, actionable side prices, policy/model
  identities, replay inputs, and venue-specific outcomes;
- report sample sizes, calibration, proper scores, benchmark comparisons, lead-time slices, independent-window
  counts, simulated return, and material limitations;
- preserve unavailable or non-comparable evidence rather than reconstructing it optimistically;
- keep walk-forward evaluation offline from funded runtime and prohibit automatic promotion; and
- require quiescent, authenticated, audited manual model promotion or rollback.

Evaluation of the decision path proceeds serially so an upstream generation is frozen before a downstream cohort
starts: base forecast → confirmed signal → venue candidacy → portfolio selection → live authorization → attempt and
outcome. The accepted evaluation designs in [`docs/README.md`](../docs/README.md) define each mechanism; the current
sequence and active collection state live only in [`status/roadmap.md`](../status/roadmap.md).

<a id="req-delivery-phase-3"></a>

### Phase 3 — Provider and account integrations

Provider delivery must:

- start from the versioned provider and market registries and fail closed for unknown capabilities;
- separate market-data, paper, and live capability for every provider × market pair;
- preserve exact provider, variant, market, contract, rules, and target identities;
- add official read/paper adapters before any independently approved live capability;
- keep provider prices out of the venue-independent forecast; and
- expose account, order, fill, position, fee, and reconciliation state without leaking credentials.

A provider with visible quotes, configured credentials, or paper history is not thereby live-capable. Live support
requires separately verified eligibility, signing, funding, placement, cancellation, fill, position, cash, target
integrity, and reconciliation behavior.

<a id="req-delivery-phase-4"></a>

### Phase 4 — Paper, then funded trading

Paper delivery must precede production placement and use the shared entry rule with separate capital, ledger,
execution simulation, and P&L. It must preserve provider/variant/policy identity and never mutate live authority.

Funded delivery additionally requires:

- durable whole-cent budget control with exact reporting fields kept separate;
- explicit arming, typed environment confirmation, kill switch, stake/rate/exposure/loss ceilings, and quiescent
  pause/drain;
- durable intent before submission, idempotency, uncertain-state retention, reduce-only side-aware sells, and
  partial-fill protection;
- startup, manual, pause, and periodic authoritative reconciliation; and
- guarded auto-resume only for eligible system suspensions with retained operator intent.

A historical replay harness, stronger mutation-route same-origin protection, alerts, sandbox coverage, additional
live providers, and stake expansion remain separately accepted only where their owning canonical modules and
recorded decisions say so. Roadmap placement grants none of that authority.

<a id="req-delivery-phase-5"></a>

### Phase 5 — Portability and deployment hardening

Repository interfaces may move durable data to database-backed implementations without changing domain semantics.
A stateless host remains read-only and bounded: it cannot collect, reconcile, execute, mutate ledgers, or hold funded
credentials. Durable worker/queue, backup/restore, authentication, and deployment hardening must preserve the same
owner, authority, atomicity, and fail-closed boundaries as local operation.

<a id="req-delivery-acceptance"></a>

## 11. Initial acceptance criteria

1. The landing page lists every currently discoverable supported initial market without hardcoded probabilities.
2. Each card separately shows venue probability, model probability, edge, confidence, close time, chart, and action.
3. A drill-down exposes the initial factor set and marks unavailable seasonality or source data honestly.
4. Refresh updates server data and local cache; stale use is visible.
5. An upstream partial failure degrades locally rather than producing invented values.
6. Production build, TypeScript, lint, and the required test suite pass.
7. Every qualifying active-policy expected-value update is durably recorded at most once per provider
   variant/contract/15-second bucket with selected side and side-specific actionable prices; legacy rows remain
   immutable and version-labeled.
8. Final venue outcomes resolve records without altering the original forecast snapshot.
9. Accuracy excludes pending/invalid records and reports sample size beside every metric.
10. A $100 total budget with a $1 all-in purchase size never spends more than $1 on principal plus fees; reservation
    does not change equity, and unused maker reserve returns without changing P&L.
11. New paper orders are blocked while unconfigured, depleted, stale, duplicated, disconnected, underfunded, too
    wide, too near close, above exposure limits, or unable to buy the venue minimum quantity.
12. Budget configuration, control-state transitions, reservations, settlements, and rejected resumes are durably
    audited.
13. Live placement remains impossible until the provider × market capability, account readiness, arming, budget,
    reconciliation, identity, freshness, and every funded guard independently pass.
14. A stateless deployment can publish only bounded sanitized paper projections and possesses no funded write or
    credential authority.

Implementation completion is reported only in [`STATUS.md`](../STATUS.md). Passing these criteria does not by itself
arm automation, promote a provider/model/policy, increase capital, or authorize deployment.
