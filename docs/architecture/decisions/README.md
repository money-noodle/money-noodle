# Architecture decision index

The maintainer accepted the first-slice decision set on 2026-08-29. These records define current intended architecture; implementation and remote validation remain separate work.

| ADR | Status | Decision |
| --- | --- | --- |
| [`ADR-0001`](ADR-0001-separate-web-and-platform-api.md) | Accepted | Separate Next.js web and interface-neutral platform API deployments |
| [`ADR-0002`](ADR-0002-openapi-and-generated-client.md) | Accepted | API-owned OpenAPI contract and generated TypeScript client |
| [`ADR-0003`](ADR-0003-first-slice-runtime-and-deployment.md) | Accepted | First status slice, framework lines, and portable deployment artifact |
| [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md) | Accepted | Google Cloud Run, Artifact Registry, interim provider URLs, and target public entry point |
| [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md) | Accepted | Federated delivery trust, separate workload identities, artifact trust, and managed secret custody |
| [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md) | Accepted | OpenTofu with separate stacks and lock-protected versioned GCS state |
| [`ADR-0007`](ADR-0007-first-telemetry-backend.md) | Accepted | OpenTelemetry to the hosting provider backend with explicit cost and Pre-GA controls |

ADR-0004 through ADR-0007 were accepted together on 2026-08-29 after the maintainer settled composition, ownership, budget, region, domain, public API, interim URL, repository-plan, and telemetry risk choices. Their shared dated evidence, estimates, unresolved provider facts, and recorded inputs are in [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md). Acceptance authorizes implementation through reviewed code and pipeline changes; it does not itself create or deploy a provider resource.

Consequential changes supersede a record rather than silently rewriting its accepted decision.