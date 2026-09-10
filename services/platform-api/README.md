# Money Noodle platform API

## Boundary

`services/platform-api` is the independently deployable, stateless, interface-neutral REST API. HTTP/Fastify code is an outer adapter. Domain and application layers cannot import Fastify, Next.js, provider SDKs, persistence implementations, or telemetry backends. External work belongs in later isolated jobs/services.

## Contracts and dependencies

- Runtime: Node.js 22.22.0 and Fastify 5.
- Canonical contract: `openapi/platform-api.v1.yaml` (OpenAPI 3.1).
- Deployment unit: `money-noodle/platform-api` OCI image.
- Configuration: server-side configuration-contract v1 below; optional `PORT` (default `3001`) and `PLATFORM_API_CONTRACT_PATH` preserve existing port and packaged OpenAPI behavior.
- Data/schema ownership: none.
- Health: `/health/live` and `/health/ready` return minimal process/readiness and artifact identity without topology.
- Public read: `GET /v1/platform/status` returns only the accepted state, UTC source time, service/version, schema version, and bounded request ID.

The API loads its canonical OpenAPI 3.1 document at startup and compiles JSON Schema 2020-12 runtime assertions for status, health, and RFC 9457 problem responses. A malformed application result fails closed as safe problem details. Generated transport files remain owned by `packages/platform-api-client` and never enter API domain models.

## Configuration-contract v1

`main.ts` uses `createConfiguredServer` to validate configuration before file loading, server construction or listen. Only the existing `{name, version}` descriptor crosses into HTTP composition. Imports perform no configuration validation. Startup errors identify invalid field names without echoing values.

| Name | Production | Explicit `NODE_ENV=development` or `test` |
| --- | --- | --- |
| `NODE_ENV` | Required, exactly `production` | Required, exactly `development` or `test`; missing/other modes fail |
| `PLATFORM_API_ORIGIN` | Web-only dedicated module input, not emitted to or consumed by API | Web defaults/validation are documented in [web README](../../apps/web/README.md#configuration-contract-v1) |
| `ARTIFACT_VERSION` | Required release label matching `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`, not literal `development` | Absent defaults to `development` |
| `MONEY_NOODLE_COMMIT` | Required 40 lowercase hexadecimal source SHA | Absent is unknown, never fabricated |
| `MONEY_NOODLE_SERVICE` | Required exact `platform-api` | Absent defaults to `platform-api` |
| `MONEY_NOODLE_ENVIRONMENT` | Required exact `production` | Absent defaults to the explicit mode; supplied value must match it |

Invalid supplied values never receive defaults. Production rejects obsolete `MONEY_NOODLE_API_BASE_URL` and `MONEY_NOODLE_VERSION`. Infrastructure reserves all table names, both aliases, `PORT`, `PLATFORM_API_CONTRACT_PATH`, `OTEL_*` and `NEXT_PUBLIC_*` against `extra_env`, even identical values. The owning stack enforces the application identity; infrastructure accepts production only. Cloud Run's injected `PORT` and the packaged contract path remain unchanged.

Artifact version is a release label, source SHA identifies artifact source internally, and image digest identifies the image reference. No source SHA, topology or private value is added to public health/status responses. Configuration-contract v1 names the validation shape, not a configuration instance, and is independent of unchanged public `schemaVersion: '1'` and OpenAPI version. Deployment evidence needs reviewed **configuration-source commit plus target/revision** for exact configuration attribution; artifact-source SHA is not a substitute. No config fingerprint or revision variable is added.

Run `node infra/modules/cloud-run-service/tests/runtime-contract.mjs` with pinned OpenTofu 1.12.6 for the mandatory provider-free bridge. It evaluates the actual production stack/module with mocked Google and every remote state overridden, feeds evaluated env/image/probes to the main composition helper, and uses Fastify injection without listening. It verifies internal source against evaluated inputs/outputs and unchanged public artifact/schema surfaces. Delivery runs this after native checks in its credential-free job; `pnpm check` remains OpenTofu-free. The dedicated `.contract.ts` test entry is excluded from ordinary source coverage because the bridge executes it separately, not because application coverage is waived; floors remain unchanged. Raw captures stay in disposable private scratch and only allowlisted synthetic results are emitted. Private `RUNTIME_CONTRACT_SCRATCH` can retain captures for debugging; never upload them. This proves desired-configuration compatibility, not artifact provenance or realized revision evidence (#73/#8), provider behavior or deployed journeys (#76/#8).

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
