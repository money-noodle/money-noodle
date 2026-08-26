# Storage and architecture

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-26
> **Canonical for:** durable storage, migration boundaries, technical architecture, runtime cadence, and non-functional requirements.  
> **Read with:** [`trading-risk-and-budget.md`](trading-risk-and-budget.md) when storage can affect funded authority or reconciliation.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

## 6. Storage

<a id="req-storage-local"></a>

### Initial local storage

`.cache/*.json` stores timestamped response envelopes and hourly price history. Writes are atomic (temporary file then rename). Runtime cache is gitignored.

Planned repository boundaries:
- `MarketSnapshotRepository`
- `ForecastRepository` (durable local snapshot `data/forecast-history.json` plus append-only `data/forecast-history.journal.jsonl`; process-cached replay and bounded compaction avoid full-history rewrites on each observation) 
- `NewsRepository`
- `AccountSnapshotRepository`
- `OrderAuditRepository`
- `ResearchSessionRepository`

Forecast history uses a bounded open set, sealed immutable content-addressed daily shards, and per-shard rollups.
Summary readers use rollups and must not load sealed shards to answer a summary question. Counts and identities are
exact; floating aggregates use a `1e-12 × max(1, |left|, |right|)` combined absolute/relative comparison bound for
unavoidable summation-order noise. Policy-scoped statistics retain policy identity in compact keys: an unscoped
legacy counterfactual is never attributed to the active policy. A reader may switch generations only after the
field-by-field semantic verifier passes. See
[`docs/forecast-storage-design.md`](../docs/forecast-storage-design.md) and
[`docs/forecast-storage-generation-repair-design.md`](../docs/forecast-storage-generation-repair-design.md).

Retention is a separate decision from storage affordability. Sharding or compaction does not authorize deletion.

An optional S3-compatible off-machine archive runs only on the persistent worker. A detached low-priority process
compresses allowlisted durable files and frozen corrupt/superseded derivatives into SHA-256-addressed immutable
blobs, uploads only missing content, reads every new blob back through decompression while verifying original
checksum and byte count, and publishes a timestamped manifest only after all files pass.

Archive publication never deletes or mutates local source data. Independent restore rejects unsafe paths and
reproduces every manifest byte under its original checksum before eviction can be considered. Remote-primary
removal is a separate owner-aware tier transaction: only allowlisted immutable content may move; hot ledgers,
journals, indexes, and open sets remain local; and a durable tier catalog retains remote-only identities. No sole
local copy may be removed until enforceable retention/Object Lock or an independently verified second bucket exists.
Archive credentials belong only to a dedicated local application identity, never the repository or stateless host.
See [`docs/object-storage-retention-and-disk-safety-design.md`](../docs/object-storage-retention-and-disk-safety-design.md).

The persistent worker also performs best-effort startup reclamation of orphaned atomic-write temp files under
`data/` and `.cache/`. A `${target}.<pid>.<rand>.tmp` may be removed only when it is older than 60 seconds
and the real rename target already exists; an absent target, fresh file, symlink, hidden subtree, malformed
name, or stateless host is never touched. This housekeeping cannot rewrite a ledger or be the only owner of
durable content, and it never delays startup reconciliation or collector activation.

<a id="req-storage-mongodb"></a>

### MongoDB migration

Replace repository implementations without changing domain/services. Add TTL indexes for raw cache records and durable collections for forecasts, outcomes, trades, and audit events. Credentials do **not** belong in MongoDB documents in plaintext.

<a id="req-storage-architecture"></a>

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

<a id="req-storage-nonfunctional"></a>

## 9. Non-functional requirements

- Landing data appears within 3 seconds from warm cache.
- One failed asset/source does not blank the full dashboard.
- All timestamps are stored UTC; UI clearly renders local/market timezone.
- Responsive from mobile to wide desktop; keyboard-accessible controls and dialogs.
- No silent fallback to fabricated data.
- Structured server logs without credentials or signed payloads.
- Unit tests for normalization, factor math, risk checks, and venue signing; integration tests against demo/sandbox APIs; end-to-end tests for confirmation flow.
- GitHub CI runs dependency installation, typecheck, Next/React/TypeScript lint, the full Vitest suite, and a production build on every push to `main` and pull request. Lint warnings remain visible, but any lint error fails the gate.
