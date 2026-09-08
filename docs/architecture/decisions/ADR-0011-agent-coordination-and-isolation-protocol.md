# ADR-0011: Agent coordination and isolation protocol

> **Status:** Working
> **Date decided:** 2026-08-30
> **Owners:** Maintainer / platform foundation
> **Related documents:** [`../../development/parallel-work.md`](../../development/parallel-work.md), [`../../../AGENTS.md`](../../../AGENTS.md), [`../../development/version-control.md`](../../development/version-control.md)
> **Depends on:** none

## Context

Concurrent agents need a public, cross-harness record of work ownership and dependencies without making local sessions, worktrees, or transcripts authoritative. The protocol must settle the initial claim race, keep work isolated, make plans and blockers visible, and preserve the separation between implementation, integration, provider effects, and production approval.

The earlier Working draft added gates, schema versions, evidence headers, reconciliation, and recovery machinery that exceeded the value of the coordination record. This Working decision is rewritten in place under the decision lifecycle rather than preserving contradictory historical rules.

## Decision

GitHub Issues are the shared registry, and remote Git references provide the claim primitive. A claim is created only at `refs/heads/claim-v1/issue-<N>`; existing refs in that namespace remain current reservations where applicable and are never renamed or bulk-migrated. The creator is the claimant only after confirmed ref creation. A failed or ambiguous response does not establish ownership; issue bookkeeping remains a separate, non-atomic host update and partial results are preserved for explicit resolution.

Work items declare scope and issue dependencies. The status tool is read-only and shows plans, lifecycle states including review and blocked work, current reservations, dependency problems, and advisory overlap. Incomplete or contradictory evidence remains unknown or warned, not ready. Scope overlap informs a planner's partitioning or ordering decision; Git can identify textual conflicts but cannot establish semantic safety.

Planners share a parent plan and serialize edits to the same plan section. They may make only small, isolated in-scope edits on a dedicated topic branch and worktree; substantial or parallel work is delegated. Workers use their own claimed branch and worktree. Checkpoints are short and state the state, commit, next action, and blockers.

Focused local validation occurs during work, with combined validation before handoff when available. Required hosted checks remain exact-current-head requirements. Deployment verification is performed only for applicable, configured deployed components and is always labeled separately from local or CI validation.

Claim ownership provides no integration, merge, provider, deployment, cleanup, or exception authority. Pull requests remain the integration route. The integration checkout is not an implementation worktree; corrections return to the execution branch.

The sole-maintainer integration exception and every security, provider, tenant, audit, funded-authority, and production-approval control remain governed by [`version-control.md`](../../development/version-control.md#temporary-sole-maintainer-integration-exception). This ADR does not duplicate or weaken those conditions.

## Alternatives considered

### Keep the former gate and reconciliation framework

**Rejected.** It made ordinary coordination difficult to operate and did not change the need to stop on an ambiguous external mutation.

### Treat declared scope or Git mergeability as safety proof

**Rejected.** Scope is a useful coordination signal and Git detects textual conflicts, but neither proves semantic correctness.

### Rename existing claim refs during simplification

**Rejected.** A namespace change would split the claim mutex while live `claim-v1` reservations remain.

### Delegate integration or production authority to claim holders

**Rejected.** A claim is implementation coordination, not human approval, integration authority, or provider authority.

## Consequences

### Positive

- Initial ownership has one deterministic, atomic remote-reference boundary.
- Existing reservations remain discoverable across harnesses.
- Planners receive a small shared board and dependency graph without treating warnings as false certainty.
- Validation and deployment evidence remain proportional and accurately labeled.

### Negative

- Ref creation and issue updates can still leave partial states requiring a maintainer decision.
- Advisory scope overlap and short checkpoints require planner judgment and review.
- Retained refs and worktrees are preserved rather than automatically cleaned up.
