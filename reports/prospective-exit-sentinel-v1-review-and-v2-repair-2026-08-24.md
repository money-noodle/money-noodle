# Prospective exit-sentinel v1 review and v2 evidence repair — 2026-08-24

## Decision

Do not change `strict-value-v1`. Preserve the four prospectively committed candidate rules and start a new
`exit-policy-sentinel-v2` evidence generation after repairing cohort identity, path coverage, and paper IOC
scoring. V1 remains immutable diagnostic evidence and is not pooled with v2.

## Inputs and method

The 2026-08-24 read used all 429 durable records in the v1 exit-sentinel snapshot and journal. Results were
recomputed through `buildExitPolicySentinelReport`, scoped to active buy-policy v22 and active live entry
execution v6. Because the paper identity defect stamped the shared live route identity, the paper diagnostic
explicitly selected that incorrectly stamped v6 cohort instead of the current paper-generation identity.

Rows were clustered by settlement window. Candidate results include every complete-path production position,
with first-to-fire winning. Live candidate sales use the documented optimistic executable-bid assumption. V1
paper candidate sales also assumed complete execution at that bid; that is a defect, not exact IOC evidence.

## V1 findings

The active live cohort contained 150 resolved positions, but only 38 positions across 34 independent windows
passed the 20-second path rule: 25.3% coverage versus the committed 90% requirement.

| live candidate | triggers | divergent windows | incremental cash | clustered incremental return |
| --- | ---: | ---: | ---: | ---: |
| `strict-value-margin3c-v1` | 12 | 6 | +27.4206¢ | +1.89% ±7.03pp |
| `strict-value-margin5c-v1` | 8 | 6 | +82.6416¢ | +8.06% ±5.02pp |
| `strict-value-confirm2-v1` | 9 | 5 | −53.4714¢ | −5.77% ±3.97pp |
| `trailing-50-35-v1` | 4 | 9 | −21.3124¢ | −2.65% ±10.77pp |

The corrected-identity paper diagnostic contained 158 resolved positions, of which 39 positions across 34
windows passed the path rule: 24.7% coverage.

| paper candidate | triggers | divergent windows | incremental cash | clustered incremental return |
| --- | ---: | ---: | ---: | ---: |
| `strict-value-margin3c-v1` | 12 | 6 | −23.0170¢ | −2.52% ±6.27pp |
| `strict-value-margin5c-v1` | 7 | 11 | +48.2630¢ | +4.61% ±4.50pp |
| `strict-value-confirm2-v1` | 10 | 5 | −20.5650¢ | −1.97% ±1.86pp |
| `trailing-50-35-v1` | 5 | 11 | −71.8480¢ | −4.41% ±10.70pp |

No candidate reached 60 windows, 20 divergent windows, 90% path coverage, or a Holm-corrected positive lower
bound. The 3¢ arm also disagreed in sign between tracks. The 5¢ arm was positive in both diagnostics but remained
far below the evidence lock and was scored under the defective paper full-fill assumption.

## Defects established

1. `exitPolicySentinelFromOrder` preferred `entryExecutionDecision.policyVersion`, the shared route identity,
   over `entryDecision.executionPolicyVersion`, the immutable per-track execution generation. The authenticated
   performance report therefore showed zero active paper positions despite 158 paper records in the cohort.
2. `maintainExitPolicySentinels` ran before the current lifecycle observation. Resolution could become durable
   before the final observation, while routine successful worker cycles also exceeded the fixed 20-second gap.
   The rule measured elapsed scheduler timing rather than actual evaluator opportunities.
3. V1 candidate P&L used full `netLiquidationCents` at the best bid. Production paper exits use
   `immediateSellFill`, including displayed depth, no-fill, partial-fill, and charged taker fees. The report's
   “exact simulated execution” label was therefore unsupported.
4. The report's `reviewUnlocked` field enforced counts and coverage but not the documented positive-cash,
   Holm-corrected lower-bound, or cross-track sign requirements.

## V2 repair

The approved v2 design is recorded in
[`docs/positive-edge-execution-exit-sentinel-design.md`](../docs/positive-edge-execution-exit-sentinel-design.md).
It starts separate v2 snapshot/journal files, preserves the four candidate rule identities, enrolls every new
filled edge position independently of first-quote availability, records explicit observed/unavailable evaluator
cycles before resolution, stamps the correct per-track generation, and scores paper triggers from the existing
reduce-only IOC depth model. A paper trigger with missing executable-depth evidence is incomplete rather than
invented. Live remains optimistic and separately labelled.

The review lock now requires the original counts and coverage, positive cash and clustered mean, one-sided Holm
family-wise significance across all four arms, and simultaneous positive eligibility in live and paper.

## Caveat and authority

The dominant caveat is that only about one quarter of v1 positions passed its path rule and v1 paper exits did
not model executable depth. These diagnostics cannot authorize a policy change. V2 changes only evaluation
collection and reporting; production exit policy, reduce-only order behavior, sizing, exposure, budget, and
reconciliation remain unchanged.
