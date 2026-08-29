# Money Noodle platform API

## Boundary

`services/platform-api` is the independently deployable, stateless, interface-neutral REST API. HTTP/Fastify code is an outer adapter. Domain and application layers cannot import Fastify, Next.js, provider SDKs, persistence implementations, or telemetry backends. External work belongs in later isolated jobs/services.

## Contracts and dependencies

- Runtime: Node.js 22.22.0 and Fastify 5.
- Canonical contract: `openapi/platform-api.v1.yaml` (OpenAPI 3.1).
- Deployment unit: `money-noodle/platform-api` OCI image.
- Configuration: optional `PORT` (default `3001`), safe `ARTIFACT_VERSION` (local default `development`), and optional contract path override; none is secret.
- Data/schema ownership: none.
- Health: `/health/live` and `/health/ready` return minimal process/readiness and artifact identity without topology.
- Public read: `GET /v1/platform/status` returns only the accepted state, UTC source time, service/version, schema version, and bounded request ID.

The API loads its canonical OpenAPI 3.1 document at startup and compiles JSON Schema 2020-12 runtime assertions for status, health, and RFC 9457 problem responses. A malformed application result fails closed as safe problem details. Generated transport files remain owned by `packages/platform-api-client` and never enter API domain models.

## Commands

Run from the repository root:

```bash
pnpm nx run platform-api:lint
pnpm nx run platform-api:typecheck
pnpm nx run platform-api:test
pnpm nx run platform-api:contract
pnpm nx run platform-api:build
pnpm nx run platform-api:container
pnpm nx run platform-api:dev
```

The status query is framework-free and currently observes `available` without a database or external dependency. Request IDs accept a bounded propagated value or are regenerated; valid W3C trace context crosses the HTTP adapter for later provider-neutral OpenTelemetry composition.
