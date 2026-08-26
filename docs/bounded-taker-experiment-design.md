# Bounded taker execution pilot

> **Document type:** Execution design
> **Design status:** Retired
> **Implementation:** Complete
> **Created:** 2026-08-24
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260824-01`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> Agreed with the maintainer on 2026-08-24 before implementation. The v1 pilot completed on 2026-08-25 at its
> compiled 10-authorization / 300¢ ceiling: three signed IOC submissions were accepted, no treatment safety stop
> occurred, and treatment-minus-control was negative with broad uncertainty in both live and paper. It closed
> without extension and with `reviewUnlocked: false`; see
> [`reports/bounded-taker-pilot-v1-closure-2026-08-25.md`](../reports/bounded-taker-pilot-v1-closure-2026-08-25.md).
> This changed funded execution and capital, not the shared buy rule. It was a deliberately small operational
> pilot, not a policy promotion and not evidence for an unconditional taker switch.

## 1. Decision and question

The active positive-edge strategy keeps its current buy policy, portfolio selection, sizing policy, high-edge
taker route, exits, and account controls. A single new execution generation randomizes a prospective subset of
first-episode, sub-30pp decisions that the incumbent execution policy would send to its managed maker:

- 25% receive one bounded taker IOC treatment;
- 75% remain on the incumbent managed-maker control;
- assignment is deterministic from an immutable intent identity and occurs before a refreshed quote or outcome
  is observed.

The pilot asks whether a signed IOC can reliably convert maker misses into executed positions without violating
money, venue, reconciliation, or operational controls. The retrospective ask replay motivates the question but
is not treated as executable evidence.

The new live execution identity is
`maker-high30-requalify3-fresh1c-bounded-taker-pilot-v7`. It is one production execution policy containing two
prospectively assigned arms, not a candidate buy policy and not a fourth trading lane.

## 2. Eligible population and assignment unit

A decision reaches assignment only after all incumbent entry, persistence, classified-path, adaptive-regime,
portfolio, funding, exposure, hourly filled-order, live-risk, and reconciliation checks have passed and an order
can be built. It must also satisfy all of the following:

1. strategy is `edge-binary-buy`;
2. venue is Kalshi;
3. it opens new exposure and is entry episode 1, not a protected switch, re-entry after a sold position, or a
   requalifying episode;
4. the v7 baseline route (which preserves v6 routing) is managed maker;
5. issuance net edge is below 30pp, so the incumbent sizing decision is the reduced-size arm;
6. the incumbent reduced-size cap is no greater than 30c—raising the configured base ticket cannot silently
   enlarge or create a mismatched control cohort;
7. that 30c-or-smaller taker reservation at the existing one-cent movement cap can fund the venue minimum.

Existing high-edge taker recommendations are excluded and continue unchanged. Later maker episodes continue only
for a control sequence; a treatment IOC fill, partial fill, accepted no-fill, or pre-submit refusal is terminal
under the existing taker semantics.

The assignment key is:

```text
bounded-taker-pilot-v1 | marketId | strategyId | symbol | side | closesAt
```

SHA-256 maps the key into 10,000 buckets. Buckets `[0, 2500)` are treatment and the remainder control. Execution
mode is deliberately absent, so the same live and paper intent receives the same arm. The key, bucket, arm,
baseline route, assignment time, authorization state, and cap are stamped durably before execution. No outcome,
refreshed quote, asset-specific result, or operator choice can change an assignment.

## 3. Treatment execution

Treatment uses the existing Kalshi `immediate_or_cancel`, `post_only: false`, marketable **limit** order. It is
never an uncapped market order.

1. Keep the incumbent reduced-size decision, then additionally cap the experimental all-in ticket at 30 integer
   cents.
2. Size quantity and conservative taker-fee reserve at the worst permitted price.
3. Refresh the exact signed contract quote immediately before submission.
4. Refuse unless the selected side still passes the active production venue buy rule at the refreshed ask,
   including the current 5pp net-edge floor, 75c price ceiling, confidence/side rules, and 10c production spread
   ceiling. The design names the current 75c ceiling rather than the obsolete 97c limit retained in superseded
   execution documents.
5. Refuse movement beyond one cent from issuance. The effective cap is the lower of issuance plus one cent and
   the active buy-policy price ceiling.
6. Submit at the refreshed ask only. Never chase another quote.
7. Confirm IOC terminal state and exact fill/fee terms through the existing funded path. Partial or ambiguous
   results retain the existing fail-closed reconciliation behavior.

The experimental treatment intentionally waives only the incumbent *execution-style* gates: 30pp current edge,
10pp persistence-median edge, and the 2c strict-taker spread ceiling. Retaining those gates would reproduce the
existing narrow high-edge route and would not test the admitted moderate-edge maker cohort. No buy rule or
account protection is waived.

## 4. Hard bounds and terminal conditions

All constants are compiled and immutable for v1; environment configuration cannot enlarge one. The exact typed
enablement is off by default.

| Bound | v1 value |
| --- | ---: |
| treatment assignment share | 25% |
| per-treatment all-in authorization | at most 30c |
| cumulative treatment authorization | at most 300c |
| treatment authorizations | at most 10 |
| all assigned live intents | at most 80 |
| treatment authorizations per rolling hour | at most 2 |
| treatment authorizations per correlated settlement timestamp | at most 1 |
| elapsed collection | at most 14 days from first live assignment |
| gross realized treatment losses | stop at 150 integer cents |

Authorization is counted from the issuance cap before venue I/O and is never returned to the pilot allowance,
even if the signed quote later refuses or the IOC receives no fill. This makes 300c a conservative upper bound on
what the pilot could lose if every authorization filled and settled worthless. Ordinary budget reservation still
returns unused account funds normally.

An assigned treatment blocked by the hourly or same-window pilot ceiling executes the incumbent maker and keeps a
`withheld` stamp for intent-to-treat reporting. Once a total, count, duration, loss, or safety boundary closes the
pilot, later orders use incumbent execution and are not enrolled.

Malformed pilot stamps or an inability to establish the durable cap state can never authorize a taker; incumbent
maker execution remains available if every ordinary production control is healthy. Any treatment-specific
transport, schema, cancellation, fill, or reconciliation ambiguity records a durable safety-stop reason and ends
v1. It cannot automatically re-arm after reconciliation or restart. Continuing requires a separately approved
new generation; journals and ledgers are never hand-edited.

## 5. Track separation

The shared entry rule remains untouched and continues to take no execution mode. For the same eligible intent,
live and paper receive the same deterministic arm.

- live control uses the real managed maker;
- live treatment uses the signed IOC described above;
- paper control uses its current independent managed-maker simulation and calibration;
- paper treatment uses the current displayed-depth IOC fill model;
- paper bankroll and live capital remain independent;
- a live capacity withholding may make live execute its control while paper still simulates the assigned
  treatment. That difference is stamped and is execution/capital, permitted by SPEC §12.3.

Neither track reads the other track's fill. Actual live, independent paper, and optimistic ask benchmarks remain
separate in every report.

## 6. Evidence and estimands

The assignment unit is the logical asset/side/settlement-window sequence. A control assignment owns the complete
incumbent sequence, including a later v7 maker requalification or ordinary high-edge route if episode 1 misses.
Treatment is terminal after its first IOC result. This compares “take the first admitted ask” with the incumbent
managed sequence rather than comparing isolated order rows.

Every assigned intent is scored, including quote refusals and no-fills as zero deployment. The report is split by
live/paper and includes:

1. actual production P&L per assigned settlement window, including the active exit policy;
2. exact P&L per issuance authorization cent and treatment-minus-control clustered difference;
3. fill rate and profitable-position rate per assigned intent;
4. authoritative hold P&L as a secondary entry-only view;
5. assignment, authorization, intended-route submission, acceptance, quote-refusal, IOC no-fill, partial-fill,
   and reconciliation/safety-stop counts; a treatment assignment withheld by a pilot ceiling reports its actual
   maker submission/acceptance in separate fields and can never increment the treatment IOC counters;
6. paper arms separately and identity-paired mirror rows where both exist;
7. exact cash, whole-cent control, and normalized clustered views without smoothing disagreement.

Settlement timestamp is the economic cluster. Assets, sides, spread bands, edge bands, and prices are descriptive
only. There is one frozen treatment; no post-result threshold or subgroup may be promoted from v1.

## 7. What v1 can authorize

V1 is an operational pilot. It can establish whether signed IOC authorization, execution, exact fee handling,
terminal confirmation, cap accounting, and reconciliation behave reliably, and whether enough actual fills exist
to justify a larger randomized test.

It cannot authorize an unconditional taker switch, a lower production threshold, a buy-policy change, or a stake
increase. No `reviewUnlocked` or automatic promotion state exists. If a larger efficacy test is proposed, it must
start under a fresh generation with its sample size, economic comparison, clustered correction, safety budget,
and promotion criterion committed before the first new assignment. V1 outcomes cannot be reused as untouched
post-commit efficacy evidence.

## 8. Storage and modules

The execution ledger remains the single account ledger. No experiment money ledger or independently mutable
counter is added.

- `lib/bounded-taker-experiment.ts`: pure assignment, bounds, arm application, state, and report;
- `lib/entry-execution-policy.ts`: v7 execution identity and bounded-treatment route type;
- `lib/paper-execution.ts`: live/paper integration, exact fresh-rule recheck, cap reservation, and durable stamps;
- `lib/types.ts`: append-only optional order provenance;
- authenticated `/api/performance`: read-only track-separated report;
- the existing execution ledger: authoritative order, authorization, fill, P&L, and safety-stop evidence.

Cap calculations include only live `edge-binary-buy` v1 stamps. Another strategy can neither consume nor replenish
the pilot allowance. Account-wide position, correlation, filled-order, cash, and reconciliation controls remain
shared across strategies.

## 9. Tests and deployment

Tests must pin:

- deterministic 25/75 assignment and absence of execution mode from the key;
- exact eligibility boundaries: strategy, first episode, baseline maker, sub-30pp, and feasible 30c reservation;
- every total, hourly, same-window, duration, and gross-loss boundary;
- malformed state failing toward incumbent maker, never taker;
- 30c per-order and 300c cumulative integer authorization at float edges;
- refreshed production buy-rule, 75c, 10c spread, and one-cent movement refusals;
- the intentional absence of the 30pp, 10pp median, and 2c execution-style gates on treatment;
- treatment terminality and unchanged control requalification;
- identical live/paper assignment with separate fill/capital results;
- strategy isolation and unchanged mirror-invariant arity;
- actual-versus-hold sequence reporting clustered by settlement window;
- treatment uncertainty recording a sticky v1 safety stop.

Deployment is two acts. Code first ships disabled and must pass typecheck, all tests, lint, and production build.
Arming then requires the exact typed environment confirmation, a build, manual quiescent pause/drain, zero
reservations, restart, authoritative startup reconciliation, and explicit Resume. The first treatment IOC is
inspected before the pilot is left unattended. V1 ends at a compiled boundary and cannot be extended by changing
an environment number.
