# ADR-0005 — Agent context and requirement traceability

> **Status:** Accepted · **Date:** 2026-08-26
> **Decision index:** [`../decision-log.md`](../decision-log.md)
> **Specification root:** [`../../SPEC.md`](../../SPEC.md)
> **Design index:** [`../../docs/README.md`](../../docs/README.md)

## Context

The 2026-08-25/26 documentation split established clear authority, bounded the always-read documents, and made
specification, design, status, roadmap, and history independently verifiable. A follow-up agent-harness review found
five remaining sources of avoidable ambiguity:

1. canonical requirement modules still mixed durable rules with dated implementation state, measurements, and
   delivery history;
2. inherited section numbers are not unique across modules, while most requirements and ordinary decisions lack
   stable identifiers;
3. the design index is complete by lifecycle but expensive to traverse by domain or active workstream;
4. the verifiers establish graph integrity but do not compare repeated authority claims or selected status identities
   with their versioned source; and
5. several funded requirements are compound paragraphs containing many independently testable rules.

The existing `AGENTS.md` is not the problem. Its funded invariants, workflow, and source map are intentionally
always loaded and should not be minimized. The improvement belongs in the routed documents and their verification.

## Decision

### Keep canonical modules normative

Canonical `spec/*.md` domain modules state durable required behavior. Dated implementation progress belongs in
`STATUS.md`; pending sequence belongs in `status/roadmap.md`; measurements belong in dated reports; implementation
mechanics and rationale belong in indexed designs and decisions. A requirement may cite those records without
copying their changing state or results.

`spec/delivery-and-acceptance.md` defines required delivery boundaries and acceptance criteria, not a second
implementation checklist. Design metadata's implementation field describes the implementation state of that
particular design and remains subordinate to `STATUS.md` for the whole-system projection.

### Give requirements stable identifiers

Every independently cited canonical requirement block receives a unique lowercase HTML anchor of the form
`req-<domain>-<name>`. The visible legacy section numbers and their existing anchors remain unchanged. Requirement
identifiers are permanent, are never reused, and remain as compatibility aliases if wording later moves. New or
materially split requirements receive new identifiers rather than changing the meaning of an old one.

### Give ordinary decisions stable identifiers without rewriting archives

Every accepted decision receives a `DEC-YYYYMMDD-NN` identifier. Current and future ledger rows publish the ID in
the row. Immutable archive text is not edited; `spec/decisions/decision-id-map.json` binds each archived row's ID to
its source file, date, ordinal, normalized row digest, and short discovery summary. Verification rejects missing,
duplicate, changed, or orphaned bindings. An archived decision is cited by ID plus its archive path.

### Add domain and workstream discovery

`docs/README.md` retains lifecycle as its complete primary index and adds a concise domain/workstream view for
context selection. The secondary view does not grant authority and does not move files. It emphasizes accepted work
that is partial or not started, then routes completed, superseded, retired, reference, proposed, and exploratory
material through the lifecycle index.

Accepted design metadata cites an exact decision ID when one is available from an immutable or current decision
row. Legacy designs whose approval is represented by several historical rows may cite the earliest load-bearing ID
and list later amendments in their body. Proposed, exploratory, and reference documents continue to claim no
accepted decision authority.

### Strengthen semantic verification

The documentation gates additionally verify:

- requirement-ID syntax and uniqueness;
- complete, digest-pinned ordinary-decision IDs;
- exact decision IDs cited by accepted/superseded/retired design metadata;
- agreement between the canonical `SPEC.md` authority table and its compressed `AGENTS.md` restatement; and
- selected machine-readable active identities in `STATUS.md` against their owning source constants.

These checks remain read-only and import no funded runtime state. They cannot prove prose semantics; they guard the
small repeated facts whose drift can be detected mechanically.

### Prefer atomic requirement blocks

A requirement block should express one independently reviewable invariant or one tightly coupled rule family.
Compound funded bullets are split into named subheadings or short bullets without changing behavior. Arithmetic,
failure behavior, authority, and evidence boundaries remain explicit rather than being compressed to save words.

## Consequences

- Agents can cite requirements and decisions without relying on ambiguous section numbers or source lines.
- Current implementation and measurements stop competing with canonical requirement text.
- Design relevance is easier to determine without adding another always-loaded guide or moving stable files.
- Immutable decision archives remain byte-preserved while gaining stable external handles.
- Documentation CI catches selected authority and identity drift, not only missing files and links.
- Canonical modules become easier to review and test, but the initial extraction requires careful confirmation that
  removing history does not remove a funded invariant.
- `AGENTS.md` keeps its present safety content and stable historical numbering.

## Alternatives considered

### Add more workflow prose to `AGENTS.md`

Rejected. The guide is already effective and intentionally dense. Domain routing and traceability belong in the
indexes and canonical modules, where they can grow without consuming every agent session.

### Renumber the specification

Rejected for the same reason as ADR-0004: immutable history depends on the inherited numbering. Stable requirement
IDs are additive aliases.

### Edit archived decisions to insert IDs

Rejected because it would violate the immutable-history contract. A digest-pinned sidecar supplies stable identity
without changing historical text.

### Generate current status entirely from code

Rejected. Some status claims are bounded human projections and measurements rather than constants. Verification is
limited to exact identities with clear source ownership; operational state still comes only from authenticated
controls.
