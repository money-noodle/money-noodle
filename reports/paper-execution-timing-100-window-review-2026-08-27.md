# Paper execution timing F2 100-window review — 2026-08-27

> **Initial finding:** F2 crossed its predeclared count and coverage gates with 163 exact maker pairs across 117
> independent close windows and complete timing evidence, but five ordinary-control rows consumed public trade
> batches whose last venue event time was after the fixed 12-second horizon; two became paper fills.
>
> **Approved disposition:** The maintainer subsequently approved the pre-outcome horizon rule as a deterministic
> availability filter. Excluding all five affected rows retained 303/308 records (98.38% coverage), 159 exact maker
> pairs, and 115 independent exact-maker windows. The corrected 100-window milestone therefore passed. Neutral v7
> repairs the runtime prospectively; v6 history is unchanged and retained evidence carries only under the exact-
> equivalence and generation-stratification rules in the accepted design §4.4. F3 remains off, no timing candidate
> is adopted, and no funded rule changes.

## Question and fixed method

This review follows
[`reports/paper-execution-timing-10-window-review-2026-08-25.md`](paper-execution-timing-10-window-review-2026-08-25.md)
and asks whether `paper-execution-timing-shadow-v1` clears the 100 exact-maker-window milestone in
[`docs/paper-execution-fidelity-v2-design.md`](../docs/paper-execution-fidelity-v2-design.md) §4.3.

The prospective clock began at **2026-08-25T06:47:41.724Z**. The fixed read ran at
**2026-08-27T02:16:57.962Z**:

```bash
npm run analyze:paper-execution-timing
```

The analyzer reloaded `data/paper-execution-timing-shadows.journal.jsonl` and the execution ledger without writing
`data/`. It joined live state afterward by exact prospective mirror-pair identity, required maker route and exact
requested quantity for the milestone denominator, clustered by UTC close, and compared every consuming public
trade batch's venue event time with the immutable `restingUntil` boundary. The analyzer was corrected in this
review because its prior readiness flag counted every paper window rather than exact paired-maker windows and did
not audit the ordinary control's horizon.

The caveat that most threatens the detailed five-row count is evidence granularity: ordinary paper observations
retain a consuming batch's first and last venue timestamps and aggregate quantity, not every print identity. A batch
whose last timestamp exceeds the horizon proves that post-horizon evidence entered the queue calculation, but does
not identify the exact post-horizon quantity when the batch straddles the boundary. The two affected fills are
stronger: each fill-adding batch retained one consuming print and its first and last timestamps were both after the
horizon.

## 1. Count, identity, and coverage gates passed

| Measure | Fixed result |
| --- | ---: |
| Timing records / expected paper makers | 308 / 308 |
| All paper close windows | 125 |
| Known exact live pairs | 163 |
| Exact same-route, same-quantity maker pairs | 163 |
| Independent exact-maker close windows | 117 |
| Route or quantity exclusions | 0 |
| Missing / pending / ambiguous live pairs | 145 / 0 / 0 |
| Acceptance evidence | 308 / 308 |
| Grace evidence | 308 / 308 |
| Candidate unavailable / incomplete rows | 0 / 0 |

The numerical 100-window and 95% coverage requirements were met. Missing live counterparts do not enter the exact
pair denominator and are not treated as live refusals. Coverage alone cannot pass an execution invariant.

## 2. The acceptance candidate preserved accepted orders but missed most create races

| Public candidate / later live target | Count |
| --- | ---: |
| Candidate accepted / live accepted | 139 |
| Candidate accepted / live non-accepted | 23 |
| Candidate race / live accepted | 0 |
| Candidate race / live non-accepted | 1 |

All 139 accepted live targets were classified accepted, so accepted recall was 100% in this cohort. Only one of 24
pooled non-acceptances was classified as a race. The live non-acceptance reasons were:

- 14 post-only acknowledgement races;
- five `market_not_found` responses later reconciled absent;
- four other rejections; and
- one reconciled absence.

On the clean post-only target alone, the candidate detected **1/14 races (7.14%)** and falsely accepted 13. The
other ten non-acceptances are not all outcomes a public quote model is intended to predict, so the pooled 4.17%
race recall is not a clean estimate. Fourteen observed create races also remain below the precommitted phase-exit
minimum of 30. These results do not authorize changing the frozen 400ms/250ms candidate after inspection.

## 3. The grace exposed a real control-boundary defect

The three-second grace remained classification-only; it did not extend executable time. It produced three replay
differences:

| Difference | Rows |
| --- | ---: |
| Recovered an in-horizon fill absent from ordinary control | 1 |
| Removed an ordinary-control fill | 2 |
| Total differences | 3 |

Both removed fills came from ordinary-control trade evidence timestamped after `restingUntil`:

- `paper:DOGE:DOWN:2026-08-26T13:00:00Z:episode:2` consumed one print 540.678ms after the horizon, filled 0.56
  contracts, and later recorded −27¢ whole-cent P&L.
- `paper:BNB:UP:2026-08-27T00:00:00Z:episode:2` consumed one print 13.528ms after the horizon, filled 0.50
  contracts, and later recorded +21¢ whole-cent P&L.

Three additional no-fill rows consumed batches whose last event was 243–561ms after the horizon. Those batches did
not add a fill, but they still entered queue depletion after executable time. Across the two manufactured paper
positions, durable whole-cent P&L was net **−6¢**; no-fill means zero spend and zero P&L, not a losing trade. This is
an accounting impact description, not permission to rewrite either immutable order.

The source mechanism is direct: `simulateManagedPaperMaker` bounds the number and spacing of reads but
`applyTradePrintsToPaperQueue` enforces only the lower acceptance timestamp. It does not reject a venue event after
`restingUntil`. A final read can therefore observe and apply a print created just after the 12-second boundary.
That contradicts the fixed horizon in `spec/trading-risk-and-budget.md` req-trading-paper-engine and the execution
invariant in the accepted paper-fidelity design §2 and §4.2.

## 4. Timing remained observational

| Measure | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Create public-read latency | 76ms | 198ms | 789ms |
| Acknowledgement public-read latency | 75ms | 184ms | 325ms |
| Create schedule lateness | 2ms | 97ms | 191ms |
| Acknowledgement schedule lateness | 2ms | 108ms | 257ms |
| Final-grace schedule lateness | 2ms | 152ms | 410ms |

No acceptance or grace row was stored unavailable or incomplete; the corrected analysis separately makes the five
post-horizon control rows unavailable without rewriting their stored events. This review did not establish absence
of production latency or rate-limit effects; that remains a manual 300-window phase-exit check. The observer remains detached from
paper status, bankroll, policy, live orders, and reconciliation.

## Gate disposition and next decision

| F2 gate | State |
| --- | --- |
| 100 exact-maker-window count | **passed**: 117 windows |
| At least 95% control/timing coverage | **passed**: 100% |
| Deterministic post-horizon availability filter | **passed**: five rows excluded regardless of outcome |
| Retained 100-window count / 95% coverage | **passed**: 159 pairs, 115 windows, 98.38% row coverage |
| At least 30 observed live create races | **closed**: 14 |
| 300 exact-maker-window phase exit | **closed**: 115 |
| F3 activation | **blocked** |

Under the subsequently approved availability correction, the 100-window milestone passes while the full phase
remains closed. Neutral v7 prospectively filters ordinary paper prints by the exact inclusive `restingUntil`
event-time boundary and pins the boundary in pure tests. V6 history remains immutable. A v6 timing row carries
forward only when every state-changing consuming batch ends on or before the horizon, which proves this repair
would remove no input from that row; reviews show v6 and v7 strata before combined totals. This narrow equivalence
does not authorize pooling queue calibrations or execution economics. No live order, forecast, entry policy,
sizing, capital ceiling, or reconciliation rule changes.

## Implementation and activation

The approved repair uses `paper-managed-execution-route-ioc-requalify3-calibrated-v7` with neutral
`queueClearFraction = 0`. Venue timestamps are parsed to safe-integer microseconds so a print one microsecond after
the millisecond-aligned boundary fails closed rather than being truncated onto it. Pure tests pin the opening and
closing boundaries, one-microsecond overflow, malformed timestamps, exact retained-row equivalence, neutral queue
arithmetic, and the detached grace replay. The first future calibration adoption is reserved for v8.

The final build passed specification/design/status/agent verification, typecheck, lint with pre-existing warnings,
1,023 tests, and the production build. Neutral v7 activated only after the funded lifecycle reached zero positions
and reservations. Startup full reconciliation completed READY at **2026-08-27T02:44:52.760Z** with no blockers;
a separate read returned neutral v7 as the active paper calibration. Historical v6 rows and the two affected P&L
entries were not rewritten.

Nothing in this report is financial advice.
