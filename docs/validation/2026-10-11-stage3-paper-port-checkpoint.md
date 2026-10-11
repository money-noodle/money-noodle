# Stage 3 paper port: accumulated unqualified checkpoint

Refs #243. This is an unqualified implementation checkpoint, not review-ready
or deployed evidence. Stage 2 was accepted via PR #274, merged at
501fad6daea2164e370be87343538a8f25603b14. Its full archived calculation closure
was not executed: static comparisons, synthetic vectors and hosted PostgreSQL
checks must not be described as exhaustive historical runtime parity.

## Initial queue slice and subsequent pure additions

The isolated paper queue domain ports historical v7 microsecond event-time
cutoffs and conservative displayed-queue consumption into public-data DTOs.
It has no imports, provider client, signed order path, store, timer or execution
authority. Batches and retained print identities are bounded. Synthetic expected
vectors exercise UP/DOWN, partial quantity, duplicate evidence, missing queue,
wrong taker side, inclusive horizon and one-microsecond exclusion.

The initial queue slice alone did not implement the rest of the engine. Subsequent additions now include pure entry/persistence/portfolio/episode reducers, managed repricing, fee/maker/IOC accounting, sale/exit/switch plans and configuration/authority/regime DTOs. None composes or executes durable reservation/settlement, SQL transactions or the application paper lane. The existing
entrypoint continues refusing paper mode. No intent, epoch, migration, schedule,
secret binding or production state was changed.

## Storage boundary requiring explicit scope approval

Restored ledger/state tables require a genuine restore-run foreign key. A new
paper execution must not forge that provenance or mutate the restored seed.
Forecast overlay migration 0005 does not authorize paper storage. The remaining
port needs an additive paper order/state overlay with original restore-or-run
provenance, current mutation-run attribution, epoch/funding identity, immutable
revision events and database-enforced order/fill/settlement uniqueness.
A new migration path is outside the issue's original scope and the prior
stage-2-only 0005 exception. No 0006 file is authored in this checkpoint.
Exact DDL is still subject to the remaining entry/risk/funding contract audit.

## Ordering and evidence limits

Historical source, not just the inventory summary, confirms forecast recording
before the paper cycle; within paper: signal persistence, settlement,
counterfactuals, standalone exits, portfolio decisions, orphan expiration,
entry reservation persisted before managed simulation, then final accounting.
The historical resolver was detached; the port must make phases bounded and
awaited. Live, reconciliation, detached sentinels and projection remain excluded.

Tests in this checkpoint are new synthetic expectations, not executed archive
fixtures. Full hosted checks and independent exact-head review remain required.
No local dependency installation, build, suite or database run was performed.

## Current review and execution boundary

F1–F7 guards are implemented pending fresh independent confirmation and current-head hosted qualification. The reported71 authored cases is not a verified executed/passed count. CI38107395722 on0f22cdc failed typecheck (TS2375 in the malformed-fill fixture); hosted lint/build/test/contract target summaries succeeded with case counts suppressed. The fixture correction retains omitted/invalid quantity refusal rather than weakening an assertion.

Pure authority snapshots, expected identities, completeness and historical warming lineage are caller claims, not DB provenance. Restrictive and historical warm-lineage contracts are distinct proposals; no full historical parity is asserted, including explicit queue chronology and IOC source-epsilon corrections. IOC and sale arithmetic now exists as pure plans, not runtime effects. Compiled availability remains false, paper refuses and migration0006 author/test permission remains pending. No real paper SQL transaction/fault/concurrency proof exists; forecast PostgreSQL validation is not that proof. GoalOPEN/PR275DRAFT remains.
