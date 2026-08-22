# Forecast storage single-writer and generation repair

> Design · 2026-08-22 · approved for implementation after the live desk was paused and drained
>
> This extends [`forecast-storage-design.md`](forecast-storage-design.md). It changes only forecast evidence
> persistence and reporting. Forecast values, entry policy, paper/live mirroring, capital, reconciliation, and
> order construction do not read this storage and do not change.

## 1. Incident and established cause

At the 2026-08-22 seal, the active index, one shard, `open.json`, and the rollups did not describe one
commit. The current `open.json` held 11,247 pending copies of rows already terminal in shards; 2,414 of
those were qualified and exactly explained the direct-versus-rollup resolved-count difference. The indexed
2026-08-20 shard count exceeded the file by nine rows, while that file's rollup rebuilt exactly from the
file.

One `next-server` process was running, but its production output contained independent copies of the
dashboard/forecast modules for instrumentation, route handlers, and server rendering. `buildDashboard`
called `trackCalculations`, so every copy was a writer. Their module-local queues and caches were unrelated.
An interleaving writer could seal its own stale cache and truncate events appended by another writer. The
artifact generations and simultaneous dashboard builds establish that concurrency; the exact instruction
interleaving was not logged.

A verified object-store archive retained 88 qualified v22 pending rows absent from every current local
artifact. They are recoverable. More rows may have been lost between the archive journal's final event at
approximately 03:58Z and the corrupt seal's new journal beginning at approximately 05:22Z; no surviving
source can prove that interval complete.

The old writer had a second independent defect: it atomically renamed each file, but overwrote files still
referenced by the old index before publishing the new index. A crash before the index rename could therefore
leave the old index pointing at new content. Single-writer ownership alone does not make that protocol
crash-consistent.

## 2. Invariants

1. Only the durable background collector records calculations or resolves forecasts. Request-triggered
   dashboard builds are read-only for forecast storage.
2. One stateful process owns a lifetime filesystem lease. A second process fails closed for forecast
   mutation; it does not alternate writes.
3. Every mutation reloads the durable open generation plus journal while serialized through one
   process-global queue. A caller's stale cache is never a compaction source.
4. Shards, rollups, and open snapshots are immutable, content-addressed files. The active index is the sole
   publication pointer and is renamed last.
5. The journal is truncated only by the owning compactor after the new index is durable and verified.
   Replaying a journal retained across a crash is idempotent.
6. Qualified rows are never pruned. Unqualified retention remains exactly 20,000 rows and is applied once
   to the reconstructed whole history at compaction.
7. On identity collision, a terminal row beats a stale pending row. Two materially different terminal rows
   for one ID fail repair rather than choosing one silently.
8. A checksum/count contradiction degrades historical reporting and evaluator input. It does not enter the
   forecast, policy, budget, or order path.

## 3. Storage v3

`index.json` becomes `forecast-storage-v3` and includes a generation identity plus an explicit open artifact:

```text
forecast-history-shards/
  index.json
  open.<sha256>.json
  2026-08-21.<sha256>.json
  2026-08-21.rollup.<sha256>.json
```

The index records the open filename, hash, and count, every shard/rollup filename and hash, and the exact
SHA-256 of the journal incorporated by that generation. A writer:

1. builds and verifies the complete plan in memory;
2. writes every content-addressed artifact to a temporary file and renames it to its immutable name;
3. reads each artifact back and verifies its hash;
4. atomically publishes `index.json` last;
5. truncates the journal atomically;
6. removes only unreferenced v3 content-addressed artifacts after publication.

A crash before step 4 leaves the previous index and all of its immutable files valid. A crash after step 4
leaves the new generation valid. If the pre-truncation journal still exactly matches the hash recorded by the
new index, readers skip it because every event is already incorporated; after normal truncation, later events
form a different journal and replay normally. The writer lease prevents an append between index publication
and truncation. Orphans are harmless and cleaned by a later successful compaction.

## 4. Writer ownership

The mutation queue and lease state live on `globalThis` under `Symbol.for`, not in a bundled module's local
scope. The first mutation atomically creates `data/forecast-history.write.lock` with PID, nonce, and creation
time. A live owner is never displaced. A dead PID's directory is renamed to a `.corrupt-*` quarantine before
acquisition; it is not deleted as though it had never existed.

The collector records a completed dashboard explicitly. `buildDashboard` reads the performance summary but
never records its predictions. A source invariant test permits the collector alone to import the mutation
entry point. The filesystem lease remains necessary for overlapping starts and accidental future callers.

Readers do not retain a module-local open-set cache indefinitely. Each read composes the indexed open
artifact with the current journal, so separately bundled read-only modules cannot serve a permanently stale
open set.

## 5. Recovery

Recovery is an owning-compactor operation performed only while trading is operator-paused, the execution
drain is restart-safe, reservations are zero, and the server is stopped.

The repair command accepts the extracted verified archive and the frozen current layout. It:

1. verifies source shard checksums where an index supplies them;
2. replays the archive journal over the archived index/open snapshot;
3. overlays current terminal shards, then current open rows, ignoring stale pending copies of terminal IDs;
4. replays the frozen current journal last;
5. fails on conflicting terminal rows or deletion of qualified evidence;
6. applies the existing unqualified retention rule once;
7. builds v3 and runs full ID, count, summary, and rollup verification;
8. writes and verifies a staging directory;
9. renames the corrupt v2 directory and journal to `.corrupt-<timestamp>` and atomically installs v3;
10. writes a repair manifest containing source hashes, counts, restored qualified IDs, merge decisions,
    verification totals, and the unresolved evidence gap.

The recovered pending rows are not assigned guessed outcomes. Normal venue-specific resolution follows them
from their preserved issuance provenance after restart.

## 6. Verification and activation

Tests pin:

- request paths cannot import the writer;
- two bundled callers share one queue and one lease;
- a second process cannot acquire a live lease;
- stale-lock quarantine;
- stale pending never replaces terminal evidence;
- terminal conflicts fail closed;
- a simulated crash before index publication leaves the old generation readable;
- a crash after index publication with the old journal retained replays idempotently;
- open, shard, and rollup checksum/count failures degrade or fail verification;
- qualified repair rows survive while unqualified retention remains bounded;
- direct and rollup summaries agree over the repaired set.

Activation requires `npm run typecheck`, `npm test`, `npm run build`, and a healthy
`npm run verify:forecast-storage`. The worker remains operator-paused after restart. Resumption is a separate
manual act after startup reconciliation and all normal readiness checks.
