# ADR-0009: Administrative infrastructure, deployment, and cost observability

> **Status:** Proposed
> **Date proposed:** 2026-08-30
> **Owners:** Platform foundation; proposed for maintainer acceptance
> **Related architecture:** [`../data-identity-observability.md`](../data-identity-observability.md)
> **Evidence:** [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md)
> **Depends on:** [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md), [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md), [`ADR-0007`](ADR-0007-first-telemetry-backend.md), [`ADR-0008`](ADR-0008-single-object-store.md)

## Context

The requirement for an administrative cost surface is currently half-present, and a half-present requirement is unbuildable. `principles.md` already mandates scoped operational views at all times and enumerates what administrative views expose — deployment, config, and schema versions, service health, queues, jobs, leases, ownership, reconciliation, data quality, cleanup, and incidents — but that enumeration omits infrastructure spend entirely. `data-identity-observability.md` already keeps platform operations, billing/ownership, and debug access as distinct permissions, and already requires ingestion volume, cardinality, retention, query use, and cost to be instrumented from the start so that unknown cost cannot grow invisibly. It names no surface on which any of that would be rendered.

The infrastructure side is further along than the platform side, which is the actual problem. `infra/modules/budget-guardrail/` implements the maintainer-accepted `$30` monthly ceiling with actual-spend alerts at 50, 80, and 100 percent plus a forecast alert at the ceiling, and it deliberately does not disable billing. Its only notification channel is `type = "email"`. There is no programmatic egress from that module at all: provider spend reaches a human inbox and stops. Nothing inside the platform can read the figure the budget already knows, so no administrative view can render month-to-date spend, forecast spend, or proximity to the ceiling without inventing a second source of truth for the ceiling itself.

The cost evidence that exists is an estimate, not a measurement. `deployment-composition.md` records dated published prices and free-tier limits with sources, but its largest unresolved items — U1's unverified warm-window billing and U4's unread egress rate, over U7's complete absence of a real image — mean no figure in it has been confirmed against a bill. [`ADR-0007`](ADR-0007-first-telemetry-backend.md) accepted the provider's native telemetry backend precisely because it is the cheapest choice to reverse, and named telemetry as the composition element most likely to become an unbudgeted recurring cost. A surface that shows measured spend is the instrument that makes that reversibility decidable.

This record crosses an accepted exclusion, and that must be visible rather than smoothed over. `overview.md` records maintainer decision 11 as the "exclusion of identity, PostgreSQL/schema work, jobs, simulation, and funded authority from the first slice", and the ingestion unit decided here is a job. The maintainer has accepted this scope, so the exclusion is deliberately extended rather than quietly reinterpreted; the sequencing that keeps that extension honest is decided below. This record decides only. It creates no project, no provider resource, no credential, and no billing relationship, and implementation is separately scoped.

## Decision

### Ingestion boundary

Reading provider cost, deployment, and service state is **provider integration**, not request serving. `principles.md` states that APIs remain stateless and that durable coordination stays behind explicit ports, and it prefers short-lived idempotent batch execution over resident workers and multipurpose services. The reader is therefore an **isolated scheduled deployment unit** — a fresh invocation with checkpoints, retries, a timeout, a concurrency limit, and duplicate handling — that writes a durable read model. The stateless platform API serves that read model and nothing else.

The platform API **never calls a provider billing, deployment, or infrastructure API inline on a request path**, and no provider credential exists on a request path or in a browser. The API's dependency is the read model, not the provider.

This unit is the first inhabitant of `jobs/`, which `principles.md` declares as the home of scheduled, event-driven, and batch workloads but which does not yet exist on disk. It carries its own least-privilege reader identity — a **fourth principal**, added to the deployer, web, and API principals separated in [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md), and mechanically distinct from all three. It reads provider cost and deployment state and exports telemetry; it may not deploy, write infrastructure state, push or read the registry, serve requests, or hold any billing administration or payment authority. That distinction is not cosmetic: `infra/README.md` records that the deployer holds `roles/billing.costsManager` on exactly the selected billing account because project IAM cannot create a billing-account budget, and that it grants no billing administration or payment authority. A reader identity is therefore genuinely new work rather than a reuse of an existing grant. Provisioning it is implementation; deciding that it must be separate and least-privilege is this record.

### Cost data source

The budget publishes to **Pub/Sub**. A `pubsub_topic` is added to the existing budget's `all_updates_rule` in `infra/modules/budget-guardrail/`, alongside the existing email channel rather than replacing it.

The budget notification payload carries the cost amount, the budget amount, the threshold crossed, and the forecast, which covers every figure the surface needs except free-tier headroom. Decisively, it reuses the accepted `$30` ceiling as the **single source of truth** — the surface reads the ceiling the budget enforces instead of restating it in a second place where the two can silently diverge. The alternative sources examined either cannot supply current spend at all or buy a breakdown that two services do not need.

### Free-tier headroom is a derived figure, not a provider-reported one

The provider exposes no clean free-tier-consumption API. Free-tier and quota headroom is therefore **derived**: measured usage from Cloud Monitoring metrics is compared against the free-tier limits already recorded, with sources and as-of dates, in `deployment-composition.md`.

This is stated plainly because the surface must not present it as equivalent evidence. A derived headroom figure inherits the uncertainty of the usage metric, of the recorded limit, and of the mapping between them, and free tiers are per billing account rather than per service, so the denominator moves as projects are added. **Derived headroom is weaker evidence than reported spend** and is labeled as derived wherever it appears. It is an early-warning indicator, never a number to plan against.

### Read model and storage

The read model is stored in **Google Cloud Storage**, per [`ADR-0008`](ADR-0008-single-object-store.md), which consolidates on a single object store and drops the previously accepted second provider. That decision is cited here, not re-made.

It is **one small schema-versioned JSON document, rewritten in full each run**, following the chunk and manifest contract in `data-identity-observability.md`: a stable chunk identity, schema and producer versions, a checksum, byte and record counts, and an event-time range, so a reader detects a missing, duplicate, corrupt, or incompatible document rather than trusting a listing. The dataset is bounded and tiny by construction — a platform-wide snapshot, not a history — so a full rewrite is correct and a partitioned chunk sequence would be ceremony. Retaining spend history is a separate later decision with its own retention policy.

### Attribution granularity

Attribution is **platform-wide now**. At first-slice scale there are two services under one `$30` ceiling, and a per-tenant figure would be an allocation formula invented ahead of any tenant.

Per-tenant attribution and any chargeback model are **deferred deliberately, with a stated path**: they become answerable once identity and tenancy exist, and the path is provider labels applied per deployable project and per tenant-scoped resource, aggregated into the same read model, with the allocation rule for shared and fixed costs — the load balancer being the obvious one — decided explicitly rather than spread pro rata by default. Nothing decided here blocks that; the read model's schema version is the seam.

### Freshness, source, and unknown semantics

Provider cost data is **materially delayed**, and a surface that hides the delay is worse than no surface. Every figure carries its **source and as-of time**, and the surface distinguishes the ingestion run's own time from the provider's stated data time; they are not the same instant and must not be collapsed.

A failed, delayed, or partial read renders **explicitly unknown or stale**, per `reference-assessment.md`: "A failed read must not become an invented zero or healthy state." A missing cost figure is unknown, never `$0`. A read model older than its declared freshness window is stale, never current. The surface uses the state vocabulary already accepted in `principles.md` — **healthy, degraded, stale, blocked, retrying, and unknown** — and applies it per figure rather than to the view as a whole, so a fresh deployment state and a stale spend figure are visibly different rather than averaged into one flag.

### Authorization mapping

Authorization defaults to deny, per `data-identity-observability.md`, and is evaluated on every server, job, and administrative path. The surface maps onto the distinct permissions that document already defines — **platform operations, organization administration, membership, billing/ownership, project control, resource use, debug access, experiments, and funded authority** — as follows:

- deployment, configuration, artifact version, and service-health state require **platform operations**;
- month-to-date spend, forecast spend, operating-cost-ceiling proximity, and free-tier headroom require **billing/ownership**;
- neither implies the other in either direction, and **no generic admin role grants the whole surface**.

A principal holding only platform operations sees deployment and health state with the spend region absent — not zeroed, not blanked to look empty, and not rendered as unknown, since unknown means the platform could not read it rather than that the viewer may not see it. Authorization-shaped absence and data-quality-shaped unknown are different states and are presented differently.

### Financial-meaning separation

Platform infrastructure spend is **operating cost**. It is structurally separate from simulation balances and from funded balances, ledgers, execution authority, presentation, and audit, and no view, DTO, aggregate, or metric may combine them or let one substitute for the other.

The word **budget** is the specific hazard. `principles.md` uses "budget" for *trading* budget assigned to autonomous work — a durable fenced reservation with an authorizing human, exposure and loss limits, and reconciliation state — which is a genuinely different concept from a provider spending ceiling that triggers an email. The two must remain unconfusable in code, schemas, events, metrics, and interface text. This surface uses **operating spend** and **operating cost ceiling**; where the word budget appears at all it is qualified as the operating budget, and the unqualified term stays reserved for the trading concept.

No whimsical mapping is needed. `glossary.md` states that administrative surfaces default to the canonical term, and it currently contains no accepted mappings at all — its active-mappings section records that none has been accepted. It also reserves marking a term active to the maintainer, so an agent could not introduce one here even if the surface wanted one.

### No automated cost control

The surface **reports; it does not act**. No scaling down, no capping, no disabling a service, and no billing detachment is triggered by any figure it renders, at any threshold, including the ceiling itself.

This extends an existing accepted position rather than inventing one. `infra/modules/budget-guardrail/main.tf` already records why the budget notifies rather than disables billing: "an automatic shutdown would turn a cost surprise into an outage, and the accepted design surfaces conditions rather than silently acting on them." Rendering the same condition on a screen does not change that reasoning. A cost response is a human decision with a human's context, and any future automated control needs its own separately accepted safety design with deterministic triggers, false-positive analysis, and a bounded blast radius.

### Sequencing past the first-slice jobs exclusion

This record deliberately extends past `overview.md`'s maintainer decision 11, which excluded jobs from the first slice. The maintainer accepted this scope. The exclusion is not reinterpreted as having meant something narrower, and it is not treated as void: it remains the accepted shape of the first slice, and this is the first documented departure from it.

Implementation is therefore **sequenced after the first dated remote baseline**, so the surface is built against measured spend rather than against the unresolved U1, U4, and U7 estimates in `deployment-composition.md`. Building a cost view before a bill exists would produce a screen that has never displayed a real number, and its first real number would arrive untested.

## Alternatives considered

### BigQuery billing export

Deferred, not rejected. It is the provider's own answer for cost analysis and the only source that yields per-SKU and per-label attribution, which is exactly what a per-tenant chargeback model would eventually need. It is not selected now because with two services under a `$30` ceiling the per-SKU breakdown is trivially small, and because standing up BigQuery's own storage and query billing to watch a `$30` bill cuts directly against the cost containment `ADR-0007` accepted — the instrument would be a meaningful fraction of the thing it measures. Revisit when per-tenant attribution becomes a real requirement, when the number of deployable projects makes a platform-wide total uninformative, or when measured spend is large enough that a per-SKU breakdown would change a decision.

### Serving provider APIs inline from the platform API

Rejected. It violates the accepted statelessness of the API, couples the request lifecycle to provider latency and quota, and places provider billing credentials on a path reachable from the internet. `reference-assessment.md` already rejects exactly this shape in the reference implementation, where "V1's API routes directly imported stores, providers, reconciliation, and process-local queues", because "it couples internet request lifecycle to platform work, blocks independent deployment, and lets framework adapters reach authority." Nothing about the data being cost data makes that shape safer; the credential it would need is the most sensitive one the platform holds.

### Polling the Cloud Billing API for current spend

Rejected on capability grounds rather than on architecture. The Cloud Billing budget API exposes budget *definitions* — ceilings, thresholds, filters — not current-month spend, so polling it answers "what did we say the limit was", a question the repository already answers from its own OpenTofu source. It cannot supply the month-to-date or forecast figure the surface exists to show.

### Email alerts alone, the status quo

Rejected. `infra/modules/budget-guardrail/main.tf` configures `type = "email"` as its only channel, so the budget's knowledge terminates in a human inbox. A mailbox is not a platform surface: it cannot be queried by the API, cannot be authorized against platform operations or billing/ownership permissions, carries no source and as-of contract, cannot render stale or unknown, is not visible to anyone who is not on the recipient list, and it delivers only at threshold crossings, so it says nothing at all about the 49 percent of the ceiling already spent. It is retained as a push channel for the moments that need to interrupt a person; it is not a substitute for a readable state.

### Automated cost-control actions

Rejected, per the decision above. An automatic shutdown converts a cost surprise into an outage, which is the position `budget-guardrail` already takes and this record extends rather than revisits.

### Per-tenant cost attribution now

Deferred, not rejected. There are no tenants, so any per-tenant figure would be an invented allocation of a `$30` platform-wide bill across zero subjects. The path is stated in the attribution decision above — provider labels per project and per tenant-scoped resource, an explicit allocation rule for shared and fixed cost, and a schema version bump on the read model — and it is deferred deliberately rather than omitted.

## Consequences

### Positive

- The ceiling has exactly one source of truth: the budget the infrastructure already enforces, read rather than restated.
- The API stays stateless, and no provider billing credential exists on a request path or reaches a browser.
- Spend, ceiling proximity, and headroom become platform state that can be authorized, versioned, tested, and rendered, instead of mail.
- Cost visibility arrives before the composition grows, which is when `ADR-0007`'s reversibility judgement is still cheap to exercise.
- Deployment state and spend are separated at the permission boundary from the first version, before a generic admin role exists to be over-granted.
- Operating cost is separated from simulation and funded meaning before either exists, which is the cheapest moment to establish it.
- The first `jobs/` project is created for a read-only, financially inert workload with no external effect and no tenant data.

### Negative

- The first inhabitant of `jobs/` arrives outside the accepted first-slice scope, and that exclusion had to be extended rather than met.
- Budget notifications are event-driven, so between crossings the read model's figure ages, and freshness depends on the ingestion cadence rather than on continuous truth.
- Free-tier headroom is derived and therefore materially weaker evidence than reported spend, and it will be read as equally authoritative unless the surface labels it clearly and repeatedly.
- Provider cost data is delayed at source, so a correct, fresh, fully healthy surface still shows a figure that is behind reality.
- A new reader identity and a new Pub/Sub topic widen the infrastructure surface and the IAM review area for a read-only view.
- Per-SKU attribution is unavailable, so a spend anomaly can be seen but not immediately decomposed without a separate investigation.
- Anything in this surface that is later needed as an accounting record is not one; like telemetry, it is operational state and satisfies no audit obligation.
