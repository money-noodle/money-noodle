# Forecast candidate Phase 2 wiring review — 2026-08-25

> **Finding:** the predeclared 10-window wiring milestone passed with exact production replay and a complete
> six-arm family. This is an infrastructure result, not candidate-performance evidence. Phase 2 continues
> unchanged; Phase 3 does not start, and no forecast, policy, execution, capital, or promotion state changes.

## Question and fixed read

Does prospective `forecast-candidate-registry-v1` evidence satisfy the Phase 2 activation-smoke requirements in
[`docs/forecast-model-and-evaluator-v3-design.md`](../docs/forecast-model-and-evaluator-v3-design.md) §4.3: exact
identity, no missing arm, and exact production replay over at least ten independent settlement windows?

The review reran:

```bash
npm run analyze:forecast-candidates
```

The analyzer reloaded durable forecast history at **2026-08-25T14:43:42.187Z**. The prospective clock is the
precommitted activation time **2026-08-25T03:17:17.456Z**. UTC contract close is the unit of independence. Rows
before activation are excluded; candidate absence remains in the denominator.

The caveat that most threatens interpretation is maturity: only **45 closed windows** exist, and Phase 2 does not
yet have evaluator-v3 policy-complete paired return or simulated-execution evidence. This review deliberately does
not rank the six arms.

## Wiring evidence

| Measure | Result |
| --- | ---: |
| Prospective rows | 5,169 |
| Closed rows | 5,058 |
| Observed UTC close windows | 46 |
| Closed UTC close windows | 45 |
| Rows carrying the complete six-arm family | 5,169 / 5,169 |
| Maximum production replay error | 0 |
| Production-control scoreable closed rows | 4,835 / 5,058 (95.59%) |
| Minimum candidate availability | 100.00% |

Every registered arm was present on every prospective row. Candidate availability was 100%; the smaller 95.59%
production scoreable denominator reflects funded-provider actionable/outcome availability and is not a missing-arm
error. Production replay was exactly equal rather than merely within tolerance.

Qualified-row counts were 623 for production, 592 for `basis065-slow050-v1`, 627 for
`settlement-average-v1`, 410 for `basis-only-v1`, 518 for `basis-intraday-v1`, and 496 for `slow-half-v1`.
Those differences show that the family is non-inert, but they are not efficacy comparisons: counting survivors
without scoring every settlement window would be selection bias.

## Milestone disposition

| Phase 2 gate | State | Reason |
| --- | --- | --- |
| 10-window activation smoke | **passed** | 46 observed windows; complete family on 5,169/5,169 rows; replay error 0 |
| 100-window coverage review | **closed** | 45/100 closed windows; 95.59% production scoreable coverage |
| 300-window phase exit | **closed** | 45/300 closed windows; latency/non-interference review still required |

Passing the smoke milestone authorizes only continued untouched collection. It does not authorize a candidate
selection, parameter change, Phase 3 activation, evaluator-v3 activation, or confirmed-signal collection.

## Decision and next review

Continue the immutable six-arm Phase 2 cohort. At 100 closed windows, report every unavailable class and require at
least 95% scoreable production-control coverage. At 300 closed windows, require at least 90% availability for every
retained candidate and a written production-latency/output non-interference review before Phase 3 can be proposed.
Elapsed time and favorable interim rows never substitute for those gates.
