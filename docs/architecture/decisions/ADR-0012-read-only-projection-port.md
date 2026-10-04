# ADR-0012: Read-only projection port for the existing paper projection

> **Status:** Working
> **Date accepted:** 2026-10-04
> **Owners:** Platform foundation; accepted by maintainer
> **Related architecture:** [`../overview.md`](../overview.md)
> **Evidence:** None — no provider resource applied and no database reached from the platform
> **Depends on:** [`ADR-0001`](ADR-0001-separate-web-and-platform-api.md), [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md)
> **Amends:** [`../overview.md`](../overview.md) "database-free" first slice

## Context

[`../overview.md`](../overview.md) establishes the smallest boundary that can prove the web/API, contract, trust, deployment and observability requirements "without introducing identity, tenant data, a database, provider credentials, background work, simulation, or funded authority". That was the right first slice, and the first status endpoint is deliberately database-free.

M3 ([#79](https://github.com/money-noodle/money-noodle/issues/79)) migrates the public paper dashboard, and the [accepted migration outline](https://github.com/money-noodle/money-noodle/issues/78#issuecomment-5975551638) is explicit about where its data comes from: a separate system — the v1 worker — already writes a sanitized PostgreSQL projection of four tables, and the existing public site reads it. The projection is frozen at the worker's pause, which makes this the calmest moment this migration will ever offer to introduce database access.

So the database-free rule has to change, and the interesting question is how little it can change by. Three things make that possible:

- **The projection is not this service's schema.** Another system owns the writes, the column meanings and the names. The API is a reader of somebody else's table, which is a materially weaker claim than owning a store.
- **There is no identity, no tenant and no funded authority yet.** The projection carries only the sanitized public data today's public site already serves.
- **There is still no read endpoint.** The contracts ticket ([#210](https://github.com/money-noodle/money-noodle/issues/210)) adds those. This decision is about the port and its custody, so the credential boundary is settled before anything renders.

The temptation worth naming: a database connection is the usual way "the API must never become a resident multipurpose worker" starts to erode, because once a connection exists, a write is one line away. This decision is shaped mostly around making that line impossible to add quietly.

## Decision

### The amendment, stated exactly

`overview.md`'s database-free property is amended to admit **one read-only projection port in `services/platform-api`, and nothing else**. Specifically:

- The API may read the four public paper projection tables through a typed port with one PostgreSQL adapter.
- The API owns no schema, performs no write, and runs no migration against this database. It is not the projection's authority and does not become one by reading it.
- **The web gains nothing.** It remains a presentation client that cannot be a direct database client, and it reaches paper data only through the API's contract. That rule predates this decision and is unchanged by it.
- No other store, provider credential, background worker, scheduler or funded authority is admitted. A second datastore needs its own accepted boundary.

### The role is SELECT-only, and the service proves it

The connection is made as a database role holding **nothing but SELECT** on the projection tables. That is a claim about a system outside this repository, so the API verifies it rather than trusting it: at readiness, it queries `information_schema.role_table_grants` for the projection tables and `pg_roles` for the connected role's own attributes, and refuses to become ready when

- any privilege other than SELECT is granted on a projection table, or a privilege name the rule does not recognise is — an unknown privilege is not assumed harmless;
- any expected table grants no SELECT at all;
- the role is a superuser, or may create roles or databases, or holds replication or row-level-security bypass. A superuser's grant table says nothing about what it may actually do.

The judgement is a pure function over what the database reported, separate from the adapter that asked, so the hostile cases are unit-testable without a database.

Four independent layers keep the read-only property, which is deliberate redundancy rather than belt-and-braces theatre — each covers a different failure:

| Layer | Stops |
| --- | --- |
| The port exposes no write operation | A use case asking for one |
| The adapter contains no write statement | A future edit adding one |
| The session sets `default_transaction_read_only=on` | A write that got past both |
| The privilege probe gates readiness | A role that was over-granted at the provider |

Only the last survives someone editing this repository, which is why it is the one readiness depends on.

### Readiness fails closed; liveness does not move

`/health/ready` reports not-ready when the database is unreachable or the role is over-privileged. Cloud Run has no separate readiness probe — the startup probe on `/health/ready` is what gates a revision from receiving traffic — so a revision that cannot satisfy this never serves.

`/health/live` is untouched. A database outage is not a reason for the platform to restart a process that is answering correctly, and conflating the two turns a dependency outage into a restart loop.

The not-ready response is an RFC 9457 problem with the stable code `MN-NOT-READY` and **no detail**. It does not name the dependency: which component is unready is operational detail, and a public probe response is the wrong place to disclose that this service has a database behind it at all.

### Nothing a driver says is ever repeated

A PostgreSQL driver error is among the most leak-prone objects in this service — depending on the failure it carries the host, the port, the database name, the role, the SQL and sometimes a parameter value. The adapter therefore **never re-throws a driver error and never copies its message**. Every failure becomes one of a closed set of fixed sentences with a stable code, carrying no `cause` chain, because a cause would travel with the error and defeat the purpose.

The cost is accepted and real: diagnosing a projection failure means reading the provider's own logs rather than this service's. That is the right trade when the alternative is a connection string in a public job summary ([`SECURITY.md`](../../../SECURITY.md)).

Privilege violations name the table and the privilege and never the role, the database or the host, because those strings do reach logs.

### Custody

The connection string is held in Secret Manager under ADR-0005's existing custody rules, which this decision uses rather than extends:

- The container `platform-api-projection-database-url` is declared **empty** by the platform stack, with its owner, consuming principal, rotation interval, revocation procedure and recovery path recorded beside it.
- **No value passes through this repository.** A value supplied as an OpenTofu variable would travel through a plan and into remote state, so the module creates containers and never versions. The maintainer adds the version out of band.
- The api stack grants the API's own runtime identity `roles/secretmanager.secretAccessor` on that one secret — per-secret, never project-level — and binds it to `PLATFORM_API_PROJECTION_DATABASE_URL` by **reference**, so Cloud Run resolves the value at instance start and OpenTofu never sees it.
- The reference pins `latest`, because revocation is "add a new version" and a revision pinned to a version number would keep serving a credential the maintainer had already replaced.
- An absent or empty value is a legitimate state, not a misconfiguration: it is exactly the window between this decision landing and the maintainer entering a value.

### The binding is proved against the evaluated plan, by reference only

`infra/modules/cloud-run-service/tests/runtime-contract.mjs` evaluates both production stacks and feeds the rendered container into the readers the service really boots with, so the runtime described above is checked rather than asserted. A secret bound by reference is the first thing that check had no vocabulary for: it previously required every environment entry to carry a literal value.

An environment entry is therefore one of exactly two kinds, and nothing else is accepted:

- A **plain value entry** — no `value_source`, a name matching the existing allowlist, and a non-empty evaluated value. Unchanged.
- A **secret-reference entry** — a name on an explicit per-stack allowlist, exactly `PLATFORM_API_PROJECTION_DATABASE_URL` for the api stack and nothing at all for the web; no inline value; and one `secret_key_ref` naming a secret at `latest`.

The expected secret id is read from the stack's own evaluated plan rather than restated in the check, so a stack that quietly stopped declaring the binding fails instead of passing against a copied literal. The referenced secret must also appear among the ids granted to that service's runtime identity, because a reference the runtime cannot read is a revision that will not start. The web stack must render **zero** secret-reference entries: this decision's driver ban, asserted against evaluated infrastructure rather than only against imports.

Reading a reference and never a value is what allows this check to run in a public pipeline at all — there is nothing in the rendering to leak, which is the same property that puts the value in a managed secret in the first place.

### Driver choice

**`postgres` (postgres.js), exact-pinned, with an empty dependency closure.** Chosen over `pg` on supply-chain surface alone: `pg` brings six further packages, and the delivery contract binds the complete executable dependency closure. No ORM, no query builder, no migration tool — this port reads four tables.

The driver is permitted in `services/platform-api/src/adapters/projection/**` and nowhere else. Boundary probes prove the narrowness in every direction: the driver is refused in the HTTP adapter, in the application layer and in the domain; the inner layers cannot import the adapter directory at all; and the web is refused both the driver and any projection module.

## Consequences

### Positive

- The credential boundary is settled before any endpoint renders paper data, which is the opposite order from how this usually goes wrong.
- "SELECT-only" is a checked property rather than a sentence in a document, and the check fails closed on its own uncertainty.
- The projection's writer is untouched. The existing public site keeps working throughout, so M3 has a parity baseline rather than a cutover.
- The web's boundary is unchanged and now enforced against a specific, plausible temptation rather than only in principle.

### Negative

- `overview.md`'s database-free property is genuinely gone. Every later reader must now ask "which database, and with what privileges" rather than "none", and that question does not go away.
- Readiness now depends on a system outside this repository. A provider outage makes healthy revisions unready, which is the correct behaviour and still an availability coupling that did not exist before.
- Diagnostics are deliberately worse. A failed read says "a projection read did not complete" and nothing else.
- The privilege probe runs on every readiness check, which is two extra queries per probe against a shared serverless database.
- `latest` version pinning means a bad secret version takes effect on the next instance start without a deployment.
- The `latest_ready_revision`-style caveat of any projection applies: this API reads what the writer last wrote, and has no way to tell a stale projection from a quiet one. Freshness is the writer's `source_updated_at`, which a later read endpoint must surface rather than hide.

### Neutral or deferred

- No read endpoint exists yet ([#210](https://github.com/money-noodle/money-noodle/issues/210)). Until one does, a revision with no projection configured still serves its entire declared contract and is honestly ready; when an endpoint depends on the projection, a missing projection becomes an unready revision.
- Neon stays where it is. Proving its ownership, access, billing and recovery independent of the Vercel integration is the first M5 preservation obligation, not this decision's.
- Whether the projection remains the long-term read path, or M4 moves the writer onto this platform, is [#80](https://github.com/money-noodle/money-noodle/issues/80)'s question.

## Alternatives considered

**Keep the database-free rule and proxy the existing public site.** Rejected: it makes the Vercel deployment a runtime dependency of the new platform, which is the thing M5 exists to retire, and it carries no credential boundary forward — the problem would simply arrive later with more coupling.

**Let the web read the projection directly.** Rejected outright. It contradicts an accepted rule, puts a database credential in a presentation deployment, and would make the web a data authority. The rule is restated as an enforced driver ban precisely because this is the shortcut someone would otherwise take under delivery pressure.

**Give the API a read-write role and rely on code review.** Rejected. The structural separation of paper and live, and of reader and writer, is the main thing the v1 shape got wrong; a role that *can* write is one merge away from writing.

**A single shared role with the v1 worker.** Rejected: it would give the API the writer's privileges, and would make revoking the API's access revoke the writer's.

**Pin the secret to a version number rather than `latest`.** Rejected: revocation would require a deployment, so a replaced credential would keep serving until one happened.

**An ORM or query builder.** Rejected as unnecessary surface for four `select` statements, and as a migration tool this service must not have.

## Status and evidence

Working: decided enough to build on, not production-proven. There is **no evidence of applied infrastructure or of a real database read** — no provider resource was created, no secret version exists, and the integration test that would exercise a real projection is skipped unless a connection string is supplied, so it has never run in CI.

What is exercised by repository checks: the privilege rule, the readiness verdict, the safe-failure conversion, the configuration reader, the boundary probes, the infrastructure policy tests, and the evaluated-runtime contract above against both production stacks. What is not: the adapter against a live PostgreSQL server, the Secret Manager reference resolving at instance start, and the behaviour of readiness against a genuinely unreachable database.

Promotion to Settled requires a deployed revision reading the projection through a role independently confirmed to be SELECT-only, with readiness observed failing closed when that role is widened.
