# Decision history

> **Status:** Normative index and current ledger · **Parent:** [`SPEC.md`](../SPEC.md) · **Updated:** 2026-08-26
> **Canonical for:** accepted decision history, archive routing, and architecture decision records.
>
> Current decisions are appended here newest first. Historical entries move to immutable range archives without
> rewriting their text. Detailed requirements remain canonical in their domain modules; a decision record explains
> why, but does not silently override those requirements.

## 14. Decision log

### Recording policy

- Record every accepted requirement or architecture change in the current ledger.
- Use one row per decision with its rationale, evidence links, and explicit non-changes where safety depends on them.
- Supersede an earlier decision with a new row; never edit history to make the old decision appear different.
- Create an ADR for a load-bearing, cross-domain decision that future agents need to understand independently.
- Keep implementation status and current measurements in [`../STATUS.md`](../STATUS.md).
- If an ADR, historical row, and canonical requirement disagree, stop and resolve the specification conflict.

### Current decisions

| Date | Decision |
|---|---|
| 2026-08-26 | Verify the always-loaded agent guidance and require module-qualified citation. `npm run verify:agents` governs `AGENTS.md`, `README.md`, and `reports/README.md` in CI: cited paths must resolve, an identifier cited beside a module path must be bound by that module, `AGENTS.md` stays under 3,000 words, links and anchors resolve, and every report is indexed exactly once and link-checked. This caught a `§0` pointer to `lib/target-exit-policy.ts`, deleted with the long-shot retirement. All four verifiers now reject absolute-path links, which resolved on the authoring machine and failed only in CI. `SPEC.md` becomes canonical for document authority with `AGENTS.md` holding an always-loaded restatement that loses on divergence; `README.md` is ranked as human orientation only and its duplicated implementation claims were removed in favor of `STATUS.md`. Open decisions gain permanent `OD-<n>` identifiers. Agents must watch CI to completion after a push (`gh run watch`) and report the outcome, because absolute paths, case-sensitive filenames, and other Linux-runner differences cannot reproduce on a macOS worktree. Documentation organization and verification only: no product, policy, capital, execution, reconciliation, deployment, or funded authority changed. See ADR-0004. |
| 2026-08-26 | Use one read-only order-attribution vocabulary across signed open-order, decision-history, and performance surfaces: track, provider, provider variant, market, forecast model, buy policy, and execution policy. Provider and market may use their canonical historical normalization; missing variants and policy identities remain explicitly `unattributed`. Filters select presentation cohorts only, preserve separate live/paper denominators, do not rewrite history, and gain no forecast, ranking, execution, budget, reconciliation, capability, or promotion authority. See [`docs/provider-policy-attribution-visibility-design.md`](../docs/provider-policy-attribution-visibility-design.md). |
| 2026-08-26 | Keep `AGENTS.md` as one compact always-loaded operating guide rather than another module tree. Preserve the generated Next.js block, stable §§0–10 and §5 item numbering used by historical citations, and inline money, storage, evidence, mirror, strategy-isolation, and funded-safety invariants. Organize authority, change routing, and registry capability boundaries for scanning; keep the file below 3,000 words by consolidating repetition, never by deleting a funded invariant. `AGENTS.md` operationalizes repository workflow but cannot override canonical requirements, code, registries, or authenticated runtime state. This is documentation organization only and changes no product, policy, capital, execution, reconciliation, deployment, or funded authority. |
| 2026-08-26 | Separate current implementation status, planning, and history. Keep `STATUS.md` as a compact dated projection; move non-normative sequencing to `status/roadmap.md`; index reading and maintenance rules in `status/README.md`; and preserve superseded status in bounded immutable archives. The three initial fragments reproduce the former 2,905-line status byte for byte. `npm run verify:status` and CI enforce current/roadmap size limits, archive hashes and completeness, discovery, and local links. Status and roadmap text grant no product, policy, capital, execution, reconciliation, deployment, or funded authority. See ADR-0003. |
| 2026-08-25 | Establish a controlled lifecycle and complete discovery index for all top-level design documents. `docs/README.md` indexes every design, evaluation plan, reference, and exploration exactly once; each document records type, design status, implementation state, creation date, canonical requirement modules, decision authority, and an index backlink. Proposed and exploratory work claims no accepted authority; accepted, superseded, and retired work links the canonical spec and decision index. Lifecycle changes do not move files. `npm run verify:docs` and CI enforce metadata, authority combinations, indexing, and local links. This changes documentation structure only and grants no product, policy, capital, execution, reconciliation, or funded authority. See ADR-0002. |
| 2026-08-25 | Modularize the living product specification using a hub-and-spoke structure. Keep `SPEC.md` as the stable entry point for the product statement, global principles, authority, routing map, and compatibility pointers; make the indexed `spec/*.md` modules canonical for detailed domain requirements, open decisions, and decision history. Agents read the root first and every relevant canonical module completely; conflicting canonical text is a specification defect to resolve, not permission to choose silently. The initial extraction preserved the former sections without changing product, policy, capital, execution, reconciliation, or funded authority. Future behavioral changes update the owning module and this decision log; `STATUS.md` remains implementation and measurement state. |

### Architecture decision records

| ADR | Status | Decision |
| --- | --- | --- |
| [`ADR-0001`](decisions/ADR-0001-modular-specification.md) | Accepted | Use a hub-and-spoke specification with `SPEC.md` as the stable router and canonical domain modules beneath `spec/`. |
| [`ADR-0002`](decisions/ADR-0002-design-document-lifecycle.md) | Accepted | Index every design document with controlled lifecycle and implementation metadata while keeping requirements, status, evidence, and code authority separate. |
| [`ADR-0003`](decisions/ADR-0003-current-status-projection-and-immutable-archives.md) | Accepted | Keep root status current and compact, separate roadmap sequencing, and preserve historical status in verified immutable archives. |
| [`ADR-0004`](decisions/ADR-0004-verified-agent-guidance-and-citation.md) | Accepted | Verify the always-loaded agent guidance against the code it cites, rank `README.md`, and require module-qualified section citation. |

### Immutable archives

| Date range | Entries | Notes |
| --- | ---: | --- |
| [`2026-08-24` through `2026-08-26`](decisions/2026-08-24-to-26.md) | 14 | Evaluator sequence, execution/paper fidelity, storage/runtime integrity, and strategy retirement |
| [`2026-08-19` through `2026-08-23`](decisions/2026-08-19-to-23.md) | 32 | Entry execution, reconciliation, evidence instrumentation, provider-market expansion, and storage repair |
| [`2026-08-14` through `2026-08-18`](decisions/2026-08-14-to-18.md) | 35 | Mirror/evaluation doctrine, paper fills, exits, model replay, and the historical long-shot workstream |
| [`2026-08-08` through `2026-08-13`](decisions/2026-08-08-to-13.md) | 76 | Product foundation, forecast evolution, funded controls, provider keying, and security decisions |

Archive counts include 157 preserved historical decisions. The current ledger contains decisions accepted after
the archive extraction.
