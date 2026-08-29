# Engineering and testing standards

## Language and contracts

TypeScript is the default for applications, services, jobs, infrastructure, and tooling. Python and Rust are expected options for bounded projects where they offer a documented material advantage; Go remains an option to evaluate. A non-TypeScript project records toolchain, security, deployment, interface, and maintenance implications. Cross-language/project contracts use runtime-validated language-neutral wire schemas, not TypeScript types alone.

Use pnpm workspaces for JavaScript/TypeScript package and lockfile management and Nx for monorepo project/target orchestration, caching, dependency visualization, and affected-work computation. Nx also invokes project-owned Python, Rust, or future Go commands through explicit targets; it does not force one language toolchain.

Each project declares and pins its own execution runtime and supported version. Runtime selection is project-specific and must match local, CI, and production builds. Projects expose consistent Nx target names while retaining fit-for-purpose internals behind those contracts.

Use REST APIs described by canonical versioned OpenAPI documents. Validate requests and responses at runtime, check compatibility in CI, and keep provider/domain contracts separate. Generate one shared TypeScript API client package for TypeScript front ends and language-specific clients only where another project needs them. Do not hand-maintain duplicate transport types or request code in each interface. Generated transport models remain at the adapter boundary and do not become the core domain model.

## Implementation workflow

1. Read current guidance, accepted records, and source; do not work from memory.
2. State problem, scope, assumptions, acceptance, and risk.
3. Resolve architecture-impacting decisions before production code; spike only a bounded uncertainty.
4. Implement the smallest reversible vertical slice.
5. Test at the cheapest effective level and add negative boundary cases.
6. Run affected and repository checks; never weaken gates to pass.
7. Validate acceptance independently and record uncertainty.
8. Update specifications, decisions, diagrams, status, and agent guidance whose truth changed.

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

## Current tooling gap

The v2 foundation has selected pnpm and Nx but has not yet created or validated the workspace/build/test manifests. Do not assume v1 commands. Foundation implementation must pin tool versions, define project targets and dependency rules, establish the OpenAPI workflow, publish the command contract here, and summarize operational commands in `AGENTS.md`.
