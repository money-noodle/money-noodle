# Money Noodle v2 Platform Agent Guide

## Start here

Money Noodle v2 is an architecture-first rebuild of a continuously deployed, multi-tenant financial learning, gaming, analysis, and funded-trading platform. The current sequence is architecture → implementation → testing → deployed validation. Do not recreate v1 behavior by default.

`AGENTS.md` is the required entry point and operational map, not the repository's encyclopedia. Read it first, run `node tools/coordination-status.mjs`, then read the linked document relevant to the task completely. The shared plan and work status are the cross-harness coordination authority; a missing or unreachable registry never means work is unclaimed. Keep detailed standards and rationale in their owning documents so this guide stays short, current, and useful.

## Current non-negotiables

- Treat all v1 material as historical evidence, never current authority. Revalidate before reuse.
- Resolve architecture and acceptance criteria before production implementation. Isolated disposable spikes may answer bounded questions.
- Use one monorepo with independently buildable and deployable projects. Favor TypeScript; use another language when a bounded project has a documented material advantage.
- Follow Clean Architecture. User interfaces present state and submit intent; they do not perform platform work. APIs are stateless and lightweight. Jobs and provider integrations run in isolated deployment units.
- Assume a person may use web, mobile, desktop, game, and MMO-style interfaces concurrently. Server state is authoritative. Offline behavior is explicit and designed per capability.
- Funded trading is foundational, but v2 currently has **no real-money authority**. Simulation and funded balances, ledgers, execution authority, presentation, and audit remain structurally separate.
- Run the integrated system remotely, not on a developer laptop. Prefer short-lived idempotent functions, containers, and jobs over resident multipurpose services.
- CI/CD is mandatory. After cutover, a reviewed merge to `main` authorizes and triggers production deployment; agents must not merge unless explicitly asked.
- Default authorization to deny, enforce tenant scope at every boundary, keep operational secrets in durable managed storage, and preserve reconstructable audit/accounting records.
- Keep architecture visually current with version-controlled diagrams-as-code. A boundary or topology change is incomplete when its current diagram is stale.
- All agents and harnesses coordinate through one shared plan and GitHub work status. Before editing, follow the pre-claim double-check in [`docs/development/parallel-work.md`](docs/development/parallel-work.md): status output alone is insufficient, so inspect the issue body, its ownership/checkpoint comments, and local worktrees immediately before claiming. Stop on conflicting evidence rather than overwriting it. Then claim a bounded non-overlapping scope and use a dedicated branch/worktree. Suspected stale work includes a proposed completion/cleanup plan and is surfaced to the maintainer, never taken over automatically.
- Whimsy guides the user experience; precise industry terminology guides code and infrastructure. Never let playful language conceal financial meaning or risk.
- Prefer self-healing leases, reconciliation, cleanup, and status checks. Administrative repair exists as an authorized, audited fallback.

## Authority and reading map

Authority descends from the maintainer's current instruction, to accepted current specifications/decisions, to implemented behavior, to tests and dated validation evidence, and finally to historical material. Resolve conflicts visibly. Proposed documents do not become accepted merely by being committed.

| Task area | Read completely |
| --- | --- |
| Documentation authority and placement | [`docs/README.md`](docs/README.md) |
| Product experience, risk profiles, offline use, and whimsy | [`docs/product/experience.md`](docs/product/experience.md) |
| Whimsical-to-domain vocabulary | [`docs/product/glossary.md`](docs/product/glossary.md) |
| Architecture, monorepo, diagrams, runtime boundaries, and self-healing | [`docs/architecture/principles.md`](docs/architecture/principles.md) |
| Accepted first web/API boundaries, diagrams, and source/deployment map | [`docs/architecture/overview.md`](docs/architecture/overview.md) |
| Data placement, telemetry, audit, identity, ownership, and roles | [`docs/architecture/data-identity-observability.md`](docs/architecture/data-identity-observability.md) |
| Implementation and testing standards | [`docs/engineering/standards.md`](docs/engineering/standards.md) |
| CI/CD, remote operation, secrets, and deployment | [`docs/operations/delivery.md`](docs/operations/delivery.md) |
| Branches, tags, and v2 cutover | [`docs/development/version-control.md`](docs/development/version-control.md) |
| Parallel planning, claims, worktrees, stale sessions, and handoff | [`docs/development/parallel-work.md`](docs/development/parallel-work.md) |

Use the accepted source/deployment map instead of inferring current boundaries from directory names alone.

## Working method

For each change:

1. Inspect branch/status, run the coordination status command, and read the shared plan, active worktrees/claims, routed current documents, and relevant source.
2. Update the shared plan as needed, then state and claim the problem, scope, facts, assumptions, unknowns, acceptance criteria, dependencies, and risk.
3. Resolve cross-boundary decisions and update proposed/accepted visual architecture before production code.
4. Implement the smallest reversible vertical slice with explicit contracts.
5. Add focused tests plus negative tests at authority, tenant, data-quality, concurrency, and external-effect boundaries.
6. Run all available affected-project and repository checks. Never weaken a gate merely to pass.
7. Validate acceptance independently of the implementation path and record remaining uncertainty.
8. Update the owning docs, diagrams, decisions, status, and this map in the same change when their truth changed.

Recalculate before making consequential quantitative claims. Distinguish fact, hypothesis, estimate, simulation, and realized result. Include as-of time, sample, exclusions, uncertainty, and the largest validity threat.

## Keep the guidance operational

This is a living standard and safety envelope, not an exhaustive specification or ceiling on judgment. Requirements and safety controls remain constraints until deliberately changed; conventions and preferred tools are challengeable defaults. Surface stale or obstructive guidance and propose a better validated approach rather than following it mechanically.

- Keep this root file navigational and present-tense. Move detailed subject matter to one owning document and link it here.
- Do not duplicate a rule across several files. A summary here must point to its authority.
- Rewrite stale guidance instead of appending corrections or migration diaries. History belongs in Git, ADRs, releases, and dated validation records.
- Use nested `AGENTS.md` files only for stable instructions local to a substantial subtree.
- Use agent skills for repeatable procedures that benefit from executable or stepwise guidance, not as hidden requirement authority. Skills must route back to current repository documents and remain testable. Automate parallel-work preflight only after the documented manual protocol is stable.
- Update this file when phase, terminology, source map, commands, safety boundaries, deployment, or routing changes.
- At v2 cutover, remove migration-only v1/v2 language and evolve this into the **Money Noodle Platform Agent Guide**.

## Current repository state

Development currently targets `v2`; work occurs on short-lived typed branches such as the current `arch/v2-foundation`. `main` remains the v1 production line until the controlled cutover. The immutable v1 archive and maintenance refs are documented in [`docs/development/version-control.md`](docs/development/version-control.md).

The first-slice workspace foundation now defines pnpm/Nx projects for the Next.js web, Fastify platform API, API-owned OpenAPI document, generated TypeScript client, and separate OCI artifacts; see [`docs/architecture/overview.md`](docs/architecture/overview.md) and [`docs/engineering/standards.md`](docs/engineering/standards.md). Use Node.js 22.22.0 and pnpm 11.24.0. Run `pnpm install --frozen-lockfile`, `pnpm check`, and—when Docker is available—`pnpm container`; use `pnpm nx run <project>:<target>` for a focused project. CI runs affected lint, type, test, contract, build, dependency, secret, container, provenance/SBOM, and image-vulnerability gates. The platform-status behavior is implemented for local and container validation; the remote provider/IaC deployment remains unimplemented. Never describe local or CI validation as deployed validation.

## Safety and handoff

Never commit or print secrets, customer data, private keys, or production snapshots. Never enable funded authority, trigger provider automation manually, alter protected refs, or deploy outside the approved pipeline without explicit instruction.

Report the branch, changed paths, decisions, checks and exact failures, evidence, security/tenant impact, deployment impact, and unresolved risks. Label work accurately as proposal, spike, unvalidated implementation, locally validated change, or deployed-and-verified change. Completion means documented acceptance criteria are met, not merely that code was written.
