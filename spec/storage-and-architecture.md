# Storage and architecture

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-25  
> **Canonical for:** durable storage, migration boundaries, technical architecture, runtime cadence, and non-functional requirements.  
> **Read with:** [`trading-risk-and-budget.md`](trading-risk-and-budget.md) when storage can affect funded authority or reconciliation.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

## 6. Storage

### Initial local storage

`.cache/*.json` stores timestamped response envelopes and hourly price history. Writes are atomic (temporary file then rename). Runtime cache is gitignored.

Planned repository boundaries:
- `MarketSnapshotRepository`
- `ForecastRepository` (durable local snapshot `data/forecast-history.json` plus append-only `data/forecast-history.journal.jsonl`; process-cached replay and bounded compaction avoid full-history rewrites on each observation) 
- `NewsRepository`
- `AccountSnapshotRepository`
- `OrderAuditRepository`
- `ResearchSessionRepository`

The single-array forecast snapshot is now a memory-residency and startup risk, not the event-loop culprit it was first reported to be. Direct measurement found that parsing the roughly 190 MB snapshot costs about 1.2 seconds once per process behind a promise cache; the observed ten-second stalls came from quadratic copy-on-append grouping in `summarizePerformance`, now fixed at roughly 0.6–0.7 seconds. The process still retains roughly 396 MB of parsed history to serve a hot set near 100 rows and grows about 40 MB per day. `ForecastRepository` therefore moves to a small open set, sealed immutable daily shards, and per-shard rollups. `summarizeFromRollups` is implemented beside the direct path and must reproduce the complete summary under a field-by-field gate before any reader switches. Counts and identities are exact; floating aggregates use a `1e-12 × max(1, |left|, |right|)` combined absolute/relative bound for unavoidable summation-order noise. Policy-scoped statistics retain policy identity in their compact rollup keys: an unscoped legacy counterfactual may never be attributed to the active buy policy, and the verifier fails if excluding it would hide active-policy sealed rows. A worker boundary is deferred because it relocates work without reducing retained memory. Retention is deliberately unchanged — making unbounded history affordable is not the same decision as choosing what to discard. See [`docs/forecast-storage-design.md`](../docs/forecast-storage-design.md).

The persistent local worker also maintains an optional S3-compatible off-machine archive. Every 24 hours a detached, low-priority process compresses durable JSON/JSONL files and their frozen corrupt/superseded derivatives into SHA-256-addressed immutable blobs, uploads only missing content, reads every new blob back through gzip while verifying its original checksum and byte count, and commits a timestamped manifest only after all files pass. Vercel/stateless workers cannot start it. Archive v1 never deletes or mutates local source data. An independent restore must reject unsafe paths and reproduce every manifest byte under its original checksum before any eviction is considered. Local removal is a separate owner-aware tier transaction: only allowlisted immutable content may be remote-primary, hot ledgers/journals/indexes/open sets remain local, and the latest durable tier catalog must retain remote-only identities. No sole local copy may be removed until the object set has enforceable retention/Object Lock or an independently verified second bucket. Credentials belong only to a dedicated object-read/write application in local environment configuration, never Vercel or the repository. See [`docs/object-storage-retention-and-disk-safety-design.md`](../docs/object-storage-retention-and-disk-safety-design.md).

The persistent worker also performs best-effort startup reclamation of orphaned atomic-write temp files under
`data/` and `.cache/`. A `${target}.<pid>.<rand>.tmp` may be removed only when it is older than 60 seconds
and the real rename target already exists; an absent target, fresh file, symlink, hidden subtree, malformed
name, or stateless host is never touched. This housekeeping cannot rewrite a ledger or be the only owner of
durable content, and it never delays startup reconciliation or collector activation.

### MongoDB migration

Replace repository implementations without changing domain/services. Add TTL indexes for raw cache records and durable collections for forecasts, outcomes, trades, and audit events. Credentials do **not** belong in MongoDB documents in plaintext.

## 8. Technical architecture

- **Framework:** Next.js App Router, React, TypeScript.
- **UI:** Tailwind CSS and local shadcn/ui components; Radix primitives for accessibility.
- **Charts:** Recharts initially.
- **Server:** Next.js route handlers and server-only services.
- **Runtime:** local Node.js; architecture remains deployable later.
- **Data flow:** external adapter → cached raw data → normalized domain data → feature/model service → API → client dashboard.
- **Freshness and cadence:** every dashboard payload includes generation/expiry, per-source status, and a bounded runtime-task snapshot. Input TTLs remain client-safe data in `lib/freshness.ts`; task metadata and shared cadence constants live in `lib/task-cadence.ts`; process-local run health lives only in server-side `lib/task-cadence-runtime.ts`. Existing loops mark their own outcomes but the registry cannot schedule, await, gate, price, size, or trade. Conditional and on-demand tasks do not become unhealthy merely because no candidate, order, position, or event activated them.

**Aspirational, not current.** `lib/` is flat; none of the directories below exist. They record an intended
future decomposition, not a map of the code — for that, see the table in `AGENTS.md` §0. Do not cite this list
as evidence of where anything lives.

Recommended future service boundaries:
- `lib/venues/*` — normalized trading-provider registry and Polymarket/Kalshi/Crypto.com/ForecastEx/Robinhood adapters.
- `lib/market-data/*` — spot, derivatives, historical feeds.
- `lib/news/*` — retrieval, dedupe, entity matching, sentiment.
- `lib/models/*` — feature generation, versions, calibration.
- `lib/llm/*` — provider adapters and grounded research orchestration.
- `lib/repositories/*` — filesystem then MongoDB implementations.
- `lib/trading/*` — risk checks, previews, idempotency, audit.

## 9. Non-functional requirements

- Landing data appears within 3 seconds from warm cache.
- One failed asset/source does not blank the full dashboard.
- All timestamps are stored UTC; UI clearly renders local/market timezone.
- Responsive from mobile to wide desktop; keyboard-accessible controls and dialogs.
- No silent fallback to fabricated data.
- Structured server logs without credentials or signed payloads.
- Unit tests for normalization, factor math, risk checks, and venue signing; integration tests against demo/sandbox APIs; end-to-end tests for confirmation flow.
- GitHub CI runs dependency installation, typecheck, Next/React/TypeScript lint, the full Vitest suite, and a production build on every push to `main` and pull request. Lint warnings remain visible, but any lint error fails the gate.
