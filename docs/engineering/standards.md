# Engineering and testing standards

## Language and contracts

TypeScript is the default for applications, services, jobs, infrastructure, and tooling. Python and Rust are expected options for bounded projects where they offer a documented material advantage; Go remains an option to evaluate. A non-TypeScript project records toolchain, security, deployment, interface, and maintenance implications. Cross-language/project contracts use runtime-validated language-neutral wire schemas, not TypeScript types alone.

Use pnpm workspaces for JavaScript/TypeScript package and lockfile management and Nx for monorepo project/target orchestration, caching, dependency visualization, and affected-work computation. Nx also invokes project-owned Python, Rust, or future Go commands through explicit targets; it does not force one language toolchain.

Each project declares and pins its own execution runtime and supported version. Runtime selection is project-specific and must match local, CI, and production builds. Projects expose consistent Nx target names while retaining fit-for-purpose internals behind those contracts.

Use REST APIs described by canonical versioned OpenAPI documents. Validate requests and responses at runtime, check compatibility in CI, and keep provider/domain contracts separate. Generate one shared TypeScript API client package for TypeScript front ends and language-specific clients only where another project needs them. Do not hand-maintain duplicate transport types or request code in each interface. Generated transport models remain at the adapter boundary and do not become the core domain model.

## Implementation workflow

1. Inspect branch and status, run the coordination status command, review the decision lifecycle for records that have become production-proven, and read the shared plan, active worktrees and claims, routed current documents, accepted records, and relevant source; do not work from memory.
2. Update the shared plan as needed, then state and claim the problem, scope, facts, assumptions, unknowns, acceptance criteria, dependencies, and risk.
3. Resolve cross-boundary and architecture-impacting decisions and update proposed or accepted visual architecture before production code; spike only a bounded uncertainty.
4. Implement the smallest reversible vertical slice with explicit contracts.
5. Test at the cheapest effective level, adding focused tests and negative cases at authority, tenant, data-quality, concurrency, and external-effect boundaries.
6. Run every available affected-project and repository check; never weaken a gate merely to pass.
7. Validate acceptance independently of the implementation path and record remaining uncertainty.
8. Update the owning specifications, decisions, diagrams, status, and agent guidance whose truth changed.

Recalculate before making consequential quantitative claims. Distinguish fact, hypothesis, estimate, simulation, and realized result. Include as-of time, sample, exclusions, uncertainty, and the largest validity threat.

Avoid speculative abstractions. Complex logic belongs in small named dependency-free units with exhaustive boundary tests. Add regression tests for every defect.

## Test design

Favor pure domain tests, schema/contract tests, adapter integration tests, and a small number of end-to-end journeys. Required special coverage includes:

- invariant/property boundaries for risk and money;
- leakage, calibration, baselines, and walk-forward evaluation for forecasts;
- cross-tenant and privilege-escalation attacks for tenancy/roles;
- fencing, lease expiry, admin revocation, reconciliation, and orphan cleanup;
- crashes, retries, duplication, overlap, and partial failure for processes;
- migrations, startup, health, rollback, and restore for deployment.

Test code is clearer and more concise than the behavior it proves. Use behavioral names, focused setup, and obvious outcomes. Prefer pure values/lightweight fakes and mock external ports rather than internals. Put typed reusable fakes, fixtures, builders, and provider contract suites in project test-support modules or a justified shared package; do not copy large mocks across tests.

Every test starts and ends clean. Reset databases, queues, files, environment, module state, clocks, randomness, network interceptors, and mocks as applicable, restoring globals even on failure. Tests cannot depend on order, machine state, production services, or prior residue and must be repeatable/parallel-safe. Seed randomness, control time, block unapproved network, and use disposable integration namespaces.

## Coverage

Coverage is an enforced regression floor, not a substitute for meaningful assertions. Each project publishes CI thresholds. Unless an accepted project decision says otherwise, begin at 90% statements/lines/functions and 85% branches. Require near-complete meaningful branch coverage for security, tenancy, risk, money, and complex domain logic.

Do not lower thresholds merely to pass. A justified reduction needs an accepted decision, explicit exclusions, and compensating validation. Review generated-code and exclusion boundaries.

## Current foundation toolchain

The first web/API foundation pins one reproducible toolchain. Reverify security and compatibility before an intentional upgrade; never replace exact ranges or the lockfile opportunistically.

| Concern | Current exact version or boundary |
| --- | --- |
| Runtime/package manager | Node.js 22.22.0 and pnpm 11.24.0 |
| Workspace orchestration | Nx 23.1.2 |
| TypeScript | 6.0.3 |
| Web | Next.js 16.3.3, React/React DOM 19.2.8 |
| API HTTP adapter | Fastify 5.12.1 |
| Lint/format | ESLint 10.9.1, Prettier 3.9.6, current Next/React-hooks/accessibility plugins |
| Test/coverage | Vitest 4.1.11 with V8 coverage |
| OpenAPI | Redocly CLI 2.49.0, Hey API OpenAPI TypeScript 0.99.0, OpenAPI Changes 0.2.11 |

The lockfile overrides the generator's exact vulnerable `js-yaml@4.2.0` transitive dependency to compatible patched `4.3.2`; `pnpm audit --audit-level high` must remain clean. Approved install scripts are allowlisted in `pnpm-workspace.yaml`. Adding a build script requires review rather than interactive approval residue.

The generated client package disables `exactOptionalPropertyTypes` only because generator 0.99 emits explicit `undefined` in optional Fetch fields. Domain, API, and web source retain the strict repository default. Revisit and remove this exception when the generator supports it.

### Command contract

Run commands from the repository root:

| Command | Contract |
| --- | --- |
| `pnpm install --frozen-lockfile` | Reproduce the committed dependency graph without changing resolution |
| `pnpm check` | Verify runtime, formatting, documentation/coordination, forbidden dependency probes, and every project lint/type/test/contract/build target |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` | Run the named target across all applicable projects |
| `pnpm contract` | Lint OpenAPI, compare deterministic generated output, and reject breaking v1 changes against the configured base |
| `pnpm container` | Build separate web and API OCI images with provenance and SBOM; requires Docker Buildx |
| `pnpm graph` | Inspect the Nx project/dependency graph |
| `pnpm nx affected -t lint,typecheck,test,contract,build --base=<ref> --head=HEAD` | Run affected project gates as CI does |
| `pnpm nx run <project>:<target>` | Run one declared project target; see that project's README |

`pnpm check` does not build containers or prove remote deployment. Container scans run in CI, and deployed validation remains blocked on the accepted provider/IaC composition.

### OpenAPI workflow

The platform API owns `services/platform-api/openapi/platform-api.v1.yaml`. Run `pnpm nx run platform-api-client:generate` only after an intentional contract edit, then review every generated change. `platform-api:contract` regenerates into a temporary directory and compares file names and bytes; hand edits and nondeterminism fail. Compatibility uses OpenAPI 3.1-aware semantic comparison and fails on breaking changes once a baseline exists. Runtime request/response conformance for actual operations begins with the first vertical slice rather than inventing an endpoint in the scaffold.
