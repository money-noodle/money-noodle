# Forecast storage integrity incident and repair — 2026-08-22

## Result

The forecast store failed because request, rendering, and instrumentation bundles each held an independent
module-local writer queue and cache while writing the same files. Interleaved seals published different
shard/open/index generations and one stale writer truncated events appended by another. The old v2 protocol
also overwrote files referenced by the active index before publishing its replacement, so it was not
crash-consistent even with one writer.

Funded execution was operator-paused and quiescent before repair. No forecast, buy policy, execution policy,
budget, or order rule changed. Forecast history remains reporting/evaluation evidence and does not enter the
funded decision path.

## Inputs and method

- Verified object-store manifest created `2026-08-22T03:54:47.309Z`:
  - indexed snapshot: 69,515 rows;
  - append journal: 16,960 events, ending near 03:58Z;
  - all indexed row-shard checksums passed.
- Frozen current v2 layout after the restart-safe drain at `2026-08-22T06:04:01Z`:
  - 70,306 actual sealed rows;
  - 11,597 rows in `open.json`;
  - 2,255 journal events;
  - the index claimed 70,315 terminal and 136 open rows.
- Recovery replayed the archive journal, overlaid current terminal rows, ignored pending copies of terminal
  identities, overlaid current-only open rows, replayed the current journal last, and then applied the
  existing 20,000-row unqualified retention limit once.
- For independently calculated payloads sharing one bucketed observation ID and the same terminal outcome,
  recovery retained the earliest `issuedAt`, matching the normal first-writer behavior. Same-time slim/full
  provenance representations retained the richer representation. A differing outcome, integrity target, or
  invalid statement failed closed.
- `verifyForecastStoragePlan` then checked ID bijection, counts, checksums, direct-summary equality, and
  stored-rollup equality before publication.

## Corruption measured

- `open.json` held 11,247 pending identities already terminal in shards.
- 2,414 of those were qualified, exactly accounting for the direct-versus-rollup resolved-count difference.
- The 2026-08-20 index expected 11,196 rows and SHA `040783…`; the file held 11,187 and SHA `988064…`.
- The current 2026-08-20 shard was an exact subset of the archived shard. Its 1,148 omitted rows were all
  resolved and unqualified, consistent with retention; no qualified row was missing from that shard.
- Across the complete archived replay, 88 qualified v22 pending rows were absent from all current local
  artifacts. Recovery restored all 88.
- 2,892 terminal identity collisions required deterministic canonicalization, predominantly slim versus
  expanded provenance copies and, for independently bundled calculations, different payloads inside one
  bucketed observation identity.

## Installed generation

The owning repair command installed `forecast-storage-v3` generation
`55f7bf788ed25b6c18b10848` at `2026-08-22T06:16:28.623Z`:

| Measure | Repaired value |
| --- | ---: |
| Retained rows | 70,837 |
| Qualified/scored rows | 50,837 |
| Terminal rows | 70,400 |
| Open rows | 437 |
| Resolved qualified rows | 50,525 |
| Pending qualified rows | 312 |
| Resolved cycles | 5,252 |
| Resolved windows | 1,147 |
| Calibration windows | 1,158 |
| Unqualified rows removed by existing retention | 3,028 |

A fresh `npm run verify:forecast-storage` returned `ok: true`, zero errors, 15 checksum-valid shards,
70,837 current rows, and zero journal events. The corrupt v2 directory and journal were moved to dated
`.corrupt-*` paths; the repair manifest is retained under `data/forecast-history-repair-*.json`.

After restart resolved the restored pending rows, a paused owning-compactor pass exercised the final journal
watermark protocol and installed generation `55b4a6c63a3c20cc208617be` at
`2026-08-22T06:25:15.388Z`: 70,837 rows, 70,802 terminal, 35 open, and all 50,837 qualified rows resolved.
The stopped-worker verifier again returned zero errors. After the final rebuilt-worker startup reconciliation,
the collector acquired the sole lease and a live verifier remained green as the journal advanced; funded
operator intent remained paused.

## Preventive change

- Request-triggered dashboard builds are read-only for forecast storage; only `background-collector` imports
  `recordCollectorCalculations`.
- The writer queue is process-global through `Symbol.for`, and a process-lifetime filesystem lease refuses a
  second live writer and quarantines a dead owner's lock.
- Writers reload the indexed open artifact plus journal instead of sealing a caller cache.
- V3 open, shard, and rollup artifacts are immutable and content-addressed; `index.json` is published last
  and records the exact incorporated journal hash so a crash before truncation cannot replay that generation.
- Readers verify open/shard/rollup hashes and counts. Historical health degrades on contradiction.
- Tests simulate pre-index publication failure and enforce writer import authority, lease exclusion,
  stale-lock quarantine, terminal-over-pending recovery, qualified retention, and summary equality.

Design: [`docs/forecast-storage-generation-repair-design.md`](../docs/forecast-storage-generation-repair-design.md).

## Uncertainty and policy consequence

The archive journal ended near 03:58Z and the surviving current journal began near 05:22Z. Current shards and
open rows recover much of that interval, but a row present only in a losing writer's truncated journal has no
remaining authoritative source. Therefore 88 is a verified minimum recovered count, not proof that the
interval is complete.

No forecast-performance figure from the corrupt layout is retained as evidence. The repaired generation is
structurally verified, but aggregate model conclusions should be recalculated from it before citation. No
production policy changes, and evaluator v2 remains barred from promotion.
