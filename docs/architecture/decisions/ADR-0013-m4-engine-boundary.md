# ADR-0013: M4 engine boundary — jobs family, engine store, identity, and persisted intent

> **Status:** Working
> **Date accepted:** 2026-10-06
> **Owners:** Platform foundation; accepted by maintainer
> **Related architecture:** [`../overview.md`](../overview.md), [`../data-identity-observability.md`](../data-identity-observability.md)
> **Evidence:** None — no job, store, schema, identity provider or provider resource exists
> **Depends on:** [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md), [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md), [`ADR-0012`](ADR-0012-read-only-projection-port.md)
> **Amends:** [`../overview.md`](../overview.md) "no background work" first slice and its future-command rule

## Context

M4 ([#80](https://github.com/money-noodle/money-noodle/issues/80)) migrates the producing half of the platform — collector, forecasts, paper engine, observers, archive — off a stopped v1 worker. The [outline](https://github.com/money-noodle/money-noodle/issues/80#issuecomment-6009533271), the [maintainer's answers of 2026-10-06](https://github.com/money-noodle/money-noodle/issues/80#issuecomment-6009650718) and its [acceptance that day](https://github.com/money-noodle/money-noodle/issues/80#issuecomment-6009663304) fix the shape; this record writes the boundary down before any child builds against it, because the repository requires an accepted boundary and a current diagram first.

Three facts from the sanitized v1 engine inventory (private) decide most of what follows. The v1 worker was **one resident Node process inside a web server on a workstation**, with every cadence an in-process timer and every lease a file on local disk. Its authoritative state was small hot atomic-rewrite JSON plus append-only journals plus sealed daily shards. And it is **stopped** — last activity between 2026-08-27 and about 2026-09-01 — which means M4 is a restart from archive rather than a cutover, and nothing has to be migrated live.

That stopped worker is also the argument. One process owning every capability is why a compaction could stop all of them at once, why "is it running?" had no answer outside the workstation, and why paper and live rows shared one ledger file. The boundary below is mostly a list of things that are no longer allowed to be shared.

What this record is not: it implements nothing. No job, schema, role, identity provider, schedule or provider resource is created here, and nothing in it grants merge, host, provider, secret or funded authority.

## Decision

### 1. A `jobs` deployment family, and the rule it exists to enforce

**One authoritative execution owner per capability. No resident worker anywhere. The API stays stateless.**

The family is one workspace project, `services/engine-jobs/`, building **one image** with one entrypoint per job. Each job is deployed as its own **Cloud Run Job** with its own **workload identity** and its own trigger, so authority and schedule are separate per capability even though the build is shared. A job may later move to its own project when it needs a different runtime or dependency closure; until then, five near-identical build pipelines would be cost without benefit, and each Cloud Run Job pins its own image digest, so they still roll independently.

Workload identity account ids follow the existing `<service>-runtime` convention and the 6–30 character constraint the bootstrap stack already validates. They are declared in the bootstrap stack by the infrastructure child, not here.

| Job | Trigger | Store | Workload identity | Idempotency rule |
| --- | --- | --- | --- | --- |
| Restore | Manual, one-time ([#241](https://github.com/money-noodle/money-noodle/issues/241)) | Reads the Scaleway archive; writes the engine store | `engine-restore-runtime` | Keyed by manifest digest and target schema version. Refuses to run against a non-empty engine schema, so a second invocation cannot double-load |
| Collector, forecast and paper engine | Cloud Scheduler ([#243](https://github.com/money-noodle/money-noodle/issues/243)) | Engine store | `engine-cycle-runtime` | Per run id, and per cycle key (asset, cycle close time) which is unique in the store. A Scheduler retry re-enters an already-recorded cycle and writes nothing |
| Projection writer | Cloud Scheduler, same cadence offset after the cycle job ([#244](https://github.com/money-noodle/money-noodle/issues/244)) | Reads the engine store; writes the public projection | `engine-writer-runtime` | Output is a pure function of committed engine rows, published as an upsert keyed by the source row identity. Running early, late or twice publishes the same record |
| Hourly threshold observer | Cloud Scheduler ([#245](https://github.com/money-noodle/money-noodle/issues/245)) | Engine store | `engine-observer-runtime` | By versioned observation identity; a duplicate identity is dropped rather than appended |
| Daily archive | Cloud Scheduler, once a day ([#246](https://github.com/money-noodle/money-noodle/issues/246)) | Reads the engine store; writes the Scaleway archive | `engine-archive-runtime` | Content-addressed: an unchanged blob re-uploads to the same address. Additive only; nothing is deleted or overwritten |

Four details inside that table are decisions rather than description:

- **The restore job verifies before it loads.** Whether a successful archive run completed after the worker's final write is *unknown* (maintainer decision 2026-10-06). So its first step is verifying the last archive manifest against the workstation copy, and only then does it transform. The workstation copy stays primary until the first GCP archive verifies.
- **The restore is a transform, not a byte-exact copy.** Historical live rows are dropped at the paper seam (maintainer decision 2026-10-06): the migrated ledger holds paper rows only, mirror-pair identifiers are carried as **inert metadata with no join**, and live-era evidence remains only in the append-only archive.
- **The cycle job holds its lease in the store, not on disk.** v1's lease was a file, which is exactly the kind of state that makes a second runner unsafe and a crash leave a stale lock. The lease is a store row with an owner, an expiry and a fencing token; one authoritative execution owner is then a property the store enforces rather than a convention.
- **The projection writer writes the three public projection tables the M3 contracts read — budget, executions and performance — unchanged in shape.** The retired long-shot table is not written. The writer role moves to this job's workload identity; the API keeps reading the same tables through the unchanged read-only port of [`ADR-0012`](ADR-0012-read-only-projection-port.md), and the public paper dashboard stays public and unauthenticated.

The hourly observer **restarts with a documented hole** (maintainer decision 2026-10-06). No backfill exists for the gap since the v1 stop, and inventing one would publish observations nobody made.

The daily archive provisions **no second archive copy** (maintainer decision 2026-10-06). The existing Scaleway archive is sufficient for M4; its contract — content-addressed blobs plus a manifest, append-only, verified by read-back — is reused rather than redesigned.

### 2. The engine store

**Neon PostgreSQL, in a schema named `engine`, separate from the public projection tables** (maintainer decision 2026-10-06). The public projection lives in `public` with its `money_noodle_public_*` tables; the engine owns `engine` and nothing else, and does not read or write the public schema except through the projection writer job.

Three roles, named by purpose, and they are the point of the separation:

| Role | Held by | Grants |
| --- | --- | --- |
| `engine_writer` | the restore, cycle and observer jobs | `SELECT`, `INSERT`, `UPDATE` on `engine` tables. No `DROP`, no `CREATE`, no privilege on `public` |
| `engine_reader` | the platform API's read path, and the projection-writer and archive jobs | `SELECT` on an explicitly granted subset of `engine`, and nothing else |
| `engine_control_recorder` | the platform API's control path, and every job | `INSERT` on the one append-only control table, and nothing else — no `SELECT`, no `UPDATE`, no `DELETE`, nothing on any other table or schema |

The third role exists because the second one has to stay honest. Recording a control fact is a write, and widening `engine_reader` to permit it would give the API's read path a privilege ADR-0012 spent a whole record removing, and would end the readiness check that proves `SELECT`-only. Keeping them apart costs a second connection and secret container, and buys a read path that cannot record anything and a control path that cannot read the engine. *Reading* control history is an ordinary read through `engine_reader` or `engine_writer`.

A workload identity and a database role are different things, and M4 uses both: the identity governs which secret a job may read, the role governs what the connection may do once opened. So the restore, cycle and observer jobs produce engine state as `engine_writer`; the projection-writer and daily-archive jobs only consume it and connect as `engine_reader`, the projection writer holding its write grant on `public` from whoever owns the public schema rather than from this record. Every job additionally holds `engine_control_recorder`, because appending its own outcome row is the one write a consuming job must make.

Migrations are applied by the schema owner out of band, never by `engine_writer`. A job that could migrate its own schema is a job that can destroy the restored seed in a bad release, and the restore seed is the one thing in M4 that cannot be re-derived.

**Sealed forecast shards and evidence batches live in the engine schema, as rows, in M4.** The alternative — an object store — is not available on terms this record can rely on: the accepted historical direction is the Scaleway *archive*, whose contract is additive backup rather than working storage, and [`ADR-0008`](ADR-0008-single-object-store.md) is Proposed, not Working, so nothing may depend on it. Keeping shards in the schema gives one transaction boundary, one lease, one backup path and one restore target, which is what makes the restore child's verification meaningful. The cost is accepted and named below: PostgreSQL is a poor blob store, and if shard volume grows this has to move.

One bucket does exist for the restore, and it is worth saying plainly what it is not. The restore job's inputs have to be somewhere the execution can read — a container reads its image and its mounts and nothing else — so the platform stack declares a private, versioned **staging bucket** with a bounded object life, mounted into the job, readable and appendable by the restore identity alone (#241). It holds one job's staged copy of state that exists elsewhere, plus the evidence document the execution writes back, and it is retired with the job. It is **not** a platform object store, it carries no authoritative record, nothing else reads or writes it, and declaring it neither depends on nor promotes ADR-0008, which remains Proposed.

The API's access to the engine store is one adapter directory, `services/platform-api/src/adapters/engine-store/**`, holding both connections: the read path as `engine_reader` and the control path as `engine_control_recorder`. Both follow the custody rules of the projection port — a Secret Manager container declared empty, bound by reference, filled by the maintainer out of band, with no value passing through this repository ([`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md)). The API's inner layers depend on ports and may not import this directory, the repository check refuses a database driver outside it, and the jobs' writer adapter lives in `services/engine-jobs/` where the API may not import it at all.

### 3. The persisted-intent contract

Every control action is a durable row in one append-only control table in the `engine` schema, which carries intent rows and the outcome rows jobs append against them. The API records intent as `engine_control_recorder` and performs no effect itself; jobs read intent at the start of a run and **never act on in-memory state**. The API never calls a job, and a job is never woken by a request.

The row carries, at least: `capability` (which job it governs), `action` (configure, pause, resume, reset, provider enable), `actor` (the principal, agent or workload identity that recorded it), `epoch`, `recorded_at` and the `run_id` of the recording request. Because the table is append-only and no role may `UPDATE` it, a job records what it did by appending its own outcome row — `applied_run_id`, `applied_at`, `outcome` (`applied`, `refused`, `superseded`) and a fixed `reason` code — as `engine_control_recorder`, rather than mutating the intent it read. "Latest row for a capability" is therefore evaluated over intent rows, not over the table. Intent and outcome together are the audit; there is no separate control log to keep in step.

**An intent is current when all three hold**, and **stale otherwise**:

1. it is the latest row for its capability, ordered by `(epoch, recorded_at, id)`;
2. its `epoch` equals the engine store's current control epoch; and
3. its `recorded_at` is not in the future by more than the allowed clock skew.

**Missing and stale are treated identically: the job runs paused.** It performs no external effect, records no cycle, and writes an outcome row saying which of the three conditions failed. The control epoch increments on any event that invalidates prior intent — a restore or reseed, a budget reset, a schema migration — so a resume recorded before a reseed cannot silently authorise the engine after it.

Staleness is deliberately **not** a time horizon. An operator's "resume" from three weeks ago is still the operator's wish, and expiring it would turn a quiet period into an unexplained stop; the risk actually worth guarding is acting on intent that something superseded, which is what the epoch catches.

Jobs are **idempotent per run id**, so a Scheduler retry cannot double-record a cycle, double-apply an intent, or double-publish a projection row.

### 4. Identity, and the two budgets

**Google Identity Platform** (maintainer decision 2026-10-06), implemented by [#242](https://github.com/money-noodle/money-noodle/issues/242), behind the platform API's authentication adapter — the slot [`../overview.md`](../overview.md) already reserves and the contract's empty `security: []` leaves open. **MFA is on from the start.** Sessions are **server-side and revocable**, bound to one account. None of v1's authentication is carried over in any form, and this record does not describe it: v1 is still serving, so its mechanism stays out of a public document.

**One account holds two budget records, `paper` and `live`, with the same schema and the same controls** — configure, pause, resume, reset, provider enable — through the same intent endpoints and the same audit. Only the paper budget is wired to an engine in M4.

The live budget **exists as a record only.** In M4 there is **no venue credential in Secret Manager, no live wire module, no reconciliation job, and no arming path.** Kill switch and live enable stay outside the UI. Any funded authority is a separate accepted authority design; this record does not begin one, and the platform's "no real-money authority" rule is unchanged.

Reads: the public paper dashboard stays **public and unauthenticated**, and the M3 contracts are unchanged. Signed-in reads in M4 are the paper budget detail, intent history and job health.

### 5. What this boundary refuses

- No resident worker, in any deployment. The API does not acquire a scheduler, a queue consumer or a timer.
- No second datastore beyond the engine store and the existing projection and archive.
- The web gains nothing: no store, no job module, no scheduler. It reaches engine data only through the API's contract, as it reaches paper data today.
- No live execution path, venue credential, or funded authority.
- M5 ([#81](https://github.com/money-noodle/money-noodle/issues/81)) owns `noodle.money` routing, Vercel retirement and Neon ownership. M4 touches none of them.

## Alternatives considered

**Keep one process and schedule it externally.** Rejected. It preserves the property that made v1 fragile — one failure domain for six capabilities — while adding a scheduler, and it makes "one authoritative execution owner per capability" unprovable.

**Five separate workspace projects, one per job.** Rejected for now: the jobs share the engine domain and the store contracts, so five build pipelines would mostly rebuild the same code. Revisit when a job needs a different runtime or dependency closure — the separation that matters, identity and schedule, is already per job.

**Engine state in the object store rather than Postgres.** Rejected: the only accepted object-storage direction is the Scaleway archive, which is additive backup rather than working storage, and ADR-0008 is Proposed, so depending on it would depend on something that is not authority. Revisit when shard volume makes rows expensive, or when an object-store decision becomes Working.

**One schema shared with the public projection.** Rejected: it would give the engine's writer a grant surface over the tables the public dashboard serves, and make revoking one revoke the other. The whole point of ADR-0012 was that the API reads somebody else's table; that stays true with the writer on this platform.

**A single role for jobs and API.** Rejected, for the reason ADR-0012 already gave: a role that *can* write is one merge away from writing.

**Widening `engine_reader` with an `INSERT` so the API can record control facts with one connection.** Rejected, and it is the same reason stated once more. One `INSERT` grant is what makes the readiness proof stop being a proof, and the saving is one secret container. Revisit only if the recorder's separate connection turns out to cost something real.

**Time-based staleness for intent.** Rejected — see above; it converts a quiet control plane into an engine outage and does not catch the failure that matters.

**Chaining the projection writer to the cycle job's completion.** Rejected as unnecessary machinery: the writer's output is a function of committed rows, so an offset schedule plus idempotency gives the same result and keeps the writer running when the cycle job is paused.

**Carrying historical live rows into the migrated ledger.** Not ours to weigh — the maintainer decided to drop them at the paper seam on 2026-10-06. Recorded here because the restore child's transform depends on it.

## Consequences

### Positive

- Six capabilities become six failure domains with six identities. A compaction, a bad release or a stuck lease stops one of them.
- "Is it running?" becomes a question with an answer: a job execution, its intent row and its outcome row.
- Paper and live stop sharing a store. The live budget can exist as a record without existing as a capability, which is what lets the account model land before any funded design.
- The engine's state has one restore target, which is what makes the restore child's verification a real check rather than a partial one.
- The API's statelessness is preserved at the moment it was most likely to erode, and the web's boundary does not move at all.

### Negative

- `overview.md`'s "no background work" property is genuinely gone, as its database-free property went in ADR-0012. Every later reader must now ask which job, under which identity, on which schedule.
- PostgreSQL holds blobs it is not ideal for. This is a deliberate, bounded trade and the first thing to revisit if shard volume grows.
- Five Cloud Run Jobs, five identities and five schedules are more infrastructure than one process, and each is a thing that can be misconfigured independently.
- A shared image means a bad build can reach every job, even though each pins its own digest.
- Scheduler-driven cadence is coarser than v1's in-process timers. A 15-second cycle inside a short run is a design the cycle child has to prove, not a property this record can assert.
- Intent adds a read and a write to every run, and a control plane that is wrong in a new way: a stuck epoch pauses the engine until someone notices.

### Neutral or deferred

- Nothing here is applied. No job, schema, role, identity provider or schedule exists, and the account ids above are names, not resources.
- The engine store's connection custody reuses ADR-0005 and ADR-0012's pattern rather than extending it; the containers and grants are the maintainer's to create.
- Whether the public projection remains the long-term read path is unchanged by this record: the writer moves, the contract does not.
- The restore's completeness question is open until the restore child verifies the manifest. This record states the verification, not its result.

## Status and evidence

Working: decided enough to build on, not production-proven. **There is no evidence of any kind** — no job has run, no schema exists, no identity provider is configured, no intent row has ever been written, and no provider resource was created for this decision.

What is exercised by repository checks: the boundary rules in [`../../../tools/verify-boundary-rules.mjs`](../../../tools/verify-boundary-rules.mjs), which refuse the web a jobs module, an engine-store module and a scheduler runtime; refuse the API a jobs module and a scheduler runtime; and refuse the API's inner layers its own engine-store adapter. Those probes pass against a tree in which none of the forbidden modules exists yet, which is the point: they are written to bite when the children land.

Promotion to Settled would need every job running remotely under its own identity with dated evidence, the restore verified, and intent observed failing closed on a missing or superseded row. None of that has happened.
