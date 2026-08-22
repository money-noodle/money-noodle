# Forecast residency profile and bounded projection repair — 2026-08-22

## First confirmed source — necessary fix, not the complete diagnosis

One major source of the long-running RSS problem was repeated whole-history allocation and garbage-collection
churn, not the forecast hot-set cache retaining every sealed row. A post-deployment profile below showed that
removing this source was not sufficient; other whole-file stores still dominate the steady-state worker.

At `2026-08-22T06:33:54Z`, the rebuilt production `next-server` had been running for 4m35s:

| Measure | Observation |
| --- | ---: |
| RSS | 2.39 GiB |
| Physical footprint | 3.0 GiB |
| Physical peak | 4.6 GiB |
| CPU at sample | 112.8% |
| Forecast v3 artifacts | 417 MB |

RSS subsequently fell from 2.03 GiB to 1.61 GiB over 15 seconds while CPU fell, showing that a material
part of the footprint was temporary allocation/high-water behavior rather than a stable retained set.

A five-second macOS `sample` caught 1,085 of 3,909 main callback samples inside V8 `Builtin_JsonParse`, with
substantial object allocation, scavenging, incremental marking, and mark/compact work. `vmmap` reported a
4.6 GiB peak and large writable/anonymous regions rather than a comparable mapped-file footprint.

## Cause

The once-per-minute public paper-performance replication called:

```text
replicatePublicPaperPerformance
  → getPublicPaperPerformance
  → getForecastHistory
  → readFullForecastHistory
  → every 417 MB sealed shard
```

The payload needs a lifetime summary and the latest 500 qualified rows. The summary already comes from
rollups, but the list loaded and sorted all 70,000+ rows before slicing 500. When Postgres was over its data
transfer quota, the write failed only after the entire parse/allocation cost had already been paid. This
repeated every replication interval and produced sustained GC pressure capable of delaying unrelated event
loop work.

The automatic walk-forward evaluator was not the trigger at this snapshot: its next checkpoint had not been
reached. The authenticated full performance report remains an intentional on-demand whole-history consumer;
it is not scheduled by the collector.

## Repair

- Added a bounded recent-history reader. It always includes the small journal-backed open set, then reads
  newest complete daily shards in reverse order only until 500 matching rows are available.
- Public paper performance now combines the existing rollup summary with that bounded list; it no longer
  calls `getForecastHistory`.
- Replication coalesces an in-flight operation and exponentially backs off after database failures, from two
  minutes through a one-hour ceiling. A quota outage therefore cannot force payload reconstruction every
  minute.
- The signed, on-demand performance report and evaluator retain their explicit full-history behavior.

No forecast, model, policy, paper/live decision, execution, budget, reconciliation, or order behavior changed.

## Equivalence and measured cost

Two fresh processes read the same repaired v3 generation and advancing journal. Both produced the same 500
IDs (SHA-256 `09fa33f4ce40582e07ba5e3537298d4aee605794b1c9e6bc119ad2924e93dee8`), with the same first and last
identity.

| Reader | Elapsed in reader | Peak RSS | Heap used at result |
| --- | ---: | ---: | ---: |
| Bounded newest-shard reader | 208 ms | 247 MiB | 144 MiB |
| Full-history scan then slice | 2,217 ms | 892 MiB | 835 MiB |

The bounded path reduced measured reader time by 90.6% and process peak RSS by 72.3% in this isolated
comparison. This is not a production steady-state heap measurement: JITI/module startup is included in both
processes, macOS RSS is not V8 live heap, and the production server has other caches. ID equality establishes
behavior; the cost comparison establishes direction and order of magnitude.

## Post-deployment check: substantial churn remains

The rebuilt worker was observed for four minutes without calling the authenticated full-history report. The
projection backoff worked: only two paper-performance attempts appeared, rather than one per minute, and the
bounded reader retained exact payload identity. Nevertheless RSS still peaked at 3.17 GiB and sampled CPU
reached 266%. The first repair therefore removed a measured expensive route but did **not** close the
production residency concern.

Read-only mtime and source tracing exposed the next stores:

- `data/cycle-paths.json` was about 12 MB and was parsed and pretty-printed atomically roughly every 8–10
  seconds by `recordCyclePathObservations`.
- `data/contract-provenance.json` was about 32 MB. Although append-only and unchanged during the sample,
  `getContractProvenanceRegistry` had no cache. One forecast cycle can parse it repeatedly while recording
  provenance, loading/rehydrating the open forecast set, slimming journal events, and resolving rows.
- `data/paper-orders.json` was about 48 MB and is parsed by the execution orchestrator. It changed only twice
  in the sampled interval, but execution reads remain a funded-path concern and must not be casually cached
  or combined with this observation-store repair.

## Second repair: observational stores

The provenance and cycle-path stores now use `globalThis` runtimes, so independently emitted server module
copies share one load, queue, and committed value. Writes remain atomic and publish to memory only after
rename; a failed write invalidates memory and forces a durable reload. Machine-owned JSON writes are compact
rather than pretty-printed. Tests load independent module copies and pin single-load, write-through, rename,
and failed-write behavior.

On first production mutation, `cycle-paths.json` fell from 12.0 MB to 7.5 MB. The provenance file fell from
32.8 MB to 30.6 MB when the next contract additions committed; its rules text, not whitespace, dominates.
The changes retain one parsed value deliberately instead of repeatedly allocating it.

This second repair was also insufficient. During the next five-minute observation, with no authenticated
full-history request, RSS peaked at 2.95 GiB and sampled CPU reached 140%. That is slightly below the prior
3.17 GiB peak but is not evidence that residency is operationally fixed.

## Remaining dominant scheduled whole-file path

`data/paper-orders.json` was 48.0 MB and changed roughly every 15 seconds after the worker reached steady
collection. A fresh external parse measured:

- 3,606 orders: 1,940 paper and 1,666 live;
- 1,665 unfilled, 1,180 lost, 429 sold, 324 won, seven rejected, and one open;
- 13.8 MB of compact field payload in `entryDecision`, 7.1 MB in `positionObservations`, and 3.6 MB in
  `entryExecutionObservations`;
- 147 ms parse time and 303 MiB process peak RSS for one isolated read. This does not include the server's
  subsequent mutation, full stringify, overlapping async work, or V8 high-water behavior.

The source has one module-local `engineQueue`, but the production build emitted at least seven distinct
chunks containing the complete execution engine and pause/drain implementation. This is the same class of
bundle-ownership boundary that caused the forecast incident. Disk reloads currently limit stale-cache risk,
but module-local queues cannot prove that an API control mutation and collector mutation serialize before
atomic replacement of their shared ledger.

## Third repair: process-global execution-ledger ownership

The funded-path design was agreed and recorded in `docs/execution-ledger-runtime-design.md` and the SPEC
2026-08-22 decision log before implementation.

- Every emitted execution-engine copy now uses one `globalThis` serializer. Collector cycles, long-shot
  mutations, reconciliation, reset, API control, consistent reads, and pause/drain's barrier share it.
- Disk JSON remains authoritative. Mutations receive an isolated `structuredClone` of one immutable
  committed snapshot. Writes still use temporary-file plus rename; memory publishes only after successful
  operation completion, and ambiguous write/post-commit failures invalidate it for durable reload.
- The one-second long-shot exit precheck derives only cloned open long-shot positions while serialized. It
  no longer parses the complete ledger to discover that no relevant position exists.
- Scheduled public projections request strategy/mode slices. Authenticated full reporting retains an
  explicit on-demand full detached read.
- Compact encoding reduced `paper-orders.json` from 48.0 MB to 33.6 MB without changing schema or rows.

Cross-module serialization, commit-after-rename, failed-rename reload, detached filter, strategy isolation,
budget, reconciliation, and source-authority tests passed. Startup reconciliation remained ready and funded
control remained operator-paused with 2,285¢ available and 0¢ reserved.

## Production result

The repair materially reduced continuous work but did not lower the allocator high-water mark:

- During the first five-minute observation, RSS peaked at 3.37 GiB. `vmmap` shortly afterward reported a
  1.3 GiB physical footprint and 3.9 GiB physical peak; 1.1 GiB resident was in V8's anonymous memory tag.
- A subsequent five-second native sample was idle in `kevent` for 3,002/4,117 main-thread samples (72.9%).
  Its largest captured JSON-parse branch was 149 samples and structured clone accounted for two branches
  totaling 128 samples. Before the repair, the comparable sample caught 1,085/3,909 samples in JSON parse
  and the worker commonly sustained more than one core.
- Ten-second observations after warm-up often showed 0–10% CPU, punctuated by collector spikes around
  100–150%. This is a real duty-cycle improvement, not evidence that 1.3 GiB steady physical residency is
  acceptable.

The remaining parse sample is consistent with other whole JSON/JSONL observational stores read on the
collector cycle (calendar, exit, portfolio, and maker-restriction evidence), while every mutating execution
cycle still clones and serializes the complete 3,600-order ledger. Exact attribution among those paths needs
another instrumented profile; RSS alone cannot choose one.

## Remaining work

Do not remove the isolated mutation clone or weaken serialization to chase RSS. Meaningfully reducing the
execution hot set requires a separately designed terminal-order archive/current-state split, including what
reconciliation must retain, immutable reporting access, crash publication, and strategy/account aggregation.
That is a schema change and remains explicitly outside this repair. The append-only observational journals
should be profiled and compacted only by their owning stores; they must not be hand-truncated.

A manual full performance request may still raise the process high-water mark by design. If that on-demand
cost becomes operationally unsafe, it requires a separate incremental report design.

Final validation passed: TypeScript, 131 Vitest files / 1,054 tests, production build, `git diff --check`,
and ESLint with zero errors / 37 inherited warnings.
