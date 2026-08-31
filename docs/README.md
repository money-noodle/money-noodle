# Money Noodle documentation

`AGENTS.md` is the agent entry point. The root [`README.md`](../README.md) is the concise public project entry; [`SECURITY.md`](../SECURITY.md) owns private vulnerability and accidental-disclosure reporting, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) owns public contribution expectations. This index routes detailed authority and prevents any entry point from becoming an encyclopedia.

## Current map

| Area | Authority |
| --- | --- |
| Current repository, host-control, validation, and deployment truth | [`current-status.md`](current-status.md) |
| Product experience and capability boundaries | [`product/experience.md`](product/experience.md) |
| Product vocabulary mappings | [`product/glossary.md`](product/glossary.md) |
| Architecture and runtime standards | [`architecture/principles.md`](architecture/principles.md) |
| First web/API architecture, diagrams, and source/deployment map | [`architecture/overview.md`](architecture/overview.md) |
| Architecture decision index and lifecycle | [`architecture/decisions/README.md`](architecture/decisions/README.md) |
| Agent coordination and isolation protocol | [`architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md`](architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md) |
| Running decision log | [`architecture/decisions/log.md`](architecture/decisions/log.md) |
| Data, telemetry, audit, identity, and authorization | [`architecture/data-identity-observability.md`](architecture/data-identity-observability.md) |
| Engineering and testing | [`engineering/standards.md`](engineering/standards.md) |
| Delivery and operations | [`operations/delivery.md`](operations/delivery.md) |
| Accepted first remote deployment composition and dated comparison evidence | [`operations/deployment-composition.md`](operations/deployment-composition.md) |
| Version control and cutover | [`development/version-control.md`](development/version-control.md) |
| Parallel planning, work claims, stale detection, and handoff | [`development/parallel-work.md`](development/parallel-work.md) |

## Dated evidence

| Record | Role |
| --- | --- |
| [`architecture/reference-assessment.md`](architecture/reference-assessment.md) | Dated v1 and Portfolio Copilot reference evidence and independent reuse rationale |
| [`research/README.md`](research/README.md) | Reusable convention for dated, non-authoritative research assessments |
| [`research/2026-08-30-typescript-unity-viability.md`](research/2026-08-30-typescript-unity-viability.md) | Dated TypeScript-with-Unity viability evidence; not a technology decision |

Add accepted specifications, an experiment index, and a validation index here as they are created.

## Document roles

- **Architecture overview:** current system context, boundaries, visual views, deployment, and source map.
- **Living design document:** present-tense current intent for one area, rewritten in place. Git holds the history. Most architecture lives here.
- **Decision log:** one line per choice — date, what was chosen, why, and where it is discussed. The default home for a decision.
- **Decision record:** a decision that earned a document of its own under the promotion rule below.
- **Specification:** bounded normative behavior and acceptance criteria.
- **Current status:** concise implemented/deployed truth and known gaps, not a diary.
- **Experiment:** hypothesis, assignment, metrics, guardrails, stop criteria, and result.
- **Research assessment:** dated question, source snapshots, facts, inference, uncertainty, and conclusion; evidence only, never requirement, status, validation, decision, or acceptance authority.
- **Validation report:** dated method, evidence, limitations, and conclusion.

## Where a decision goes

Write decisions at the weight the decision earns. Ceremony that outruns the substance makes reversal expensive without making the choice better, and an early-stage platform reverses often.

Default to the decision log. Promote a choice to its own record only when at least one is true:

- reversing it later costs materially more than deciding it now — it moves data, credentials, money, or a provider relationship;
- a real alternative was seriously considered, so the reasoning is worth more than the conclusion;
- it constrains money handling, authorization, tenant isolation, or audit.

Everything else stays one line in the log, or becomes a paragraph in the living design document it affects. A choice that is cheap to reverse does not need a record to reverse it.

## Decision lifecycle

The architecture [`decision index`](architecture/decisions/README.md#lifecycle) owns decision statuses, in-place editing rules, evidence requirements, and promotion to Settled. Dated evidence is never rewritten to match a later decision; it records what was known on its date.

## Placement rules

Keep `AGENTS.md` as a concise current routing and safety guide. Put detailed requirements and rationale here under one clear owner. Avoid duplicate rules: summaries link to authority. Use nested `AGENTS.md` only when a substantial subtree needs stable local instructions.

Agent skills may encode repeatable operational procedures after the workflow is stable. They are not hidden specification stores: a skill must cite current docs, expose inputs and side effects, fail safely, and be tested when executable. Repository automation belongs in `tools/`; generated outputs never replace editable source.
