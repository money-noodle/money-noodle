# Architecture decision index

The maintainer accepted the first-slice decision set on 2026-08-29. These records define current intended architecture; implementation and remote validation remain separate work.

| ADR | Status | Decision |
| --- | --- | --- |
| [`ADR-0001`](ADR-0001-separate-web-and-platform-api.md) | Accepted | Separate Next.js web and interface-neutral platform API deployments |
| [`ADR-0002`](ADR-0002-openapi-and-generated-client.md) | Accepted | API-owned OpenAPI contract and generated TypeScript client |
| [`ADR-0003`](ADR-0003-first-slice-runtime-and-deployment.md) | Accepted | First status slice, framework lines, and portable deployment artifact |
| [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md) | Proposed | First remote hosting, registry, and public entry point |
| [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md) | Proposed | Delivery trust, workload identity, and secret custody |
| [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md) | Proposed | Infrastructure-as-code tool and remote state |
| [`ADR-0007`](ADR-0007-first-telemetry-backend.md) | Proposed | First telemetry backend and cost containment |

ADR-0004 through ADR-0007 are a single proposed set for work item #7 and are decided together; their shared evidence, cost model, and unresolved constraints are in [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md). They remain proposals until the maintainer settles the account, billing, region, and domain decisions recorded there, and no provider resource may be created before then.

When accepted, update the record status and date, the architecture overview, this index, the shared plan, and affected diagrams in the same change. Consequential changes supersede a record rather than silently rewriting its accepted decision.