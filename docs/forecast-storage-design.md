# Forecast storage redesign — sharding, rollups, and a non-blocking I/O boundary

> Design proposal · 2026-08-14 · **not yet implemented**
> Companion to [`SPEC.md`](../SPEC.md) §6 Storage. Nothing here changes the model, execution, or any gate.

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

### Why the cheaper fixes were rejected

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
| Find due-for-resolution | every cycle | `pending` rows only — currently **8** |
| `summarizePerformance` | cached 60s | lifetime aggregates, not rows |
| Walk-forward evaluator | every 25 windows | everything; may be slow |
| `/api/performance` list | on demand | most recent 500 |

Nothing on the 15-second path needs the 47,528 resolved rows, and a resolved row is immutable. We
re-parse all of them every load only because they share one array.

## 3. Data layout

```
data/forecast-history/
  open.json                 hot set: pending + unresolved rows (~100 rows, KBs)
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

`summarizePerformance` must produce byte-identical output. Its statistics fall into three classes, and
each needs a different merge rule. This is the part most likely to be got subtly wrong, so it is
specified explicitly.

**Additive** — a plain sum per shard: `issued`, `pending`, `resolved`, `correct`, `invalid`,
`observedCalculations`, `realizedEdgeTrades`, Brier sum, log-loss sum, predicted-edge sum,
realized-return sum, and every `benchmarks` entry (each is a count plus sums over one probability
source). Grouped slices — `byAsset`, `byDirection`, `byLeadTime`, `edgeBuckets`, `calibrationBins`,
`segments` — are additive per group key.

**Distinct-set** — `cycles`, `resolvedCycles`, `calibrationWindows`, `resolvedWindows` are cardinalities
of id sets. Each shard stores its distinct keys (~2k cycle ids/day, far smaller than the rows) and the
merge is a union. Exact, not estimated: these counts gate calibration readiness and must not drift.

**Non-additive** — three cases needing explicit handling:

- `cycleBalancedAccuracy` is the mean over cycles of per-cycle accuracy, so a shard stores per-cycle
  `(correct, total)` pairs rather than a ratio. A settlement window can straddle midnight, so pairs
  merge by cycle key across shards before the mean is taken.
- `currentStreak` and `currentCycleStreak` depend only on the most recent rows, read from the tail of
  the newest shards until the streak breaks. No full scan.
- `timeline` is per-row with a rolling 25-row window. Each shard stores its own timeline segment plus
  the trailing 24 rows needed to continue the rolling window across the boundary; segments concatenate.

`missedBuyCounterfactual` runs over all forecasts including unqualified ones, so it needs its own
additive counters rather than riding on the qualified path.

**Verification gate.** Before anything switches over, compute the summary both ways over the existing
47,536 rows and assert field-by-field equality. The rollup path does not ship unless it reproduces the
current numbers exactly.

## 5. Non-blocking I/O boundary

All shard parse and serialize moves into a `node:worker_threads` worker behind a small async API
(`readShard`, `writeShard`, `readRollup`, `sealShard`). The main thread never calls `JSON.parse` or
`JSON.stringify` on a file that can grow.

This is worth doing even after sharding, because sharding bounds the *hot* path while the archive is
still large: the evaluator reads every shard every 25 windows, and today's journal compaction would
serialize the whole history in one blocking write when it crosses 50 MB. With the worker, neither can
stall a calculation.

Structured-clone cost of passing rows back is real but bounded — the hot set is small, and bulk
consumers (evaluator, `/api/performance`) are already off the 15-second path.

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

1. **Rollups** over the current single file — no layout change, proves the algebra against live data.
2. **Sharding** underneath the rollups, with the hot set split out. Biggest win: the cycle stops
   touching the archive.
3. **Worker boundary** for all shard I/O.
4. **Payload split** (already agreed separately): the freshness badge judges only market data, so no
   future slow subsystem can blank the trading view.

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
