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
- Public presentation: every read is server-side, through the generated client, no-retry and no-store. Each is bounded — 1.5 s for the status card, 2.5 s for the three home-page reads, 4 s for a view of its own, 6 s for the full simulated record — and a read that is refused, times out, answers unusably or cannot be reached renders its own panel as unavailable without a stale or fabricated fallback. There is no client-side polling and no refresh control: reloading re-reads what the server has.

## Views

All four are server-rendered, dynamic, and read only through the generated client.

| Route | Reads | Content |
| --- | --- | --- |
| `/` | status, market overview, paper budget, paper performance summary | Platform availability, per-asset market data with each source's freshness, headlines, and the bankroll and record headlines |
| `/market/hourly` | hourly thresholds | The hour each asset is trading, the price and volatility inputs, and each contract's model probability against its own asking price |
| `/paper/budget` | paper budget | The simulated bankroll and its recent executions |
| `/paper/performance` | paper performance summary, paper performance | The summary, and the full record behind closed disclosures |

Every view carries a research-only notice and the source times the API published. Simulated records carry times from the stopped writer's era, so the source time is shown prominently rather than at the foot of a page. No view presents a forecast, an entry signal, a fill estimate or a policy document, and nothing stands in for one.

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

The availability card presents only the API-provided state, source time, and artifact version. Text communicates every state independently of color: a feed's `fresh`, `stale` or `unavailable` state, its age and its reason are sentences, and the border colour beside them is decoration. Charts are inline SVG with an accessible name stating direction and endpoints; there is no chart library and no client-side JavaScript for presentation. The only figures this app derives are display conversions (cents to dollars, a ratio to a percentage, a contract price to cents) and two the API's own documentation hands to a client: the bankroll reconciliation residual and the bankroll status line, both labelled as computed here. Existing `noodle.money` DNS and provider deployment remain outside this project.
