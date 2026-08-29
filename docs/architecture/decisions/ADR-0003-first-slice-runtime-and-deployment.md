# ADR-0003: First slice runtime and deployment shape

> **Status:** Proposed
> **Date proposed:** 2026-08-29
> **Owners:** Platform foundation
> **Related architecture:** [`../overview.md`](../overview.md)

## Context

The first slice must validate a real web/API boundary without introducing unresolved identity, tenant, database, job, provider, simulation, or funded designs. It must run remotely, build reproducibly, and permit independent deployment. Framework and artifact lines need enough definition for the next scaffolding task, while hosting/IaC choices remain open.

As of 2026-08-29, npm reports stable Next.js 16.3, React 19.2, Nx 23.1, and pnpm 11.24 lines. Nx and pnpm require a sufficiently recent Node.js 22 release. Version evidence from Money Noodle v1 is historical and is not reused as authority.

## Proposed decision

### Framework/runtime lines

- Node.js 22 for both request-serving projects, pinned to one exact supported release during scaffolding;
- pnpm workspaces and Nx as already selected by engineering standards;
- Next.js 16 App Router with React 19 for `apps/web`;
- Fastify 5 as the HTTP adapter for `services/platform-api`;
- TypeScript for web, API, contracts, tests, and repository tooling.

Exact package patches, peer compatibility, security advisories, integrity, and production build behavior are reverified immediately before the lockfile is created. Dependencies use committed exact resolution rather than `latest` ranges.

### Capability

Implement one public read after scaffolding is accepted:

```http
GET /v1/platform/status
```

The web renders an accessible platform availability card from this response. It always shows the API source time. Timeout, unavailable transport, invalid response, or incompatible schema renders `unknown`. No cached or synthetic response is presented as current health.

The slice has:

- no identity/session or tenant context;
- no database/object store/queue;
- no provider or external financial integration;
- no recurring/scheduled work;
- no simulation or funded state;
- no state-changing API operation;
- no client-side direct API call in the initial server-rendered path.

### Artifact and deployment

Both projects produce independent OCI images from immutable CI inputs. Next.js uses its supported standalone production output inside the web image; the API runs compiled Node.js in the API image. Images run as non-root with read-only filesystems and bounded writable temporary space where the chosen platform supports it.

OCI is the application artifact contract, not a requirement for resident VMs. The chosen provider may run each image as an autoscaled container or serverless container. Provider deployment composition stays in `infra/` behind project-specific modules.

The web and API have separate:

- build/deploy targets and images;
- workload identities and configuration;
- health/readiness checks;
- scaling/concurrency settings;
- telemetry service identity;
- deployment/rollback status.

The first slice needs no operational secret. API base URL, service name, contract compatibility, and telemetry destination are typed non-secret configuration. Future credentials use the accepted managed secret store and never enter the image or browser.

## Why a status slice

A platform status card is small but vertical: it starts at a person-visible state, crosses the deployed web/API contract, executes an application query, and returns through generated transport and presentation mapping. Its most important negative path—API failure becomes explicit unknown—tests the honesty required later for financial and tenant state.

A static welcome page would not prove the API. A database-backed profile would force identity, privacy, tenant, migration, secret, and data-provider decisions before the delivery foundation is proven. A trading/simulation endpoint would cross even more unresolved authority boundaries.

## Alternatives considered

### Use Next.js Route Handlers for the endpoint

Rejected by ADR-0001: it would not prove independent API deployment or interface neutrality.

### Use a database-backed user/profile resource

Deferred. It is more product-visible but cannot be safely minimal because identity ownership, tenant scope, RLS, retention, migration, and private caching must be accepted together.

### Use a simulated portfolio endpoint

Deferred. It would require accepted portfolio taxonomy, balance/ledger semantics, simulation lifecycle, accounting, and data ownership. A fake payload would teach the wrong contract.

### Deploy provider-native source functions

Rejected as the architecture contract. It may reduce platform work for one provider, but it couples build/runtime behavior before provider selection. A compatible provider can run the portable image without changing inner code.

### Keep API framework selection open through implementation

Rejected. The scaffold needs a concrete adapter and build target. Fastify is proposed for a narrow Node HTTP adapter; replacing it before acceptance is inexpensive because inner layers are framework-free.

### Use a long-running local development server as integrated validation

Rejected. Local project checks are useful but cannot prove the required remote independent delivery, workload identity, routing, health, or rollback path.

## Consequences

### Positive

- The first behavior has almost no financial, tenant, privacy, or persistence blast radius.
- It validates generated contracts, separate artifacts, traces, health semantics, and failure presentation.
- OCI artifacts preserve provider choice and local/CI build parity.
- Framework selection is concrete enough for bounded scaffolding.

### Negative

- Status is a thin product slice and does not validate identity, data storage, commands, or jobs.
- Two container images and remote services cost more than a static page.
- Provider selection remains a blocker for deployed validation.
- Exact service-level objectives cannot be set honestly until a remote baseline exists.

## Validation

Before this decision is considered implemented:

1. exact Node/pnpm/Nx/Next/React/Fastify versions are pinned and compatibility is recorded;
2. web and API affected targets pass independently from clean checkout;
3. each image runs as its declared project and contains no other project runtime authority;
4. dependency and container scans plus SBOM/attestation pass;
5. API contract and runtime validation tests include malformed output and errors;
6. web component/adapter tests cover all status states and API failure/incompatible schema;
7. remote deployment verifies separate versions, health/readiness, trace propagation, source time, and independent rollback;
8. forced API unavailability makes the remote web show `unknown`, not stale available state;
9. observed latency/error/cold-start evidence is recorded with as-of time and largest validity threat before quantitative objectives are accepted.

## Revisit when

- provider limits make the proposed image/runtime unsupported;
- measured cold start or cost materially favors another standard runtime;
- the API requires streaming or a protocol Fastify cannot support cleanly;
- a private first capability is preferred and its identity/tenant architecture has been accepted;
- Node.js 22 leaves the supported/security window before implementation.