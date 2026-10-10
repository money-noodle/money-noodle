# Forecast stage 2 — implementation qualification

## Scope and authority

This is the stage-2 candidate for #243, not completion of the issue. The maintainer authorized the additive services/platform-api/migrations/0005-*.sql path deviation on October 10, 2026. Migrations 0001–0004 and restored rows are unchanged. No merge, runtime DDL, deploy, scheduler activation, paper execution, funded authority, projection, observer or archive change is authorized. Committed infrastructure stays dry, paused and without a secret binding.

## State and provenance

The existing budget:paper intent/epoch is evaluated once at run start, as ADR-0013 and the stage-1 contract specify. This grants only that bounded run; it is not repeated mid-run intent evaluation. Live lease checks guard each forecast effect phase and mutation. A unique (asset, close time) cycle groups many immutable observation identities rather than discarding four qualified 15-second observations. Non-qualified calculations use the historical minute identity. Run retries never call feeds; observation retries never replace contents.

New rows reference job_run_record, not a fabricated restore run. Restored resolution writes an overlay with the original restore-run foreign key and the current mutation run. Original restored JSON is untouched. Slim references are rehydrated from restored contract provenance. Missing/mismatched provenance cannot substitute another venue.

Forecast mutations lock and validate the same lease transactionally, including database-clock expiry. Oracle samples and row/events commit or roll back together. Terminal overlays cannot be rewritten by late results. Events are append-only for the writer role.

## Historical semantics and adaptations

Constructed inputs compare an independent transcription of historical basis/Blend 0.4 equations with the implementation at 1e-13 tolerance across price, slow-feature and time matrices. Tests cover confidence, independent asks/taker fees, policy qualification, observation-only candidate probabilities, identities, scoring, backoff, abandonment and venue/contract integrity. No archive runtime import or private fixture is published.

Provider target records retain actual venue close times, binary outcome/token mapping, bounded rules fingerprints and known settlement metadata; unknown oracle/reference/window metadata remains unknown. Kraken basis inputs are explicitly the historical same-series cycle-open approximation, not equality with a venue oracle. The legacy observation-only settlement distribution retains its historical 60-second default when a contract window is unknown; that is a model assumption, not manufactured venue provenance.

The six candidate probabilities are observations only. Candidate entry comparisons describe paper research, not funded capability. They cannot choose production probability or promote a model. Existing model-promotion records remain restored immutable history.

Public requests use fixed origins and bounded deadlines. Calculation and bounded resolution are awaited, replacing the historical detached process-local resolution task. At most 20 asset/close cycles and 40 target requests are resolved per pass. Tick waits subtract elapsed work from the 15-second cadence. No detached work survives exit.

The October 8 ADR-0013 restore narrowing leaves historical sealed bodies/rollups/IDs in the frozen archive. This stage adds hot rows/events, not sealing, compaction or a new retention policy. Long-term new-row retention remains future work. Historical diagnostic payloads unrelated to production probability (cycle regimes and quote-trajectory research) are not active collectors here.

## Validation status

**Unvalidated candidate until exact-head remote checks and independent review finish.** No local install, build, test suite or database operation was run. Lightweight inspection, formatting and diff/privacy scans are not tests.

The engine contract target runs only in GitHub Actions and accepts no arbitrary database URL. It creates disposable loopback PostgreSQL 16, applies/reapplies migrations to synthetic rows and exercises real adapters: cycle grouping, duplicate rows, restored overlay/reference rehydration, stale token/expiry rejection, role grants and immutable events. It never contacts the engine database. Unit coverage thresholds are unchanged; PostgreSQL adapters are checked by the remote contract, not the DB-free unit suite.

Required before review-ready: exact-head CI green, independent arithmetic/provenance/security review, findings fixed and exact-head requalification. Stages 3–4 remain open. This candidate references #243; it does not close it.

## Outstanding independent review

Provider-control materialization and Kalshi-only/candidate research adaptations are not established copied parity. The current implementation reads the restored paper registry and applies no archived promotion authority. Broader live/current-control changes are not authorized here. Full calibration/candidate DTO fidelity, streaming resource limits, fair due-work selection and remaining independent requalification must finish before readiness.
