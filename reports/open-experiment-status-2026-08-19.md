# Open experiment and sentinel status — 2026-08-19

> **No production policy, execution style, stake, or live authority is changed by this review.** It reads
> the durable local stores at 2026-08-19T01:44:04Z, reruns the named read-only analyses, and compares their
> claims with the active symbols. Live and paper remain separate; uncertainty is clustered by settlement
> window where the underlying report supports it.
>
> The caveat that most threatens the review is recency: buy policy v21 had run for about one hour. Its
> operational counts can expose a wiring disagreement, but its returns cannot establish economics.

## 1. Operating snapshot

`data/trading-control.json` reported active live mode, 1,610¢ available, 0¢ reserved, and −390¢ current-epoch
whole-cent P&L. The ledger had no open, pending-reservation, or uncertain entry. Lifetime exact reporting
P&L was −124.14¢ on 28,855.67¢ for 567 settled live edge entries and −2,242.36¢ on 47,984¢ for 945 settled
paper edge entries. These are different accounting views and are not combined.

The collector was current, but the Next development server occupied about 3.7 GB RSS. RSS is not retained
heap and development mode carries compiler/cache overhead; it nevertheless disagrees materially with the
70 MB post-sharding RSS previously recorded in `STATUS.md` and needs a like-for-like profile before the
residency issue can be called closed.

## 2. v21 does not execute what its prose says

`MONEY_NOODLE_ENTRY_EXECUTION_MODE=taker` does not mean unconditional taking in
`evaluateEntryExecutionPolicy` (`src/lib/entry-execution-policy.ts`). Both `adaptive` and `taker` execute the
recommendation after the same edge, median-edge, quality, spread, sample, and advantage gates; a failed gate
still executes as maker. Paper remains the independent managed-maker lane.

A policy-aware reconstruction from forecast history found 43 v21 decisions admitted, 35 satisfying the
current 2-over-15-second persistence requirement, 15 matched live orders, and 6 fills. The order ledger held
18 live v21 orders: 13 labelled taker (4 fills) and 5 labelled maker (2 fills). Paper held 17 orders and 7
fills, all through its managed-maker path. Thus the claims "every accepted decision fills at the ask" and
"100% fills" in `STATUS.md` and the v21 entry in `src/lib/policy-manifest.ts` are false descriptions of current
behavior.

The checked-in `scripts/analyze-execution-gap.mjs` also still required 3 observations over 30 seconds for
v21 and inferred gate changes from timestamps. The accompanying change makes requirements explicit by
stamped policy identity and fails unknown policies closed.

**Decision made later on 2026-08-19:** the maintainer chose selective `adaptive`, not unconditional taking.
The initial `maker-taker-adaptive-one-miss-fallback-v2` restored the six strict attempt-1 thresholds and
permitted one sequence-local capped taker fallback only after an authoritative maker zero-fill, two new
post-completion qualifying snapshots over 15 seconds, and the four absolute edge/median/quality/2¢ spread
gates. A later same-day maintainer decision produced `maker-taker-adaptive-one-miss-slippage1c-v3`: permit
at most 1.0¢ ask movement before signed submission, re-run the applicable gates on the fresh quote, reserve
all-in cost at the worst allowed price, and distinguish pre-submit refusal from accepted IOC and rested
maker no-fills. See `docs/adaptive-entry-fallback-design.md`. These are explicit operator execution
decisions, not results this review's evidence authorized.

## 3. Prospective evidence lanes

### Persistence candidate

`buildPersistenceCandidateReport` (`src/lib/persistence-candidate-store.ts`) reported 28 current-policy intents
and zero incremental intents: v21 made the candidate identical to production. The detached maker observer
continues to make public requests, while the report deliberately summarizes observed fills only over the
incremental cohort and therefore displays zero current observations. The policy experiment is complete;
continuing it requires a new stated measurement or retirement.

### Edge-spike sentinel

`buildEdgeSpikeSentinelReport` (`src/lib/edge-spike-sentinel.ts`) reported 28 v21 samples, 23 resolved, with only
2 declined windows against the 60-window review bar. Admitted-minus-declined edge was +12.9pp with 32.6pp
standard error. Earlier policy cohorts cannot be pooled under the sentinel's version-scoping rule. No gate
change is authorized.

### Adaptive regime gate

`getRegimeGateStatus` (`src/lib/regime-gate-store.ts`) reported 4/12 resolved v21 windows, +3.0pp weighted edge
with 21.3pp standard error, and 44.4% confidence of negative return. It was warming and permissive, as
specified.

### Calendar evaluation

`buildCalendarEvaluationReport` (`src/lib/calendar-evaluation-store.ts`) reported 5 current-policy windows, 4
resolved candidate windows, and one date. The bars remain 30 dates and 100 candidate windows per time band,
plus 12 weekday occurrences and 100 candidate windows per weekday. Neither review is close to unlocked.

### Walk-forward model

The latest durable run was `walk-forward:875:fnv1a-27542176`, generated 2026-08-18T22:00:08Z. Over 438 test
windows, candidate mean window return was +5.75% against baseline +2.37%; it beat baseline in 5/5 folds but
was positive in 3/5 and the modal parameters appeared in 3/5. The recorded decision `baseline_retained`
therefore stands. The still-missing execution arm and promotion criteria in `STATUS.md` prevent promotion.

### Profit-reversal exit

`npm run analyze:exit-counterfactuals` on 2026-08-19 measured authoritative live profit-reversal EXIT versus
HOLD at −192.9% ±81.5pp standard error over 9 positions in 8 windows; paper was −10.1% ±29.3pp over 37
positions in 23 windows. Strict-value EXIT versus HOLD remained positive on both tracks. The local
profit-reversal execution flag should remain disabled; this does not establish permanent refutation.

## 4. Long-shot program

The active local policy is `long-shot-round-trip-buy12-sell97-win600-v1`, paper enabled and live disabled.
The committed status and report mostly describe 10¢→90¢. The 12¢→97¢ cohort was selected from the same
50-cell retrospective fine-path sweep it is meant to follow prospectively, so it is a collection candidate,
not a promoted result.

`npm run analyze:long-shot-fine-marks` measured the retrospective 12¢→97¢/600s cell on 149 fine-path entries:
9.4% touch, 0.83 touch/break-even ratio, +9.0% ±46.3pp sell-at-mark return, and +11.5% ±47.3pp hold return.
The current forward ledger held 8 resolved paper attempts in 4 settlement windows, all losses: −402¢ on
402¢, no mark exits, against the 60-attempt first-review bar. This sample is operational telemetry only.

`long-shot-hold-v1` has zero records under the current policy despite those eight executions. Its store ends
with prior 10¢→90¢ and 40¢ configurations. Until current-policy trigger capture is fixed, the prospective
hold-versus-exit review cannot accrue.

Fine-path coverage now includes 562 settled windows at a mean 266 samples per window, clearing the previous
"few hundred" revisit trigger. The only displayed fine-path ratio above one remained the early ≤10¢ cohort;
its interval included zero and its exit arm trailed hold. Finer sampling did not authorize a mark.

The near-money sentinel had 51 positions in 27 prospective windows. Hold returned −19.5% ±11.1pp standard
error; the best displayed stop arm, 5¢ below entry, returned −14.8% ±7.7pp. There are five stop comparisons,
and stop fills are optimistic. Nothing is authorized. The separate quiet-market sentinel remains unstarted.

`npm run analyze:long-shot-roundtrip` produced its path tables and then failed in the ledger section with
`ReferenceError: readFile is not defined`. The accompanying change restores that import.

## 5. Maker evidence

`npm run analyze:maker-fills` covered 2,229 windows. Touch-model post-fill drift remained indistinguishable
from zero across depths and horizons; at 120 seconds the reported adverse drift was about −0.30¢ to −0.33¢
with 0.39–0.42¢ standard error. It still cannot distinguish a touch from queue consumption.

The bounded depth file contains 10,448 rows over 447 asset-contract windows and 64 settlement windows from
2026-08-18T03:11:41Z to 19:47:55Z. The standalone process is no longer running. Its compact persisted rows
omit `takerSide`, although `fetchKalshiTradePrintsSince` provides it. As a result, the experiment counts all
prints through a selected-side bid even though only the opposite-outcome taker consumes that bid; one print
can be credited to both sides. An ad-hoc replay's 93.3% upper-bound fill rate and −0.23¢ ±0.17¢ 60-second
drift are therefore not decision-grade. Persist direction under a new schema before rerunning.

## 6. Storage verification

The active shard index at 2026-08-19T01:25:08Z listed 58,360 rows, 632 open rows, and 12 shards. The first
run of `npm run verify:forecast-storage` returned `ok: true` over 52,417 rows and 10 shards because the script
still replayed the frozen coexistence snapshot plus the current journal. It verified the migration input it
was written for, not the active sharded layout.

The accompanying correction makes the default command verify the reader's actual composition: indexed
sealed shard and rollup hashes/counts, the indexed open file, current journal replay, duplicate identity,
terminal/open separation, and direct full-history summary versus stored rollups plus current open rows. The
first corrected run passed over 58,756 current rows: 57,728 sealed, 1,028 current open, 12 shards, and 1,820
journal events. It is read-only and refuses `--write` against an active layout because only
`sealForecastStorage` under the forecast write lock may seal it.

## 7. What this authorizes

- Correct monitoring and status prose without changing execution.
- The funded maker/taker decision was subsequently recorded as selective adaptive v2 and then bounded-quote
  v3; measure each stamped cohort separately and do not describe either as evidence-promoted.
- Treat the current long-shot settings as a new paper collection cohort, not evidence-backed promotion.
- Retire or redesign completed/invalid collectors before spending more venue request budget.
- No stake expansion, model promotion, edge-spike re-arm, profit-reversal enablement, or long-shot live enablement.
