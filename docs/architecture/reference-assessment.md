# First web/API reference assessment

> **Status:** Dated architecture evidence; not requirement authority
> **Inspected:** 2026-08-29
> **Purpose:** Record what was learned from historical/reference systems and independently justify every idea carried into the proposed v2 first slice
> **Current proposal:** [`overview.md`](overview.md)

## Reference boundaries

This assessment treats both systems as evidence only:

- Money Noodle v1: immutable `archive/v1-final`, commit `4b71b61894622b1c01f3552f9c7af5592cb2800a`.
- Portfolio Copilot: local `main`, commit `496337158173fef024c25c1f0239e3756b7ea200`.

No v1 source, schema, threshold, credential path, runtime topology, or funded behavior is accepted by appearing here. Current v2 standards remain the authority.

## Material inspected

### Money Noodle v1

The inspection covered the root orientation/status, package and CI manifests, App Router/API shape, and the architecture designs most relevant to the web/API boundary:

- `README.md`, `STATUS.md`, `package.json`, `next.config.ts`, `.github/workflows/ci.yml`;
- `src/app/`, representative `src/app/api/*` routes, `src/lib/auth.ts`, worker bootstrap/import relationships, and the broad `src/lib` project shape;
- `docs/execution-engine-separation-design.md`;
- `docs/multitenancy-design.md`;
- `docs/multitenant-web-ui-design.md`;
- `docs/reporting-read-path-design.md`;
- `docs/task-cadence-observability-design.md`.

Important observed facts were a single Next.js project containing UI, API routes, domain/provider/storage code, process-local scheduling, local durable files, a deployment-specific stateless branch, and a bounded Postgres projection for hosted reads. V1 itself marked the engine separation and multitenancy designs as proposed, not implemented authority.

### Portfolio Copilot

The inspection covered repository/project structure and the material describing decision, execution, safety, deployment, persistence, and paper/live behavior:

- `HOW_IT_WORKS.md`, `SYSTEM_DIAGRAM.md`, `GO_LIVE.md`, `LESSONS.md`;
- `deploy/README.md`, systemd/cron deployment shape, and single-runner warning;
- `pyproject.toml`, application module inventory, and representative test inventory.

Important observed facts were deterministic risk code around advisory model output, separate paper/live paths, an always-on monitor plus many cron jobs on one VPS, machine-local SQLite/file authority, manually transferred secrets/state, hard-coded paths, and a per-machine lock unable to prevent cross-machine duplicate execution.

## Independently evaluated ideas

Every **carry forward** row below has a v2 reason independent of the reference implementation.

| Reference observation | v2 treatment | Independent current justification |
| --- | --- | --- |
| V1's hosted UI could run without its local execution worker. | Carry forward as a stricter boundary: the web is always presentation-only, not conditionally stateless. | Concurrent interfaces and independent deployment require platform state and work to survive web replacement. Current architecture and delivery standards already prohibit UI-owned platform work. |
| V1 proposed a separate stateless web/BFF and client-neutral API/control boundary. | Carry forward the separate web and API projects, but not the proposed v1 schema or command protocol. | Mobile, desktop, game, and web need one server authority. A canonical OpenAPI contract prevents Next.js types and lifecycle from becoming the platform protocol. |
| V1's compact public projection fixed repeated full-history scans and represented unavailable data explicitly. | Carry forward bounded DTOs, source times, and explicit unknown/unavailable behavior. | Request budgets, safe degradation, data minimization, and honest freshness are current quality requirements. A failed read must not become an invented zero or healthy state. |
| V1 used a Server Component/server-only layer for private API composition in its UI proposal. | Carry forward a server-only generated-client adapter for the first read. | It keeps transport credentials and protocol mapping out of browser components while preserving the API as the canonical interface-neutral boundary. It is not reused because Next.js suggested it; it follows least privilege and clean adapter direction. |
| V1 proposed asynchronous commands and separate command/projection status. | Defer commands, retain the principle for future external effects. | Stateless APIs cannot report an effect complete merely because intent was accepted. Durable intent, idempotent jobs, and observable state are required by current runtime standards. The first read-only slice does not need this machinery. |
| V1 separated process health, intent, reconciliation, drain, and task health. | Carry forward distinct public and operational state vocabularies; start only with safe platform availability plus separate liveness/readiness probes. | A single green flag conceals unknown or stale authority. Current operational-view requirements explicitly distinguish healthy, degraded, stale, blocked, retrying, and unknown. |
| V1 proposed API-owned tenant isolation, composite keys, RLS, and no direct frontend database access. | Carry forward as a gate for the later first tenant-data slice, not as first-slice implementation. | Current identity/data standards independently require default deny, explicit tenant scope at every boundary, composite ownership, and storage defense in depth. Adding unused identity/schema now would be speculative. |
| V1 separated public research, paper, and tenant live projections. | Carry forward the rule that public, simulation, and funded contracts cannot be one shape that expands after login. | Simulation and funded authority are current non-negotiable structural separations; public caching and private financial confidentiality also need separate resources. No such payload enters the first slice. |
| V1's API routes directly imported stores, providers, reconciliation, and process-local queues. | Reject. | It couples internet request lifecycle to platform work, blocks independent deployment, and lets framework adapters reach authority. Clean Architecture requires explicit application ports and isolated jobs/providers. |
| V1 started recurring work through a Next.js runtime and changed behavior based on stateless-host environment flags. | Reject. | The same web artifact must not acquire authority because of placement. Scheduled/provider work belongs in independently deployed jobs/services and remote state must remain authoritative. |
| V1 had one large `src/lib` and one package containing UI, API, providers, analytics, jobs, and funded execution. | Reject as a v2 project boundary. | It prevents independent build/deploy, broadens secret and failure blast radius, and makes dependency direction difficult to enforce. It is evidence for separation, not a directory template. |
| V1 depended heavily on unpinned `latest` package ranges. | Reject. | Reproducible artifacts, security review, rollback, and local/CI/production parity require exact committed resolution and pinned project runtimes. Current npm versions are rechecked during scaffolding rather than copied. |
| V1 kept durable execution state on a developer workstation and described a persistent local worker. | Reject. | The current operating model explicitly makes the laptop a development client, never production control plane or canonical state. |
| Portfolio Copilot made model output advisory and deterministic code authoritative for safety and external effects. | Carry forward as a platform invariant, although no model or execution appears in this slice. | Server-enforced policy, risk, authorization, and financial invariants must be deterministic, testable, reconstructable, and unable to be overridden by presentation or probabilistic text. |
| Portfolio Copilot used the same conceptual strategy with paper/live execution targets and measured divergence. | Carry forward only the need for explicit simulation/funded separation and comparative evidence; do not copy its mode switch or schemas. | Current product standards require unmistakable separate balances, ledgers, authority, presentation, and audit. Simulation fidelity must be measured rather than asserted. |
| Portfolio Copilot used an always-on monitor for position protection while cron launched other jobs. | Carry forward the need to isolate deadline-sensitive management from optional work, not the resident VPS topology. | Resource/failure isolation and per-workflow cadence are current architecture requirements. Future workloads should prefer bounded managed jobs; a long-running process requires a documented deadline/state reason. |
| Portfolio Copilot warned that a machine-local lock could not prevent two hosts from trading the same account. | Carry forward distributed leases/fencing and account-level single-writer ownership for any future external effect. | Current lifecycle standards independently require bounded leases, fencing tokens, stale-writer rejection, idempotency, and reconciliation. A filesystem lock cannot establish remote exclusivity. |
| Portfolio Copilot kept one VPS as scheduler, process host, state store, and secret destination. | Reject. | It creates a large blast radius, manual drift, weak independent deployment, and a laptop/VPS transfer path. Current operations require managed durable secrets/state, reviewed IaC, pipeline delivery, and independently deployable projects. |
| Portfolio Copilot used manual `rsync`, hard-coded user paths, and separate secret file transfer. | Reject. | Builds must be immutable and attributable; configuration is injected through declared runtime contracts; secrets need durable managed custody and cannot be hand-carried as routine deployment. |
| Portfolio Copilot relied on extensive deterministic boundary tests around risk and broker behavior. | Carry forward the testing posture, not individual tests or behavior. | Current engineering standards require negative tests for authority, tenancy, retries, ambiguity, money, provider conformance, and external effects. The first slice applies this to contract/failure boundaries only. |

## Resulting proposal constraints

The reference review therefore supports, but does not authorize by itself:

1. a separately deployable Next.js web and interface-neutral API;
2. API-owned OpenAPI source and generated client adapters;
3. presentation of source time and unknown/degraded states without fallback invention;
4. no database, identity, worker, provider, simulation, or funded path in the first slice;
5. OCI artifacts and pipeline-only remote deployment rather than machine mutation;
6. future deterministic policy/execution, distributed fencing, and simulation/funded separation as explicit later designs.

It specifically does **not** justify recreating v1's route handlers, dashboard DTO, local stores, password session, Postgres projection schema, worker loop, trading contracts, or Portfolio Copilot's VPS, cron, SQLite, broker, model, or secret handling.

## Largest validity threat

Both references are concentrated personal trading systems rather than validated multi-tenant platforms. They are useful failure and coupling evidence, but they do not establish the correct v2 domain decomposition, production scale, tenant model, hosting provider, or user need. The first-slice recommendation is therefore deliberately small and must be validated through independent contract, deployment, failure, and remote smoke evidence.