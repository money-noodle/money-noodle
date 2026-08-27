# Current roadmap

> **Status:** Non-normative planning projection · **Updated:** 2026-08-26
> **Current implementation:** [`../STATUS.md`](../STATUS.md) · **Canonical requirements:** [`../SPEC.md`](../SPEC.md)
> **Historical roadmap:** [`archive/roadmap-record-through-2026-08-26.md`](archive/roadmap-record-through-2026-08-26.md)

This file orders already accepted or explicitly deferred work. It does not authorize implementation, change
acceptance gates, or override `spec/*.md`. Proposed designs remain unapproved even when listed here. Resolve any
conflict in the canonical specification and decision record before coding.

## Active collection and review sequence

1. **Finish forecast-candidate Phase 2 unchanged.** The fixed 100-window coverage review passed on 2026-08-26;
   continue `forecast-candidate-registry-v1` to its precommitted 300-window phase-exit gate. Do not rank arms, start
   uncertainty work, or begin confirmed-signal collection early. The governing accepted design is
   [`forecast-model-and-evaluator-v3-design.md`](../docs/forecast-model-and-evaluator-v3-design.md).
2. **Repair the paper timing F2 control before further maturity claims.** The 2026-08-27 review passed 100-window
   count and coverage but found five rows consuming post-horizon evidence, including two manufactured fills. Review
   a prospective paper execution generation that enforces the exact inclusive 12-second cutoff, preserves v6, and
   restarts timing evidence without pooling generations. F3 remains off; the 300 exact-pair, 30-create-race,
   coverage, and non-interference gates remain binding. See
   [`paper-execution-fidelity-v2-design.md`](../docs/paper-execution-fidelity-v2-design.md).
3. **Continue maker-restriction v1 without tuning.** The fixed 20-live-divergence review completed on 2026-08-26
   without unlocking either arm. The joint live/paper, divergence, cash, clustered-return, and multiple-comparison
   gates remain binding; repeated interim looks cannot create promotion authority.
4. **Keep reasoned exit-v3 deferred.** Exit v2 conflates a known zero owned-side bid with missing evidence and its
   incomplete cohort is outcome-selected. Do not relabel history or score efficacy. No v3 design or implementation
   begins until the maintainer reopens it.
5. **Repeat fixed-UTC operational and economic monitoring.** Keep signal quality, fills, exits, exact P&L,
   whole-cent bankroll control, and paper/live fidelity separate. Correctness or safety contradictions are immediate
   investigations; negative return alone is not permission to tune.
6. **Run evaluator-v2 checkpoints only during planned paused/stopped maintenance.** Evaluator v2 remains
   monitoring-only, offline-only, and barred from promotion.

## Strict serial decision-layer program

Each layer starts only after the previous layer has frozen its retained or promoted generation. This prevents a
later cohort from silently changing population when an upstream probability, confirmation, venue, or selection
rule changes.

| Order | Layer | Current state | Governing design |
| ---: | --- | --- | --- |
| 1 | Base forecast signal | Phase 2 collecting | [`forecast-model-and-evaluator-v3-design.md`](../docs/forecast-model-and-evaluator-v3-design.md) |
| 2 | Confirmed signal | Queued; not started | [`confirmed-signal-evaluation-design.md`](../docs/confirmed-signal-evaluation-design.md) |
| 3 | Venue candidacy | Queued; not started | [`venue-candidate-evaluation-design.md`](../docs/venue-candidate-evaluation-design.md) |
| 4 | Portfolio selection | Queued; not started | [`portfolio-selection-evaluation-design.md`](../docs/portfolio-selection-evaluation-design.md) |
| 5 | Live authorization | Queued; not started | [`live-authorization-evaluation-design.md`](../docs/live-authorization-evaluation-design.md) |
| 6 | Attempt and outcome | Queued; not started | [`attempt-outcome-evaluation-design.md`](../docs/attempt-outcome-evaluation-design.md) |

No layer may gain order, budget, reconciliation, or automatic-promotion authority through its observer.

## Storage and operational durability

1. Add enforceable remote retention or a second independently verified bucket before any remote-primary eviction.
2. Implement the owner-aware tier catalog, dry-run deletion selection, verified hydration, and fail-closed restore
   semantics from [`object-storage-retention-and-disk-safety-design.md`](../docs/object-storage-retention-and-disk-safety-design.md).
3. Observe execution-ledger v9 under normal operation. Design compaction separately for each append-only
   observational journal; never generalize the ledger compactor or hand-truncate a journal.
4. Preserve frozen corrupt and superseded evidence until every owning semantic verifier and independent restore gate
   authorizes retirement.
5. Add operator alerts and strengthen deployment/runbook observability after the current safety and evidence work.

## Accepted work not yet scheduled

- Continue the accepted hourly threshold market after H1 public market data: design and activate H2 detached
  durable observation/outcome ownership, then freeze the complete H3 policy, persistence, paper accounting,
  settlement, budget, and target-integrity gates before enabling paper. Live capability remains a separate
  promotion. See [`second-market-hourly-crypto-design.md`](../docs/second-market-hourly-crypto-design.md).
- Verify the first organic live switch end to end without forcing one: reduce-only action, venue fills and fees,
  remaining quantity, reservation release, replacement withholding, and switch-versus-hold accounting.
- Continue prospective strict-value/profit-reversal and maker queue/depth evidence without reinterpreting historical
  cohorts or pooling execution generations.
- Add historical execution replay with explicit reconstructed assumptions, stronger same-origin protection on every
  mutation or billable route, dependency pinning, and credential/auth hardening.

## Explicitly deferred or blocked

- **Stake expansion:** blocked by negative current evidence and the complete capital/downside criteria; no single P&L
  view, fill count, or forecast score can authorize it.
- **A second live venue:** blocked until its exact adapter, eligibility, signing, target integrity, funding, order
  lifecycle, fills, reconciliation, and routing promotion are implemented and verified.
- **Remote-primary deletion:** blocked while the archive lacks enforceable retention or an independent replica and
  the tier catalog is absent.
- **Exit v3:** deferred by maintainer decision; no design clock has started.
- **Execution-engine separation and multitenancy:** remain Proposed in [`../docs/README.md`](../docs/README.md) and
  carry no implementation authority.
- **Noodle Land application work:** remains exploratory pending another design pass, specification decision,
  accessibility/comprehension review, and explicit implementation approval.

## Closed workstreams

Provider/policy attribution visibility is complete; durable policy lineage remains separate structural work. The bounded taker pilot and long-shot round trip are complete and retired. Their code or traffic must not be revived
through roadmap wording. Historical implementation and evidence remain in the status archives, design index, policy
history, and dated reports.
