# Portfolio-selection evaluation design

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Not started
> **Created:** 2026-08-24
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260825-07`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Status:** Approved analysis plan, queued strictly after the venue-candidate final review in
> [`docs/venue-candidate-evaluation-design.md`](venue-candidate-evaluation-design.md). No new portfolio family or
> full-cycle journal is collecting. The existing `portfolio-choice-set-v1` issued-order integrity lane continues
> unchanged and cannot become promotion evidence for a later candidate. This document changes no forecast, buy
> policy, confirmation, venue candidacy, sizing, portfolio constraint, execution, capital, reconciliation, or live
> authority. Its final retained/promoted handoff is the prerequisite for the separately approved live-authorization
> reliability program.

## 1. Question

A mechanically usable venue candidate is still not permission to spend a shared account slot. Portfolio selection
must choose among opportunities arriving over time while preserving global exposure ceilings and leaving capital,
execution style, and live authorization with their existing owners.

The first question is an engineering one:

> Given the candidates and exposure production knew at that calculation, did its greedy algorithm choose the best
> feasible subset under production's own stated objective?

The economic questions follow only after that is answered:

> Do expected-profit ranking, static exposure groups, soft correlation penalties, and immediate use of capacity
> preserve more deployable portfolio value than predeclared alternatives?

The orchestration question is separate and equally important:

> When a provisional winner later fails asset, regime, funding, retry, or authorization checks, does production
> unnecessarily leave a usable slot empty instead of reranking the surviving candidates?

## 2. Current production boundary

Current `selectPortfolio` receives candidates with `id`, asset, UTC close, and expected profit cents. It receives
existing exposure only as asset plus UTC close. It repeatedly:

1. subtracts fixed cents for each existing position in the same settlement window and exposure group;
2. sorts by adjusted expected contribution, then standalone expected contribution and asset;
3. selects the first positive candidate that fits total-position, same-window, same-asset/window, and
   same-group/window ceilings;
4. adds that candidate to provisional exposure and rescans the remainder.

`expectedProfitCents` is the forecast-weighted payout less the provisional all-in reserved stake. It assumes the
provisional quantity is deployable; maker no-fill and fill-conditional adverse selection are measured later.
Portfolio selection is online: it sees candidates available now and does not know which candidates will arrive
later in the window.

Effective environment values are runtime evidence, not source-code defaults, and must be stamped on every row. At
the 2026-08-25 design read, the effective values were 6 total positions, 3 per window, 1 per group/window, and 1c
same-window plus 1c same-group penalties. Those values may change only through existing operator authority and do
not become constants in this evaluation. In that configuration, three groups multiplied by one position per group
already imply the three-position same-window ceiling, and the same-group soft penalty cannot independently select a
second same-group candidate because the hard limit refuses it first. Those are configuration-specific structural
findings, not permission to delete either control or assume it remains inert after a configuration change.

## 3. Measure classes and ownership

### 3.1 Safety and exposure ceilings

These protect a stated account-level contradiction or loss boundary and are validated with invariant, fault, and
scenario evidence rather than average-return promotion:

- the global maximum active-position ceiling across the shared account;
- refusal of additive same-asset/opposite-side exposure outside the reduce-only switch path;
- same-window and same-group/window hard ceilings;
- account-wide counting across strategies and providers;
- the per-placement recheck that includes exposure created earlier in the same drain;
- fail-closed treatment of malformed identity, stale state, or ambiguous exposure.

A hard ceiling may remain conservatively active without proving higher mean return. Loosening one requires a
separate capital and downside decision even if an economic candidate later wins.

### 3.2 Economic selectors

These choose among otherwise feasible candidates and require paired prospective return evidence:

- ranking by expected profit cents;
- static same-window and same-group cent penalties;
- the static `majors` / `layer1-beta` / `alt-beta` grouping;
- requiring positive adjusted expected contribution;
- greedy subset construction rather than exact optimization of the stated objective;
- immediate acceptance rather than a predeclared capacity-reservation price;
- direction-, quantity-, and stake-blind treatment of existing exposure.

An economic selector that cannot independently change a decision under the effective hard ceilings is inert. It
may remain a backstop but cannot be credited with measured economic protection.

### 3.3 Diagnostics

These are recorded and cannot authorize or refuse during attribution:

- exact optimum under production's own objective and constraints;
- production-versus-exact objective gap;
- cap, group, penalty, and positive-contribution bind rates;
- side-, quantity-, stake-, strategy-, provider-, market-, and close-aware exposure;
- joint settlement results and direction-aware net exposure;
- estimated opportunity cost of occupied capacity;
- candidates removed after provisional ranking and a surviving candidate that could have used the slot;
- fill/no-fill, partial fill, deployable contribution, cash use, and continuous drawdown;
- mathematically duplicate or redundant controls under the effective configuration.

## 4. Identity and causality

Every actionable candidate and outcome retains this tuple:

```text
strategyId
marketId
providerId
providerVariantId
contractRegistryId / exact contractId
symbol
side
closesAt UTC
```

Existing exposure additionally retains order identity, quantity, reserved stake, and status. One provider's fill or
outcome cannot resolve another provider's contract. Rows sharing `closesAt` are one independent settlement window.

Counterfactual arms are causal online policies. They may read only evidence available at that calculation and may
never use candidates that appeared later to improve an earlier decision. A hindsight best-of-window subset may be
reported only as a labelled upper-bound diagnostic, never as a tradable candidate or promotion comparator.

## 5. Relation to `portfolio-choice-set-v1`

The existing journal writes one immutable row after each durably issued live edge order. It tests whether the live
drain issued production's own preferred candidate conditional on issuance. It deliberately omits no-order cycles.
It remains useful as an execution-integrity sentinel and is not rewritten, backfilled, or widened. The fresh
2026-08-25T04:35:52Z replay contained 852 records, 851 scoreable records over 323 independent windows, zero
integrity failures, zero missing post-boundary edge orders, and zero issued-versus-production-preferred differences.
Both views returned +17.4%. Its main caveat is the boundary itself: it proves conditional issuance integrity but
cannot evaluate the ranking formula, no-order cycles, or unused capacity.

The new program needs a separate generation because it asks a different question. It records every distinct fresh
calculation where at least one exact venue candidate reaches portfolio consideration, including calculations that
issue no order. Explicit absence and every downstream refusal remain in the denominator. V1 rows may describe the
motivation and verify historical wiring; they cannot supply prospective outcomes for a family selected later.

## 6. Phase A — full-cycle exact-control attribution

Before testing another ranking rule, add an observation-only full-cycle record with:

- calculation time and complete exact candidate identities;
- all production candidate terms, sizing inputs, expected-profit terms, and effective constraints;
- complete account-wide exposure with side, quantity, reserved stake, strategy, provider, market, and status;
- production greedy scores, ranks, selected set, and every simultaneous refusal reason;
- asset, classified-regime, retry, funding, and authorization state before and after provisional selection;
- per-placement drain actions, reruns, skips, issued intents, and unused capacity;
- exact outcome plus separate ask-and-hold and deployable execution evidence when available.

The writer is detached and observation-only. Store or evaluation failure cannot delay, refuse, or authorize an
order. No report result may be imported by forecast, policy, persistence, venue construction, portfolio, sizing,
budget, reconciliation, or order modules.

Exact production control must match the current greedy selection on a pure grid and in live-runtime observations.
Configuration changes start a stamped effective-policy segment; they do not silently mix constraints.

## 7. Phase B — objective and orchestration diagnostics

Run these diagnostics on the complete prospective state without changing production:

1. **Exact production control:** current greedy algorithm and runtime constraints.
2. **Exact stated-objective solver:** enumerate every currently visible feasible subset and maximize production's
   exact adjusted-contribution objective. This tests algorithm fidelity, not a new economic objective.
3. **Eligibility-first reconstruction:** apply existing asset and classified-regime admission before the same
   production selection.
4. **Downstream rerank reconstruction:** after a provisional winner is removed by an existing later check, rerank
   the currently surviving candidates under unchanged production constraints.
5. **Hard-ceiling-only diagnostic:** retain every safety ceiling but remove soft penalties to measure whether those
   penalties independently select anything.

The exact solver is snapshot-local and cannot see future arrivals. The other reconstructions may identify a later
focused hypothesis, but their attribution outcomes are selection data and cannot promote that hypothesis.

The report separately states:

- greedy objective parity and any exact-solver gap;
- calculations and independent windows with a different subset;
- no-order calculations with a currently viable rerank candidate;
- effective-cap and penalty bind rates;
- controls that are mathematically redundant under each effective configuration;
- ask-and-hold value, deployable value, cash use, and drawdown without smoothing disagreements.

## 8. Phase C — focused prospective family

Only after the attribution report may an amendment freeze one small new-outcome family. Candidate areas, not
approved choices, are:

- production greedy versus exact optimization under the same objective;
- eligibility ordering and reranking after a downstream skip;
- hard ceilings with or without independently active soft penalties;
- side-, quantity-, or stake-aware exposure;
- an online capacity-reservation price based only on prior evidence.

The amendment declares every arm, parameter, material margin, downside ceiling, and family-wise correction before
new outcomes accrue. It holds the frozen upstream base, confirmation, venue-candidate rule, sizing, execution style,
fees, exits, and live authorization fixed. Sizing, switch, and maker/IOC alternatives remain separate families.

Each arm maintains its **own shadow portfolio and capacity state** from a common initial state. It cannot reuse
production exposure after its selections diverge. External exposure from strategies outside the evaluated family
is applied equally as exogenous account state. The signal lane treats a selected ask-priced position as occupying
its virtual slot through the declared terminal rule. The execution lane uses equivalent public maker/IOC evidence,
fees, exits, and fill/no-fill state; a confirmed no-fill does not become fictional exposure. Missing evidence is
`unavailable`, never a manufactured fill.

## 9. Milestones

| Milestone | Requirement | Nominal planning duration |
| --- | --- | --- |
| Safety and parity engineering | Pure fault/tie/boundary grid plus 25 live-runtime portfolio calculations with zero exact-control score, rank, set, or reason mismatch | Before evidence clock |
| Full-cycle smoke | 10 independent settlement timestamps; exact identity, effective constraints, all candidates, downstream state, issued/no-order result, and explicit absence complete | About 2.5 hours |
| Attribution coverage | 100 closed timestamps; at least 95% complete portfolio-decision/outcome coverage and 100% ledger coverage for issued edge intents in the generation; every unavailable class explained | About 25 hours |
| Objective/orchestration review | 300 closed timestamps and at least 100 windows with an exact-solver, eligibility-order, downstream-rerank, or independently binding-selector difference, or a documented inert/insufficient-activity finding | At least 75 hours; divergence may dominate |
| Focused-family signal readiness | New prospective cohort: 300 closed timestamps, at least 90% per-arm availability, and 100 materially divergent windows | At least another 75 hours |
| Focused-family execution readiness | 200 execution-scoreable timestamps, at least 90% public-evidence coverage, and 100 divergent windows | Multi-day to multi-week |
| One corrected review | Signal and execution lanes complete; declared family-wise correction, material margin, cash/downside checks, and safety scenarios pass | Manual, once |

A repeated calculation, asset, order, or row does not increase the independent-window count. If 100 divergent or
selector-changing windows do not occur, the result is `inert` or `insufficient selective activity`; elapsed time
never substitutes for the denominator.

## 10. Review and promotion boundary

The one final review scores every position, assigning zero when an arm declines, and clusters all assets and rows
inside UTC settlement window before uncertainty. It reports:

- signal-policy ask-and-hold return;
- simulated deployable return and coverage;
- exact solver objective gap;
- candidate-only, control-only, same-set, and different-set windows;
- capacity utilization, no-order rescue, turnover, and occupied stake;
- continuous cash return and drawdown;
- exact versus unavailable cohorts;
- all arms and the predeclared multiple-comparison correction.

A selection candidate must beat production in both the declared signal and execution comparisons without worsening
the declared cash/downside limits. A rule that loosens a safety ceiling additionally requires a separate exposure,
capital, and failure-scenario design; this portfolio review alone cannot authorize it. Counts, dates, a diagnostic
exact optimum, or a favourable hindsight upper bound never alter production automatically.

A successful review permits only a separate written policy/ownership proposal, version bump, immutable evidence
link, and manual promotion act. A null result retains production and is documented with the same care.

## 11. Serial placement

This program begins only after the venue-candidate final review freezes the exact candidate definition. A venue
change alters price, quantity, provider identity, and which opportunities reach portfolio selection; collecting an
unsettled portfolio family concurrently would invalidate both cohorts.

The serial handoff is:

1. freeze the base signal;
2. freeze confirmed signal;
3. freeze venue candidacy;
4. implement full-cycle portfolio parity and attribution;
5. report greedy fidelity, active/inert controls, and downstream unused capacity;
6. freeze at most one small portfolio family in a new cohort;
7. maintain independent causal shadow portfolios through signal and execution lanes;
8. perform one corrected review;
9. freeze the retained or separately promoted portfolio-selection definition;
10. only then permit the live-authorization parity phase in
    [`docs/live-authorization-evaluation-design.md`](live-authorization-evaluation-design.md) to start.

No observation phase starts automatically after a prior count. Each transition requires its written milestone
review and explicit approval.
