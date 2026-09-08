# Money Noodle Platform Agent Guide

## Start here

Money Noodle is an architecture-first rebuild of a continuously deployed, multi-tenant financial learning, gaming, analysis, and funded-trading platform. The current sequence is architecture → implementation → testing → deployed validation. Do not recreate historical behavior by default.

`AGENTS.md` is the required entry point and operational map, not the repository's encyclopedia. Read it first, run `node tools/coordination-status.mjs`, then read the linked document relevant to the task completely. GitHub Issues are the cross-harness work registry; a missing or unreachable registry never means work is unclaimed. Keep detailed standards and rationale in their owning documents so this guide stays short, current, and useful.

## Session orientation

Determine session kind before working role. A delegated assignment is a bounded subagent session—worker, reviewer, researcher, planner, or ordinary diagnostic—not a root supervisor or human-directed debugger; ask the assigning supervisor when that is unclear. Parent context, a role label, and ordinary fanout permission do not change this.

An independent session normally works as an execution supervisor for a clear build or development request; a plan, ticket, research, or specification request selects planning supervisor. Infer natural-language intent, briefly state the working role, and ask a concise question before consequential work only when role, outcome, or authority is materially unclear. The [parallel-work standard](docs/development/parallel-work.md#session-roles) owns role responsibilities, transitions, and the separately human-directed debugger role.

## Current non-negotiables

- Treat the private archive and all prior-generation material as historical evidence, never current authority. Revalidate before reuse.
- Resolve architecture and acceptance criteria before production implementation. Isolated disposable spikes may answer bounded questions.
- Use one monorepo with independently buildable and deployable projects. Favor TypeScript; use another language when a bounded project has a documented material advantage.
- Follow Clean Architecture. User interfaces present state and submit intent; they do not perform platform work. APIs are stateless and lightweight. Jobs and provider integrations run in isolated deployment units.
- Assume a person may use web, mobile, desktop, game, and MMO-style interfaces concurrently. Server state is authoritative. Offline behavior is explicit and designed per capability.
- Funded trading is foundational, but the platform currently has **no real-money authority**. Simulation and funded balances, ledgers, execution authority, presentation, and audit remain structurally separate.
- Treat repository source, issues, pull requests, commit metadata, prompts copied into coordination, Actions logs and summaries, artifacts, and caches as public or potentially externally observable. Never place secret payloads, customer or production data, billing/account identifiers, private recovery material, production snapshots, or durable provider credentials in them; follow [`SECURITY.md`](SECURITY.md) for private reporting and accidental disclosure.
- Run the integrated system remotely, not on a developer laptop. Prefer short-lived idempotent functions, containers, and jobs over resident multipurpose services.
- CI/CD is mandatory. Once delivery is configured, a pull-request merge to protected `main` that satisfies the applicable integration policy authorizes and triggers production delivery; agents must not merge unless explicitly asked.
- Claim work by creating its remote reference: one claim owns one issue, one `claim-v1/issue-<N>` branch, and one dedicated worktree, and its agent edits only there. An agent with a current matching claim may make a normal, non-force push only to that claim's own branch. It may not push the integration branch, a tag, another claim's branch, a deletion, or rewritten history; this grants no pull-request, integration, merge, provider, or deployment authority, and pull requests remain the only integration route. [`docs/development/parallel-work.md`](docs/development/parallel-work.md) owns the claim, checkpoint, and publication protocol.
- The temporary sole-maintainer integration exception belongs only to the maintainer acting personally as the human principal and may waive only the unavailable independent-review gate: its required approving review and last-push approval subgates. Stale approval never qualifies. Conversation resolution and every required check on the exact current head remain mandatory, and any head change invalidates all previous required-check and exception-evidence qualification. An agent, workload identity, or automation cannot invoke the exception, request it, infer it from an issue, assignment, green check, prior bypass, or broad instruction, or treat it as merge authority. Direct push, force push, history rewriting, any other protection bypass, failed-check bypass, and provider or deployment bypass remain forbidden; [`docs/development/version-control.md`](docs/development/version-control.md) owns the exact conditions, evidence, expiry, and retirement procedure.
- Use **principal** for a person holding authority, **agent** for an AI session executing bounded work, and **workload identity** for a machine credential something runs as. Human and AI remain useful clarifiers; role-specific reviewer and event-envelope actor remain valid.
- Agents are intended technical operators for routine platform work through reviewed automation, short-lived workload identity, default-deny authorization, independent verification, and durable evidence. Humans retain account ownership, recovery authority, and explicit scoped approval of production effects; neither agents nor humans bypass the pipeline through a cloud console or developer laptop. [`docs/operations/delivery.md`](docs/operations/delivery.md) owns the detailed boundary.
- Default authorization to deny, enforce tenant scope at every boundary, keep operational secrets in durable managed storage, and preserve reconstructable audit/accounting records.
- Keep architecture visually current with version-controlled diagrams-as-code. A boundary or topology change is incomplete when its current diagram is stale.
- Root session roles, bounded-child status, and human-directed debugging are defined by [`docs/development/parallel-work.md`](docs/development/parallel-work.md#session-roles). A supervisor may make a small direct edit only with known in-scope ownership or explicitly authorized unclaimed scope—still on a dedicated typed branch and worktree, still through a pull request—and delegates substantial or parallel work non-blockingly. Never hand-edit in the integration checkout while integrating someone else's work; conflicts and corrections go back to the execution branch. Claims come from the GitHub registry and refs, never a session list or worktree inspection.
- Whimsy guides the user experience; precise industry terminology guides code and infrastructure. Never let playful language conceal financial meaning or risk.
- Prefer self-healing leases, reconciliation, cleanup, and status checks. Administrative repair exists as an authorized, audited fallback.

## Authority and reading map

Authority descends from the maintainer's current instruction, to accepted current specifications/decisions, to implemented behavior, to tests and dated validation evidence, and finally to historical material. Resolve conflicts visibly. Proposed documents do not become accepted merely by being committed.

| Task area                                                              | Read completely                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Documentation authority and placement                                  | [`docs/README.md`](docs/README.md)                                                                     |
| Current repository, host-control, validation, and deployment truth     | [`docs/current-status.md`](docs/current-status.md)                                                     |
| Public security reporting and accidental disclosure                    | [`SECURITY.md`](SECURITY.md)                                                                           |
| Public contribution and untrusted-fork expectations                    | [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                                   |
| Decision index, log, and promotion to Settled                          | [`docs/architecture/decisions/README.md`](docs/architecture/decisions/README.md)                       |
| Product experience, risk profiles, offline use, and whimsy             | [`docs/product/experience.md`](docs/product/experience.md)                                             |
| Whimsical-to-domain vocabulary                                         | [`docs/product/glossary.md`](docs/product/glossary.md)                                                 |
| Architecture, monorepo, diagrams, runtime boundaries, and self-healing | [`docs/architecture/principles.md`](docs/architecture/principles.md)                                   |
| Accepted first web/API boundaries, diagrams, and source/deployment map | [`docs/architecture/overview.md`](docs/architecture/overview.md)                                       |
| Data placement, telemetry, audit, identity, ownership, and roles       | [`docs/architecture/data-identity-observability.md`](docs/architecture/data-identity-observability.md) |
| Implementation and testing standards                                   | [`docs/engineering/standards.md`](docs/engineering/standards.md)                                       |
| CI/CD, remote operation, secrets, and deployment                       | [`docs/operations/delivery.md`](docs/operations/delivery.md)                                           |
| Branches, tags, publication, and releases                              | [`docs/development/version-control.md`](docs/development/version-control.md)                           |
| Parallel planning, claims, worktrees, stale sessions, and handoff      | [`docs/development/parallel-work.md`](docs/development/parallel-work.md)                               |

Use the accepted source/deployment map instead of inferring current boundaries from directory names alone.

## Working method

Use the applicable [`implementation workflow`](docs/engineering/standards.md#implementation-workflow) for lasting implementation work. [`docs/development/parallel-work.md`](docs/development/parallel-work.md) owns session roles, claims, isolation, checkpoints, staleness, and handoff; [`docs/development/version-control.md`](docs/development/version-control.md) owns worktree placement, branches, publication, and integration.

## Keep the guidance operational

This is a living standard and safety envelope, not an exhaustive specification or ceiling on judgment. Requirements and safety controls remain constraints until deliberately changed; conventions and preferred tools are challengeable defaults. Surface stale or obstructive guidance and propose a better validated approach rather than following it mechanically.

- Keep this root file navigational and present-tense. Move detailed subject matter to one owning document and link it here.
- Do not duplicate a rule across several files. A summary here must point to its authority.
- Rewrite stale guidance instead of appending corrections or migration diaries. History belongs in Git, ADRs, releases, and dated validation records.
- Use nested `AGENTS.md` files only for stable instructions local to a substantial subtree.
- Use agent skills for repeatable procedures that benefit from executable or stepwise guidance, not as hidden requirement authority. Skills must route back to current repository documents and remain testable. Automate parallel-work preflight only after the documented manual protocol is stable.
- Update this file when phase, terminology, source map, commands, safety boundaries, deployment, or routing changes.

## Current repository state

Read [`docs/current-status.md`](docs/current-status.md) for current repository, host-control, validation, and deployment facts. Use the accepted [`source and deployment map`](docs/architecture/overview.md#source-and-deployment-map) for project boundaries and the engineering [`command contract`](docs/engineering/standards.md#command-contract) for local checks. Never describe local or CI validation as deployed validation.

## Safety and handoff

Never commit or print sensitive payloads; public-source handling and private reporting are defined in [`SECURITY.md`](SECURITY.md). Never enable funded authority, trigger provider automation manually, alter protected refs, or deploy outside the approved pipeline without explicit instruction.

Report the branch, changed paths, decisions, checks and exact failures, evidence, security/tenant impact, deployment impact, and unresolved risks. Label work accurately as proposal, spike, unvalidated implementation, locally validated change, or deployed-and-verified change. Completion means documented acceptance criteria are met, not merely that code was written.
