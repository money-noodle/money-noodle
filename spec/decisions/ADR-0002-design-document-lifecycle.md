# ADR-0002 — Design-document lifecycle and discovery

> **Status:** Accepted · **Date:** 2026-08-25  
> **Decision index:** [`../decision-log.md`](../decision-log.md)  
> **Specification root:** [`../../SPEC.md`](../../SPEC.md)  
> **Design index:** [`../../docs/README.md`](../../docs/README.md)

## Context

The repository had 46 top-level design, evaluation, reference, and exploration documents totaling more than
111,000 words. Their lifecycle labels used inconsistent syntax, and `STATUS.md` had become the accidental discovery
index: it referenced 41 documents while canonical spec modules referenced 18. Two documents had no incoming
reference in the audited specification/status/design/report graph. Proposed, accepted, implemented, superseded,
retired, reference, and exploratory work could not be distinguished mechanically.

This ambiguity is unsafe for an agentic harness. A plausible but unapproved design must not be mistaken for a
requirement, and an implemented historical design must not override current code or specification text.

## Decision

Use [`docs/README.md`](../../docs/README.md) as the complete discovery and lifecycle index for every top-level
Markdown document in `docs/`.

Every indexed document carries a controlled metadata block:

- document type;
- design status;
- implementation state;
- creation date;
- canonical requirement modules, when any;
- accepted decision index, when any; and
- backlink to the design index.

Design status and implementation are independent axes. Controlled design statuses are **Accepted**,
**Proposed**, **Superseded**, **Retired**, **Reference**, and **Exploratory**. Controlled implementation states are
**Not started**, **Partial**, **Complete**, **Removed**, and **Not applicable**.

Authority remains separated:

- `SPEC.md` and `spec/*.md` own normative requirements;
- `spec/decision-log.md` and ADRs own accepted decisions and rationale;
- design documents explain proposals, mechanisms, evaluation plans, or historical reasoning;
- `STATUS.md` owns the dated current implementation projection;
- reports own dated quantitative evidence; and
- code and versioned registries own current behavior.

A proposed or exploratory document claims no accepted requirement or decision authority. Accepted, superseded,
and retired documents identify their canonical requirement modules and decision index. Moving a design through a
lifecycle state requires updating its metadata and the index in the same change.

`npm run verify:docs` enforces complete indexing, controlled metadata, authority combinations, backlinks, and
local Markdown links/anchors. CI runs it independently of application tests.

## Consequences

- Agents can discover all design work without loading `STATUS.md` history.
- Proposed architecture remains visible without appearing approved.
- Superseded and retired reasoning remains available but cannot silently authorize current behavior.
- Status archives may preserve historical links while the root status links only current work.
- Lifecycle metadata is a maintained projection and must change when implementation or approval changes.
- Physical files remain stable; lifecycle changes do not move files and therefore do not churn inbound links.

## Alternatives considered

### Continue using `STATUS.md` as the design index

Rejected because current implementation state and design discovery have different retention and authority rules.
Archiving status history would make many designs hard to find.

### Organize files into proposed, implemented, and retired directories

Rejected because lifecycle changes would repeatedly move files and break or churn references across specs,
reports, decisions, and code comments.

### Treat every design as normative once approved

Rejected because implementation detail and rationale must not become a second specification that can conflict with
the canonical domain requirement.
