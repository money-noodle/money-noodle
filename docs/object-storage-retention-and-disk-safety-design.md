# Object-storage retention and local-disk safety

> **Document type:** Architecture design
> **Design status:** Accepted
> **Implementation:** Partial
> **Created:** 2026-08-24
> **Canonical requirements:** [`spec/storage-and-architecture.md`](../spec/storage-and-architecture.md)
> **Decision record:** [`DEC-20260824-03`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

**Status:** approved design; phased implementation begins 2026-08-24
**Scope:** persistent worker durability, verified restore, bounded local retention, and disk-pressure behavior
**Non-goals:** no policy, forecast, order, fee, sizing, budget, reconciliation, or execution-semantic change

## 1. Problem and measured baseline

The persistent worker needs local POSIX files for atomic rename, append-only journals, startup reconciliation, and the funded execution ledger. Scaleway Object Storage is S3-compatible object storage, not an appendable or atomically renamed filesystem, so mounting it in place of `data/` would weaken the storage guarantees that money paths depend on.

At the 2026-08-24 baseline, `data/` occupied about 1.4 GB. The latest successful archive manifest covered 133 eligible files and 1,416,335,950 source bytes, compressed to 129,974,588 bytes. An independent HEAD pass found all 133 content-addressed objects with matching SHA-256/source-byte metadata, and all current candidate paths appeared in that manifest. Roughly 11 MB of frozen `.corrupt-*`, `.journal-copy`, and `.superseded-*` artifacts were excluded by archive v1's extension rule.

The larger immediately reclaimable allocation was non-durable Next output: `.next/cache` plus `.next/dev` occupied 2,905,120 KiB. Next 16 documents these as reusable build and development caches; production output lives separately under `.next/server` and `.next/static`.

The archive bucket had no lifecycle configuration, versioning was suspended, and Object Lock was absent when read on 2026-08-24. The dedicated application credential has object read/write and bucket-read authority but no object-delete or bucket-write authority. That protects against deletion by this process, but bucket-owner deletion or account loss still prevents the current bucket from becoming the only copy without Object Lock or an independent replica.

## 2. Storage classes

Every local path belongs to exactly one class. A generic disk-pressure task may never infer a class from age or size.

| Class | Examples | Local rule | Object-storage rule |
|---|---|---|---|
| Ephemeral/rebuildable | `.next/cache`, `.next/dev`, stale atomic-write temps whose target exists | Exact-path cleanup is allowed; never remove production output | Do not archive |
| Hot authoritative | canonical execution ledger, trading control, reconciliation checkpoint, open forecast set, indexes, active journals | Remains local; owner alone mutates it | Snapshot backup only |
| Sealed immutable | terminal forecast row shards, sealed execution evidence batches | May become remote-primary only after an owning reader supports verified hydration | Content-addressed blob plus durable tier catalog |
| Frozen historical | corrupt generations, migration inputs, superseded journals | May be evicted after exact archive match, complete restore drill, and catalog publication | Retain indefinitely initially |
| Owner-compacted journal history | future sealed journal segments | Generic archive never truncates it; owner publishes segment/index/hot tail | Segment can be tiered after owner verification |

Retention is not evidence deletion. Remote-primary content remains part of the logical dataset and every latest logical manifest must continue to reference it after the local source is absent.

## 3. Archive and restore contract

Archive v1 remains snapshot-only and performs no deletion. Candidate selection expands narrowly to frozen JSON/JSONL derivatives such as `.corrupt-*`, `.journal-copy`, and `.superseded-*`; hidden files, archive state, locks, and atomic-write temps remain excluded.

For every archived file:

1. Stream the local bytes through SHA-256 and gzip.
2. Require the source identity, size, and modification time to remain stable across the snapshot; a file changed during capture fails the pass rather than publishing a mixed file version.
3. Store at `blobs/sha256/<prefix>/<sha256>.gz` with original hash and byte count as metadata.
4. Read every newly uploaded blob back through gzip and verify source hash/bytes.
5. Publish the manifest only after every candidate is represented by a verified new or existing blob.

An independent restore command is a prerequisite to any durable local eviction. It:

- reads a specified manifest and verifies its own stored checksum metadata;
- rejects absolute, traversal, backslash, duplicate, malformed-hash, or wrong-prefix entries;
- downloads every blob, gunzips into a new staging tree, and verifies original SHA-256 and byte count;
- publishes the requested restore directory by one rename only after the complete set passes;
- never writes into active `data/` and refuses an existing destination;
- emits auditable manifest/file/byte totals.

The restore is not yet an account-wide atomic snapshot: independently mutable files may represent nearby but different instants. Hot funded authority therefore stays local. A full standby restore remains paused/manual: restore, run forecast and execution-ledger semantic verifiers, reconcile venue state authoritatively, and Resume explicitly.

## 4. Remote-primary tier protocol

Local eviction is a separate future operation, not a flag on the daily archiver. It requires a durable `object-tier-index.json` whose records include relative path, owner/storage class, source SHA-256 and bytes, object key, manifest key, and verification time.

The transaction is ordered:

1. The owning store proves the path immutable and allowlisted.
2. The evictor hashes the current local file and requires an exact manifest/object match.
3. It downloads and verifies the complete object independently.
4. It atomically publishes the updated local tier index and uploads/read-verifies the new complete logical catalog/manifest.
5. Only then may it unlink the local source.

A crash before catalog publication leaves the local source authoritative. A crash after publication but before unlink leaves two copies. A crash after unlink leaves a catalogued remote source. No phase leaves an unreferenced sole remote object.

Readers use an owner-aware `readTieredFile`: local first, then catalogued download into a bounded checksum-verified cache, then atomic publication. Hot collection, reconciliation, status, and live execution must never require object-storage availability. Missing or corrupt remote evidence fails the requesting offline report/maintenance operation; it cannot silently become an empty history.

Forecast tiering additionally requires a new owner generation that carries unchanged old shard/index/rollup identities forward without loading and rewriting every old row shard. Until that lands, active indexed forecast shards remain local. Execution evidence likewise remains local until startup/control readers no longer require all batches.

## 5. Disk-pressure behavior

Disk monitoring uses blocks available to the unprivileged worker and requires at least **10% of total filesystem capacity free**. `npm run check:disk` reports the exact total, available, threshold, and deficit and exits nonzero below the reserve. Because APFS volumes share container capacity, this is an operating-volume requirement rather than a Money Noodle directory quota.

Only exact rebuildable paths and already-safe stale temps may be reclaimed automatically. Disk pressure never authorizes deletion of `data/`, journal truncation, ledger rewriting, removal of a corrupt generation, or eviction lacking the tier transaction above. Falling below 10% requires operator cleanup and blocks declaring storage healthy. A future funded-admission interlock is separate money-path work: activating it while the host is already below 10% would immediately stop new exposure, so it requires explicit approval and fail-closed tests rather than being smuggled into housekeeping.

The explicit Next cache cleaner refuses a running `next dev` or `next build`, rejects symlinked/unexpected targets, removes only `.next/cache` and `.next/dev`, and verifies neither `.next/server` nor `.next/static` is in its deletion set. A running production `next-server` is permitted.

## 6. Bucket durability requirement

No local durable source becomes sole-copy remote while the current bucket lacks Object Lock and an independent replica. Before the first eviction, the operator must either:

1. provision a bucket with enforceable retention/Object Lock and copy/read-verify the content-addressed set; or
2. maintain a second independently credentialed bucket/account and require both copies to verify.

Application credentials remain unable to delete objects or change bucket policy. No lifecycle expiry or object garbage collection is introduced in this phase.

## 7. Phases and gates

### Phase 0 — immediate reclaim and proof

- reclaim exact Next build/dev caches;
- expand archive candidate coverage for known frozen derivatives;
- implement and test the independent byte-exact restore command;
- run a full restore into temporary storage and run canonical forecast and execution-ledger verification;
- retain all durable local files.

### Phase 1 — frozen historical tier

After bucket durability and a successful restore report, add the tier catalog and allowlist frozen corrupt/migration artifacts. Estimated current reclaim is about 716 MiB. The deletion command remains manual and dry-run by default.

### Phase 2 — sealed forecast rows

Add owner-aware hydration and an incremental forecast generation that does not rebuild old terminal shards. Keep index, rollups, open artifact, and active journal local. Estimated current reclaim is about 432 MiB, followed by bounded growth.

### Phase 3 — owner-specific bounded stores

Design execution evidence, trading-control audit, and each observational journal separately. Owners publish immutable segments and compact rollups before any local segment eviction. The shared account ledger remains one logical ledger and every aggregation remains strategy-scoped where required.

## 8. Acceptance criteria

Phase 0 is complete only when:

- cache cleanup reclaims only the two documented paths and production remains healthy;
- archive tests pin derivative inclusion, changed-during-capture refusal, traversal rejection, complete restore, and checksum failure;
- a current Scaleway manifest restores every file byte-exactly;
- restored forecast and execution-ledger semantic verifiers pass;
- no durable local file has been deleted.

Any failed restore, semantic verifier, bucket durability check, or catalog publication blocks eviction. It is never converted into a warning.
