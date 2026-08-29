# ADR-0001: Separate web and platform API deployments

> **Status:** Proposed
> **Date proposed:** 2026-08-29
> **Owners:** Maintainer / platform foundation
> **Related architecture:** [`../overview.md`](../overview.md)

## Context

Web is the first interface, but Money Noodle must also support mobile, desktop, game, and MMO-style clients against server-authoritative state. The UI cannot run platform work, and deployable projects must build, release, observe, and roll back independently.

A Next.js application can host Route Handlers, but making those handlers the canonical platform API would tie every client and authority boundary to the web framework, web deployment lifecycle, and web scaling profile. Starting with many domain services would avoid that coupling but would invent data ownership and distributed failure before the first domain slice exists.

## Proposed decision

Use:

- `apps/web` as an independently deployable Next.js presentation application;
- `services/platform-api` as an independently deployable, stateless, interface-neutral REST API;
- `packages/platform-api-client` as the generated TypeScript transport client.

The first API is a small modular service. Its internal domain/application layers depend on no HTTP, UI, provider, database, cloud, or telemetry-backend framework. Fastify and Next.js remain outer adapters.

The web calls the API through the generated client. It does not import API service source, connect directly to a database, inspect local files/processes, or run jobs/providers. Canonical platform operations never live only in a Next.js Route Handler. A future Route Handler may adapt browser session/cookie concerns to the canonical API but cannot become another authority path.

The API authenticates, authorizes, validates, serves reads, accepts commands, and enqueues work as later capabilities require. It does not execute long-running/provider work in interactive handlers. Each later domain declares data ownership before entering this service or becoming a separate deployment.

## Alternatives considered

### Canonical API inside Next.js

One project and same-process calls are initially simple. This was rejected because web deploy/restart and framework limits would become platform lifecycle, future clients would depend on a web adapter, and dependency rules could not reliably keep presentation away from provider/data authority.

### Separate web plus one modular API

This adds a network boundary, compatibility requirements, and an additional deployment. It is recommended because those costs are required platform properties and remain bounded at two deployable projects.

### Web, BFF, gateway, and multiple domain services immediately

This can isolate mature domains but is premature before use cases, stores, throughput, and failure budgets are known. Defer splits until a domain has explicit ownership or measured scaling/security need.

### Browser directly accesses database/backend-as-a-service

Rejected. Client possession of data credentials and public schema/RLS as protocol would expand tenant, migration, cache, and authority risk and violate the client-neutral API decision.

## Consequences

### Positive

- Web and API can deploy, scale, and roll back independently.
- Future interfaces share one contract and server authorization boundary.
- Platform work, provider credentials, and future owned schemas stay outside the internet-facing presentation project.
- Nx dependency rules can mechanically reject forbidden imports.
- API runtime/framework changes do not redefine domain or client contracts.

### Negative

- Even the first read gains timeout, tracing, compatibility, and partial-failure concerns.
- CI/CD must build and attest two artifacts and plan compatibility order.
- Local development needs both bounded projects or a contract fixture; it cannot use a hidden direct path.
- A modular API can become a monolith unless future data/authority boundaries are reviewed deliberately.

## Validation

Acceptance requires:

- separate Nx project graphs, build targets, artifacts, health checks, and deployment manifests;
- import rules proving web cannot reach API implementation/database/provider/job code;
- contract tests and a remote smoke proving web-to-API behavior;
- independent API/web deploy and rollback evidence under a compatible contract;
- an API outage test showing the web reports unknown without local/database fallback.

## Revisit when

A domain needs an independently owned schema, distinct authority/workload identity, failure isolation, scaling profile, or release cadence. A split requires a new ADR and current diagrams; directory growth alone is not sufficient.