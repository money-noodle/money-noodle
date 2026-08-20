# Money Noodle - Implementation Status

> Living status document. Updated 2026-08-20.
> Product requirements and architecture decisions live in [SPEC.md](SPEC.md).

## Executive Summary

Money Noodle is operational as a local research dashboard, continuous paper shadow trader, public paper-track-record publisher, and explicitly armed live Kalshi trader. Core UP/YES and DOWN/NO entry, managed maker execution, paper maker mirroring, signed Kalshi reconciliation, quiescent pause/drain, loss gates, budget epochs, provider permissions, contract provenance, target integrity, standalone reduce-only exits, protected switching, model evaluation, and immutable promotion accounting are implemented.

The system is mechanically capable. The unresolved question is economic: current evidence does not justify stake expansion, unconditional taker execution, an automatic entry relaxation, queue-aware live gates, or adding a second live venue. The shared buy rule is **v22** — a 2026-08-20 operator narrowing to a +5pp edge floor and a 10–75¢ price band, not an evidence promotion; see below. Live execution is explicitly `maker-high30-requalify3-fresh1c-v5`, not the withdrawn unconditional-taker description attached to v21's first deployment.

A second policy runs on the same market — the long-shot round trip, §2 below. Its current 12¢→97¢/600s cohort is paper-only; live arming is false. The parameters were selected from a retrospective sweep and therefore define a new collection cohort rather than evidence-backed promotion. It relaxes none of the edge policy's constraints and changes no edge rule.

| Area | Status |
| --- | --- |
| Dashboard and public paper track record | Functional locally and through optional Postgres projection |
| Forecast and performance tracking | Functional and deterministic; large forecast history is now a memory-residency risk rather than a latency one |
| Live execution | Kalshi live-capable and active in local control; no current open/working positions in the local ledger snapshot |
| Paper execution | Continuous and independently accounted; exact-contract managed repricing now uses public trade/queue evidence concurrently with live |
| Model evaluation | Automatic walk-forward scheduler and immutable manual promotion ledger implemented; latest run retained baseline |
| Provider expansion | Registry, permissions, variants, and budgets implemented; only Kalshi is live-capable |
| Operational safety | Startup/periodic/manual reconciliation, quiescent drain, guarded auto-resume, loss gates, and failure injection are implemented |

### Runtime task cadences are visible without merging their schedulers, 2026-08-20

The data-freshness dialog now separates input TTLs from eight task clocks and shows each task's cadence,
activation condition, purpose, request cost, last run, and process-local health. The shared registry covers
dashboard prefetch, 15-second edge observation, exact pre-submit quotes, the bounded 2-second managed maker,
ordinary and active-trailing long-shot entry watches, long-shot target exits, and periodic/event-triggered
reconciliation. Existing timers, queues, quote caches, request budgets, and policy behavior are unchanged;
price trajectory and spread remain observation-only evidence. Design boundary:
[docs/task-cadence-observability-design.md](docs/task-cadence-observability-design.md).

Signed open-order rows now show the latest owned-side venue bid/ask and its age, updating from the managed-order
or open-position observations already captured by the execution engine. Values older than one 15-second
calculation window are visibly stale. This adds no venue request, polling loop, ledger field, or path back into
pricing and execution.

### Quote trajectory and spread collection deployed and running, 2026-08-20

The collection-only generation in
[docs/quote-trajectory-spread-signal-design.md](docs/quote-trajectory-spread-signal-design.md) preserves feed
source timestamps so a cached fallback cannot manufacture a flat path, derives signed underlying and exact
provider/side midpoint direction plus spread widening/narrowing over trailing-60-second and contiguous
cycle-to-date horizons, and stamps the selected observation only on new qualified forecasts and immutable
entry decisions. Four unique observations over 45 seconds are required; a stale latest point, malformed or
crossed book, contract change, or gap over two calculation buckets leaves the feature unavailable rather than
substituting another provider or a zero.

This uses only quotes existing tasks already fetched and adds no poll, scheduler, request, public projection,
policy read, ranking weight, gate, sizing, execution, exit, or promotion path. Any selection or gate candidate
still requires a separate precommitted design and sentinel generation under SPEC §12.5.

**Deployment check, 2026-08-20T04:50–04:54Z.** Live automation paused and drained quiescently; manual
reconciliation passed with 28¢ reserved. The production build passed, the server restarted, and startup
reconciliation reported the local ledger, venue cash, positions, orders, fills, IDs, resting orders, and
reservations in agreement. The operator explicitly resumed live mode with 1,625¢ available and 28¢ reserved.
At the first post-warm-up read, venue history held 112 exact-book samples over 16 source timestamps and oracle
history held eight source-timestamped samples. The production feature calculator returned both trailing and
cycle-to-date quote and underlying features from the live cache; the collector was running with a successful
04:54:27Z cycle and no last error. Two bounded Kalshi read-limit backoffs occurred at startup and recovered.

There was not yet a qualified signal record: all seven predictions had zero currently admissible v22 options,
so the private dashboard and forecast journal correctly carried zero selected observations. This is an
operational verification of source collection and feature calculation, not an economic sample. The main
caveat is candidate sparsity under the narrower v22 entry band; only future qualified calculations stamp the
durable selected observation.

**First durable cohort, 2026-08-20T05:05:57Z.** The forecast journal then held 10 unique qualified
observations from 2026-08-20T05:01:14Z–05:05:30Z: nine SOL and one HYPE. All 10 carried cycle-to-date
underlying direction; eight carried cycle-to-date quote/spread features; five carried both trailing-60-second
features. Missing horizons remained explicitly unavailable under the source coverage rules rather than
becoming flat values. None had resolved, so this verifies prospective persistence only and supplies no
economic result; the greatest caveat is ten highly concentrated observations over four minutes.

**Hosted deployment check, 2026-08-20T05:04Z.** Manual `npx vercel --prod` deployment
`dpl_J5rvqJ6nTtdNcjRNBHvoVEB3vP4u` reached READY and aliased `noodle.money`. The canonical public API
published v22 with +5pp edge and 10–75¢ ask bounds over seven predictions, omitted
`quoteTrajectorySpread`, and reported its stateless collector disabled. Hosted therefore exposes the policy
and sanitized dashboard without acquiring collection, storage, reconciliation, or execution authority.

## Current Measured State

Snapshot from local durable files at 2026-08-19T01:44:04Z. Full method, cohorts, corrections, and caveats in [reports/open-experiment-status-2026-08-19.md](reports/open-experiment-status-2026-08-19.md).

- Forecast storage index: 58,360 rows, 632 open and 57,728 sealed across 12 shards. Collection and settlement journals were advancing.
- Edge ledger lifetime, exact reporting view: live −124.14c on 28,855.67c over 567 settled entries and 367 settlement windows; paper −2,242.36c on 47,984c over 945 settled entries and 485 windows. These are not the whole-cent budget view.
- Long-shot ledger lifetime, exact reporting view: live −28.26c on 55.19c over three manual mechanism tests in one window; paper −709.27c on 895c over 41 settled attempts and 27 windows.
- Live budget control, whole-cent view: active live mode, 2,000c starting budget, 1,610c available, 0c reserved, and −390c current-epoch realized P&L. No entry was open, pending-reservation, or uncertain.
- v21 had run for about one hour. A policy-aware reconstruction found 43 admitted decisions, 35 satisfying 2-over-15 persistence, 15 matched live orders and 6 fills. The ledger held 18 live v21 orders: 13 labelled taker with 4 fills, and 5 labelled maker with 2 fills. This is operational attribution, not an economic sample.
- The active local long-shot cohort is `long-shot-round-trip-buy12-sell97-win600-v1`, paper only: 8 resolved attempts in 4 windows, all losses, −402c on 402c, no mark exits, and 0 current-policy hold-sentinel records.
- Latest walk-forward run: `walk-forward:875:fnv1a-27542176`, generated 2026-08-18T22:00:08Z. Candidate mean window return was 5.75% against baseline 2.37% over 438 test windows; it beat baseline 5/5 folds but was positive only 3/5 with modal parameters in 3/5. Decision: `baseline_retained`.
- The current Next development server occupied about 3.7 GB RSS. RSS is not retained heap and dev mode carries compiler/cache overhead, but this materially disagrees with the prior 70 MB post-sharding RSS measurement and needs a like-for-like profile.

### Forecast rollup policy attribution repaired, 2026-08-20

`forecast-rollup-v1` omitted buy-policy identity from its compact missed-buy counterfactual. The direct
summary filtered rows to `BUY_POLICY_VERSION`; the rollup merge did not, so after v22 activated it combined
363 sealed v21 candidates with v22's eight current candidates and reported 371 candidates / 77 windows
instead of 8 / 4. Every other field reconciled, which is why ordinary storage health remained green while
`npm run verify:forecast-storage` failed the complete field-by-field gate.

`forecast-rollup-v2` stamps `policyVersion` on each counterfactual asset/window, includes it in the merge
key, and filters to the active policy before nearest-snapshot and best-per-window selection. Existing
untagged v1 counterfactual columns are excluded rather than guessed; all of their policy-independent
statistics remain readable. The verifier now fails explicitly if a legacy rollup contains an active-policy
resolved row, where exclusion would under-report rather than repair attribution.

At the **2026-08-20T06:08Z** read, the 12 indexed sealed shards contained zero v22 rows; all v22 rows were
in the open snapshot/journal, where direct and v2 rollup paths independently reproduced 8 candidates / 4
windows. The repaired read-only verifier passed over **67,346 rows**: 62,997 sealed, 4,349 current open and
17,492 journal events, with zero errors. No shard, rollup, index or journal was rewritten; the owning
forecast compactor will emit v2 rollups at its next normal seal. The main caveat is that these counts are a
point-in-time read of an advancing journal. Design: [docs/forecast-storage-design.md](docs/forecast-storage-design.md) §4.1.

**Deployment check, 2026-08-20T06:13–06:16Z.** Automation paused and drained quiescently; manual
reconciliation passed with one settlement-pending 28¢ position and restart-safe state. The production build
passed, the worker restarted, and startup reconciliation passed against 5,428.79¢ venue cash with 0¢
reserved, zero venue-managed positions, zero recovered fills and zero resting cancellations. The operator
explicitly resumed live mode with 1,738¢ available. The authenticated Performance route then reported the
active-policy missed-buy cohort alone — 11 candidates / 5 windows as the journal advanced — and no degraded
storage state. A fresh read-only verifier passed over **67,439 rows**: 62,997 sealed and 4,442 current open,
with 17,930 journal events and zero differences between direct and rollup summaries. RSS was about 593 MB
after that full-history verification and Performance read; RSS is not retained heap and this single
post-restart observation does not close the separate residency review.

**Hosted deployment check, 2026-08-20T06:17Z.** Manual production deployment
`dpl_BWFuwFrd2ExLtny9FCZK9mRvhFMg` reached READY and was aliased to `noodle.money`. The canonical public
API published v22 over seven predictions, served the durable sanitized paper projection, omitted private
policy-model state, and reported its stateless collector disabled. Forecast shard repair remains
worker-local; the hosted runtime gained no storage write, collection, reconciliation or execution authority.

### Mirror fidelity and skip attribution, 2026-08-20

Three changes from the 2026-08-20 divergence review. Full design and the falsification test in
[docs/mirror-fidelity-and-skip-attribution-design.md](docs/mirror-fidelity-and-skip-attribution-design.md).
**No entry rule, threshold, size or gate moved**; buy policy stays v22 and `lib/mirror-invariant.test.ts`
still asserts the rule layer takes no execution mode.

**1. Live skips are durable (`live-skip-v1`).** SPEC §12.8 step 2, previously unimplemented — the ledger
kept `lastLiveSkip`, one overwritten slot. Every gate in `runLive` now names its own class (`stop`,
`operator`, `environment`, `reconciliation`, `rate_limit`, `budget`, `funding`, `exposure`, `portfolio`,
`persistence`, `regime`, `staleness`, `none`) and writes an episode to `data/live-skips.journal.jsonl`.
A classifier over the existing free-text reasons was rejected: a new gate would silently inherit whichever
pattern matched. Records fold consecutive identical cycles into one episode, so 2026-08-19's six-hour risk
stop is one row with a cycle count and its settlement windows rather than ~1,440 rows. Operator intent
separates a system `stop` from an `operator` pause. `windowsWithheldBy(records, 'stop')` joined to the
paper book on `closesAt` is the number that previously required reconstructing from the control audit.
The three withholds inside the switch path journal too, under class `fill` — §12.3 decomposes
`paper − live` into fill, limit and stop drag, so a reduce-only exit that did not fill is fill drag and
not a ranking decision. The one `lastLiveSkip` line reporting a *completed* switch is deliberately not
journalled; it is a status line, not a withhold.
No execution authority; a failed write is logged and dropped rather than stalling a cycle.

**2. The paper exit has a fill model (`paper-ioc-exit-depth-v1`).** It previously set `status = 'sold'`
unconditionally — 106 of 106 attempts completed, against live's 50 of 87 (57.5%). **The agreed design
changed before implementation:** `placeKalshiSell` sends `immediate_or_cancel` with `post_only: false`
and returns `liquidityRole: 'taker'`, so the exit never rests and cannot be modelled by the resting-maker
print loop. It is now a single sweep of displayed depth at or above `decision.executableBid`, with
partial fills and a no-fill that retains the position exactly as live does, neither automatically
retried. Deliberately conservative: displayed size only, one instant, no price improvement, no market
impact.

Both new taker paths distinguish missing evidence from a genuine no-fill: the order-book fetch is
allowed to fail silently, and sweeping an absent book would have recorded a data outage as an
`ioc_no_fill` — and, on the exit, stranded the position, since `standaloneExitAttemptedAt` disables
retry permanently. The entry returns its reservation and marks the attempt `rejected`; the exit defers
without stamping. This mirrors the maker simulation's existing `evidenceComplete` posture.

**Expect the published paper track record to fall.** Live's 37 exit no-fills retained positions that
returned +55.5% (25 won, 12 lost), so live's failures to exit were profitable and paper was clipping the
same winners at a worse price. The old number was optimistic; the direction of the correction is right
and its magnitude is not predicted. The 106 already-recorded costless exits stay in the ledger as
evidence of what the v3 simulator did — `paperExitFillVersion` keeps the cohorts unpooled.

**3. Paper takes the route live takes (`paper-managed-execution-route-ioc-v4`).** SPEC §12.2 specifies
the mirror as an independent simulation with "the same versioned episode boundary and route decision";
the route half was never implemented, so all 556 paper edge orders were makers against live's 15 takers
and the high-edge IOC route the v4/v5 execution change was about had no mirror. `runPaper` now calls the
same `evaluateEntryExecutionPolicy` and branches, refreshing the exact contract and re-checking the
one-cent cap and taker authorization before sweeping depth. `post_only_race` stays unmirrorable — it has
no meaning for an order that never rests. The version bump resets the paper execution cohort.

**Deliberately not done: paper still ignores live's risk stops, hourly ceiling and reconciliation gate.**
Per §12.3 that channel must stay open — paper's value there is measuring what the stop cost, and making
the tracks symmetric would delete the measurement. What was missing was the label, which (1) supplies.

New: `lib/live-skip.ts`, `lib/live-skip-store.ts`, `lib/ioc-fill-model.ts` and their tests.
`npm run typecheck` and `npm test` (964 tests, 117 files) pass.

**Two defects found in review before deploy, both fixed.** (a) Three withholds inside the switch path
bypassed the journal entirely, leaving that path with the single-slot problem this change removes; fixing
them exposed a missing class, since §12.3 decomposes `paper − live` into fill, limit and stop drag and
there was no `fill`. (b) Both new taker paths recorded *missing evidence* as a genuine no-fill. The
order-book fetch is allowed to fail silently, so a data outage would have been logged as an
`ioc_no_fill`, biasing downward the exact fill rate this change exists to measure — and on the exit it
would have stranded the position, because `standaloneExitAttemptedAt` disables retry permanently.

**Deployment check, 2026-08-20T06:00–06:03Z.** The desk was allowed to go quiet rather than paused: a
manual pause sets `operatorIntent: paused` and per §4 never auto-resumes, so draining would have left
the desk off pending a manual resume. The one open live position, `live:HYPE:UP:2026-08-20T06:00:00Z:episode:2`
at 29¢, settled `won` at +24.38¢, leaving 0¢ reserved and nothing open, working, uncertain or
exit-pending. The production build passed and the local server restarted under `npm run start`. Startup
reconciliation passed against 0¢ reserved with 0 fill states recovered and 0 managed remainders canceled;
the desk stayed `active`/`live` with operator intent `active` and 1,766¢ available, so no resume was
required. The skip journal began writing on the first live cycle and folded 5 events into 2 episodes —
a four-cycle `none` run and a `persistence` episode — which is the attribution surface working on real
cycles rather than in a test. Commit `fbbe10b` is pushed; `npx vercel --prod` is Ready and the hosted
root returns its login redirect. No paper order had been created at the first post-restart read, so this
verifies build, restart, reconciliation and the journal — **not** the exit fill model, the taker route,
or any economics.

### Entry admission narrowed to buy policy v22, 2026-08-20

`MIN_NET_EDGE` returns to **+5pp** (from −5pp at v20) and the price band narrows to **10–75¢** (from
5–97¢). Nothing else moved: side floor, quality floor, persistence, warm-up, late cutoff, execution
policy `maker-high30-requalify3-fresh1c-v5`, sizing, and exits are unchanged. Both tracks changed at
once — the rule layer takes no execution mode, so the mirror invariant holds by construction.

**This is an operator narrowing, not an evidence promotion, and it reverses v20 on evidence that still
reproduces.** Full corrected review:
[reports/entry-admission-v22-review-2026-08-20.md](reports/entry-admission-v22-review-2026-08-20.md);
reproduce with `npm run analyze:entry-admission-v22`. At the 2026-08-20T05:00:49Z read of 66,728
forecasts / 66,651 resolved, exact-provider first-to-fire replay found **3,941 v21 versus 3,373 v22
positions**: zero added and **568 omitted**, a 14.4% reduction. The omitted cohort returned **+26.1%
±7.6 over 238 settlement timestamps**; v22's surviving cohort returned +19.2% ±2.3 over 837.

This corrects the original uncertainty: the previously stated **±3.8pp belonged to the edge-floor
subgroup**, not the whole omitted cohort's settlement-window-clustered standard error. Scored on every
v21 position, with omissions earning zero and later v22 first fires retained, v22 changes ask-priced
return by **−3.7pp ±1.3pp** and bounded payout edge by **−1.09pp ±0.31pp**. Price-first exclusive
attribution is 487 edge-floor positions (+21.3% ±3.8), 72 above 75¢ (+8.1% ±5.2), and nine below 10¢
(+173.2% ±185.9). The edge-floor population v20 cited remains positive and is not treated as refuted.

**The caveat that most threatens this:** every figure is retrospective and ask-priced with no
persistence, maker-fill selection, portfolio capacity, sizing, exits, or budget reuse. Ask-priced return
is an upper bound this book has never realized, and concentrating capital on fewer higher-conviction
tickets remains the stated reason for accepting the reduction — a judgment about execution reality,
not a result the replay produced. The corrected replay weakens rather than supports the economic case
for v22; it cannot reverse the operator decision automatically.

Both band ends now bind. The former 97¢ ceiling refused no row the expected-value gate had not already
refused, so under §5.7 it was not a control; at 75¢ it is one. `maximumNetEdge()` remains disarmed at
1, leaving the 10¢ floor as the only gate bounding the documented above-35pp calibration inversion.

V22 activated in the built local runtime at **2026-08-20T04:50:15Z** during the quiescent deployment
recorded in the trajectory-collection section above. Startup reconciliation passed and live mode was
explicitly resumed. Source, policy manifest history, SPEC §3.7 and its decision log, the reproducible
analysis, and affected tests are updated; the runtime publishes v22.

### XRP exclusion re-evaluated; current evidence is null, 2026-08-20

Full review:
[reports/xrp-exclusion-review-2026-08-20.md](reports/xrp-exclusion-review-2026-08-20.md); reproduce with
`npm run analyze:xrp-exclusion`. At the 2026-08-20T00:01:37Z read of 2,730 orders / 65,854 resolved
forecasts, the original executed-loss result reproduced exactly: live **−45.7% ±21.5 over 41 fills/windows**
and paper **−35.1% ±13.0 over 85 fills / 81 windows**. Those rows ended under legacy through v13/v14 and
do not measure v21/v5.

A reconstruction of the current v21 first-to-fire rule found XRP **+1.0% ±12.5 over 59 decisions/windows**
from 2026-08-19T00:42Z–23:57Z, versus non-XRP **+9.7% ±5.9 over 364 decisions / 83 settlement
timestamps**; the paired XRP-minus-peer difference was **−12.1pp ±12.8 over 58 common windows**. Fifty-
eight of 59 XRP decisions were below 30pp and would use the reduced ticket; they returned +2.7% ±12.6.
This is ask-priced, less than one day, reconstructs persistence from bounded forecast history, and contains no
current-policy XRP execution, so it establishes neither harm nor value.

The prospective choice journal held three unique resolved XRP candidates across 17 issued-order records.
Only one had completed persistence; it lost, but the portfolio independently blocked it for negative adjusted
expected contribution. Removing only the asset gate would have changed zero recorded selections in this tiny,
conditional sample. No blocker or buy-policy change was made. Removal would be an explicit bounded operator
experiment requiring a new shared buy-policy version and manifest history, not an evidence promotion.

### Requalifying maker episodes deployed live, 2026-08-19

The maintainer found that v4's `maker missed · sequence ended` state was too broad: one authoritative
zero-fill locked the asset/side for the rest of its settlement window even when the signal subsequently
earned the entry checks again. The approved v5 design does **not** require the signal to become
nonqualifying. Instead, each maker miss resets execution qualification at `makerCompletedAt`; two new
qualifying snapshots spanning 15 seconds, both strictly after completion, may authorize the next episode.
See [docs/requalifying-entry-episodes-design.md](docs/requalifying-entry-episodes-design.md).

`maker-high30-requalify3-fresh1c-v5` permits at most three episodes per asset/side/window. Every episode
reruns reduce-only sizing, current maker/high-edge routing, exact quote, portfolio, funding, exposure,
live-risk, and reconciliation gates. Any fill, working or uncertain state, rejection, stale-policy order,
taker refusal/no-fill, or episode 3 ends rearming. Later IDs are durable `:episode:2` / `:episode:3` rows;
historical `:retry:` rows cannot open v5 authority. Paper uses the same post-completion boundary under
`paper-managed-maker-requalify3-v3` while retaining independent simulated fills.

This is an explicit execution decision, not a measured promotion. At the decision read, v4 had only four
live attempts: one fill and three maker zero-fills; because v4 prohibited later episodes, it supplied no
prospective episode-2 outcome sample. The main unresolved risk is repeated exposure to the same
continuously qualified but adversely selected signal. Fresh persistence, the three-episode ceiling,
unchanged reduced sizing, and stop-on-any-fill semantics bound the first generation. Source, tests, policy
manifest, dashboard labels, SPEC, and design records are updated.

**Deployment check, 2026-08-19T23:43–23:46Z.** Automation was manually paused and drained. Manual
reconciliation recovered one fill, agreed one local/venue-managed position, canceled no resting remainder,
and reported restart-safe with 28¢ reserved. The production build passed, the local server restarted under
`npm run start`, and startup reconciliation passed against 5,520.32¢ venue cash with 0¢ reserved, one local
settlement-pending position, zero venue-managed positions, zero recovered fills, and zero canceled resting
orders. The authenticated manifest published v5, the read model published the three-episode ceiling, and the
operator explicitly resumed live mode with no blockers and 1,905¢ available. No v5 live or paper order had
fired at the first post-resume read, so this verifies build, policy identity, restart, and reconciliation—not
episode-2 routing or economics. Hosted verification caught that the stateless deployment's absent execution-
mode setting described the safe maker-only default and published one episode despite the v5 identity. The
production Vercel environment now carries `MONEY_NOODLE_ENTRY_EXECUTION_MODE=adaptive` as a fifth,
display-only setting; the final canonical read published adaptive mode and three episodes. Stateless runtime
intersection still grants no collection, ledger writes, reconciliation, or order authority.

### High-edge execution, direction observation, and reduce-only sizing deployed live, 2026-08-19

Full 2026-08-19T22:43:38Z durable-data review in
[reports/execution-direction-sizing-review-2026-08-19.md](reports/execution-direction-sizing-review-2026-08-19.md);
reproduce with `npm run analyze:execution-direction-sizing`. The supplied realized-edge shape reproduced:
30pp+ returned +46.2% ±46.9 live over 18 rows / 17 windows and +56.3% ±45.4 paper over 29 / 25. It is
not ready to lever: the three largest positive rows exceed each track's total high-edge profit, and each
standard error is about as large as its point estimate.

The prior 0.3×–3× proportional-sizing result does **not** reproduce on executed money. It raises modeled
capital about 76% while clustered realized return remains negative and nearly unchanged. The maintainer
instead approved an explicit restrictive deployment on retrospective evidence:
`entry-sizing-reduce30-below-edge30-v1` commits 0.3× of each track's current base ticket below 30pp and 1×
at 30pp+, with no arbitrary minimum and no upsizing. `maker-high30-one-attempt-fresh1c-v4` gives every
logical sequence one attempt: below 30pp one managed maker whose zero-fill ends the sequence; at 30pp+ one
IOC only if an immediate exact quote still clears 30pp fresh taker edge, 10pp persistence median, 65%
quality, 2¢ spread, and the existing 1¢ movement and safety gates. The old random-fill maker comparison no
longer gates high-edge taking. Design and stated departure:
[docs/high-edge-execution-reduced-sizing-design.md](docs/high-edge-execution-reduced-sizing-design.md).

Exact-quote direction explains many misses but does not yet supply a production rule. The
2026-08-19T23:19:35Z rerun read 2,723 orders / 65,381 resolved forecasts: across 77 live attempts / 36
windows and 208 paper attempts / 60 windows, favorable one-cent moves filled 31.7% live / 18.3% paper while
adverse moves filled 63.6% / 68.9%. Refusing adverse pre-submit movement improves live +12.6pp ±8.2 but
paper only +0.3pp ±7.1 and drops 6 live and 22 paper winning fills. The post-deployment rows are not an
independent validation cohort, and the direction result remains track-discordant. `entry-direction-observation-v1`
now stamps the pre-submit and first-unfilled-management direction plus the fixed refusal/cancel candidates,
but production never reads them.

**Deployment check, 2026-08-19T23:08–23:14Z.** Automation was manually paused and drained; reconciliation
passed with 0¢ reserved, zero local/venue positions, and zero resting orders canceled. The built production
server restarted, startup reconciliation passed against 5,541.96¢ venue cash with zero recovered fills, and
the operator explicitly resumed live mode. The first v4 runtime trace was SOL UP at 3.7pp issuance edge: the
100¢ base sized to a 30¢ reservation, one maker filled 0.54 contracts for 28.62¢ exact all-in spend, and the
order stamped both v4 execution and direction evidence. After a final current-source build, a second
quiescent restart reconciled that one open position exactly against 5,513.34¢ venue cash and 29¢ local
reservation, with zero recovered fills or resting orders; live mode was explicitly resumed with no blockers.
At the 2026-08-19T23:17:34Z follow-up, that first order had settled DOWN for an exact −28.62¢, and a
second v4 trace (BTC UP, 4.7pp issuance edge) completed its single 30¢-cap maker attempt unfilled. Live mode
remained active with 0¢ reserved and 1,836¢ available. These are two attempts in two settlement windows and
verify routing, sizing, settlement, and terminal zero-fill wiring only; they do not estimate economics.

### Winner-preserving loss screen: no production filter qualifies, 2026-08-19

Full 2026-08-19T22:20Z durable-data review in
[reports/winner-preserving-loss-filter-review-2026-08-19.md](reports/winner-preserving-loss-filter-review-2026-08-19.md);
reproduce with `npm run analyze:winner-preserving-filters`. At that read, v21's first
qualified population remained positive at **+12.0% ±5.1 over 591 decisions / 84 windows**, while its 42
live fills over 26 windows were **−31.6% ±19.8** ask-priced and held. Tightening entry is not the supported
response.

The predeclared 2pp maker-spike restriction is the lead, not a promotion. Retrospectively across v21 it
improves the all-attempt mean by +13.8pp ±7.2 live and +3.9pp ±5.9 paper, but refuses **6 live and 13 paper
winning fills** at the report read. On the 2026-08-19T23:19:35Z rerun, its prospective cohort had refused
five losing fills and zero winning fills across the two tracks, but only over **1 resolved live window and
13 paper windows**, far below the locked 60-window / 20-differing-window review requirement. The greatest
threat is the tiny, repeatedly observed prospective cohort; the 2¢ spread restriction also disagrees by
track. This screen authorizes no additional buy, execution, sizing, exit, or live-authority change.

The separate paper-only long-shot ledger now has 42 settled attempts in 28 windows, zero `won` statuses,
and −754.27¢ exact P&L on 940¢. Its latest settled 12¢→97¢ predecessor cohort is 0/9 over five windows;
the derived v2 cohort has no settled order. Retiring that lane is an operator choice about research value,
not a live-risk action.

### Eleven ideas screened; sizing was the one worth further evaluation, 2026-08-19

Full measurement in [reports/edge-buy-opportunities-2026-08-19.md](reports/edge-buy-opportunities-2026-08-19.md).
Method was the admitted population — first qualifying calculation per `(symbol, closesAt, side)`, at the
recorded ask, held to settlement, window-clustered, under the live v21 bounds. The harness returned
**+20.8% ±5.2 over 671 windows** against `analyze:loss-decomposition`'s +20.9% for v19, which was the
control. About **thirty-three comparisons** were evaluated; **no policy, gate, execution, sizing, or
calibration change was authorized by any of it.**

**Subsequent correction:** the proposed 0.3×–3× proportional arm did not reproduce on realized executed
money; it increased modeled capital about 76% while clustered returns remained negative and nearly
unchanged. It is superseded and must not be implemented. Production later adopted the separately approved,
reduce-only `entry-sizing-reduce30-below-edge30-v1`, with no multiplier above 1. Dollar-denominated account,
window, and correlation-group ceilings remain mandatory before any future proposal above 1×; they are not
an authorization to revive proportional upsizing. See
[reports/execution-direction-sizing-review-2026-08-19.md](reports/execution-direction-sizing-review-2026-08-19.md)
and [docs/high-edge-execution-reduced-sizing-design.md](docs/high-edge-execution-reduced-sizing-design.md).

- **Sizing appeared to be the largest lever on the admitted population and changed no admission.**
  Identical 3,078 decisions, only the weight: flat +18.6% per $1, capped 0.3×–3× edge-proportional
  **+28.9%**, better on **9 of 9 days**, with the ten highest-edge rows contributing **4.0%** of the
  profit. Below a 35pp edge it was +19.9% against +14.8%. The desk already ranked by
  `expectedProfitCents` ≈ `edge / cost` and then committed the same dollar to every winner. This read
  described position-count exposure caps as the sole blocker; the subsequent realized-money correction
  above established that execution evidence is also a blocker and superseded the proposal:
  [docs/edge-proportional-sizing-design.md](docs/edge-proportional-sizing-design.md).
- **The edge spike separates realized money out-of-sample, and the committed sentinel says it is not a
  forecast effect.** On v19+ orders — chosen after the threshold was set — live fresh +0.2% against spiked
  −22.2%, paper −6.7% against −16.9%; both tracks agree that **spike ≥ 5pp** is the bad cohort (live
  −37.7% on 3,558¢, paper −51.6% on 3,223¢). But 296 graded `edge-spike-sentinel-v1` records, at the ask
  and held, give **+1.9pp, t = 0.12** at 2pp. Fill rates barely differ by spike (43–59%) while the maker
  discount is **larger** on spiked orders, 5.30¢ against 4.55¢ — a better price with a worse outcome.
  Reading: the spike belongs in the **execution** layer, not the entry gate. Re-arming the gate is not
  supported and is not proposed.
- **`volatilityRatio` is clean on the gate and does not survive the ledger.** Admitted: +19.4% at
  VR 0.00–0.20 falling monotonically to **+1.4%** above 0.72, holding inside every edge band. Realized,
  from the field already stamped on 605 of 995 v17+ orders: the **middle** band 0.38–0.72 is the worst on
  both tracks (−27.3% live, −26.7% paper) and refusing VR ≥ 0.72 recovers nothing. **Fourth reversal of
  this shape** — clean on admitted rows, absent on filled ones.
- **The 0.55 calibration weight is too much shrinkage, and correcting it loses money.** Fitting the
  log-odds weight on 54,576 replayable rows gives β̂ = 0.738 pooled, 0.69–0.77 leave-one-day-out on
  **11 of 11 days**, day-clustered 0.62 ± 0.10. But re-running admission at β = 0.74 admits 3,523
  decisions at +18.2% against 3,078 at +20.8%, and β = 1.0 gives +15.5%. `settlementAverageEstimate`
  unmodified gives +16.1%. **The 0.55 weight is not calibration, it is selectivity.** Null result.
  Recorded beside it: β varies with time remaining (0.63 at T < 60 s, 0.78 at 120–240 s), which is the
  `effectiveSeconds = T − 30` approximation and the absent oracle-basis variance floor, not noise.
- **Smaller readings.** Late entries pay (+44.2% at 30–60 s, +59.5% at 60–120 s, against +18.4% at
  420–900 s). Contradicting the venue's direction wins 51.5% but returns +23.0%, while agreeing wins
  71.2% and returns +16.3% — the "win rate is the wrong statistic" lesson again. Price 0.80–0.90 is dead
  (−0.0%, n=47). Confidence is **not monotone** in return, so `edgeStrength` has no support as a ranking
  key. Asset exclusion still disagrees between tracks and stays unsupported.

**Shipped with it: `entry-decision-v2`.** `entryDecision` now records `edgeSpike` and the numeric
`cycleRegime` features, both already computed at decision time and previously discarded at the order
boundary — which is why §3 above could be checked against realized money and §4's trend-efficiency
result could not. Reporting-only; `lib/entry-decision-observation.test.ts` asserts no pricing, sizing,
gating, or execution module reads them, that features are cloned rather than aliased, and that v1 rows
keep the fields **absent** rather than defaulted. No behaviour changes and `BUY_POLICY_VERSION` is
untouched.

### Maker/exit depth follow-up: reporting fixed; sentinel design proposed, 2026-08-19

The outcome-conditioned maker review found active v3 losers filled materially more often than winners, while
the nine then-current v21 live strict-value exits all sold eventual winners. Full dated evidence and its
small-cohort caveats are in
[reports/maker-adverse-selection-and-exit-depth-2026-08-19.md](reports/maker-adverse-selection-and-exit-depth-2026-08-19.md).
The maintainer chose to keep live running unchanged. No entry, execution, sizing, or exit policy changed.

`buildMakerFillReport` now excludes rows stamped `executedStyle: taker` before venue submission assigns a
`liquidityRole`; those refusals no longer inflate maker submissions or depress maker acceptance. Accepted
maker fills and returns were unaffected. A regression test covers the pre-submission refusal and preserves
its actual-taker attribution.

The approved prospective evaluation-only design is implemented in
[docs/positive-edge-execution-exit-sentinel-design.md](docs/positive-edge-execution-exit-sentinel-design.md).
It precommits two restrictive maker candidates and four exit candidates, keeps their append-only stores and
track-separated evidence separate, requires complete first-to-fire cohorts, and cannot place or influence
an order. Maker records begin only after durable issued intents; exit records begin at the first prospective
filled-position observation and continue from fresh public data after production sells. Reports are exposed
only by the authenticated stateful performance route. Existing orders are never backfilled. Collection has
not started in the currently running process; its prospective timestamp is created on the first cycle after
a built restart/deploy.

### Contract selection: the named leak was a comparator artefact, corrected 2026-08-19

The first correction to `scripts/analyze-contract-selection.mjs` fixed its ranking key and removed
opposite-side contamination, but still compared an issued order with every contract that had qualified at
some earlier or later point. Those alternatives had not passed the decision-time persistence, classified
regime, re-entry cooldown, retry, active-exposure, or sizing checks. Its **−20.2pp** ranking gap is withdrawn.

The script now starts at each issued v17-v19 live order snapshot, reconstructs those checks, sizes with
production `estimatePaperFill`, ranks with production `selectPortfolio` under the historical 3/2/1 caps,
and clusters paired chosen-versus-replay-preferred differences on settlement window. Read at
**2026-08-19T16:12:53Z**: 346/354 order snapshots replayed; 339 passed the positive control that the
reconstructed portfolio admitted the order production demonstrably placed. On those 339 snapshots over
**232 independent windows**, replay chose the same contract **331 times**. Chosen returned −5.5%, replay
−4.6%; paired difference **−0.9pp ±2.7pp (95%)**. V19 alone was −2.1pp ±4.1pp over 44 windows. The eight
different-choice snapshots read −38.9pp ±88.8pp and are too sparse to carry a claim.

**Current conclusion:** no measured ranking defect. The older loss-decomposition stage remains a real gap
between all admitted rows and the ordered cohort, but it is not a decision-time choice comparison and must
be called **ordered-cohort selection**, not contract selection. Historical alternatives remain partly
reconstructed because failed dashboard observations and `portfolioDecisions` were not durably journaled;
a future ranking claim requires prospective committed choice sets. Full correction:
[reports/edge-buy-opportunities-2026-08-19.md](reports/edge-buy-opportunities-2026-08-19.md) §8.

### Prospective portfolio choice sets: implemented, collection not started

`portfolio-choice-set-v1` replaces favourable historical reconstruction with one immutable record after
each durable positive-edge live intent. It stamps the production candidate set, persistence/retry/cooldown
state, classified regime, effective runtime caps, account-wide exposures, production sizing/rank, drain
skips, and issued order, then resolves every exact Kalshi contract. The pre-registered report scores every
record, clusters on settlement window, opens diagnostics at 30 resolved windows, and requires 60 overall
plus 20 differing-choice windows before any differing-choice claim. No result can reach execution or
promote a policy. Design: [docs/portfolio-choice-set-journal-design.md](docs/portfolio-choice-set-journal-design.md).
Run `npm run analyze:portfolio-choice-sets`.

The current read is **0 records / 0 windows** because the running process has not initialized the new store.
No historical order is backfilled. Collection begins only after a build and restart/deploy; none was done
for this change.

### Edge policy v17, reviewed 2026-08-17

Three days of `buy-binary-edge-net5to35-quality50-owned55-price5to97-v17` are now reportable, and the
policy is losing money on both tracks while the gate it enforces is not the reason. Full review in
[reports/edge-policy-review-2026-08-17.md](reports/edge-policy-review-2026-08-17.md); reproduce with
`npm run analyze:entry-realization`. Figures are one read at 2026-08-17T07:17:38Z, settled entries only.

- The gate is intact. In the v17 era the rows it admits win 58.8% and return +14.9% [+8.9, +21.0] over
  892 settlement windows, against +15.4% in the era before it. The market did not deteriorate.
- The book is negative: live −565c on 13,185c (−4.3%) over 110 settled entries, paper −1,458c on 15,550c
  (−9.4%) over 117. Retired-policy entries on the same ledger returned +570c on 8,457c.
- **Fill selection is a leak and the previous 3.4pp figure was pooled across policy eras.** Split out,
  v17 filled entries win 19.2pp ±14.3 less than unfilled on live (t = −2.63) and 20.3pp ±12.4 less on
  paper (t = −3.21), while capturing a −3.96c maker discount. The earlier eras are too small or too
  low-base-rate to serve as a control, so "this is new" is *not* established.
- **Entries fired on an edge spike lose.** Decisions where `netEdge` sat 2pp or more above the
  `medianNetEdge` that `signalEligibility` already stamps win 34.0% against 58.7%, deduplicated to 228
  unique `(symbol, window, side)` decisions and clustered by window. It holds within every edge band and
  on 6 of 6 assets. It is retroactive screening on a threshold chosen after the fact and promotes nothing.
- The walk-forward evaluator could not referee any of this. **Two of the three defects are fixed as of
  2026-08-18:**
  - `WalkForwardParameters` now carries `maximumEdge` and `minimumSelectedProbability`, defaulted to the
    production constants and held fixed across the candidate sweep, so the baseline **is** the gate the
    desk runs. Sweeping a gate bound would let the search rediscover a policy by fitting it; that belongs
    in the manifest, not a candidate set.
  - `selectedTrade` now scores **per dollar committed** rather than per contract. The desk sizes by stake,
    so a win at cost 0.45 returns 1.22 per dollar against 0.55 per contract. Per-contract scoring
    systematically misweights across price levels — the exact axis on which return per dollar rises with
    edge while win rate falls. `profitPerContract` is retained beside it so earlier runs stay comparable.
    **Every historical `meanWindowReturn` was produced in the old unit** and promotion-ledger entries
    predating this are not restated.
  - A structural property surfaced while testing: the 0.55 side floor and the 0.35 edge ceiling together
    make any cost at or below 0.20 unreachable, since `cost > sideProbability − 0.35 ≥ 0.20`.
  - **Still open:** `selectedTrade` scores buy-at-the-ask-and-hold, which the decomposition shows is
    neither what the desk earns nor a clean bound — fill selection costs −19pp and the exits are worth
    +14.6pp. An execution arm is the remaining piece.
  - The suite did not catch the scoring-unit change: none of its seven assertions touched
    `meanWindowReturn`. Six tests now pin both gates and the unit.

### High edge is the best band — and the diagnosis is unstable, 2026-08-18

[reports/edge-magnitude-2026-08-18.md](reports/edge-magnitude-2026-08-18.md). Measured on the **admitted**
population rather than the desk's filled orders, return per $1 *rises* steeply with edge — 5–10pp earns
+11.6%, 25–35pp earns **+44.0% ±11.5**, positive on 8 of 9 days — even though the win rate falls from
62.7% to 51.9%. **Win rate is the wrong statistic across price levels.** Ranking *filled* orders by edge
shows the top quintile at 28.1%, which reads as calibration failure and is a selection artifact of
execution. **Do not lower the max-edge ceiling**; that band is the most profitable thing the gate admits.

Fill selection is not uniform: the gap widens from −6.4pp at 5–10pp edge to −17.3pp at 25–40pp, and
high-edge orders fill *more* often (63–65%). The rows worth most are the ones execution damages most. No
cell is individually significant; the monotone shape is what carries it.

**Three reversals in one session**, each from a control that should have been applied first: fill selection
−25pp → −19pp conditional; window selection −16pp → −0.1pp; high edge miscalibrated → most profitable.
Surviving effects sit at t=1.5–1.7. Per AGENTS §6 the instability is itself the result, and **no execution
or gate change is authorized on this evidence.**

**The binding constraint is refereeing, not measurement.** Every open question ends at "needs prospective
evidence," and the walk-forward evaluator cannot supply it — see §3 below.

### v19 — the edge-spike gate is disarmed, 2026-08-18, by operator decision

`buy-binary-edge-net5to35-quality50-owned55-price5to97-v19`, manifest entry in `lib/policy-manifest.ts`.
The spike ceiling no longer refuses an entry. **The spike is still computed and still recorded on every
decision** by `edge-spike-sentinel-v1`, because that sentinel is the only prospective evidence that could
ever justify re-arming it — turning the gate off must not turn off the measurement.

**Recorded plainly: the evidence did not ask for this.** Over 52 graded sentinels the gate refused 7, and
those refusals returned −24.4% against −7.2% for admitted decisions — +17.2pp in the gate's favour at
t=0.43, directionally supportive and far from conclusive. v18's book was *not* measurably worse than v17's
(t=−1.36 paper, −0.41 live, n=37/44 over two days), so "v18 is underperforming" is not established either.
This is an operator decision taken with that stated. It is reversible through
`MONEY_NOODLE_EDGE_SPIKE_GATE=true` without a further version bump, and the bump's known cost — discarding
the accumulated adaptive-regime windows and re-warming — was accepted again.

A design defect was fixed in passing: the first version read `process.env` inside `evaluateSignalPersistence`,
which made the rule untestable from a fixture. `spikeGateEnabled` is now a declared field on
`SignalPersistenceRequirements` beside `maximumEdgeSpike`, so a caller states what it holds fixed. Tests
pin both the armed logic and that production is disarmed.

### Long-shot: there is no exit mark that works, 2026-08-18

Full measurement in [reports/long-shot-roundtrip-2026-08-18.md](reports/long-shot-roundtrip-2026-08-18.md);
`npm run analyze:long-shot-roundtrip`. Opened on the premise that the long shot needs a better entry gate.
**The entry gate is not where the loss is.**

- **A contract that prints a 90¢ bid has essentially already won.** Spike-and-lose is ~1% of entries in
  every band (0 of 77, 1 of 474, 3 of 549, 4 of 664, 14 of 1,074). The mark is not harvesting a reversal.
- **The 90¢ mark reaches fewer contracts than holding wins**, by 1.3–5.9 points in every band, because
  these settle on a close-price comparison and a winner need never trade near 90¢.
- **The retrace population is real but sits at 30–50¢**, where the payoff multiple cannot cover break-even.
  No cell in the grid clears break-even except 0–10¢/≥600s at 90¢ (10.4% against 10.1%) — the same cell
  where the mark loses to holding.
- **Holding alone** falls monotonically with entry price: +16.8% ±72.3 at 0–10¢/≥600s (9 winners in 77),
  +3.1% at 0–10¢/≥300s, then −3.7%, −5.3%, −8.9%.
- Realized paper ledger: −309¢ on 493¢, **0 of 33 settled in the money**. Three `sold` rows are
  strict-value exits from the since-scoped bug; the three live entries were manual tests at a higher entry
  price to prove the mechanism executes, not policy execution.

**Open decision for the maintainer:** removing the mark is a policy version bump that changes what the
strategy is — without a mark, `long-shot-round-trip` is not a round trip. Removing it does not make the
strategy positive; it stops one measured leak.

### Long-shot hold sentinel — not ready, and one day carries every winner, 2026-08-18

Full review in [reports/long-shot-hold-sentinel-2026-08-18.md](reports/long-shot-hold-sentinel-2026-08-18.md).
`long-shot-hold-v1` has **38 windows with a recorded peak against its bar of 60**, not the 64 a naive count
of the store suggests.

- **`peakOwnedSideBidCents` was not written before 2026-08-18.** It is absent on 26 of 64 records, and a
  naive comparison reads the absence as "did not touch". Anything computed from the earlier cohort is
  silently wrong rather than missing — the same class of bug the 2026-08-17 filter screen hit with
  `cycleRegime.regime`.
- The store pools three configurations. Only `buy10-sell90-win600-v1` has a sample (64); the two 40¢ arms
  hold 2 records each and should be retired or fixed.
- On the covered day: touched the 90¢ mark **6 of 38 (15.8%)** against a **10.6%** break-even; sell-at-mark
  **+64.0% ±111.7**, hold +55.3% ±115.8. Positive, and unmeasurable at this width.
- **All six in-the-money settlements fall on 2026-08-18**; the three prior days are 0 of 26. Not explained
  by volatility — 08-17 was the most volatile of the four days (0.149% mean local 15m against 0.129%) and
  produced zero winners in 18 records.
- The peak distribution is bimodal: median 14¢, p75 31¢, p90 99.2¢. Eight of 38 peaked above 50¢, six above
  90¢, almost nothing between.

This configuration was also the **only cell above break-even** in the 2026-08-18 retroactive sweep across
2,131 paths (10¢/90¢ ratio 1.12, 10¢/70¢ 1.03; every other entry band 0.68–0.85). Two routes agreed it was
marginally positive; neither had the sample to establish it.

**Current update, 2026-08-19:** the configured marks are 12¢→97¢/600s. The deterministic entry-owner fix
advances the active derived policy to `long-shot-round-trip-buy12-sell97-win600-v2`; the prior v1 order and
10¢→90¢ sentinel cohorts are historical. `long-shot-hold-v1` ended with nine 12¢→97¢ paper executions but only two sentinel
records, both falsely stamped unexecuted with the obsolete collection-only reason. Those rows remain
immutable and are excluded. `long-shot-hold-v2` starts a fresh zero-window cohort: `runLongShot` now stamps
the exact paper decision, persists the order first, and writes the sentinel; the detached pass only recovers
version-stamped decisions, observes later peaks, and settles outcomes. No prior fill is backfilled. The
parameter change came from a 50-cell retrospective sweep and therefore nominates a paper collection cohort;
it is not prospective promotion evidence. The worker restarted on hold capture at 2026-08-19T04:53Z and
on deterministic entry ownership at 2026-08-19T05:17Z; both startup reconciliations passed with 0¢
reserved, zero recovered fills, and zero managed remainders canceled. The initial
hold-v2/order-policy-v2 cohort is zero by design until the next prospective trigger. The
one-second refreshed trailing poll is now the sole paper/live entry owner; the regular 15-second cycle can
no longer bypass `evaluateTrailingEntry`. See `docs/long-shot-policy-design.md` §§10b–10c.

### v21 — promote the persistence candidate, and take the ask, 2026-08-19

`buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21`. Two changes,
shipped together on purpose.

**Persistence 3-over-30s to 2-over-15s.** The **first entry change made on prospectively committed
evidence** rather than a retroactive screen — the bar SPEC 12.5 sets and the one the withdrawn v14 DOWN
suspension failed. `persistence-two-consecutive-v1` holds **553 resolved incremental settlement windows at
+13.2% +/-8.4** per $1 at the ask, with the value concentrated in the **227 production never took at all
(+23.5% +/-13.0)** rather than the half it reached a median 17 seconds later (+6.5% +/-11.1, noise).

Recorded as a departure: under 706's version-scoping only the v19 cohort formally counted — 92 windows,
+16.0% +/-19.9 — and this promotes on the pooled figure.

What it fixes is bigger than the entry rule. A single non-qualifying snapshot resets the streak to zero, so
at the collector's ~17s cadence one blip cost ~51 seconds of re-earning. Measured over 12 hours,
**115 of 205 admitted decisions never persisted at all.**

**Historical v3 execution discrepancy, superseded later on 2026-08-19 by v4.** The audit found
`MONEY_NOODLE_ENTRY_EXECUTION_MODE=taker` still applied the same recommendation as `adaptive`, while local
threshold overrides had relaxed most of the six gates. The maintainer chose adaptive rather than
unconditional taking. Attempt 1 now takes only at ≥15pp current edge, ≥10pp persistence median, ≥65%
quality, ≤2¢ selected-side spread, ≥30 comparable accepted maker samples, and ≥2pp estimated advantage over
maker capture; otherwise it uses managed maker. The 2¢ ceiling limits the cost of immediacy and is not
claimed to predict maker fills. The separate 10¢ spread ceiling rejects the entry entirely.

One authoritative attempt-1 maker zero-fill may open one capped taker fallback for that exact
asset/side/window/generation. There is no fixed cooldown: two new qualifying observations strictly after
maker completion must span 15 seconds. Attempt 2 retains the four absolute edge, median, quality, and 2¢
spread gates, waives only sample count and comparative advantage, and ends the sequence whether filled or
unfilled. Every other sequence starts adaptive attempt 1 anew. Paper remains its independent managed-maker
lane. Immediate and fallback takers now tolerate at most 1.0¢ of selected-side ask movement from issuance,
while re-running the applicable gates on the fresh quote and reserving quantity plus fees at the worst
permitted price. The cap never exceeds 97¢. Reporting separately labels pre-submit quote movement, accepted
IOC no-fill, and rested maker no-fill without rewriting historical rows. `ENTRY_EXECUTION_POLICY_VERSION` is
`maker-taker-adaptive-one-miss-slippage1c-v3`; design and audit requirements are in
`docs/adaptive-entry-fallback-design.md`.

**Deployment check, 2026-08-19T02:53Z:** the worker was stopped with active operator intent preserved,
restarted on the new configuration, and startup reconciliation passed with 0¢ reserved, zero recovered
fills, and zero managed remainders canceled. The first v2 live intent was one operational smoke sample only:
ETH DOWN attempt 1 retained maker because current edge was 2.9pp, persistence median 3.4pp, and estimated
taker advantage 0.4pp; it authoritatively completed unfilled. Its signal then reset rather than manufacturing
a fallback from stale observations. This n=1 trace verifies wiring, not economics.

**v3 deployment check, 2026-08-19T03:23Z:** the bounded-quote worker restarted with active operator intent
preserved; startup reconciliation again passed with 0¢ reserved, zero recovered fills, and zero managed
remainders canceled. No v3 live order had fired at the first post-start read, so only startup and build/test
integrity—not order economics or the one-cent path—had runtime evidence at that point.

**Execution-state display corrected, 2026-08-19.** The edge panel had hardcoded the retired three-snapshot
denominator and displayed attempt ceilings as progress (`1/2 no fill`). The authenticated read model now
publishes the active `productionSignalPersistence` snapshot count/span. The primary panel shows only
execution-confirmed signals and current-window attempts; base-edge signals awaiting confirmation are hidden
behind a secondary control. Labels state what happens next—fresh fallback evidence, checks pending,
eligible awaiting execution, or sequence ended—while the two-attempt ceiling remains audit detail. The
worker restarted on this read-model change at 2026-08-19T03:38Z; startup reconciliation passed with 0¢
reserved, zero recovered fills, and zero managed remainders canceled.

**Environment surface cleaned, 2026-08-19.** `.env.local` was reduced from 84 assignments to 52 without
changing any retained value. Removed entries were blank/default-only research and Polymarket configuration,
credentials for read-only account connectors belonging to planned/unimplemented providers, and five archive values equal to code
defaults; funded authority, caps, risk gates, reconciliation, active strategy policy, projection, auth, and
archive credentials remain explicit. `.env.example` now marks optional providers as commented examples and
matches current 9/6/3 portfolio defaults plus the disabled net-edge ceiling. The linked Vercel project was
reduced from 21 variables to the four the hosted app read at that point: canonical URL, auth password/secret,
and its dedicated database URL. No deployment was triggered then. The later v5 deployment added a fifth,
non-authority execution-mode value so the public manifest describes the funded desk's adaptive policy rather
than the code's safe maker-only default.

The earlier v21 sentence "every accepted decision fills at the ask" remains false and withdrawn. A capped
IOC can also finish unfilled when the quote moves beyond its approved ask.

| v19 arm | live | paper |
| --- | --- | --- |
| A as traded | -13.1% +/-17.8 | -24.6% +/-13.7 |
| A2 same fills, held | -7.6% +/-19.3 | -21.8% +/-16.3 |
| B take ask, filled only | -14.3% +/-18.0 | -32.9% +/-13.9 |
| **C take ask, every decision** | **-3.7% +/-13.4** | **-1.8% +/-13.5** |

**This reverses [take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md), and the reason is a
changed constraint, not changed data.** That report set arm C aside because it "assumes capacity the
hourly order ceiling and budget would not have given". The same evening raised positions 3 to 9,
same-window 2 to 6, per-group 1 to 3, and made `runLive` drain its ranked queue. That capacity now exists.

Stated plainly: paying the spread **costs** ~7pp on trades the maker would have filled anyway (arm B
-14.3% against A2 -7.6%). Taking wins only by converting the other half — the half the maker was adversely
selected out of. Capital deployed roughly doubles. **Arm C is the best arm measured, not a profitable one:
still negative per dollar.**

The rationale for shipping the two halves together assumed the desk would take every ask. Current code does
not implement that assumption. At the 2026-08-19T01:44:04Z read, 13 live v21 orders were labelled taker and
only 4 filled; 5 were labelled maker and 2 filled. The sample is too small to judge economics, but enough to
show that neither unconditional taking nor 100% fills occurred.

**Three volume multipliers are confirmed** — v20's wider gate, 9/6/3 caps, and the drain loop. The claimed
fourth multiplier, 100% fills, is withdrawn. `npm run analyze:execution-gap` remains the monitor after its
persistence requirements are selected by stamped policy version; the old script still applied 3-over-30 to
v21 and undercounted executable decisions.

### Portfolio caps raised to 9 / 6 / 3, 2026-08-18

`DEFAULT_MAX_OPEN_POSITIONS` 3 → **9**, `maximumSameWindow` 2 → **6**, `maximumSameGroupPerWindow`
1 → **3** (`lib/portfolio-policy.ts`).

**The caps, not the gate, were refusing the volume.** Across 632 settlement windows there were 1,633
decisions the desk could actually have executed — admitted *and* persisting three snapshots over 30s — and
the 2-per-window / 1-per-group limits admitted only 992 of them. Candidates do not all present at once, so
a three-slot desk fills with the first arrivals rather than the best of the window: it held no live
position 75% of the time and still passed over executable decisions at 15–31pp, the band that returns
+44% per $1.

| per window | per group | capturable | vs today |
| --- | --- | --- | --- |
| 2 | 1 | 992 | baseline |
| 3 | 2 | 1,297 | +31% |
| **6** | **3** | **1,560** | **+57%** |
| 9 | 3 | 1,569 | +58% |

Per-window capture saturates at 6 — nine slots per window would catch nine more decisions out of 1,633 —
so the total cap of 9 is what buys headroom across overlapping settlement times, not the per-window one.

**Stacking has been the better cohort for this strategy**, which is why this is a raise:

| | single-position windows | multi-position windows | sharing a correlation group |
| --- | --- | --- | --- |
| live | −5.7% on 207 | **+2.3% on 352** | **+19.3% on 80** |
| paper | −22.6% on 126 | +0.6% on 82 | **+22.9% on 19** |

Of 155 multi-position live windows, 61 were mixed, 73 all-lost, 21 all-won — outcomes are correlated but
not lockstep. **This is the opposite of the long-shot policy**, where stacked windows lost together 7 times
in 9; long-shot buys sides that got cheap *because* the underlying moved, so its stacked positions are one
directional bet repeated. The evidence does not transfer between the two strategies and should not be
quoted across them.

**Caveats.** The stacking cohorts are selection-biased: the desk only holds 2+ when it found 2+ good
candidates, which may itself mark favourable conditions. Same-group cohorts are n=80 live, n=19 paper.
Exposure rises from roughly 21% to 64% of the edge policy's allocation when fully committed — 9 positions
at $1 per trade against $14 — so this is the number that bites if the correlated-outcome result is bias.

Tests moved with it: `portfolio-policy.test.ts` and `global-exposure-caps.test.ts` now state their limits
explicitly or derive fixtures from the constants, so they pin the mechanism rather than a policy number.

### Live execution drains its queue instead of placing one order per cycle, 2026-08-18

**The binding constraint on concurrency was never the position cap or the entry gate — it was the loop.**
`runLive` took `selected.find(...)`: one order per cycle, by construction, while `runPaper` had always
looped its whole portfolio selection.

Measured over the whole ledger before the change: live held **no position 75% of the time** (one 15%, two
8%, three 1%), and reached its three-position cap on **3 of 348** orders, while the gate admitted a median
of three simultaneous decisions. v20's extra admissions could not express themselves — candidates queued
behind a one-per-cycle door and their windows closed underneath them. It also explains the contract
selection leak: the better-ranked alternatives the desk "passed over" had been admitted a median of 95
seconds and were still waiting their turn.

`runLive` now drains the ranked selection up to `maximumOpenPositions()`. **Every ceiling is re-read per
placement**, which is the whole safety argument: a cycle can now commit real money three times where it
committed once.

- hourly filled-order limit, re-counted before each placement
- funding headroom and the live stake ceiling, re-read as each order consumes them
- `makerRetryDecision` and execution eligibility, per candidate
- **exposure created earlier in the same cycle** — `portfolioAdmitsAdditional`, pinned by
  `lib/live-concurrency.test.ts`. `portfolioDecisions` is computed before anything is placed, so orders 2
  and 3 could not otherwise see orders 1 and 2. Correlation limits were never load-bearing on live while it
  placed one order per cycle; now they are the only thing stopping three copies of one bet in a window.
  The long-shot policy demonstrated that failure the same evening — three DOWN positions on three assets in
  one window, all lost together — because it has no correlation limit at all.

No entry-rule change and no `BUY_POLICY_VERSION` bump: this is execution, which SPEC §12.3 permits to
differ between tracks. The mirror invariant is untouched.

**Historical maker retry review.** Live attempts were raised 1 → 2 on 2026-08-18 despite negative evidence:
second maker attempts measured −11.6% under 60s after the miss (n=35), −63.0% at 60–180s (n=6), and −17.7%
beyond 180s (n=9), against −2.0% for first attempts. That operator decision is superseded for adaptive live
execution: attempt 2 is no longer another maker order and the unsupported fixed 30-second delay is removed.
The old result does not validate the new taker fallback—it measured maker retries—but it does reject citing
30 seconds as an evidence-backed duration.

51% of historical live maker orders went unfilled, so misses remain the larger volume constraint. Adaptive
v2 addresses one exact sequence after fresh post-miss evidence; draining the ranked queue still addresses
volume by taking the next different contract.

### v20 — admit substantially more entries, 2026-08-18, by operator decision

`buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-v20`, manifest entry in
`lib/policy-manifest.ts`. Three bounds moved at once:

| bound | v19 | v20 | the increment it admits |
| --- | --- | --- | --- |
| `MIN_NET_EDGE` | 5pp | **−5pp** | 402 decisions, +17.5% ±6.5 |
| `MAX_NET_EDGE` | 35pp | **disarmed (1)** | 18 decisions, +144% ±141 |
| `EXECUTION_LATE_CUTOFF_MS` | 120s | **30s** | 248 decisions, +19.8% ±12.0, 8/8 days |

Combined: **686 additional decisions at +32.4% ±10.5 per window, +20.2% stake-weighted, positive on 8 of
8 days**, against a live rule admitting 2,227 at +17.2%. 537 of the 686 are ordinary 50–85¢ contracts
carrying 73% of the profit, with the per-window and stake-weighted views agreeing to within a point, and
the best ten decisions are only 11% of the total — it is neither a weighting artefact nor tail-driven.

**Why this was judged additive rather than substitutional at the time.** The original
`analyze:contract-selection` reported the desk at its 3-position cap on 0 of 67 v19 orders and 3 of 348
since v17. The 2026-08-19 decision-state correction withdraws that script as authority for historical
capacity because it had treated created orders as exposure without replaying terminal state. The policy
change remains historical; its capacity rationale now requires the same authoritative exposure replay as
any future claim.

**What the evidence does not cover, recorded plainly:**

- Under the durability proxy the same increment falls from +20.2% to **+10.3% ±10.8**.
- Every figure is at the ask, held to settlement. Production rests a maker order, fills about half the
  time, and those fills are adversely selected. Nothing here measures what these entries would fill at.
- The 30-second cutoff carries an operational risk the measurement cannot see: no time to reprice, no
  retry inside 120s (`MAKER_RETRY_LATE_CUTOFF_MS` is unchanged), and no time to exit. Exit availability in
  that band is 64% against 82% for the population.
- Eight days, one venue, one strategy; the edge-floor increment exists on three of those days.

Every safety control remains in force — environment gating, typed-confirmation arming, the per-trade
all-in cap, rate limits, kill switch, reduce-only exits, and reconciliation before execution. Reversible
by restoring the three constants; the ceiling alone re-arms with `MONEY_NOODLE_MAX_NET_EDGE=0.35`.

**A consequence to expect:** the price ceiling now binds. With a −5pp floor the expected-value test no
longer refuses expensive contracts before `MAX_ENTRY_PRICE` does, which reverses a property
`lib/paper-execution.test.ts` had pinned since v9.

### Why the edge policy loses — v19 decomposed, 2026-08-18

`npm run analyze:loss-decomposition` now covers v19, and a loader bug had been hiding it: the script read
sealed shards and `open.json` only, `open.json` is rewritten just on compaction and was **7 hours stale**,
and resolution arrives as a journal patch. It reported **zero rows for v19** while the desk traded it.
Fixed with a shared journal-aware loader, `scripts/lib/forecast-history.mjs`; v17 and v18 are unchanged.

| era, live | gate | realized | ordered-cohort selection | fill selection | exits |
| --- | --- | --- | --- | --- | --- |
| v17 | +14.4% | −2.9% | −15.7 | −19.4 | +14.6 |
| v18 | +13.5% | −11.8% | −26.0 | −16.2 | +18.0 |
| **v19** | **+20.9%** | −9.7% | **−21.8** | **−8.4** | **−2.9** |

The gate was at its best reading yet and fill selection more than halved. The −21.8pp stage is the gap
between the admitted and ordered cohorts; it does **not** identify a ranking decision. The corrected
snapshot replay later found chosen minus production-preferred at −0.9pp ±2.7pp (95%) over 232 v17-v19
windows, so the earlier `analyze:contract-selection` explanation and its passed-over alternative figures
are withdrawn. What makes the ordered cohort differ remains unidentified.

### Missed entries — the selection gates are not what keeps volume out, 2026-08-18

Full measurement in [reports/missed-entry-review-2026-08-18.md](reports/missed-entry-review-2026-08-18.md);
`npm run analyze:missed-entries`. It asks whether the desk should be admitting more buys, judged the way an
operator watching the app judges it — could this have been sold at a positive exit?

- **"Sellable at a profit" barely selects.** 81% of live-rule entries with a recorded path were sellable at
  a profit after entry, and so were **60% of the ones that expired worthless**.
- **No relaxation of the edge floor, edge ceiling, price band, quality floor, or selected-side floor
  produces an increment that beats the live rule** (+16.7% ±4.5 per $1 over 1,970 decisions in 1,803
  windows). The edge-floor increments match it; both side-probability increments are negative, −13.3%
  ±12.9 at a 50% floor, independently confirming the v13 restoration.
- **`MIN_ESTIMATE_QUALITY` and the price band are inert**: relaxing either admits **zero** additional
  decisions across 3,017 windows. AGENTS §5.7 — do not describe them as risk controls.
- **The venue price is calibrated from 30¢ up**, so there is no price band to harvest; below 30¢ it costs
  19–27¢ on the dollar.
- **Capacity binds first.** The live rule already admits a median of 3 and a mean of 3.6 simultaneous
  decisions per settlement time against `DEFAULT_MAX_OPEN_POSITIONS` = 3. A looser gate changes which trade
  is taken, not how many.
- **The gate that costs volume is signal persistence**, and §6 below is where that is measured.

Fill-optimistic throughout: entries are bought at the recorded ask. Three to five days, Kalshi only.

### CLOSED AS AN ENTRY CANDIDATE: `persistence-two-consecutive-v1` is production in v21

The committed sentinel of SPEC §706 records, at decision time, every entry two qualifying observations over
15s would have taken that production's three over 30s did not. At the 2026-08-18T20:33:05Z read it holds
**553 resolved incremental settlement windows against the 100 it was locked for**, returning **+13.2% ±8.4
per $1** at the ask, positive on all 5 days. The value is concentrated where production never caught up at
all — **+23.5% ±13.0 over 224 windows** — while the half production reached a median 17s later is
indistinguishable from noise.

v21 promoted it by operator decision on the pooled figure, with the version-scoping departure recorded in
the manifest. At the 2026-08-19 read the current cohort held 28 intents and **0 incremental intents** because
the candidate and production rule are now identical. The entry-policy experiment is closed. Its detached
maker observer still runs, but `buildPersistenceCandidateReport` summarizes observed fills over incremental
intents and consequently displays zero current observations; continuing that request load needs a newly
stated measurement or retirement.

The three blockers that existed before the operator promotion were:

1. **~~The maker benchmark could not answer the fill question~~ — instrumented 2026-08-18.** The recorded
   benchmark is `bid-priced return × modelled fill probability`: it prices the fill as a random draw the
   adverse-selection evidence refutes, and as a positive scaling it can never disagree with the ask
   benchmark. Intents now also carry a resting post simulated against observed trade prints, and the
   report gives **return conditional on an observed fill**. See the section below.
2. **SPEC §706 scopes evidence to the active buy-policy version.** Under that rule only the v19 cohort
   counts: 92 windows, +16.0% ±19.9 — below both the bar and significance.
3. Promotion is a manual act recorded in an immutable ledger.

### Observed maker fills on the persistence sentinel, shipped 2026-08-18; retired 2026-08-19

Design and retirement decision in
[docs/maker-post-observation-design.md](docs/maker-post-observation-design.md).
`persistence-two-consecutive-v1` recorded, per intent, whether the resting entry production would have
placed **actually would have filled**, simulated against observed trade prints.

- **What was wrong.** `makerExpectedProfitPerContract` = bid-priced settlement return × modelled fill
  probability. That prices the fill as a random draw, which the desk's own −19pp adverse-selection finding
  refutes; and being a positive scaling it can never disagree with the ask benchmark beside it. On the v19
  cohort the modelled probability ran 43–70% with a mean of 50.8%, so the tile was the bid return times
  roughly one half. It was also labelled "Maker-touch benchmark", which it never was — touch is
  `touchProbability`, documented in `lib/maker-fill-model.ts` as *inverted* against real fill rates.
- **What it did.** One order-book snapshot at post time (depth is not historical), the reprice ladder
  reconstructed from the **2-second contract path**, and one trade-print fetch after the 12-second managed
  horizon — two venue requests per intent. A post fills only when volume traded at or through its price
  exceeds the size displayed ahead of it (`lib/maker-depth-experiment.ts`), never on a touch. Both arms
  are scored: the ladder production actually walks, and a static post as a conservative floor.
- **Retirement.** Approval at 2026-08-19T04:15Z found 76 v21 intents and zero incremental intents. Shutdown
  waited for an open funded position to settle; the final 2026-08-19T04:35Z store had 80 v21 intents, all
  already production-eligible at candidate time, and no unresolved intent. The runtime
  `persistenceCandidateCycle` trigger and detached maker observer are removed. Existing evidence and report
  code remain read-only.
- **The recorded fields are untouched.** `makerExpectedProfitPerContract` and `makerFillProbability` stay
  exactly as written — the store is committed evidence — and are simply no longer reported as the maker
  benchmark. The report gains return **conditional on an observed fill**, plus the bid-priced return with
  no fill assumption applied at all.
- **Backfill: 16 intents, labelled separately and never pooled.** Of 103 intents with 60-second depth
  coverage, the bid had already moved on 87, so only 16 could be posted at the price production would have
  chosen. Those 16 score the static arm only and their fills are an **upper bound** — one 60-second print
  window against a 12-second horizon, with taker direction already discarded by that sampler.
- The live observer accumulated 12 v19 intents and 20 v20 intents before promotion. In the final store it
  had attached observations to 49 of 80 v21 intents—17 simulated fills and 32 misses—but none were
  incremental, so the active-policy observed-fill panel was empty by construction. This is not evidence
  about a persistence alternative and collection has stopped.
- The worker restarted at 2026-08-19T04:34Z. Startup reconciliation passed with 0¢ reserved, zero recovered
  fills, and zero managed remainders canceled; active operator intent was preserved.

### Where the loss comes from — decomposed 2026-08-18

Full chain in [reports/loss-decomposition-2026-08-18.md](reports/loss-decomposition-2026-08-18.md);
`npm run analyze:loss-decomposition`. Each stage is conditional on the last, so the deltas sum to the gap
between what the gate is worth and what the desk realizes. **It changes the diagnosis.**

| stage | live | Δ |
|---|---|---|
| every admitted row, at ask, held | +14.4% | |
| in windows the desk was active for | +14.3% | **−0.1%** |
| contracts it actually ordered | −1.4% | **−15.7%** |
| the ones that filled | −20.8% | **−19.4%** |
| repriced at the maker fill | −17.5% | **+3.4%** |
| with the exits it took = realized | −2.9% | **+14.6%** |

- **Window selection costs nothing** (−0.1pp). The earlier "+16.2pp for passed-over contracts" was
  ordered-cohort selection, not window selection or a demonstrated ranking effect.
- **Ordered-cohort selection is a real narrowing**: −15.7pp live, −11.8pp paper. The 2026-08-19
  decision-state replay showed it is not evidence of a ranking defect.
- **Fill selection is half its reputation**: −19.4pp conditional against −44.5pp standalone. Every prior
  reading of this policy used the inflated figure, which double-counts ordered-cohort selection.
- **The maker discount helps** (+3.4pp), confirming that switching to taking would forfeit it.
- **The exit rule is the desk's strongest component** (+14.6pp live, +17.8pp paper). Execution is not
  uniformly the problem — one part of it is carrying the rest.

One identified leak remains—fill selection—and one unexplained admitted-to-ordered cohort gap. A ranking
change does not address the latter on current evidence.

### Fill selection, stress-tested 2026-08-18 — real, stable, and conflated with window selection

Full checks in [reports/fill-selection-robustness-2026-08-18.md](reports/fill-selection-robustness-2026-08-18.md).
The −25pp fill-selection figure survives every robustness test except the decisive one:

- **Not the price effect.** Mean limit prices differ by 1.6¢; pricing both arms at their own limit and
  holding to settlement, the gap is −48.7pp (t=−3.23) live, −51.1pp (t=−3.77) paper.
- **Not a method artifact.** Free permutation of fill labels: p=0.0004 live, p<0.0001 paper.
- **Stable across all four days** of the cohort, with no drift toward zero, and negative in 26 of 26
  sub-cohorts (8/8 days, 12/12 asset-tracks, 6/6 price bands).
- **But the within-window permutation — which holds window quality fixed — is p=0.064 on live**, where
  only **21 of 140 windows** contain both a filled and an unfilled order. Paper reaches p=0.002.

So there are **two overlapping leaks**: the desk orders in worse windows (+16.2pp live, +21.3pp paper for
passed-over contracts) *and* fills the worse orders within them. Which dominates is unresolved on live, and
it decides the fix. The effect is also concentrated — DOGE/ETH/HYPE carry it on live while BNB/SOL/BTC
show almost nothing. **No execution change is authorized until the decomposition below is measured.**

### Taking the ask instead of resting — measured 2026-08-18, not supported

Full measurement in [reports/take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md); reproduce
with `npm run analyze:take-the-ask`. It was proposed as the response to the v17 fill-selection leak and
**the data contradicts the proposal.**

With the proper control — the same maker fills held to settlement rather than exited — the three effects
separate on the 206 live and 225 paper decisions of the v17 cohort:

- **The maker discount is worth keeping**: repricing the same fills at the issuance ask with the taker fee
  costs **−15.7pp live and −9.2pp paper**. Buying ~4¢ under the ask at zero fee is genuinely valuable.
- **The standalone exits help**, adding +4.3pp live and +13.0pp paper. They are not the problem.
- **The missed fills are the leak**, worth +2,869c live and +4,642c paper — the decisions the resting order
  never filled, which win about 25pp more than the ones it did.

**Taking the ask does not improve the rate of return** (−1.0% ±8.1 live, +1.8% ±7.8 paper, indistinguishable
from as-traded and from zero); its apparent cash advantage comes entirely from deploying about twice the
capital, which the 2,000c budget cannot do. It also does not replicate on v18, where it is worse on both
tracks. The problem is not maker versus taker: **the maker fills the losers and misses the winners.** A
selective rule — crossing only where the signal is worth 4¢ — is untested and is where this points.

### Entry fee semantics resolved without changing admission, 2026-08-19

The original plan and measurements are in [docs/entry-gate-fee-design.md](docs/entry-gate-fee-design.md).
Its proposed one-constant maker flip assumed maker-only production; adaptive execution invalidated that
premise because one admitted candidate may later rest or take.

The behaviour-neutral resolution is explicit by layer:

- `ENTRY_ADMISSION_FEE_ROLE` remains `'taker'`. Shared `netEdge` means immediate-execution admission edge,
  conservative for a later maker and correct for a later taker. It takes no execution mode and preserves
  the mirror invariant.
- `entryExecutionDecision` passes `'taker'` for current taker edge and `'maker'` for maker edge. Neither can
  be changed accidentally by a future admission-policy decision.
- Ask counterfactuals use the taker role and maker counterfactuals use the maker role. The dynamic
  `buildMakerShadow` report no longer charges its hypothetical resting fill a phantom taker fee.
- `venueFeeCents` and `venueFeeRate` still derive from the shared schedule. Charged whole cents retain the
  adverse rounding and 1¢ taker floor; continuous expected-value rates do not import them.
- `calendar-effects-v1` and the retired persistence store keep their stamped taker-role convention. Their
  maker-labelled durable fields require a new collection version during the collector audit; existing rows
  are not reinterpreted or silently blended.

No candidate, persistence state, ranking, size, or funded execution changes. The worker restarted on the
semantic split at 2026-08-19T05:28Z; startup reconciliation passed with 0¢ reserved, zero recovered fills,
and zero managed remainders canceled. Flipping admission to maker remains a separate policy proposal
requiring a fresh replay under current thresholds, a buy-policy version and manifest history. The earlier
1% volume estimate was measured under obsolete thresholds and is not a current impact estimate.

### Buy policy v18: the edge-spike freshness gate, shipped 2026-08-17

`buy-binary-edge-net5to35-quality50-owned55-price5to97-fresh2pp-v18` refuses an entry whose net edge sits
2pp or more above the median of its qualifying snapshots. Design in
[docs/edge-spike-sentinel-design.md](docs/edge-spike-sentinel-design.md); manifest history carries the
decision.

**This was made on an asymmetry, not on evidence clearing a bar, and the record says so.** The threshold
was chosen after inspecting the bins, on three days, with paper's own clustered interval spanning zero —
retroactive screening, which promotes nothing. What authorizes it is that declining this volume costs
roughly nothing while the book is negative, and not declining it costs real money if the effect is real.

- The rule is `lib/edge-spike-policy.ts`: pure, restrictive-only, tunable through
  `MONEY_NOODLE_MAX_EDGE_SPIKE`, with the tolerance on the refusing side so noise can only refuse.
- The gate sits in `evaluateSignalPersistenceWithRequirements` as a declared member of
  `SignalPersistenceRequirements`. That layer takes no execution mode, so the mirror invariant holds by
  construction, and the two-snapshot candidate lane states the ceiling explicitly rather than inheriting
  it, keeping its own comparison to one variable.
- `edge-spike-sentinel-v1` (`lib/edge-spike-sentinel.ts`, `data/edge-spike-sentinels.json`) records every
  decision that reaches the gate, admitted or refused, **at decision time**. Both arms come from one
  evaluation on one population; the admitted arm is deliberately not taken from the order ledger, because
  scoring real fills against a counterfactual would reproduce the maker selection the gate addresses.
  Review bar 60 resolved windows in the declined arm — a review bar, not a promotion criterion.
- **Known cost, accepted:** the version bump discards 156 accumulated v17 adaptive-regime windows and the
  gate permits entries for 12 settlement windows while it re-warms. Scoping regime evidence to the policy
  version is correct, and special-casing a "compatible" bump would start exactly the drift it prevents.

Rollback criterion, stated now rather than after the fact: if the declined arm comes back at or above the
admitted arm over enough independent windows, the gate goes. The reason for it was never that the evidence
was strong.

Remaining: a report surface for the sentinel, and one independent re-derivation of the §3 figures from the
order ledger rather than the analysis script — the specific way the v14 DOWN suspension failed.

The other open items are listed in the review's §6, and none of them changed here.

Interpretation: the newer exact ledger snapshot is slightly negative lifetime and the current live budget epoch is down materially. Stake expansion must use both views, plus drawdown, maker-fill quality, model evaluation, and reconciliation health. Do not treat a near-flat lifetime P&L alone as readiness. The fresh evidence-by-feature review is recorded in [reports/monitoring-review-2026-08-14.md](reports/monitoring-review-2026-08-14.md); it authorizes no new live feature.

## Implemented

### Forecast and Research

- Next.js App Router dashboard with charts, countdowns, data freshness states, factor drill-downs, public paper mode, signed private controls, and Money Noodle branding.
- Polymarket, Kalshi, Kraken, CoinGecko, CoinDesk, Crypto.com public spot research, and historical ingestion for configured crypto assets.
- Venue-independent settlement probability from Kraken reference/current price, realized volatility, and time remaining. Venue prices are benchmarks and execution costs, not inputs to the tradeable probability.
- Binary buy policy currently requires an enabled side, selected-side probability floor, net edge after fees, estimate quality, price band, signal maturity, portfolio selection, and execution permission.
- Every qualifying calculation and bounded non-qualifying samples are tracked with accuracy, Brier/log loss, calibration, cycle-balanced metrics, benchmarks, and realized-versus-predicted edge.
- Versioned replay snapshots preserve issuance-time probability inputs. Historical rows without exact replay inputs are labeled rather than silently reconstructed.
- Calendar/time-of-day, regime, cycle-path, funding-rate, contract-comparability, exit, maker, and action-counterfactual reports exist under [reports](/Users/raiphairow/code/money/reports).

### Execution and Safety

- Signed Kalshi balances, positions, orders, fills, cancellation, and v2 order submission.
- Source policy `maker-high30-requalify3-fresh1c-v5` permits up to three separately requalified episodes: a managed post-only maker below 30pp issuance edge, or a capped fresh-quote IOC evaluation at 30pp+. After an authoritative maker zero-fill, the next episode requires two new post-completion snapshots over 15 seconds; no nonqualifying gap is required. Maker execution supports UP/YES and DOWN/NO with passive repricing, cancellation confirmation polling, fill/fee reconciliation, and exact sub-cent accounting. The funded worker is running v5 after a quiescent restart and authoritative startup
reconciliation.
- Paper execution mirrors live's relative `entry-sizing-reduce30-below-edge30-v1` sizing and v5 episode boundary while retaining independent fills under `paper-managed-maker-requalify3-v3`. A shared pure state machine chooses the refreshed initial passive limit and all progressive reprices. Paper polls independently every two seconds while live management runs concurrently, keeps live's issuance-sized quantity, and requires opposite-outcome public taker prints to consume displayed queue-ahead volume; ask touch alone is telemetry, not a fill. Incomplete terminal trade evidence is excluded rather than scored as a miss. Portfolio/correlation/funding limits and its separate bankroll remain unchanged.
- Contemporaneous paper intents receive a separate `matched-live-fill-shadow-v1` overlay when live fills authoritatively. It is capped at observed live and requested paper quantity and records exact live price/fee terms, but cannot alter the independent paper status, budget, P&L, or public track record. The maker report exposes matched, both-filled, and live-only counts without blending the lanes.
- Explicit live arming, environment opt-in, kill switch, pause/resume, per-trade cap, order-rate cap, budget allocation, loss stops, and automatic safety suspension on ambiguous failures.
- Pause is a quiescent drain: withdraw intent, serialize behind execution, cancel/confirm managed remainders, reconcile authoritatively, and report restart-safe only when no working or uncertain transaction remains.
- Startup and periodic reconciliation read venue orders, fills, positions, resting orders, and cash before live execution. Managed remainders are canceled/confirmed; contradictory state fails closed. Prior partial reduce-only exits are included when validating original entry fills, so reconciliation does not replay the same exit or compare full acquisition history against only the open remainder. The fill-cost ceiling is the `reservedStakeCents` authorization captured at issuance, so repricing a reporting-only shadow field cannot move a fail-closed safety threshold.
- Operator intent is separated from operational state. Manual pause/kill/config changes never auto-resume; system suspensions may guarded-auto-resume only after authoritative reconciliation and normal readiness checks pass.
- Side-aware standalone reduce-only exits and protected live switching are implemented. Sell paths cannot create reverse exposure; partial/uncertain exits stop and reconcile rather than auto-chasing.
- Budget epochs, peak-equity drawdown accounting, current-epoch/lifetime P&L separation, and explicit stake-expansion criteria are implemented. The automation panel and the budget dialog date each track's figures with the moment its funding opened, from one shared formatter, and report the bankroll reset count beside it. Paper's original bankroll predates funding stamping and holds no opening timestamp, so it is anchored to its first trade (2026-08-08T21:12:37.137Z), labelled as a first trade rather than a funding; a reset dates itself from that point on.

### Data, Public Projection, and Policy Identity

- Atomic JSON writes for cache, forecast history, provider settings, budget control, execution ledger, promotion ledger, and evaluation history.
- Forecast history is sharded: a hot open set the cycle reads and writes, immutable daily shards, and per-shard rollups that reproduce the lifetime summary without loading a sealed row. The legacy snapshot is retained during coexistence and is no longer on any read path.
- A local-only Scaleway Object Storage archive is enabled against private bucket `money-noodle-archive-857bea21`. A detached nice-priority worker runs every 24 hours, stores gzip-compressed content-addressed blobs, verifies every new upload by full read-back SHA-256 and byte count, and writes an immutable manifest only after the set passes. The first verified archive covered 31 files and 471,687,329 source bytes, uploading 43,128,615 compressed bytes. This first phase performs no local deletion and never runs on Vercel.
- Optional Postgres public paper projection is implemented with migrations:
  - [001_public_paper_projection.sql](/Users/raiphairow/code/money/db/migrations/001_public_paper_projection.sql)
  - [002_public_paper_performance.sql](/Users/raiphairow/code/money/db/migrations/002_public_paper_performance.sql)
- Hosted/stateless reads can serve replicated public paper budget and performance without live credentials or execution authority.
- Hosted/stateless market calculations now use the same seven-second pre-expiry lead as the persistent server prefetch: the browser requests again eight seconds after the prior request completes, while the hard 15-second display and execution expiry remains unchanged. Stateful execution and collector cadence remain unchanged.
- Provider registry covers Polymarket, Kalshi, Crypto.com, ForecastEx, and Robinhood with per-market research/paper/live capability boundaries. New providers fail closed.
- Provider permissions are authoritative and separate for research, paper, and live. Budget venue fields are compatibility projections only.
- Per-provider budgets and per-market percentage allocations are implemented; market/global exposure caps remain global so budget splitting cannot multiply correlated exposure.
- Active policy manifest and read-only Policy view expose current forecast, buy, execution, exit, switch, regime, and provider-variant versions.
- Immutable model promotion/rollback ledger and authenticated `/api/model/promotion` write route are implemented. The route records decisions only while authenticated, same-origin, paused, quiescent, restart-safe, and with zero reserved budget. It cannot change compile-time model parameters.

## Prioritized Plan

### 1. Reduce Forecast Storage Residency

Why this is first: the process holds ~396 MB of retained heap to serve a working set of 135 rows, and adds ~40 MB a day. Extrapolated, the heap passes 1 GB in about two weeks and the default Node ceiling shortly after. Startup already costs 6-11 s to first useful response and grows linearly.

This section previously read "a 15-second system cannot keep full-history parse/stringify in the request or collector path." That premise was wrong and is worth recording as wrong, because it is what turned this into a fire drill. The parse costs ~1.2 s once per process; the ~10 s blocks were quadratic grouping in `summarizePerformance`. Sharding is still the right answer, but for memory rather than for blocking.

Started 2026-08-14:

- Added `lib/forecast-storage.ts` and `scripts/verify-forecast-storage.ts`.
- `npm run verify:forecast-storage` began as the migration gate over the legacy snapshot and journal. On 2026-08-19 that path returned `ok: true` over 52,417 rows and 10 planned shards while the active index held 58,360 rows across 12 shards, exposing that it no longer verified production storage. It now detects the active layout and checks indexed shard/rollup hashes and counts, terminal/open separation, duplicate identities, journal replay, and the direct full-history summary against the stored-rollup-plus-current-open summary. The first corrected run passed over 58,756 current rows, 57,728 sealed rows, 1,028 current open rows, 12 shards, and 1,820 journal events. `--write` refuses an active layout because only `sealForecastStorage` under the forecast write lock may mutate it.
- The gate compares the whole summary field by field, not eight counters: exact for anything countable, and a `1e-12 × max(1, |left|, |right|)` combined absolute/relative tolerance for float aggregates, because IEEE addition is not associative and a different row order legitimately moves the last digits. The absolute floor prevents last-bit noise near zero from becoming a false relative failure. Byte-identical output is not an achievable bar.
- Passing the gate required giving every reported ordering and tie-sensitive selection a total order by `id`. Ties are the ordinary case here, so `timeline`, both streaks, the per-cycle representative row, `recent`, grouped sorts, and the missed-buy selections previously could depend on durable row order. The missed-buy gate now uses the compact persisted provenance reference directly and covers an asset/window split across shards, including a globally nearest snapshot that contributes no candidate.
- A verified `--write` run over 49,703 live rows emitted `forecast-storage-v2`: 79 open rows, 49,624 terminal rows across 8 shards, and 6.6 MB of sufficient-statistic rollups standing in for roughly 190 MB of history. Both shard rows and rollups have indexed SHA-256 checksums, and the verification path now consumes the exact rollup objects that are written rather than rebuilding them invisibly from rows. The older 14 MB / 3,082-row open artifact was a symptom of event-loop starvation; resolution has caught up.
- Off-machine archive phase 1 is active: dedicated one-year Scaleway application credentials have object read/write and bucket read permissions but no object-delete or bucket-write permission. The app archives daily from the persistent worker; rolling local deletion remains deliberately disabled until repeated manifests and an independent restore test pass.

Plan:

1. ~~Build `summarize(sealedRollups, openRows)` beside the current function, both running and compared under the existing gate on live data, with nothing switching over.~~ **Done.** `summarizeFromRollups` in `lib/forecast-rollup.ts` reproduces the full summary under the gate over the 49,703-row live history, in 134 ms against 624 ms, from 6.6 MB of rollups standing in for roughly 190 MB of rows. Both paths run on every gate run and nothing has switched over. The merge depends on no property of the layout: it sorts ordered columns, merges cycles/windows by key, and globally re-selects the missed-buy snapshot per asset/window. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §4.1.
2. ~~Switch the reader.~~ **Done 2026-08-16, and measured.** `readForecasts()` returns the open set; sealed shards load lazily for the evaluator and the on-demand reports. Retained heap to serve the hot set fell from **426 MB to 17 MB** (RSS 493 MB to 70 MB): 1,549 open rows plus nine shard rollups standing in for 50,713 sealed rows. `/api/dashboard` warms in ~1 s and then serves in ~12 ms. The summary is unchanged, produced by `summarizeFromStorage` as sealed statistics plus the open rows, which the gate proves field-by-field against the direct scan.

   The switch is gated on `index.json`: absent or version-mismatched, every path falls back to reading whole history exactly as before, so it reverts by deleting one file. Sealing now also clears the journal — without that the next read replays events for rows already inside a shard and double-counts every lifetime figure.
3. Keep retention policy unchanged during the migration; this is a storage-layout change, not evidence deletion.

Rollups must come before sharding, not after. Every cycle `updateTracking` reads the whole array and the cached summary scans all of it every 60 seconds, so switching the reader while the summary still needs sealed rows would either keep the archive resident anyway or re-read the history every minute. The residency win is gated on the summary no longer needing sealed rows.

The worker boundary previously listed here is deferred indefinitely. It relocates work without reducing residency, which is not what binds. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §5.

Done means: retained heap and startup time measurably drop, forecast scoring matches pre-migration output under the gate, 15-second collection remains fresh through restart, and the dashboard can report degraded rollup state explicitly. **All four met as of 2026-08-16.** `/api/performance` carries `forecastStorage`, and the signed Performance dialog shows an explicit incomplete-figures notice when a shard rollup cannot be read — a missing rollup still produces a summary, just from fewer shards, so silently under-reporting a lifetime figure is the failure this guards against.

Two follow-ups remain, neither of which is residency:

- **Payload split** (design §7 item 2, agreed separately): the freshness badge should judge only market data, so no future slow subsystem can blank the trading view.
- **Retire the legacy snapshot.** `data/forecast-history.json` is 207 MB, frozen since the seal, and on no read path — it is the coexistence copy. Deleting it is what makes the switch irreversible, so it should wait until the sharded layout has run through several seals and an evaluator pass.

### 2. Build the Long-Shot Round-Trip Policy

Started 2026-08-14. A second policy on `crypto-15m`, running beside the edge policy. The launch cohort
bought a side whose executable ask reached 10¢ with at least ten minutes left and sold through a one-second
reduce-only IOC poll at 90¢. **The active local cohort changed on 2026-08-18 to 12¢→97¢/600s, paper only.**
That change was selected from a 50-cell retrospective fine-path sweep, so it starts a new forward collection
cohort and is not evidence-backed promotion. Design and launch arithmetic are in
[docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md);
SPEC §12.10 and the 2026-08-14 decision-log entries carry the decisions.

This is a new trading feature, which the guidance above deprioritizes relative to storage and evidence. It
is being built anyway as an explicit operator decision, under a bounded learning budget: 30% of the
`crypto-15m` cap, a 20¢ opening ticket, and a derived halt at 300¢ of policy equity. Roughly $7–12 buys the
~60 resolved attempts needed to separate "real" from "hopeless," which is the only question that sample size
can answer.

What the screening does and does not support is recorded honestly. Buy-and-hold on this trigger has no edge:
20.2% ± 3.7pp over 119 candidates against a 22.2% break-even, so the cheap side wins about exactly what it
costs. The round-trip exit is **unmeasured**, and that is the reason to collect rather than a reason to
believe. (The "68.4% where the true figure must be 100%" reading of that blindness is **withdrawn** as of
2026-08-17: winners need not pass through 90¢, because these contracts settle on a close-price comparison.
See design §14b.)

Delivery order:

1. ~~Pure rule layer and ticket/cap arithmetic.~~ **Done.** `lib/long-shot-policy.ts`. Entry rule, ticket
   sizing, caps, and round-trip economics asserted against the production fee and sizing code rather than a
   copy, so a fee-model change breaks the test.
2. ~~`strategyId` on orders and summaries.~~ **Done.** `lib/strategy-registry.ts`, absent meaning the edge
   policy exactly as absent `marketId` means `crypto-15m`. One ledger, not two, because reconciliation is
   account-wide and a split file would leave real resting orders unmatched. `lib/strategy-isolation.test.ts`
   pins the money boundary in both directions.
3. ~~Per-policy budget sub-allocation and the derived halt.~~ **Done.** `lib/strategy-budget-policy.ts`. The
   percentage funds a strategy once; its equity then rolls forward on its own P&L. Applying the percentage
   continuously would size one strategy's ticket from the other's results and dilute its own losses so the
   halt could never fire on the strategy that earned it.
4. ~~Resting reduce-only GTC limit exits.~~ **Superseded.** Kalshi refuses `reduce_only` with
   `good_till_canceled`; verified against the production API. `lib/target-exit-policy.ts` polls the
   owned-side bid every two seconds and submits a reduce-only IOC at the mark instead.
5. ~~Buy-and-hold sentinels, written at trigger time.~~ **Done.** `lib/hold-sentinel.ts`.
6. ~~Contract price-path recorder.~~ **Done.** `lib/contract-path.ts`. Compact per-window triples rather
   than the rewritten array `cycle-path-store` uses, at under 700 KB/day.
7. ~~Reporting split by entry generation and regime.~~ **Done.** `lib/long-shot-report.ts`.

8. ~~Durable stores and collection wiring.~~ **Done, collection only.** `lib/contract-path-store.ts`,
   `lib/hold-sentinel-store.ts`, and `lib/long-shot-execution.ts` run detached from `processCycle`
   alongside the calendar and persistence lanes. Contract paths and hold sentinels accumulate from the
   next cycle onward.

9. ~~Execution.~~ **Done.** `runLongShot` and `runLongShotExits` in `paper-execution.ts`, inside the
   serialized engine queue and deliberately separate from `runPaper`/`runLive` — threading a second policy
   through the edge policy's selection, persistence, maker-retry, portfolio-ranking and regime-gate path
   would change behaviour the mirror invariant depends on. Exits run before entries so a position that
   reaches its mark frees its slot for a same-cycle re-entry.
10. ~~One-second exit poll.~~ **Done.** `TARGET_EXIT_POLL_MS`. Quotes are fetched outside the write queue and only the ledger
    mutation is queued, per the 2026-08-14 decision that upstream waits must not sit inside the queue they
    serve. A tick never queues behind itself, so a slow venue produces fewer polls rather than a backlog.

Paper-enabled and running as of 2026-08-15; the separate live flag is currently false. Entry is a price-capped taker IOC at the mark — an explicit exception
to maker-only production execution, because the trigger is defined as the ask reaching the mark. Every
account-wide protection still applies unchanged: kill switch, live arming, the reconciliation barrier, the
drain, and the shared hourly filled-order ceiling.

Funded at 30% of the Kalshi `crypto-15m` cap: 600¢, a 20¢ ticket, halting below 300¢. `npm run fund:long-shot`
reports and re-applies it, refusing unless automation is paused with nothing reserved or open.

Current state, read 2026-08-19: the paper lane is running and **the long-shot live lane is blocked by its own
per-strategy arming flag** — `liveEnabled` is false because `MONEY_NOODLE_LONG_SHOT_LIVE_ENABLED` is unset.
At the capture-repair read, the 12¢→97¢ v1 cohort had 9 resolved paper attempts in 5 windows, −447¢ on
447¢ with no mark exit. It is now historical: deterministic mandatory trailing advances the order policy to
v2. Its v1 hold records are invalid for pairing; the hold-v2/order-policy-v2 60-window review cohort starts
prospectively at zero and does not backfill those orders.
It is *not* blocked by the desk controls, which are `state: active`, `mode: live`: the desk is armed for
the edge policy. Distinguishing the two is the whole point of the separate flag, and conflating them is
what placed three unintended live long-shot orders on 2026-08-15. No breaker is involved either way — the
edge policy's loss gate is clear. Contract paths are accumulating across all seven assets.

**Historical launch cohort as of 2026-08-17:** 25 resolved paper attempts under
`long-shot-round-trip-buy10-sell90-win600-v1`, of which 1 sold at the mark, against the 60
`LONG_SHOT_REVIEW_ATTEMPTS` required before a first review. That cohort was superseded before reaching its
bar and must not be pooled with 12¢→97¢. The three `sold` rows in the earlier
`buy40` cohort were strict-value exits, not round trips: `observeAndExecuteStandaloneExits` is now scoped
to `EDGE_BINARY_BUY` precisely because it closed long-shot positions at 48–76¢ on 2026-08-15. Do not read
them as the exit working.

Live findings so far, in the order they were measured:

- **Cheap sides are common; cheap sides *early* are rare.** Only 2% of sides that reach 10¢ do so inside
  the first five minutes — a contract becomes cheap *because* the underlying already moved, so cheapness
  and clock-remaining are close to mutually exclusive. The entry window, not the price mark, is what
  limits candidate flow.
- **Fifteen-second entry sampling was not the constraint.** Of 586 recorded cheap-side episodes, only 13%
  lasted a single sample and half persisted beyond ninety seconds. One-second polling was added anyway,
  for the shared quote cache and to make a wider window affordable, not to catch flickers.
- **A still-falling price is a trend, not a dip.** Candidates still falling at the next sample reached 90¢
  0.9% of the time against 2.6% for those that stalled. Real, and worth filtering — but it moves the rate
  from 2.2% to 2.6% against a 12.5% bar.
- **No configuration of marks clears break-even.** All sixteen cells of an entry/exit sweep land between
  0.48 and 0.72, and the flatness rather than the best cell is the finding. See
  [docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md) §14a and
  `npm run analyze:long-shot-marks`.
- **No buy→sell *gap* is priced loosely enough to pay either**, measured 2026-08-17 over 1,506 windows
  spanning 62 hours. Banding the entry (so a 40→60 row describes buying at 40, which a cumulative ≤40¢
  cohort does not) and grading misses at their real settlement, 131 populated cells span 0.43–0.82. The
  touch rate tracks break-even at ~0.6–0.8× of it everywhere: narrow gaps are achieved more often in
  almost exact proportion to paying less. See §14b and `npm run analyze:long-shot-gaps`.
- **Selling earlier trades return for the appearance of success.** Dropping the exit from 90¢ to 20¢ raises
  the sold-at-mark rate from 8.2% to 26.5% by selling all five winners in the cohort at ~2× rather than
  letting them settle at ~10×, in exchange for rescuing 8 of 44 losers. Paired on identical triggers, every
  exit earlier than 90¢ is negative; only 95¢ (+0.044) and never selling (+0.088) are positive, both
  t=1.76 among 17 comparisons. **Sold-at-mark rate is not a proxy for return, and moves against it here.**
- **The coverage correction is withdrawn, and with it the last cell above break-even.** Both §14a's
  1.36× and its successor rested on "every winner passed through 90¢ on its way to 100¢". **That is false
  here**: these contracts settle on a close-price comparison, and over 1,033 resolved windows the winning
  side was still bid **below 90¢ in 10.0% of cases**, below 10¢ in 0.8%. The like-for-like replacement —
  dense 1s paths decimated to 15s — implies 1.00–1.25× where entry detection is stable and swings wildly
  at ≤10¢, so **no correction is applied**. Uncorrected, **not one of the 131 grid cells clears 1.00**;
  the best reaches 0.82. This also removes the structural argument in design §3.3 that selling early beats
  holding — about a tenth of winners are reachable only by holding, which is the direction the paired
  never-sell comparison already pointed.
- **No entry filter screens out bad candidates.** Thirty entry-time filters measured 2026-08-17 on the
  wide ≤30¢ cohort (n=429) and re-checked in the production band. Closed off as unsupported: **the
  forecast model as a veto** (it prices the side at or above the ask on 100% of production-band
  candidates — there is no disagreement to trade on, so the entry rule ignoring the forecast per design §2
  costs nothing), **spread filtering** (98% of candidates sit inside 4¢), and **asset exclusion** (no
  asset is 1.6 SE from the cohort mean; §13 stays empty). The stall filter measures a 1.04 lift here
  against the 0.9%-vs-2.6% reading §7 records — a disagreement, reported rather than smoothed. See
  [reports/long-shot-filter-screen-2026-08-17.md](/Users/raiphairow/code/money/reports/long-shot-filter-screen-2026-08-17.md)
  and `npm run analyze:long-shot-filters`.
- **The one signal that separates candidates does not select any.** Three separately-derived measures —
  fell <10¢ from the window high, local volatility <0.1%, volatility ratio <1 — move together and all say
  *the side that got cheap without a big move is the better bet*, which is the opposite of the intuition
  that a long shot needs a large move. It **keeps 1 of 49 candidates at ≤10¢**: sides reach 10¢ *by*
  collapsing, restating §7. The subset surviving the confound check is stronger (n=16, ratio 1.27, return
  +0.834 ± 0.391) but its mean entry is **28.8¢** — a different strategy, not a filter on this one, and
  n=16 after thirty tests is a hypothesis rather than a result.

Evidence stance: **stop tuning; treat 12¢→97¢ as a fresh paper cohort.** Nothing measured authorized the
parameter change. On the current 2-second retrospective sweep the selected cell held 149 entries, ratio
0.83, sell-at-mark +9.0% ±46.3pp and hold +11.5% ±47.3pp; it was one of 50 screened configurations. Only
forward records under its derived version may answer whether anything survives selection, and the current
hold-sentinel capture gap must be closed first.

**Revisit triggers.** The dense-path trigger has arrived: on 2026-08-19
`npm run analyze:long-shot-fine-marks` covered 562 settled fine windows at a mean 266 samples each. Finer
sampling raised touch rates but did not produce a promotable mark; the only displayed ratio above one had
an interval spanning zero and trailed hold. The remaining first-review trigger is **60 resolved attempts at
one policy version** (`LONG_SHOT_REVIEW_ATTEMPTS`). The 12¢→97¢ v1 execution cohort had 9 attempts in 5 windows at the repair read. It is superseded by the
mandatory-trailing v2 policy; invalid hold-v1 records are excluded, and `long-shot-hold-v2` starts a fresh
prospective 60-window review cohort paired only with order-policy v2.

**A proposed volatility-trading strategy was measured and does not work as described** (2026-08-18,
[reports/maker-fill-adverse-selection-2026-08-18.md](/Users/raiphairow/code/money/reports/maker-fill-adverse-selection-2026-08-18.md),
`npm run analyze:maker-fills`). Entering on an intra-cycle direction change far from the 50¢ open is a
**coin flip**: eighteen configurations on the unbiased fifteen-second data, 1,200–2,000 signals each, all
between 48.3% and 50.5% with every interval covering 50%. And the taking economics are prohibitive — a
round trip at 70¢ needs an **8.14¢ move** at the current ticket and never less than ~4¢ at any size,
because most of the cost is proportional. Fees peak at 50¢, so trading near the middle is worst.

What survives is **execution, not prediction**: Kalshi charges nothing on a resting fill, so posting
collects the spread rather than paying it. Resting buys show **no detectable adverse drift** — every
horizon indistinguishable from zero across 15,000–17,000 fills over 1,611 windows, against an
unconditional control at zero. That is *no evidence of* adverse selection rather than evidence of none:
the mechanism is queue position, and a fifteen-second sample cannot distinguish a one-tick touch from a
sweep. Settling it needs depth recorded at the posted price over time, which the contract-path recorder
does not carry although the venue exposes it. **Nothing here authorizes a market-making strategy.**

**The bounded maker-fill experiment stopped and its persisted sample cannot answer the question**
(2026-08-19 review in [reports/open-experiment-status-2026-08-19.md](reports/open-experiment-status-2026-08-19.md)).
It collected 10,448 rows over 447 asset-contract windows and 64 settlement windows during 16.6 hours on
2026-08-18. The standalone process is no longer running.

The intended fill rule in `lib/maker-depth-experiment.ts` is sound: a post fills only after traded volume at
or through its price exceeds size displayed ahead at posting. The recorded schema is not sufficient to
apply it. `fetchKalshiTradePrintsSince` returns `takerSide`, but `scripts/experiment-maker-depth.ts` discards
that field and persists every print on both outcome scales. Only an opposite-outcome taker consumes a
selected-side resting bid, so one print can be credited as queue progress on both sides. The resulting fill
rate is an upper bound and post-fill drift is not decision-grade. Its package command and historical
backfill command were removed on 2026-08-19, and both scripts now fail closed if invoked directly. Any new
depth measurement needs an agreed prospective schema carrying taker direction; displayed queue would still
remain a proxy for private FIFO rank. **Nothing here authorizes a market-making strategy.**

**The swing-trading premise is measured and closed** (2026-08-18,
[reports/swing-trading-2026-08-18.md](/Users/raiphairow/code/money/reports/swing-trading-2026-08-18.md),
`npm run analyze:swing-exit`). The swing is **real** — the owned-side bid reaches entry +2¢ in 64–81% of
positions — and selling into it loses to simply holding in every band and target size, by about 0.15 per $1
over 2,835 positions. A high hit rate with a capped gain and an uncapped loss is the shape.

Two further results from the same file:

- **Trajectory is a real signal, and smaller than the cost of taking it.** Trend efficiency (`slope ÷
  range`, already computed as `cycleRegime.trendEfficiency`) shows monotone mean reversion worth 2–3¢
  between extreme quintiles, and it **survives** measurement on a single consistent price series — bid-only
  t=3.52, ask-only t=2.64 — so it is not merely bid-ask bounce, though the spread's own reversion is
  enormous (t=20.65) and accounts for roughly 1.5¢ of the 3.3¢ mid effect. Traded as a taker it still loses
  (−1.4 to −2.1¢ gross before fees), because **the spread is widest exactly when trend efficiency is
  extreme**: a ~2¢ signal cannot cover a ~3.5¢ entry. An earlier reading here called it pure bid-ask bounce
  and is withdrawn. Any trajectory feature must be reported in traded form beside observed form.
- **A stop helps substantially and does not rescue it**, cutting the loss from −0.20 to −0.07 per $1. This
  **corrects §15b**, where stops appeared to hurt: that reading used the lowest bid of the whole window
  with no ordering and so fired the stop on positions that had already hit their target. Note the
  structural tilt it exposes — at a symmetric ±3¢ the stop fires 66% against the target's 30%, because
  entry pays the ask and is marked against the bid, putting the stop about a spread closer.

**Fine path recording is live** (design §18, 2026-08-18). Every eligible contract is now recorded at
**two seconds** rather than fifteen, using quotes `longShotEntryTick` already fetches for the entry
decision — **no additional venue requests**. Before this, fine sampling began only once a side fell below
the entry mark, at roughly 9¢/91¢: across 57 such windows, **zero** had the 20–80¢ range inside the fine
region, so every trajectory measurement in this repo was made at a resolution that hides ~37% of price
movement and conceals a 2¢-or-larger swing in 8.7% of intervals. Compaction thins windows older than
`CONTRACT_PATH_FINE_RETENTION_DAYS` back to the coarse grid, so the resolution is not a permanent ~130 MB
liability.

A standalone two-second poller was tried first and **withdrawn within a minute**: it rate-limited the live
desk inside thirty seconds on the endpoint it was polling. Kalshi's budget is per account and the repo's
limiter is per process, so a second process duplicating the desk's reads competes with it. Recorded here
because the instinct to add a separate collector will recur.

The one open hypothesis is the **quiet-market signal** above. If it is worth testing it needs a committed
sentinel arm at a higher entry band, written at decision time and followed to settlement — not a filter
bolted onto a policy whose candidates it does not select, and not a retroactive re-screen (§5.5). That is a
design decision, not a parameter, and is unstarted.

**Operator-defined analysis bands are implemented** (design §15a). The dashboard's long-shot dialog now
carries a band editor: each band is one hypothesis — buy inside an entry range, sell at an exit — measured
against every recorded window, with touch rate, break-even, ratio, and clustered return per $1. Saving
starts no backfill, because the stored candidate summaries carry no band, entry mark, or entry window:
`lib/long-shot-candidate.ts` keeps the first occurrence of each distinct ask with the peak bid reachable
after it, so any band is a lookup. Measured on the current data, backfill of 1,590 paths takes 69ms and a
band evaluates in single-digit milliseconds.

Two guards are structural rather than procedural, because this is a retroactive-screening surface and
AGENTS §5.5 says screening may filter an idea and may never promote one: no module that can price, size,
gate, or trade may import the band store (`lib/analysis-bands.test.ts` asserts it), and the number of
configurations ever evaluated is displayed as the multiple-comparison denominator.

Remaining: the report surface, and the durable stores' retention policy once the journal starts growing.

Done means: the policy trades paper and live under the mirror invariant, the edge policy's behaviour is
byte-for-byte unchanged, exposure caps and the shared kill switch/reconciliation/drain still bind across
both, and 60 resolved attempts are reportable against the 12.5% break-even clustered by settlement window.

### 3. Harden Walk-Forward Review Before Any Model Promotion

The evaluator and promotion ledger exist, but promotion criteria still need to become decision-grade.

Remaining work:

- Add review thresholds for held-out Brier/log loss regression, coverage, drawdown, and window-clustered uncertainty.
- Report signal-policy return separately from maker-executable return so model quality is not confused with fill selection.
- Add the explicit clock/quality candidate dimension now that quality replay inputs are persisted prospectively.
- Correct for winner's curse from selecting the largest apparent edge across correlated assets.
- Require stable held-out return across enough independent windows before any parameter deploy-and-record cycle.

Current stance: baseline retained. Latest run `walk-forward:875:fnv1a-27542176` (2026-08-18T22:00:08Z)
returned +5.75% candidate versus +2.37% baseline mean window return over 438 test windows and beat baseline
5/5 folds, but was positive only 3/5 with modal parameters in 3/5. No automatic evaluator result may change
production, and no manual promotion should be recorded unless every evidence gate clears.

### 4. Decide the Profit-Reversal Exit Policy From Prospective Evidence

Strict value exits and the 75% profit-reversal lock are measured separately. Strict value remains executable. `profit-reversal-75-v1` is already withheld from execution by default on its own negative evidence; arming and high-water observations continue so the counterfactual remains prospective. The local environment explicitly keeps it disabled.

Remaining work:

- Keep collecting complete position paths so HOLD arms are no longer approximate.
- Re-run exit policy reports after enough new armed downturns under the current implementation.
- Require a separate manual evidence review before `MONEY_NOODLE_PROFIT_REVERSAL_EXIT=true` may restore execution or before a replacement reduce-only rule is introduced.
- Preserve strict reduce-only semantics: exits reduce only existing exposure and never become opposite-side buys.

The small historical live cohort supports conservative withholding, not permanent refutation or a replacement rule.

### 5. Accumulate and Evaluate Maker Queue/Depth Evidence

Instrumentation and the queue-aware paper simulator are implemented; the next step is held-out evidence, not live execution changes. Before this deployment, same-signal paper/live maker agreement was only 29.7% across 37 paired attempts (19 live-only fills and 7 paper-only fills), which is the baseline the new independent and matched-live lanes must improve on prospectively. The first post-deployment review has only 2 matched intents.

Remaining work:

- Segment fill and return by displayed-ahead proxy, imbalance, repricing path, resting duration, profit state, probability deterioration, asset, side, and time remaining.
- Compare accepted filled orders with accepted no-fills by settlement window.
- Measure independent-paper/live agreement and disagreements against the separately stored matched-live overlay; never substitute the selected live fill for the independent paper result.
- Recalibrate maker fill probability only after enough prospective fills and no-fills exist under
  `paper-managed-maker-requalify3-v3`; keep the retired v2 cohort separate.
- Current execution identity is `maker-high30-requalify3-fresh1c-v5` with
  `entry-sizing-reduce30-below-edge30-v1`. Below
  30pp each qualified episode is a reduced-size managed maker; at 30pp+ it is one full-base capped IOC only
  after the exact refreshed quote re-clears every absolute gate. A maker zero-fill may requalify up to the
  three-episode ceiling, but there is no taker fallback. Historical v3/v4 rows retain their execution stamps
  and must not be pooled with v5.
- The pre-decision shadow had shown no discrimination: over 618 stamped orders on 2026-08-18, 74 were
  taker-flagged but all executed maker; flagged and unflagged fill rates were 51% and 50%, and fill-selection
  gaps were −11.2pp and −13.1pp. That evidence did not authorize v4 or v5; both 2026-08-19 changes are
  explicit operator decisions, not claimed promotions.
- A wholesale switch to taking remains only the counterfactual in
  [reports/take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md). It is not the deployed policy.

Forbidden for now: depth-aware sizing, any multiplier above 1, more than three entry episodes, rearming
without fresh post-completion persistence, rearming after any fill or taker result, taker fallback after a
maker miss, direction-based production cancellation, bypassing any fresh high-edge gate, or queue-aware live
gates.

### 6. Verify First Organic Live Switch and Continue Exit Verification

The switch engine, reconciliation matcher, partial-exit handling, replacement withholding, and switch-versus-hold accounting are implemented and tested. A real organic switch has still not been economically verified end to end.

When it occurs naturally, verify:

- Reduce-only exit order side/action.
- Venue fills, fees, remaining quantity, and reservation release.
- Replacement withholding after zero or partial exit.
- Replacement submission only after a complete confirmed exit.
- Switch-versus-hold and standalone exit counterfactual accounting.

Never force a live switch just to exercise the path.

### 7. Provider Variant and Policy Visibility Follow-Through

The provider registry foundation is in place. The next useful work is observability and clean attribution before new execution adapters.

Remaining work:

- Add dashboard, performance, open-order, and decision-history filters for live/paper, provider, provider variant, market, and policy version.
- Move static policy manifest details into a durable model/policy registry with historical parameter diffs, dataset fingerprints, and audited promotion/rollback lineage.
- Add per-(provider, market) policy overrides for thresholds, sizing, and execution style.
- Defer candidate-set funding/ranking changes until there is a second live-capable provider, because it cannot change behavior before then.
- Add any new provider read/paper-first behind official API verification, operator eligibility, and explicit capabilities. No scraping path may imply live capability.

### 8. Secondary Work After Safety and Evidence

These are useful, but lower priority than storage, evaluation, exits, and maker evidence:

- Operator alerts for fills, orders, settlement, reconciliation, and drain state.
- Historical execution replay/backtesting with clearly labeled reconstructed assumptions.
- Demo/sandbox venue testing where supported.
- Consolidated venue exposure/P&L views that never blend live with paper.
- Durable workers, leases, backups, restore tests, runbooks, and deployment observability.
- Same-origin/CSRF enforcement on every mutation or billable research route, not only trading/model-promotion controls.
- Dependency pinning and security cleanup for packages currently set to `latest`.
- GitHub unreachable-object purge request and confirmation that the old Kalshi key ID is revoked.

## Guardrails

- Do not increase stake size from live P&L alone. Require independent live windows, lifetime and current-epoch P&L, drawdown, maker adverse-selection evidence, walk-forward results, reconciliation health, and real switch/exit verification.
- Do not add venue prices to the tradeable probability. They remain benchmarks and execution costs.
- Do not promote DOWN/NO or any side-specific gate mechanically. Side-specific profitability must be proven in held-out clustered windows.
- Do not manually trade the same active Kalshi ticker while automation owns or may enter it; shared-account netting has already caused reconciliation to block correctly.
- Do not let public/stateless deployments gain execution authority. They may read replicated paper projections only.

## Retired From Roadmap

These were previously listed as remaining work and are now implemented:

- Accepted-order `not_found` consistency handling and separated issuance/approved/submitted/amended/fill prices.
- Exact-contract maker-execution paper shadow, shared live/paper repricing transitions, public trade/queue fill evidence, and separate matched-live overlays.
- Explicit averaging-window parsing, Kraken-to-venue reference drift, and target-integrity reporting.
- Complete position-lifecycle, liquidation, queue/depth, and path observations.
- Versioned HOLD/EXIT/SWITCH action counterfactuals.
- Separate strict-value versus profit-reversal exit reports.
- Durable budget epochs, peak-equity drawdown, and stake-expansion criteria.
- Immutable model promotion/rollback core and authenticated write route.
- Public paper performance projection to Postgres.
- Market identity, per-provider tracking, per-provider budgets, and global-caps regression guard.
