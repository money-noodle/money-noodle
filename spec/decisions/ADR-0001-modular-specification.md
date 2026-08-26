# ADR-0001 — Modular specification architecture

> **Status:** Accepted · **Date:** 2026-08-25  
> **Decision index:** [`../decision-log.md`](../decision-log.md)  
> **Specification root:** [`../../SPEC.md`](../../SPEC.md)

## Context

The former `SPEC.md` was 30,266 words and 223 KB. It mixed the product statement, detailed domain
requirements, delivery state, open decisions, and 158 historical decisions in one file. Agents had to load a
large unrelated context to find one canonical requirement, while splitting carelessly would risk duplicated or
conflicting authority in a system that can move real money.

## Decision

Use a hub-and-spoke specification with progressive disclosure:

- `SPEC.md` is the stable entry point for the product statement, global principles, authority model, canonical
  module map, and compatibility pointers.
- `spec/*.md` domain modules are canonical for detailed requirements.
- Every requirement has one canonical home; other documents link rather than copy it.
- Agents read `SPEC.md` first and every relevant canonical module completely.
- Apparent conflicts are specification defects to resolve, not permission to select a convenient rule.
- `STATUS.md` remains current implementation and measurement state.
- Accepted decisions are indexed in `spec/decision-log.md`; immutable history may be archived by bounded date
  range, while load-bearing cross-domain decisions receive ADRs.
- Existing numbered `SPEC.md §N` references remain routable through compatibility pointers while citations move
  to canonical module paths.

## Consequences

- The always-read root is small, while domain requirements can be loaded selectively.
- Domain ownership and “read when” routing become explicit.
- Link and archive integrity need automated verification.
- Moving text must be separated from behavioral rewriting and verified for complete preservation.
- The decision index and archives are routing/history, not alternate requirement authorities.

## Alternatives considered

### Keep one monolithic specification

Rejected because unrelated detail and decision history consume context and make canonical requirements harder to
discover.

### Create many feature-level microdocuments

Rejected because excessive fragmentation increases discovery failures and cross-document drift. Modules instead
follow coherent product domains.

### Move the root specification into the folder

Rejected because `SPEC.md` is already a stable repository entry point cited by agents, designs, reports, and code.
Keeping it at the root preserves discovery and compatibility.
