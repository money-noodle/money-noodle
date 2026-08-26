# Object-storage restore and local-disk reclamation — 2026-08-24

## Finding

A fresh expanded Scaleway archive restored all **138/138** manifest files byte-exactly and passed the production forecast-storage and execution-ledger semantic verifiers. Rebuildable Next build/development caches reclaimed **2,905,120 KiB** without stopping the production server or removing production output. No durable local source was deleted.

This completes the archive/restore proof and closes the pending first automatic forecast-v3 seal observation. It does **not** authorize remote-primary eviction: mutable files are not one account-wide point-in-time generation, and the bucket has neither Object Lock nor an independent replica.

## Inputs and method

Final expanded manifest:

- key: `money-noodle/v1/manifests/2026/08/24/2026-08-24T16-16-01-305Z.json`
- manifest time: `2026-08-24T16:16:01.305Z`
- manifest SHA-256: `0670e1179e8dcc2b1b7ecc659a9c9974e318fae851ba0c0b671e1826d17b9ce1`
- restore destination: a new `/tmp/money-noodle-restore-expanded-20260824/data` staging tree, removed after verification
- restore implementation: `restoreLocalArchive` in `src/lib/local-data-archive.ts`
- semantic commands: production `scripts/verify-forecast-storage.ts` and `scripts/verify-execution-ledger.ts`, run with the restored directory as `process.cwd()/data`
- cache baseline: `du -sk .next/cache .next/dev`
- runtime check: `.next/server` and `.next/static` remained present and `/api/dashboard` returned HTTP 200 after cleanup

The restore fetched the manifest under its stored checksum metadata, rejected unsafe-path shapes before writing, downloaded and gunzipped every object, recomputed original SHA-256 and byte count, wrote each file at mode `0600`, and renamed the complete staging tree into visibility only after all files passed.

Before the final pass, the prior 133-file manifest was also restored independently and passed both semantic verifiers. The final archive expanded coverage to frozen `.journal-copy`, `.jsonl.corrupt-*`, and `.jsonl.superseded-*` evidence and required every source file to remain stable while its snapshot was captured.

## Auditable totals

### Expanded archive and restore

- Files: **138 / 138**
- Original bytes: **1,436,922,799 / 1,436,922,799**
- Compressed bytes: **130,967,357**
- New blobs during final archive: **30**
- Reused content-addressed blobs: **108**
- Missing objects: **0**
- Checksum or byte-count failures: **0**

### Restored forecast storage

The full field-by-field production verifier returned `ok: true`:

- index generated at: `2026-08-24T13:38:01.496Z`
- current total rows after journal replay: **74,817**
- sealed rows: **73,680** across **17** shards
- current open rows: **1,137**
- journal events: **4,130**
- stored rollup bytes: **15,069,668**
- verifier errors: **0**

The earlier restored manifest independently verified the first v3 automatic seal generated at `2026-08-23T17:03:39.476Z`; the final manifest additionally included the next generation and a 2026-08-24 shard. This is storage evidence only and does not recalculate or authorize an economic conclusion.

### Restored execution ledger

The production verifier returned `ok: true`:

- ledger version: **9**
- orders: **4,397**
- compact evidence references: **3,548**
- compact ledger bytes: **16,339,707**
- fully hydrated equivalent bytes: **46,503,797**

### Rebuildable cache cleanup

- `.next/cache`: **1,592,016 KiB**
- `.next/dev`: **1,313,104 KiB**
- total reclaimed: **2,905,120 KiB** (about **2.77 GiB**)
- remaining `.next` production tree after cleanup: about **64 MiB**
- production dashboard check: **HTTP 200**
- filesystem availability after deleting only the temporary restored copy: approximately **34 GiB**

## Bucket durability check

Read-only bucket configuration on 2026-08-24 reported:

- lifecycle configuration: absent;
- versioning: suspended;
- Object Lock: absent.

The archive application credential remains unable to delete objects or change bucket policy. The absence of lifecycle expiry is favorable, but owner/account deletion remains possible. Object Lock/enforceable retention or a second independently verified bucket remains a hard gate before any local durable source becomes sole-copy remote.

## Caveats and authorization

The caveat that most threatens a broad restore claim is cross-file consistency: archive v1 captures each file independently while the worker may continue writing other files. Every captured file was stable during its own snapshot, exact bytes restored, and both owner verifiers passed, but the manifest is not one atomic account-wide transaction. Venue reconciliation can recover authoritative account state, but not every non-venue research observation.

Authorized now:

- retain and use the explicit Next-cache cleaner;
- retain and use the independent restore command;
- treat archive coverage and first-seal restore verification as complete for this dated manifest;
- proceed to the separately designed bucket-durability and tier-catalog phase.

Not authorized:

- deleting any file under active `data/`;
- truncating journals through generic housekeeping;
- evicting sealed forecast shards or execution evidence;
- treating Scaleway as the sole copy before the bucket-durability and tier-catalog gates.
