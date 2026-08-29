# Money Noodle documentation

`AGENTS.md` is the repository entry point. This index owns documentation placement and prevents the root guide from becoming an encyclopedia.

## Current map

| Area | Authority |
| --- | --- |
| Product experience and capability boundaries | [`product/experience.md`](product/experience.md) |
| Product vocabulary mappings | [`product/glossary.md`](product/glossary.md) |
| Architecture and runtime standards | [`architecture/principles.md`](architecture/principles.md) |
| First web/API architecture, diagrams, and source/deployment map | [`architecture/overview.md`](architecture/overview.md) |
| Architecture decision index | [`architecture/decisions/README.md`](architecture/decisions/README.md) |
| Data, telemetry, audit, identity, and authorization | [`architecture/data-identity-observability.md`](architecture/data-identity-observability.md) |
| Engineering and testing | [`engineering/standards.md`](engineering/standards.md) |
| Delivery and operations | [`operations/delivery.md`](operations/delivery.md) |
| Version control and cutover | [`development/version-control.md`](development/version-control.md) |
| Parallel planning, work claims, stale detection, and handoff | [`development/parallel-work.md`](development/parallel-work.md) |

## Dated evidence

| Record | Role |
| --- | --- |
| [`architecture/reference-assessment.md`](architecture/reference-assessment.md) | Dated v1 and Portfolio Copilot reference evidence and independent reuse rationale |

Add accepted specifications, current status, experiment index, and validation index here as they are created.

## Document roles

- **Architecture overview:** current system context, boundaries, visual views, deployment, and source map.
- **ADR:** a durable cross-cutting decision with context, alternatives, consequences, status, and validation.
- **Specification:** bounded normative behavior and acceptance criteria.
- **Current status:** concise implemented/deployed truth and known gaps, not a diary.
- **Experiment:** hypothesis, assignment, metrics, guardrails, stop criteria, and result.
- **Validation report:** dated method, evidence, limitations, and conclusion.

Every governed document must make its status clear: proposed, accepted, superseded, retired, or dated evidence. Only accepted current records define intended behavior. Supersede rather than silently rewriting consequential historical decisions; keep current indexes free of obsolete authority.

## Placement rules

Keep `AGENTS.md` as a concise current routing and safety guide. Put detailed requirements and rationale here under one clear owner. Avoid duplicate rules: summaries link to authority. Use nested `AGENTS.md` only when a substantial subtree needs stable local instructions.

Agent skills may encode repeatable operational procedures after the workflow is stable. They are not hidden specification stores: a skill must cite current docs, expose inputs and side effects, fail safely, and be tested when executable. Repository automation belongs in `tools/`; generated outputs never replace editable source.
