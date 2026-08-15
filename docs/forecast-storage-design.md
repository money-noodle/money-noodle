# Forecast storage redesign — sharding and rollups

> Design · 2026-08-14 · **partly implemented, re-scoped after measurement**
> Companion to [`SPEC.md`](../SPEC.md) §6 Storage. Nothing here changes the model, execution, or any gate.
>
> The stall this document was written to fix turned out not to be a storage problem, and is already
> fixed (§1.1). What survives is a memory-residency problem that sharding genuinely solves (§5.1). The
> worker boundary in the original title is deferred (§5), and the sequencing in §7 is the current plan.

## 1. The problem, with evidence

> **Corrected 2026-08-14 after direct measurement.** The stall was real and the lockstep evidence below
> is sound, but this section originally blamed `JSON.parse`/`JSON.stringify`, and that attribution was
> wrong. The block was `summarizePerformance`. See §1.1. The layout goals in this document still stand
> on their own merits; the ten-second figure that motivated them does not.

`data/forecast-history.json` is a single JSON array, now **48,291 rows / 228.8 MB**.

The operator symptom is "Calculation window expired". It disguises itself as slow upstreams, because
feed timing is measured in wall time:

```
Slow feed: coingecko    took 11363ms
Slow feed: polymarket   took 11361ms      four unrelated hosts,
Slow feed: kalshi       took 11359ms      identical to within 7ms
Slow feed: price-series took 11356ms
```

Four independent hosts do not stall in lockstep. The loop was blocked and every in-flight feed
recorded the same elapsed time. The same fact defeats the 6-second feed deadline added earlier: a
`setTimeout` cannot fire while the loop is held. That reasoning was correct — only the culprit was
misidentified.

### 1.1 What the block actually was

Measured against the real 48,291-row history:

| Operation | Cost |
|---|---|
| `JSON.parse` of the 228.8 MB file | **1.2 s** |
| `JSON.stringify` of the same | **0.63 s** |
| All eight durable stores, parsed *and* written once | **2.0 s** |
| `summarizePerformance(forecasts)` | **9.6–13.1 s** |

The parse is also not per-cycle: `readForecasts` caches the promise (`forecastCache ??= loadForecasts()`),
so the file is parsed once per process. `summarizePerformance` runs behind a 60-second cache on the hot
path, and it alone accounted for the entire observed stall.

A CPU profile put 43.8% of its samples in the garbage collector, 24.7% in `bucketed`, and 15.7% in
`slices`. All three were one bug: grouping rows with `map.set(key, [...(map.get(key) ?? []), item])`,
which copies the whole bucket on every row. That is O(n²) copies and the allocation churn is what the
collector was cleaning up. `byDirection` groups ~27k resolved rows into two buckets, which is the shape
that punishes copy-on-append hardest.

Replacing the six occurrences with an in-place append took `summarizePerformance` from **9.6 s to
~0.7 s**, with the serialized summary verified **byte-identical** over the full history.

This changes the case for the rest of this document. In particular, §1.2's rejection of the cheaper
fixes was argued from the ten-second figure — at 1.2 s to parse, "a 15-second cycle cannot absorb a
7-second stall" no longer follows. Sharding and the worker boundary remain defensible for growth,
startup cost, and the evaluator, but they should be re-justified on those grounds rather than on a
hot-path stall that has already been removed.

**Still outstanding:** the same quadratic idiom appears at 16 other sites. Most group into many small
buckets and are harmless, but `lib/forecast-storage.ts` groups every terminal row by day shard — few
buckets, tens of thousands of rows each — and would reintroduce this exact stall in the code meant to
cure it. Fix that before the rollup path ships.

Growth is ~8–10k rows and ~45 MB per day, all of it retained:

| Day | Rows | MB |
|---|---|---|
| 2026-08-09 | 8,392 | 26.3 |
| 2026-08-10 | 8,253 | 44.5 |
| 2026-08-11 | 8,341 | 45.0 |
| 2026-08-12 | 10,375 | 45.8 |
| 2026-08-13 | 9,597 | 40.9 |

Only `qualified === false` rows are capped (at 20,000). The 27,536 qualified rows are retained
forever by design — they are the calibration record — so the file only grows.

### 1.2 Why the cheaper fixes were rejected

De-duplicating `venueContracts` into registry references was measured end to end: **213.6 MB → 176.3 MB,
17.5%**, taking the block from ~10s to ~8s. Adding a factors-prose strip reaches ~145 MB and ~7s. A
15-second cycle cannot absorb a 7-second stall, so shrinking the file is not a fix. Daily sharding
alone fails for the same reason: one day is still ~45 MB.

The conclusion that shapes this design: **the file must stop being read whole on the hot path**, and
no parse should be able to block the loop regardless of size.

## 2. What the hot path actually needs

| Consumer | Frequency | Actually needs |
|---|---|---|
| Append new forecasts | every cycle | nothing historical |
| Find due-for-resolution | every cycle | `pending` rows only — currently **3** |
| `summarizePerformance` | cached 60s | lifetime aggregates, not rows |
| Walk-forward evaluator | every 25 windows | everything; may be slow |
| `/api/performance` list | on demand | most recent 500 |

Nothing on the 15-second path needs the 49,478 terminal rows, and a terminal row is immutable. We hold
all of them resident only because they share one array — which is the residency cost in §5.1, and the
reason this table is the design's real justification now that the stall is gone.

## 3. Data layout

```
data/forecast-history/
  open.json                 hot set: pending + unresolved rows (~205 rows, ~1 MB)
  2026-08-13.json           sealed daily shard, append-only, never rewritten
  2026-08-13.rollup.json    sufficient statistics for that shard
  2026-08-14.json           active shard for today
  index.json                shard list, row counts, checksums, schema version
```

- **Hot set** (`open.json`) holds every row not yet in a terminal state. The cycle reads and writes
  only this. A row moves into the day's shard when it reaches `resolved` or `invalid`.
- **Sealed shards** are immutable once the day passes. Nothing rewrites them, so they never need to be
  parsed by a writer.
- **Rollups** make lifetime performance a sum over per-shard statistics instead of a scan over rows.
- **`index.json`** is small and always loaded; it is the only whole-history structure on the hot path.

The existing journal keeps its role for the hot set, giving the same crash semantics it has now:
append first, snapshot on compaction. Sealing a shard is the compaction step for resolved rows.

## 4. Rollup algebra

`summarizePerformance` must reproduce its output under the gate below — exactly for everything
countable, within a documented float tolerance for the aggregates. Its statistics fall into three
classes, and each needs a different merge rule. This is the part most likely to be got subtly wrong, so
it is specified explicitly.

**Additive** — a plain sum per shard: `issued`, `pending`, `resolved`, `correct`, `invalid`,
`observedCalculations`, `realizedEdgeTrades`, Brier sum, log-loss sum, predicted-edge sum,
realized-return sum, and every `benchmarks` entry (each is a count plus sums over one probability
source). Grouped slices — `byAsset`, `byDirection`, `byLeadTime`, `edgeBuckets`, `calibrationBins`,
`segments` — are additive per group key.

**Distinct-set** — `cycles`, `resolvedCycles`, `calibrationWindows`, `resolvedWindows` are cardinalities
of id sets. Each shard stores its distinct keys (~2k cycle ids/day, far smaller than the rows) and the
merge is a union. Exact, not estimated: these counts gate calibration readiness and must not drift.

**Non-additive** — four cases needing explicit handling. What each needs was decided by measurement
rather than by reasoning about worst cases; see §4.1, which removed most of the difficulty this section
originally anticipated.

- `cycleBalancedAccuracy` is the mean over cycles of per-cycle accuracy, so a shard stores per-cycle
  `(correct, total)` pairs rather than a ratio. Cycles are shard-local in practice (§4.1), but the pairs
  still merge by cycle key so that a future straddling cycle degrades to a correct answer rather than a
  silently wrong one.
- `currentStreak` and `currentCycleStreak` cannot be read from the tail of the newest shard: the longest
  streak in the retained history is **268 rows**, which crosses shard boundaries. Both are taken as the
  leading run of the merged sequence, which the merge sorts for itself (see §4.1).
- `timeline` is per-row with a rolling 25-row window, and the 500 downsampled points are chosen by index
  into the whole sequence. No fixed-size per-shard statistic reconstructs that. Each shard therefore
  stores a **compact column** of `(id, time, correct, brierScore)` for its resolved qualifying rows —
  about 100 bytes per row against ~4 KB today, so roughly 4 MB for the whole history against 198 MB.
  This is the one place a rollup is O(rows) rather than O(1), and it buys exactness: `timeline` is
  reproduced rather than approximated. The alternative — reconstructing it from aggregates — was
  rejected because it would make `timeline` the only statistic knowingly unequal to the current output.
  The `id` is carried because it is the tie-break on every reported ordering, and the merge sorts rather
  than concatenates.
- `recent` is a top-8 over qualifying rows including pending ones, so ties decide membership. Each shard
  stores its own top 8; the merge is a top-k merge and needs no ordering assumption at all.

`missedBuyCounterfactual` runs over all forecasts including unqualified ones, so it needs its own
counters rather than riding on the qualified path. Its per-window values are stored **unclustered**, as
`(window key, sum, count)`, and merge by key — as do `segments`' per-window returns. Averaging inside a
shard would turn a window split across two shards into two observations, inflating the window count and
moving the very standard error the clustering exists to keep honest.

### 4.1 What the measurements changed, and what they got wrong

Four properties of the retained history were measured before any of this was built, because each one
decides a design rather than an implementation detail. Three of them removed difficulty this section had
assumed.

| Measured | Result | Consequence |
|---|---|---|
| Rows resolving on a different day than issued | 648 of 49,526 (1.31%) | Shards are keyed by issuance day but ordered statistics key on `resolvedAt` |
| Inversions between `resolvedAt` order and shard order | 0 at the time — **and it did not hold** | See below: the merge sorts instead of concatenating |
| Cycles spanning more than one shard | 0 of 2,432 | True today, deliberately not relied on: cycles merge by key |
| Settlement windows spanning more than one shard | 0 of 552 | True today, deliberately not relied on: windows merge by key |
| Longest resolved streak | 268 rows | Streaks cross shards; a tail read is not enough |

**The zero-inversion result was false, and finding that out is the most useful thing in this section.**

It was measured across 49,469 rows and looked structural: resolution lag under about fifteen minutes
against quarter-hour cycles, so a row issued before midnight should resolve in the previous day's last
window and never overtake one issued after it. The design was built to assert it rather than assume it,
on the grounds that it was a property of the data rather than of the code.

It broke within the hour. On the next gate run:

```
Shard 2026-08-15 overlaps the previous shard on resolution time:
2026-08-15T00:15:15.415Z does not follow 2026-08-15T00:48:39.413Z
```

A row issued before midnight settled in a 00:45 window and resolved at 00:48, after a row issued at
00:05 had already resolved at 00:15. Nothing about that is exotic; the fifteen-minute lag figure was
simply the common case mistaken for a bound.

**So the merge no longer depends on shard order at all.** The compact column carries each row's `id`,
and the merge sorts by `(time, id)` for the chronological sequence and `(time desc, id)` for the streak
— exactly the orderings the direct path uses. Cycles merge by key and re-choose their earliest-issued
representative, and per-window values merge by window key. The result is order-independent by
construction, which is a stronger guarantee than any assertion over the same assumption, and it costs a
sort of ~30k rows: the merge went from 12 ms to 134 ms against 624 ms for the direct path, and the
rollups from 3.0 MB to 6.1 MB against 188.7 MB of rows.

The two shard-locality results below are still true of today's data, and are still not relied on. The
`segments` and counterfactual merges were both written to assume them and both were wrong: a test with a
cycle split across two shards caught the window double-counting. What the measurements were genuinely
good for was sizing — the streak length, the row counts, the column cost — not for licensing
assumptions.

One rollup field was missing and would have drifted silently: `calibrationWindows` counts distinct
settlement windows over **all** resolved rows including unqualified ones (552), while the stored
`distinctResolvedWindows` covers only the qualifying set. The two happen to agree on the qualifying
count — `resolvedWindows` is 520 whether keyed on raw `closesAt` or on the normalised key — but the
calibration set is genuinely larger and needs its own field. It gates calibration readiness.

**Verification gate.** Before anything switches over, compute the summary both ways over the full
retained history and assert field-by-field equality.

This gate exists as `npm run verify:forecast-storage` (read-only; `--write` also emits the shards). It
covers the eight counters in `ForecastStorageVerification`, plus row-count and id-bijection checks.

**"Byte-identical" is not an achievable bar, and the gate must not be written to demand it.** Measured
on the full 49,583-row history, comparing `summarizePerformance(original)` against
`summarizePerformance(open ++ shards)` — the same rows in the layout's order:

| Class | Result |
|---|---|
| Counts, cardinalities, labels, array lengths | **0 differences** — exactly reproduced |
| Float aggregates (means, Brier, log loss, returns, standard errors) | max relative deviation **7.06e-15**, about 32× double epsilon |
| `timeline` | max relative deviation **0.25** |

The float aggregates differ because IEEE addition is not associative and the layout sums ~30k terms in
a different order. No amount of care removes this; a rollup that sums per-shard subtotals will differ
in the last digits too. The gate should therefore assert **exact** equality for everything countable and
a **relative tolerance** (1e-12 is ~140× the observed noise and still far tighter than anything that
could change a decision) for float aggregates.

`timeline` was the real failure, and it is the one this section predicted. **Implemented**, and the
cause was narrower than "rolling windows are hard": `Array.prototype.sort` is stable, so rows comparing
equal kept their incidental array order. Ties are the ordinary case here — seven correlated assets share
a `closesAt`, and repeated updates share an `issuedAt` — so the trailing-row continuation was not needed.
A total order was. Adding an `id` tie-break to every ordering that feeds a reported statistic makes the
summary layout-independent, and drops the whole-summary deviation to 6.3e-15 with zero structural
differences.

Six orderings needed it, and only two were found by reading the code. The gate found the rest:
`timeline`, `currentStreak`, `currentCycleStreak`, the per-cycle representative row, `recent` (ties
decide which rows make the top 8 at all), and the grouped `byAsset`/`segments` sorts, which fell back to
Map insertion order when groups tied.

This is a **behaviour change on ties**, not only a gate fix. Those statistics previously depended on the
order rows happened to occupy in the durable file, so they could shift across a compaction or a journal
replay with no data change at all. They are now deterministic.

**Implemented as** `compareSummaries` in `lib/forecast-storage.ts`, wired into
`verifyForecastStoragePlan`: exact for anything countable, `SUMMARY_FLOAT_TOLERANCE` (1e-12) for float
aggregates, output capped so a systematic divergence reports its shape rather than thousands of lines.
Last run over 49,586 live rows: `ok: true`, no errors. This completes the first half of step 1 in §7.

## 5. Non-blocking I/O boundary — deferred, and probably not needed

> **Re-scoped 2026-08-14.** This section originally required a `node:worker_threads` boundary so that
> "the main thread never calls `JSON.parse` or `JSON.stringify` on a file that can grow." That was
> written when the parse was believed to cost ten seconds. It costs 1.2 s, once per process, behind a
> promise cache. The worker would move that 1.2 s off-thread and pay structured-clone to bring the rows
> back — and it does nothing at all about the constraint that actually binds now, which is memory
> residency (§5.1). **Do not build it yet.**

The remaining honest arguments for a worker are narrow: the evaluator reads every shard every 25
windows, and journal compaction serializes the retained set. Both are real, both are off the 15-second
path already, and both get cheaper — not more expensive — under sharding. Revisit only if a measured
stall reappears after the hot set is split out.

### 5.1 The constraint that actually binds: residency, not blocking

| | Today |
|---|---|
| History on disk | 198 MB / 49,469 rows |
| **Retained JS heap once parsed** | **396 MB** |
| RSS while loading | 954 MB |
| **Rows the hot path needs** | **205 open rows = 1 MB of JSON** |
| Growth | ~10k rows/day, ~40 MB/day on disk |

The process holds 396 MB resident to serve 1 MB of working set, and that number grows every day. The
observed 2.97 GB RSS came from this, not from any single operation. Extrapolating the growth rate, the
heap passes 1 GB in roughly two weeks and the default Node heap ceiling shortly after.

This reorders the design. A worker thread relocates work; it does not reduce residency. Sharding plus a
hot set *does*: sealed shards are never held, and the cycle keeps 205 rows and seven small rollups in
memory instead of the archive. **Sharding is now justified by memory, not by event-loop blocking**, and
that is a stronger and more durable reason than the one it was originally given.

Secondary costs, in the order they will bite:

1. **Residency** — above. Binding in weeks.
2. **Startup** — parse plus journal replay plus provenance rehydrate; currently 6-11 s to first useful
   response, growing linearly. Sharding removes almost all of it.
3. **`summarizePerformance`** — 643 ms today after the §1.1 fix, roughly linear in rows. Returns to
   seconds around 300-400k rows. Rollups remove it; nothing else needs to.
4. **Evaluator** — reads everything every 25 windows. Already off the hot path; sharding makes it
   incremental.

## 6. Migration and verification

1. Back up `forecast-history.json` outside the repo, as done for the provenance migration.
2. Build shards and rollups from the existing file **without deleting it**; both layouts coexist.
3. Assert: total row count matches; every id appears exactly once; the rollup summary equals the
   current summary field by field; walk-forward over shards reproduces its last recorded run.
4. Switch reads to the new layout, keeping the old file untouched as a fallback.
5. Retire the old file only after a few days of clean operation.

Recovery semantics carry over unchanged: atomic temp-plus-rename, longest-valid-prefix recovery with
quarantine of the damaged copy, and cache invalidation on a failed write so an uncommitted mutation
can never look durable. Per-shard checksums in `index.json` make a damaged shard detectable rather
than silently short.

## 7. Sequencing

Each step is independently verifiable and independently revertable.

**Done.**

- **§1.1 quadratic grouping fix.** Removed the actual 9.6-second stall. `summarizePerformance` is 643 ms
  with byte-identical output; the shared helper is `lib/group.ts`. This was the whole of the emergency.
- **Plan builder and verification gate.** `buildForecastStoragePlan` / `verifyForecastStoragePlan` and
  `npm run verify:forecast-storage` reproduce the summary from a sharded plan.
- **Full field-by-field gate, and the total ordering it required** (§4). The gate now compares the whole
  summary, not eight counters, and six orderings were made deterministic so it can pass. Last run over
  49,586 live rows: `ok: true`, no errors. Step 1's first half is complete.

**Next, in order.**

> An earlier draft of this re-scope put sharding first and rollups second. That ordering does not work,
> for a reason worth recording. Every cycle, `dashboard.ts` → `trackCalculations` → `updateTracking`
> calls `readForecasts()` for the *whole* array, and `cachedPerformanceSummary` scans all of it every 60
> seconds. Switching the reader to shards while the summary still needs every row would either keep the
> archive resident anyway — no win — or re-read 198 MB a minute, which is worse than today. **The
> residency win is gated on the summary no longer needing sealed rows**, so the rollup algebra comes
> first even though it is the riskier half.

1. **Rollup algebra, behind the existing gate.** Extend `verifyForecastStoragePlan` to full field-by-
   field equality — including `cycleBalancedAccuracy`, the streaks, and `timeline`, which it does not
   cover yet (§4) — then build `summarize(sealedRollups, openRows)` beside the current function. Both
   run and are compared on live data; nothing switches over. This is the whole correctness risk of the
   design, isolated from any layout change, and it is verifiable before it is load-bearing.
2. **Switch the reader.** Once the summary no longer needs sealed rows, `readForecasts()` can return the
   open set only and sealed shards become lazily loaded for the evaluator and `/api/performance`. This
   is the step where retained heap and startup time actually drop, and it is measured that way rather
   than by cycle latency, which is already fixed.
3. **Payload split** (already agreed separately): the freshness badge judges only market data, so no
   future slow subsystem can blank the trading view.

**Not scheduled.**

- **Worker boundary** — see §5. Deferred indefinitely; revisit only against a measured stall.
- **De-duplication and factors-prose stripping** — §1.2 rejected these using the ten-second figure, so
  that rejection no longer holds on its own terms. They are not *needed* now, but if residency ever has
  to come down without a layout change, they are worth roughly 30% and should be re-measured rather than
  dismissed by reference to a number that was wrong.

## 8. Risks and open questions

- **Riskiest code in the system.** This is the durability layer for data the spec calls irreplaceable.
  The verification gate in §4 and the coexistence period in §6 are the controls; neither should be
  shortened for speed.
- **Cycle straddling midnight** is the main correctness trap in the rollups — a cycle key must merge
  across shards, never be counted twice.
- **Retention is unchanged here on purpose.** Sharding makes unbounded retention affordable rather than
  deciding what to discard. Whether qualified rows should be retained forever is a separate question
  and should not be settled as a side effect of a performance change.
- **Open:** should sealed shards be gzipped? It would cut disk substantially, but adds CPU to the
  evaluator's read path. Deferred until the evaluator's cost is measured on the new layout.
