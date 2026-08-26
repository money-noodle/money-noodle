# Bounded dashboard and public-projection read paths

> **Document type:** Architecture design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-22
> **Canonical requirements:** [`spec/product-and-surfaces.md`](../spec/product-and-surfaces.md), [`spec/storage-and-architecture.md`](../spec/storage-and-architecture.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> **Status: implemented.** Agreed 2026-08-22 after the local performance and hosted
> projection incident. This is a reporting/read-model change only. It changes no forecast, entry rule,
> execution route, fill, sizing, budget control, reconciliation, or live authority.
>
> **2026-08-26 amendment:** the long-shot report route, UI, and Postgres projection described historically
> below were removed when that strategy retired. Historical order attribution remains in the shared ledger.

## 1. Incident and decision

On 2026-08-22 the signed dashboard polled `/api/performance` every 15 seconds to render two trade-record
rows. That endpoint also loaded the complete forecast history and built every analytical report. The cold
response took 6.323 seconds and serialized about 970 KB. Forecast sharding correctly removed lifetime rows
from steady residency, but the old poll then turned an on-demand full-history operation into a repeated shard
scan.

The public page had the inverse problem. `PublicAutomationStatus` and `PublicPaperPerformancePanel` each
polled the same approximately 311 KB Postgres JSON projection once a minute. Those independent hooks produced
about 622 KB/minute of database result transfer for one continuously open tab before any other reader. The
managed Postgres service ultimately refused queries because its data-transfer quota was exhausted. The hosted
fallback then rendered an invented zero paper budget, obscuring an availability failure as an empty ledger.

The reporting surface will therefore use two contracts:

1. **Homepage summary** — bounded signal counters, at most four compact recent signals, and the fields needed
   for one trade-record row. It is the only performance resource polled by the page.
2. **Full report** — the existing complete public or signed analytical payload, fetched only when the operator
   opens **Full track record**.

No browser request may make a full-history scan part of a fixed polling loop.

## 2. Contract boundaries

The compact trade record contains only the fields rendered by `TradeRecordRow`: settled/window/win/loss
counts, win rate, ROI, exact realized P&L, mean predicted edge, and mean realized return. The compact signal
summary contains only the homepage tiles, calibration lock, and four compact recent rows. It omits segments,
counterfactuals, provider splits, epochs, timelines, calibration bins, benchmarks, cycle paths, and the 500-row
history.

The signed compact route remains authenticated and `private, no-store`. It reads the shared execution ledger
through the established detached runtime view, narrows to `edge-binary-buy`, and never reads forecast shards.
The signal figures are already present in the dashboard response and are not fetched again by the compact
signed route.

The public compact route is identity-free and may be cached for a bounded interval. One dashboard hook owns
that request and passes the result to both public panels. The browser retains a previously verified payload on
a transient failure but also reports that refresh failed; on a first-load failure it renders an explicit
projection-unavailable state rather than zeros or an empty gap.

## 3. Postgres projection without a schema migration

The existing `money_noodle_public_paper_performance.payload` JSONB document remains the compatibility and
full-report store. No new table or column is required while database administration is deferred.

The document gains two internal fields that are rebuilt rather than exposed by spreading stored JSON:

- `homepage`: the compact public contract plus its own generation timestamp;
- `fullGeneratedAt`: the timestamp at which the complete analytical document was replaced.

The worker attempts a complete document on process start and at most once per 15 minutes. Every replication
first builds and writes the bounded `homepage` member; only after that availability probe succeeds may a due
full report hydrate immutable execution evidence and build the analytical document. A quota outage therefore
fails before expensive local history construction, and a full-payload-specific failure cannot force another
full attempt until the 15-minute interval. Between full publishes it updates only `homepage` once per minute
with `jsonb_set`. This preserves minute-level homepage
freshness without sending the 311 KB history document from worker to database every minute. A worker or stored
document from before this change remains readable: the compact SQL query derives the required fields from the
full payload when `homepage` is absent, and the full reader falls back to `source_updated_at` when
`fullGeneratedAt` is absent.

The compact hosted query selects only `homepage` or individually reconstructed JSON fields. It never selects
the full `payload` across the database connection. Full payload transfer occurs only for the on-demand dialog.
Successful public responses carry bounded shared-cache directives; unavailable responses are `no-store` and
must not replace a last known good response.

## 4. Availability semantics

An absent or unreadable hosted projection is not a zero-value track. Public budget, compact performance, and
full performance routes return HTTP 503 with a stable reader-facing explanation. Components distinguish:

- loading with no prior record;
- verified record;
- verified record whose latest refresh failed;
- unavailable with no record.

No route falls back to the local engine, filesystem, or direct ledger on a stateless host.

## 5. Strategy and money scope

The positive-edge report is keyed to `edge-binary-buy`. Its paper and live trade records, provider rows,
epochs, lifetime exact P&L, paper maker shadow, and stake-expansion evidence must all receive only that
strategy's orders. The live venue account and reconciliation ledger remain shared; this narrowing is reporting
attribution and does not split cash, exposure, order ownership, reconciliation, or any safety ceiling.

Paper funding history applies the paper bankroll's recorded whole-cent corrections only to its current funding.
Exact order P&L remains separate. Long-shot orders continue to appear only in the long-shot report.

## 6. Forecast journal follow-up

This incident does **not** authorize lowering the 50 MB journal compaction threshold. More frequent sealing
would trade repeated journal parsing for repeated full-generation rewrites without proving a net win.

A later implementation may add a bounded process-global hot-state reader with these mandatory properties:

1. one canonical cache shared across Next.js bundles through `Symbol.for`, never a module-local authority;
2. initialization from the checksum-verified open artifact plus complete valid journal prefix;
3. cache advancement only after the owning writer has durably appended events;
4. detection of index generation changes, journal replacement/truncation, process restart, and readers in a
   different process, with a full reload on any mismatch;
5. cloned outputs so a caller cannot mutate canonical cached evidence before persistence;
6. the existing compacted-journal SHA guard during index-publication/journal-truncation crash windows;
7. grid tests for append, patch, delete, seal, replacement, damaged tail, concurrent read, and cross-bundle
   visibility, plus the complete forecast-storage verifier over current durable data.

Until those gates are implemented and measured, reads continue to replay the append-only journal and the
compaction threshold does not change. Removing the full-report polling loop is the immediate bounded fix.

## 7. Verification

Completion requires:

- a mixed-strategy test proving every positive-edge money aggregate excludes long-shot orders;
- public projection tests for legacy-document fallback and internal-field withdrawal;
- route/component tests or static boundaries proving the homepage uses the compact endpoint once and the full
  endpoint only on dialog open;
- explicit 503 behavior for missing budget and performance projections;
- measured compact/full response sizes and cold timings;
- `npm run typecheck` and `npm test`.

Live remains operator-paused throughout implementation and is not automatically resumed.
