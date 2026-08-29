# Architecture and runtime standards

## Architecture gate

Before production implementation, establish enough accepted architecture to state actors/use cases, measurable quality attributes, domain and trust boundaries, data ownership, tenant isolation, forecast/experiment lifecycles, risk/authorization/execution separation, runtime/deployment topology, observability, failure behavior, alternatives, and validation.

Technology choices follow technology-neutral requirements. Record durable cross-cutting choices as ADRs before silently coding them. Reconsider decisions when evidence or goals change; supersede them cleanly rather than preserving sunk cost.

## Visual architecture

Architecture must remain visually inspectable. Every proposal and accepted change to boundaries, dependencies, data flow, trust, processes, or deployment updates the relevant diagram in the same change.

Keep human-readable diagram source in version control. Prefer Mermaid in Markdown for straightforward views; use another text-based reproducible format when materially clearer. Generated images are optional outputs, never the only editable source. If diagrams proliferate, prefer one model generating multiple views.

Maintain small linked views, each with one purpose and abstraction level. Include as relevant:

- context, actors, external systems, and trust boundaries;
- domains, services, stores, ownership, and dependency direction;
- processes, sync/async communication, and failure isolation;
- deployment zones, scaling units, and environments;
- critical request, event, forecast, experiment, risk, authorization, lease, maintenance, and reconciliation sequences;
- identity, ownership hierarchy, role scope, and permission inheritance;
- tenant data placement, lineage, quality, retention, and authority.

Use canonical names, labeled directional relationships, accepted/proposed/external distinctions, and accessible legends. Do not rely on color alone or expose secrets, customer data, or exploitable details. Index current views from the architecture overview. Validate syntax and links in CI once tooling exists.

## Monorepo and project boundaries

Use one monorepo with separate projects organized by deployable or domain responsibility:

- `apps/`: user-facing applications;
- `services/`: stateless request/response APIs;
- `jobs/`: scheduled, event-driven, and batch workloads;
- `packages/`: deliberately shared contracts/libraries;
- `infra/`: provider-neutral modules and provider composition;
- `docs/`: governed architecture and product records;
- `tools/`: repository automation.

Create directories only when needed. Each project states purpose, ownership/boundary, contracts, build, tests, deployment unit, configuration, and dependencies in a short README. Enforce dependency direction and prevent cycles. Shared packages are not a back channel around service boundaries.

## Clean Architecture and runtime isolation

Domain rules/use cases depend on no UI, framework, provider SDK, database, or transport. External concerns implement explicit ports. Keep deterministic decision logic separate from I/O, orchestration, presentation, and adapters.

User interfaces present state and submit intent; they never run platform jobs or hold provider authority. APIs authenticate, authorize, validate, serve reads, accept commands, and enqueue work with low overhead. APIs remain stateless; durable coordination stays behind explicit ports.

Run workloads in isolated serverless functions, containers, or managed jobs. Prefer short-lived idempotent batch/event execution over resident workers and multipurpose services. Recurring work is normally a fresh invocation with checkpoints, retries, timeout, concurrency limits, and duplicate handling. A long-running process requires a documented need plus health, restart, upgrade, and isolation design.

Keep cloud-specific services behind narrow adapters, use open protocols/exportable formats, and package compute in standard runtimes or containers where practical. Cloud-specific deployment composition is acceptable; cloud-specific domain logic is not. Provider decisions cover migration, backup/restore, and egress.

## Concurrent interfaces and authoritative state

Assume one person uses several front ends concurrently. APIs never encode a single-client workflow or canonical state in a UI session. Commands carry principal/tenant scope, client identity, correlation, idempotency where relevant, and expected resource version. Reject stale conflicting changes, merge only fields proven independent, and return a structured conflict containing safe current/proposed state and resolution options. A front end may surface that conflict as a question to the user when interaction is possible; it must never silently choose a financially consequential resolution.

Use bounded polling initially rather than requiring real-time connections. Define polling interval, jitter, backoff, cache validators/version cursor, request budget, and stop conditions per data class and interface. Each read contract defines freshness and stale/unknown behavior appropriate to the data, and every surface exposes source/as-of and synchronization state when material.

Provide scoped operational views at all times. A public view exposes safe platform availability, incidents, and degradation without tenant or exploitable detail. User views expose their resources, activity, freshness, pending work, and actionable failures. Administrative views additionally expose safe deployment/config/schema versions, service health, queues, jobs, leases, ownership, reconciliation, data quality, cleanup, and incidents. Distinguish healthy, degraded, stale, blocked, retrying, and unknown.

## Resource lifecycle and self-healing

Prefer idempotency, optimistic concurrency, partitioned ownership, and atomic transitions over locks. When exclusivity is required, use bounded leases recording resource, tenant, owner, reason, heartbeat, expiry, attempt, and fencing token. Superseded owners cannot commit. Every lease has automatic recovery and an authorized audited administrative revoke/release path that cannot create split brain.

Treat budget assigned to autonomous work as a durable fenced reservation, not an in-memory number or ordinary lock. Record owning portfolio, authorizing human and policy, workload principal, strategy/purpose, permitted operations, total/reserved/consumed/released amounts, exposure and loss limits, issuance/heartbeat/expiry, and reconciliation state. Prevent overlapping reservations from spending the same authority. Market-monitoring and autonomous buy/sell work must revalidate current budget, risk, market, and fencing state before every external effect.

Lease heartbeat and expiry are defined per workload rather than by one platform constant. Base them on operation duration, retry behavior, provider uncertainty, and safe recovery time, and validate them with crash and delayed-worker tests.

Administrative stop control has two explicit paths. Graceful cancellation is the default: withdraw new-work authority, reach a safe boundary, cancel or finish in-flight work as designed, reconcile, and release. Emergency fencing immediately advances the fencing generation so the prior holder cannot commit, then blocks affected work pending reconciliation of uncertain external effects. Never unlock by deleting a lease record.

Emergency fencing is operator-initiated by default and must present scope, active work, external uncertainty, and expected consequences before confirmation. Do not create a generic automatic emergency fence. A workflow may automate fencing only through a separately accepted safety design with deterministic triggers, false-positive analysis, bounded blast radius, delayed-worker tests, observability, and a demonstrated outcome safer than graceful cancellation. Ordinary lease expiry may automatically invalidate a stale generation as a correctness mechanism; that does not imply that external effects were canceled or reconciled.

Every workflow defines a state machine, durable checkpoints, idempotency, retries, timeout, compensation/reconciliation, and terminal cleanup. Do not claim distributed exactly-once execution; make at-least-once safe and duplicate effects visible. Reconciliation compares intended, recorded, and provider-observed state. Each workflow explicitly identifies which mismatches it may repair automatically; unresolved or ambiguous contradictions fail closed and surface for administrative review.

Run bounded health, reconciliation, orphan cleanup, retention, and integrity checks continuously or on a declared per-workflow schedule. Choose cadence from freshness, risk, provider limits, cost, and recovery objectives as each workflow is designed—never inherit an unrelated global interval. Keep maintenance isolated, rate-limited, resumable, observable, and overlap-safe. Automatic recovery is normal; administrative repair is fallback. Define and test consistency, durability, RPO, RTO, and restore guarantees for each state class.
