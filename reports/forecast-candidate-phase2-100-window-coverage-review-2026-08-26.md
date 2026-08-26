# Forecast candidate Phase 2 100-window coverage review — 2026-08-26

> **Finding:** the precommitted Phase 2 coverage milestone passed with 104 closed UTC settlement windows,
> 95.34% funded-provider outcome coverage, a complete six-arm family on every prospective row, and zero production
> replay error. The only unavailable class was missing funded-provider contract provenance at issuance. This is a
> coverage result only: no candidate was ranked, Phase 3 did not start, and no forecast, entry, execution, capital,
> accounting, or promotion state changed.

## Question and fixed read

Does prospective `forecast-candidate-registry-v1` evidence satisfy the 100-window coverage milestone in
[`docs/forecast-model-and-evaluator-v3-design.md`](../docs/forecast-model-and-evaluator-v3-design.md) §4.3: at
least 100 independent settlement timestamps, at least 95% scoreable production-control coverage, and an explanation
for every unavailable class?

The review reran:

```bash
npm run analyze:forecast-candidates
```

The analyzer reloaded durable forecast history at **2026-08-26T05:27:33.326Z**. The prospective clock remained the
precommitted activation time **2026-08-25T03:17:17.456Z**. UTC `closesAt` was the unit of independence, as required
by [`spec/forecasting-and-evidence.md`](../spec/forecasting-and-evidence.md) §3.6b and the accepted design. Rows
before activation were excluded. Repeated calculations and correlated assets sharing one close did not increase the
window count. Candidate absence and unavailable funded-provider outcomes remained in their row denominators.

The analysis was an infrastructure and coverage audit. It did not inspect or compare candidate return, Brier score,
log loss, drawdown, or execution outcomes. The caveat that most threatens interpretation is that coverage cleared
its 95% floor by only **0.34 percentage points**, and candidate collection cannot reveal settlement windows the
collector never observed.

## Auditable cohort

| Measure | Result |
| --- | ---: |
| Prospective rows | 11,398 |
| Closed rows | 11,303 |
| Observed UTC close windows | 105 |
| Closed UTC close windows | 104 |
| Rows carrying the complete six-arm family | 11,398 / 11,398 |
| Candidate-available closed rows, each arm | 11,303 / 11,303 (100.00%) |
| Production-control scoreable closed rows | 10,776 / 11,303 (95.34%) |
| Scoreable closed windows | 104 / 104 |
| Maximum production replay error | 0 |

Every registered arm was present and available on every prospective row. Production replay was exactly equal, not
merely within the `1e-12` tolerance. All six arms therefore had the same 10,776 scoreable rows and 104 scoreable
windows. That common denominator is evidence about collection integrity, not evidence that any arm is better.

## Unavailable classes

The analyzer now reports candidate unavailability separately from same-provider outcome scoreability rather than
leaving the 4.66% gap implicit.

| Class | Rows | Windows | Interpretation |
| --- | ---: | ---: | --- |
| Candidate decision missing or unavailable | 0 | 0 | The six-arm family was complete and available. |
| Funded-provider contract provenance unavailable at issuance | 527 | 100 | No same-provider contract identity existed from which to resolve an outcome; the rows remained unscoreable rather than borrowing another provider's result. |
| Funded-provider outcome unavailable despite contract provenance | 0 | 0 | Every closed row carrying funded-provider provenance had its eventual same-provider outcome. |
| Funded-provider cardinality not exactly one | 0 | 0 | The generation retained its declared single-funded-provider boundary. |

The 527 unavailable rows were spread across 100 settlement windows, but every one of the 104 closed windows also had
at least one scoreable row. This is row-level provenance coverage, not 100 wholly missing windows. Treating a nearby
provider contract or another asset's shared settlement result as a substitute would violate exact-provider outcome
identity, so those rows correctly stay unavailable.

## Milestone disposition

| Phase 2 gate | State | Reason |
| --- | --- | --- |
| 10-window activation smoke | **passed previously** | Complete family and exact replay; documented in the wiring review. |
| 100-window coverage review | **passed** | 104 closed windows; 95.34% production scoreable coverage; every unavailable class explained. |
| 300-window phase exit | **closed** | 104/300 closed windows; the required production-latency/output non-interference review has not occurred. |

Passing this milestone authorizes only continued untouched Phase 2 collection. Under
[`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md) §12.5, prospective collection and a
sample count do not create promotion authority. Production remains Blend 0.4, the candidate registry remains
observation-only, and neither Phase 3 uncertainty-input collection nor confirmed-signal collection starts.

## Next review

Continue the immutable six-arm cohort to 300 closed windows. The phase-exit review must require at least 90%
availability for every retained candidate and must test whether collection changed production latency or output.
Only a written phase-exit decision may propose Phase 3 activation; elapsed time, candidate qualification counts, or
interim efficacy figures cannot substitute for that gate.
