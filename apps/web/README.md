# Money Noodle web

## Boundary

`apps/web` is the independently deployable Next.js presentation application. It renders state and submits intent only through generated API clients. It must not import platform API implementation, databases, jobs, provider SDKs, secrets, simulation authority, or funded authority.

## Contracts and dependencies

- Runtime: Node.js 22.22.0, Next.js 16, React 19.
- Platform transport: `@money-noodle/platform-api-client` only.
- Deployment unit: `money-noodle/web` OCI image.
- Configuration: server-only configuration-contract v1 below; `PORT` and `HOSTNAME` retain their Next.js behavior.
- Data/schema ownership: none.
- Health: `/health/live` reports process/artifact identity; `/health/ready` requires valid runtime configuration. Neither queries the upstream; liveness alone cannot establish readiness.
- Public presentation: the server-side generated client performs one 1.5-second, no-retry, no-store status read. Transport, timeout, malformed, and incompatible responses render `Status unknown` without stale or healthy fallback.

## Configuration-contract v1

Infrastructure emits these canonical non-secret names. Validation happens on each page/readiness invocation through the same server-only reader, never at module import. Invalid configuration produces `Status unknown` on the page and safe 503 problem details on readiness.

| Name | Production | Explicit `NODE_ENV=development` or `test` |
| --- | --- | --- |
| `NODE_ENV` | Required, exactly `production` | Required, exactly `development` or `test`; no other/missing mode is valid |
| `PLATFORM_API_ORIGIN` | Required credential-free absolute HTTPS origin; optional `/`, no other path, query, fragment, loopback IP or localhost name | Absent defaults to `http://127.0.0.1:3001`; explicit local HTTP is allowed |
| `ARTIFACT_VERSION` | Required release label matching `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`, not literal `development` | Absent defaults to `development` |
| `MONEY_NOODLE_COMMIT` | Required 40 lowercase hexadecimal source SHA | Absent is unknown, not a fabricated SHA |
| `MONEY_NOODLE_SERVICE` | Required exact `web` | Absent defaults to `web` |
| `MONEY_NOODLE_ENVIRONMENT` | Required exact `production` | Absent defaults to the explicit mode; supplied value must match it |

Invalid supplied values never receive defaults. Production rejects obsolete `MONEY_NOODLE_API_BASE_URL` and `MONEY_NOODLE_VERSION`. Infrastructure reserves every table name, both aliases, `PORT`, `PLATFORM_API_CONTRACT_PATH`, `OTEL_*` and `NEXT_PUBLIC_*` against `extra_env`, even for identical values. The web origin uses the dedicated module input; the owning stack fixes service identity and infrastructure accepts production only. Cloud Run still injects `PORT`.

Only existing artifact/service health fields and API-provided status/source time reach presentation. Source SHA is validated internally, never exposed with origin, topology or image reference to the browser. Artifact version is a release label; source SHA identifies artifact source; image digest identifies the image reference. Configuration-contract v1 describes this validation shape, independently of unchanged public API `schemaVersion: '1'` and OpenAPI version. Exact configuration attribution requires reviewed **configuration-source commit plus target/revision** in deployment evidence; artifact-source SHA cannot substitute for it. No configuration fingerprint or revision environment variable is introduced.

The mandatory provider-free bridge runs `node infra/modules/cloud-run-service/tests/runtime-contract.mjs` with pinned OpenTofu 1.12.6. It evaluates real stacks/module with mocked Google and all remote state overridden, then tests actual page/probe composition for published and explicit origins, failures and source-time rendering. It builds the client first, like `web:test`, and runs separately from `pnpm check` in Delivery's credential-free checks job. The dedicated `.contract.ts` test entry is excluded from ordinary source coverage because that suite is executed by the bridge, not application code; coverage floors are unchanged. Raw captures stay in disposable private scratch; only an allowlisted result is printed. For private debugging, `RUNTIME_CONTRACT_SCRATCH` retains disposable captures beneath the specified private directory; never upload them. Desired-configuration compatibility is not artifact provenance or deployed-revision proof; those remain #73/#8 and remote validation #76/#8.

## Commands

Run from the repository root:

```bash
pnpm nx run web:lint
pnpm nx run web:typecheck
pnpm nx run web:test
pnpm nx run web:build
pnpm nx run web:container
pnpm nx run web:dev
```

The availability card presents only the API-provided state, source time, and artifact version. Text communicates every state independently of color. Existing `noodle.money` DNS and provider deployment remain outside this project.
