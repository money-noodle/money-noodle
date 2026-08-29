# Money Noodle platform API

## Boundary

`services/platform-api` is the independently deployable, stateless, interface-neutral REST API. HTTP/Fastify code is an outer adapter. Domain and application layers cannot import Fastify, Next.js, provider SDKs, persistence implementations, or telemetry backends. External work belongs in later isolated jobs/services.

## Contracts and dependencies

- Runtime: Node.js 22.22.0 and Fastify 5.
- Canonical contract: `openapi/platform-api.v1.yaml` (OpenAPI 3.1).
- Deployment unit: `money-noodle/platform-api` OCI image.
- Configuration: optional `PORT`, default `3001`; no operational secret exists in this scaffold.
- Data/schema ownership: none.
- Health: liveness/readiness and the public platform-status operation are deliberately deferred to the first vertical slice.

The empty v1 document exposes no operation or response schema. RFC 9457 problem details are added with the first real operation so lint never hides an unused contract. Generated transport files are owned by `packages/platform-api-client` and must not enter API domain models.

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

The scaffold server intentionally returns `404` for `/v1/platform/status`; issue #8 owns that behavior.
