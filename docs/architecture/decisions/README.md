# Architecture decision index

Most decisions do not belong here. [`../../README.md`](../../README.md) owns the promotion rule: default to the running log in [`log.md`](log.md), and give a choice its own record only when reversing it is expensive, a real alternative was seriously weighed, or it constrains money, authorization, tenant isolation, or audit. A choice that is cheap to reverse does not need a record to reverse it.

## Lifecycle

| Status | Meaning | May it be edited in place? |
| --- | --- | --- |
| Proposed | Drafted for acceptance. Not authority; committing does not accept it. | Yes |
| Working | Decided enough to build on. Not yet proven. | **Yes — this is the intended way to correct it** |
| Settled | Working in production with dated evidence, and depended upon. | No — supersede with a new record |
| Superseded / Retired | Replaced or withdrawn. Kept for history, out of current authority. | No |

A record stays **Working** until something real depends on it and evidence exists that it holds. Correcting a Working record by editing it is the normal path, not a process failure. Only **Settled** records get the supersede-rather-than-rewrite treatment, because only they have readers who relied on them.

### Promotion to Settled

Settling a record removes the ability to correct it by editing, so promotion is the maintainer's decision alone and is never a side effect of other work.

- **Only the maintainer marks a record Settled.** No agent may do so, and no change may promote a record as part of a larger edit.
- **One record at a time, reviewed as questions and answers.** Never a batch, never a list approved in one pass. The agent states what the record claims, what dated evidence exists, what would falsify it, and what already depends on it; the maintainer asks and decides.
- **An agent proposes Settled only when the decision is completely obvious and already working in production.** Not implemented, not merged, not passing CI, not applied — working, remotely, with dated evidence. Short of that, the record stays Working and the agent does not raise it.
- **At session start, review the lifecycle rather than the records.** Report which records are Working and whether any has become obviously production-proven. That review is a status report, not a promotion queue.

Nothing is Settled while the platform has no production deployment. Repository and CI evidence can describe what a Working record has achieved; it cannot promote one.

"Working in production" means running remotely and observed, with dated evidence naming its as-of time, sample, exclusions, and largest validity threat. Implemented, merged, green in CI, and applied are all short of it. Repository and CI checks describe how far a Working record has been exercised; they never promote one, and describing CI as deployment validation is prohibited.

## Record format

Keep records short. A record earns permanence by being read later, and long records are read less.

Required: a metadata blockquote (`Status`, date, `Owners`, related documents, `Depends on`, `Supersedes` where applicable), then `## Context`, `## Decision`, `## Alternatives considered`, and `## Consequences`.

`## Validation` and `## Revisit when` belong to **Settled** records and are written from what building actually taught. On a Proposed or Working record they are speculation about a future that has not arrived, and they are omitted.

State alternatives with a verdict word and the reasoning that would change your mind. Record the negative consequences you are accepting; a record with only positive consequences is advocacy, not a decision.

## Records

| ADR | Status | Evidence | Decision |
| --- | --- | --- | --- |
| [`ADR-0001`](ADR-0001-separate-web-and-platform-api.md) | Working | Repository checks; not deployment | Separate Next.js web and interface-neutral platform API deployments |
| [`ADR-0002`](ADR-0002-openapi-and-generated-client.md) | Working | Repository checks; not deployment | API-owned OpenAPI contract and generated TypeScript client |
| [`ADR-0003`](ADR-0003-first-slice-runtime-and-deployment.md) | Working | Repository checks; not deployment | First status slice, framework lines, and portable deployment artifact |
| [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md) | Working | None — never applied | Google Cloud Run, Artifact Registry, interim provider URLs, and target public entry point |
| [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md) | Working | None — never applied | Federated delivery trust, separate workload identities, artifact trust, and managed secret custody |
| [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md) | Working | None — never applied | OpenTofu with separate stacks and lock-protected versioned GCS state |
| [`ADR-0007`](ADR-0007-first-telemetry-backend.md) | Working | None — never applied | OpenTelemetry to the hosting provider backend with explicit cost and Pre-GA controls |
| [`ADR-0008`](ADR-0008-single-object-store.md) | Proposed | None — not accepted | Google Cloud Storage as the platform's single object store, superseding the Scaleway direction |
| [`ADR-0009`](ADR-0009-administrative-observability-surface.md) | Proposed | None — not accepted | Administrative infrastructure, deployment, and cost observability through an isolated ingestion job and a read model |

The Evidence column is the point of this table. Every record is Working, because the platform has no production deployment and nothing here has been proven by running. Marking them Accepted said nothing; marking them Working with their real evidence says the useful thing — ADR-0001 through ADR-0003 are exercised by repository checks, and ADR-0004 through ADR-0007 have never been applied to a provider at all.

ADR-0008 and ADR-0009 were proposed together on 2026-08-30 under GitHub work item #18. ADR-0008 supersedes the Scaleway object-storage direction in [`../data-identity-observability.md`](../data-identity-observability.md); ADR-0009 depends on it and decides the administrative observability surface that work item #19 would implement. Neither is authority until accepted, and acceptance would make consequent updates due in [`../overview.md`](../overview.md) and [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md).

That distinction is worth reading before relying on any of them. Repository checks show that source structure, contract ownership, and generated artifacts behave as decided. They show nothing about deployment, provider behaviour, or cost.

ADR-0004 through ADR-0007 were accepted together on 2026-08-29 after the maintainer settled composition, ownership, budget, region, domain, public API, interim URL, repository-plan, and telemetry risk choices. Their shared dated evidence, estimates, unresolved provider facts, and recorded inputs are in [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md). Acceptance authorizes implementation through reviewed code and pipeline changes; it does not itself create or deploy a provider resource.
