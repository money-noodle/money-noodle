# ADR-0006 — Deterministic agent preflight and critical requirement traceability

> **Status:** Accepted · **Date:** 2026-08-26
> **Decision index:** [`../decision-log.md`](../decision-log.md)
> **Specification root:** [`../../SPEC.md`](../../SPEC.md)
> **Agent guide:** [`../../AGENTS.md`](../../AGENTS.md)

## Context

The modular specification, design lifecycle, compact status projection, and verified `AGENTS.md` established clear
source authority and bounded ordinary context. Agents still had to infer which domains, designs, source entry points,
invariant tests, and records were relevant to a task. Stable requirement IDs also lacked a direct navigation map to
the code and tests carrying the most load-bearing funded and storage invariants.

Current design metadata prevented silent lifecycle promotion, but superseded, retired, proposed, and exploratory
bodies could still open with confident historical prose. Design verification checked links but not current-design
source paths or legacy `SPEC §N` citation forms. `STATUS.md` named a projection date without a machine-readable
fingerprint for the source files owning its active identities.

## Decision

Add a deterministic, read-only agent preflight:

- `npm run agent:context -- <path...> --task "description"` selects task routes from
  `scripts/agent-context-manifest.json`;
- output classifies funded and durable-state impact and lists required canonical modules, relevant designs, source
  entry points, invariant tests, records, validation, and prohibited boundary crossings;
- the output is advisory and never replaces complete reading, source verification, canonical requirements, code,
  registries, or authenticated runtime controls; and
- `npm run verify:agents` runs the manifest's self-check so every routed file and requirement ID resolves.

Add `spec/traceability.json` as a bounded navigation manifest for critical requirements. Each entry binds one stable
requirement ID to its canonical module, source modules, focused/invariant tests, and an explicit navigation-coverage
state. Coverage labels describe the mapping, not proof that tests exhaust the prose requirement. A partial mapping
records its gap instead of claiming complete proof. `npm run verify:spec` checks IDs, ownership,
paths, test naming, and gap declarations. The manifest is not requirement or implementation authority.

Strengthen design lifecycle comprehension:

- every Proposed, Superseded, Retired, or Exploratory document carries a controlled `Current use` metadata field;
- current Accepted, Proposed, and Reference design source paths are checked when written as backticked repository
  paths;
- current design prose cannot use the ambiguous legacy `SPEC §N` form; it names the canonical module instead; and
- historical design bodies remain preserved, with current-use metadata controlling how an agent may use them.

Add a projection-critical source fingerprint to `STATUS.md`. `verify:status` derives it from the source and registry
files owning the active identity projection, so drift forces an explicit projection review. It remains a bounded
fingerprint, not proof that all status prose is current and never evidence of funded operational state.

Keep `AGENTS.md` within its existing limit by adding only a compact preflight instruction. Clarify that open decisions
are a canonical non-authorizing index and define same-day decision ordering as descending permanent ID sequence.

## Consequences

- Agents receive a repeatable impact/read/test checklist before editing without loading another broad prose guide.
- Critical requirement IDs become practical source/test navigation handles while uncovered test boundaries remain
  visible.
- Non-current designs are harder to mistake for implementation authority, and stale current-design pointers fail CI.
- Selected status/source drift becomes mechanically visible.
- Route and traceability manifests require maintenance as source ownership changes; verification catches missing
  paths but cannot prove semantic completeness or decide whether an agent selected every relevant route.
- No product, policy, forecast, capital, execution, reconciliation, deployment, or funded authority changes.

## Alternatives considered

### Add more prose to `AGENTS.md`

Rejected because the always-loaded guide is intentionally dense and near its size budget. Deterministic task output
can be detailed without taxing every session.

### Generate requirements or status entirely from source

Rejected because requirements and bounded implementation judgments are human-owned. Only navigation bindings and
selected exact source provenance are machine-derived.

### Require traceability for every requirement immediately

Rejected because shallow universal mappings would overstate coverage. The first manifest covers load-bearing agent
navigation and records partial coverage honestly; later entries can be added when their ownership is clear.

### Rewrite historical design bodies

Rejected because historical wording explains prior decisions. Controlled current-use metadata and lifecycle-aware
verification prevent that wording from becoming current authority without erasing it.
