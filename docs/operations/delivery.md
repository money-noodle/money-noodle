# Delivery and operations standards

## Operating model

The laptop is a development client, never a production host, scheduler, control plane, or sole canonical state location. Developers may run bounded projects and disposable dependencies locally, not the full integrated platform. Remote environments remain observable and recoverable without a laptop and evolve through small compatible deployments.

The only standing environment classes initially are local development and production. CI may create disposable test dependencies, but there is no required persistent preview or staging environment. Validation that cannot safely occur against production must run locally or in isolated ephemeral CI resources before merge.

The API platform is central to every interface, with web as the primary initial presentation. Keep APIs interface-neutral so mobile, desktop, game, and MMO clients use the same authority and contracts. Prefer isolated serverless functions, containers, and managed jobs. Keep user request paths separate from work and maintenance. Production status, deployed versions, health, queues, jobs, leases, reconciliation, data quality, and incidents must be discoverable through scoped operational views.

## CI/CD

CI/CD is mandatory for every deployable project, shared package, infrastructure module, schema, and governed documentation set. Pull requests validate affected boundaries and integration through applicable formatting/linting, types, tests/coverage, contracts/schemas, builds, dependency/secret scanning, infrastructure plans, migrations, and docs/diagram checks.

`main` is the sole integration and production branch. Once delivery is remotely configured and validated, merging to protected `main` automatically invokes production artifact publication and the authorized delivery path. GitHub Actions may orchestrate provider-native automation, but every stage and final verification reports to the commit. Merge is deployment authorization; agents do not merge without explicit instruction.

The source repository is intentionally becoming public from a one-root squashed snapshot; its private archive remains separate historical evidence. Public forks and pull requests are untrusted and receive no provider token. `pull_request_target` must not execute contributor-controlled source. Before ordinary merges resume, the maintainer follows the visibility, branch-protection, Actions, checksum-verified full-history secret scan, and no-provider OpenTofu baseline sequence in [`../development/version-control.md`](../development/version-control.md). GitHub Actions are currently disabled, and no configured CI run is evidence until they are re-enabled and observed.

Prefer immutable attributable artifacts built once and deployed after gates. If a provider builds from source, pin inputs, run an equivalent production build in CI, and retain artifact/commit attestation. Use reviewed idempotent infrastructure as code, backward-compatible schema/contracts, and independent project deployment. Maintain tested rollback/restore. A merge is not complete until deployment, migrations, health, smoke, and observability checks pass. Failed health or verification automatically rolls back when rollback is safe; otherwise automation halts, exposes the blocked state, and runs the project's declared recovery path. Do not require progressive rollout or a post-merge manual approval by default.

Protect `main` with one required reviewer and all required checks, no direct push/history rewriting, deployment concurrency, and serialization for unsafe infrastructure/schema operations. Restrict workflow permissions by default, pin third-party actions by immutable commit, and keep public pull-request jobs read-only unless a narrower permission is explicitly justified.

## Independent deployment and dependencies

Every project is independently buildable, versioned, deployable, observable, and rollback-capable. Each project owns a machine-readable manifest of build dependencies, runtime dependencies, API/event/schema contracts, compatible version ranges, deployment unit, health checks, and owned data/schema. CI computes the affected dependency graph from declared manifests and changed contracts; it does not guess from runtime traffic.

A deployed service reports source/artifact version, configuration/schema version, health, and dependency compatibility without exposing secrets. At runtime it checks declared dependencies and degrades or fails clearly when required capabilities are absent or incompatible. It must not discover new authority dynamically or silently coordinate through another service's database.

The delivery pipeline deploys only affected projects and dependents requiring coordination. Prefer backward-compatible contracts so dependencies can deploy independently; when coordination is unavoidable, CI produces an explicit ordered plan and verifies every step. The operational view shows project deployment state, versions, dependencies, compatibility, and rollback/recovery status.

Each service exclusively owns its database schema and data and uses a least-privilege database role. Other services use its API/events or an explicitly owned projection rather than reading or writing its tables. A service ships and runs its own versioned migrations as part of its deployment and provides a tested rollback or forward-recovery plan. Migration execution is single-owner and concurrency-safe, not an uncontrolled startup action by every replica. Expand/contract compatibility must allow safe application rollback whenever possible; destructive or irreversible migrations require backup, restore validation, and an explicit coordinated plan.

## Secrets and infrastructure

The first composition selects Google Secret Manager, OpenTofu, separate GCS-backed state, Cloud Run, Artifact Registry, federated GitHub Actions trust, and provider-native OpenTelemetry ingestion; the accepted decisions and dated comparison evidence are in [`deployment-composition.md`](deployment-composition.md) and ADR-0004 through ADR-0007. That composition is implemented as reviewable configuration in [`../../infra/README.md`](../../infra/README.md) and **has not been applied**; the one-time procedure and the exact identifiers the maintainer must supply are in [`../../infra/bootstrap.md`](../../infra/bootstrap.md). Until the complete validated bootstrap repository-variable contract exists, every provider-touching job in `.github/workflows/delivery.yml` is skipped. Apply and rollback additionally require explicit apply authorization, a recorded verification that the `production` environment really has required-reviewer protection, and the environment gate itself; apply also requires a typed confirmation. Naming an environment in workflow YAML is not treated as proof that GitHub configured its protection. Infrastructure definitions and desired configuration live in source control. Mutable infrastructure state lives in an encrypted durable remote backend with concurrency locking, versioning, and backup; never commit raw state to Git. Detect and surface drift against the source-controlled desired state, and keep reconstruction/reconciliation procedures tested.

Every operational secret has a durable source of truth in an approved managed secret store or equivalent encrypted durable system; laptop environment files are never canonical or unique. Document owner, access, rotation, recovery, and revocation.

Prefer short-lived workload identity and CI federation over long-lived cloud keys. Delivery receives only project/environment-specific secrets; developers use separate least-privilege access. Never commit, print, or expose secret values in status views, logs, artifacts, or handoffs.

Manual provider changes and click-only infrastructure are exceptions requiring reconciliation back into code. Never deploy around the pipeline or trigger provider automation manually without explicit authority.

## Maintenance and recovery

Run lightweight bounded health, reconciliation, cleanup, retention, and integrity work during operation. Keep it isolated, resumable, retry/overlap safe, and observable. Automatic recovery is the primary path; authorized audited administrative repair and break-glass access are fallbacks.

Define service and data-class availability, consistency, RPO, RTO, backups, restore tests, and incident behavior before production authority. A failed dependency degrades explicitly rather than presenting stale or unknown state as healthy.
