# ADR-0004: First remote hosting, registry, and public entry point

> **Status:** Proposed
> **Date proposed:** 2026-08-29
> **Owners:** Platform foundation; maintainer decides
> **Related architecture:** [`../overview.md`](../overview.md)
> **Evidence:** [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md)
> **Depends on:** [`ADR-0003`](ADR-0003-first-slice-runtime-and-deployment.md)

## Context

[`ADR-0003`](ADR-0003-first-slice-runtime-and-deployment.md) accepted two independently deployable OCI images and explicitly deferred the provider composition. The first slice cannot be deployed, and no quantitative service objective can be measured, until a hosting runtime, image registry, and public entry point are chosen.

The accepted constraints that bind this choice are: portable OCI artifacts run unmodified (ADR-0003); web and API deploy and roll back independently (ADR-0001); short-lived isolated execution is preferred over resident multipurpose services (`principles.md`); production is the only standing environment (`delivery.md`); and CI should authenticate through federation rather than a long-lived cloud key (`delivery.md`).

Two compositions were compared in full against dated published pricing and documented limits, and four further options were eliminated with reasons. The full evidence table, cost model, assumptions, and validity threats are in [`deployment-composition.md`](../../operations/deployment-composition.md) and are not repeated here.

## Decision

Deploy each accepted project as a scale-to-zero managed container service on **Google Cloud Run**, with **Artifact Registry** in the same region, and a **global external Application Load Balancer** with a managed certificate over a **Cloud DNS** zone as the public entry point.

- One Cloud Run service per deployable project, request-based billing, minimum instances zero, deployed by image digest.
- Each service holds its own service account, scaling configuration, health checks, telemetry service identity, and revision history.
- Revisions are immutable. Rollback is a traffic reassignment to a prior revision on one service, requiring no rebuild and no change to the other service.
- The registry is regional and colocated with the services so image pulls stay on the free intra-location path.
- Custom domains are served through the load balancer with serverless network endpoint groups. **Cloud Run domain mappings are not used**, because the provider documents them as preview stage and "not production-ready".
- All provider composition lives in `infra/` behind per-project modules, per ADR-0003 and `principles.md`. No provider SDK enters `apps/web` or `services/platform-api` inner layers.

## Why this rather than the alternative

The comparison came down to one criterion. Cloud Run's ecosystem is the only one examined in which the delivery pipeline can authenticate without a long-lived cloud credential stored in GitHub; the alternative's documented CI pattern stores an API key at rest. That is decided in [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md), but it is the reason this ADR selects this provider. Revision-based per-service rollback is the secondary reason.

At first-slice scale the compute for both candidates falls inside published free tiers, so cost did not decide this. The load balancer's ≈`$18.25`/month is accepted as the price of a production-grade entry point rather than shipping on a preview-stage feature.

## Alternatives considered

### Scaleway Serverless Containers

The strongest alternative, and the one this decision is most exposed to. It offers generally available custom domains with automatic Let's Encrypt certificates at no charge, free egress, a cheaper per-vCPU-second rate beyond the free tier, EU residency by construction, and — decisively for consolidation — it is the provider whose object storage `data-identity-observability.md` has **already accepted** for historical and analytical data. Choosing Cloud Run therefore establishes a permanent two-provider footprint.

It is not selected because its documented GitHub Actions pattern stores a long-lived IAM application key as a repository secret, and no OIDC workload-identity exchange for CI was found in its IAM documentation. A secondary concern is that whether its 15-minute post-request warm window is billed could not be resolved from published documentation, leaving compute cost at this scale somewhere between €0 and ≈€44.50 per month.

### Azure Container Apps

Credible on capability — scale to zero, free managed certificates, GitHub federated credentials, Key Vault, blob-lease state locking — and its published free grant is identical to Cloud Run's. Not selected because it demonstrates no cost or capability advantage, introduces a third provider ecosystem with no existing relationship, and its per-second rates could not be read from the primary pricing page on 2026-08-29.

### AWS App Runner

Rejected. Provisioned container instance memory is billed continuously at `$0.007` per GB-hour even while idle, which contradicts the preference for scale-to-zero execution and creates a standing floor of roughly `$7.67` per month for the modelled allocation before any request is served.

### AWS ECS on Fargate

Rejected on shape without pricing it: a request-serving Fargate service cannot scale to zero.

### Fly.io, Render, Railway and similar platforms

Deferred. None was found to offer OIDC workload-identity federation for CI, a managed secret store with documented rotation and revocation, and a lock-protected remote infrastructure state backend together. Revisit only if a specific platform demonstrably meets all three.

### Managed Kubernetes

Rejected as premature. It imposes cluster lifecycle, upgrade, and idle node cost on two stateless request-serving projects and contradicts the accepted preference for short-lived isolated execution.

### Cloud Run domain mappings instead of a load balancer

Rejected for production. The provider states they are preview stage, "not production-ready", unsupported at general availability, and available in a restricted region set. They remain acceptable for a disposable spike.

### Default `*.run.app` URLs with no custom domain

Deferred as an explicit interim option, not the target state. It removes ≈`$18.25`/month and unblocks the first remote validation before a domain is ready, at the cost of a non-production URL. The maintainer decides whether to take it.

## Consequences

### Positive

- The pipeline can authenticate without a long-lived cloud key, which is the property this decision was optimised for.
- Rollback is per service, immediate, and requires no rebuild, directly satisfying an accepted quality attribute.
- Compute, registry, DNS queries, state storage, logging, tracing, and uptime checks all fall inside published free allotments at first-slice scale.
- Web-to-API traffic within one region is not charged, so the accepted two-deployment boundary costs nothing in transfer.
- The application artifact contract is unchanged, so a later provider change is a composition change, not a code change.

### Negative

- **A second provider.** Scaleway object storage is already accepted, so the platform now spans two accounts, two IAM models, two bills, and two audit scopes before it has a user.
- The load balancer is a fixed ≈`$18.25`/month that does not scale down with traffic, and it is the single largest line in the first-slice estimate.
- Cloud DNS has no free tier, so a zone costs from the first day.
- The provider's free tiers are per billing account, not per service, so they will be consumed faster as projects are added.
- Data residency becomes an explicit decision rather than a property of the provider.
- OTLP metric ingestion is Pre-GA on this provider, so telemetry carries a stated risk acceptance.

## Blocked on the maintainer

This decision cannot be accepted, and no resource may be created, until the maintainer settles provider account ownership, billing account and budget ceiling, region and data-residency position, domain ownership and DNS delegation, the public hostname layout, and whether to ship on an interim default URL. These are enumerated as M1 through M9 in [`deployment-composition.md`](../../operations/deployment-composition.md).

## Validation

Before this decision is considered implemented:

1. both images deploy from one reviewed commit by digest, and each service reports its own artifact version;
2. `/health/live` and `/health/ready` pass independently for each service;
3. `GET /v1/platform/status` returns a schema-valid v1 response through the public entry point;
4. the web renders the API-provided source time;
5. a forced API failure makes the remote web render `unknown` and never `available`;
6. one service is rolled back to its prior revision while the other is left untouched and stays healthy;
7. TLS is issued and renews without a scheduled human action;
8. a budget alert fires against a stated ceiling;
9. cold-start, latency, and error evidence is recorded with as-of time, sample, and largest validity threat before any quantitative objective is proposed.

Local checks cannot satisfy any of these.

## Revisit when

- the alternative provider ships OIDC workload-identity federation for CI, which would remove the decisive argument;
- Cloud Run domain mappings reach general availability with production support, which would remove the load balancer cost;
- the maintainer adopts an EU data-residency requirement;
- measured evidence resolves whether the alternative's warm window is billed;
- the platform's second or third deployable project changes the free-tier arithmetic materially;
- a workload needs streaming, long-running execution, or a scale ceiling this runtime cannot meet.
