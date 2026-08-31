# ADR-0011: Agent coordination and isolation protocol

> **Status:** Working
> **Date decided:** 2026-08-30
> **Owners:** Maintainer / platform foundation
> **Related documents:** [`../../development/parallel-work.md`](../../development/parallel-work.md), [`../../../AGENTS.md`](../../../AGENTS.md)
> **Depends on:** none

## Context

Money Noodle coordinates concurrent work through a public, cross-harness registry while keeping repository changes isolated in claimed branches and worktrees. The protocol must expose ownership and liveness, settle claim races, preserve reviewable evidence, prevent scope collisions, and keep integration and production authority separate from execution authority. A local harness transcript, worktree, or private note cannot provide that shared authority.

A review on 2026-08-30 found failure modes that the current process could not safely classify. Review work could be overdue without appearing stale, could have no deadline, and could retain a registered branch and worktree after both disappeared. Open work used inconsistent or missing dependency fields. Validation claims referred only to local branches and self-reported checks, while checkpoint formats varied. Missing, unclaimed, empty, and none-like values collapsed together, preventing a reader from distinguishing a valid empty value from a malformed record.

The same review observed a claimed branch advancing between reads, a local integration branch diverging without detection, absolute local paths published in the registry without locality reconciliation, and overlapping hotspots discoverable only by manually reading an issue body. Most importantly, the coordination session that settled the first seven decisions held no claim, so its decisions initially existed only in private session output. These observations explain the protocol below; they are historical evidence, not assertions about current registry state.

In this record, a **principal** is a person holding authority, an **agent** is an AI session executing bounded work, and a **workload identity** is a machine credential something runs as. “Human” and “AI” may remain as clarifiers, and provider-specific dialect inside infrastructure code is outside the broad vocabulary adoption deferred to work item #39.

## Decision

Adopt the following eight coordination and isolation rules as one protocol. They define required behavior and safety boundaries, not an implementation design.

These rules are accepted direction, not current operating procedure. None of these rules changes present authorization or process until the work item or items implementing that rule are integrated and the governing guidance is updated. Until then, [`AGENTS.md`](../../../AGENTS.md) and [`docs/development/parallel-work.md`](../../development/parallel-work.md) as currently written govern.

### 1. Liveness is per state

Agent-owed work requires a check-in deadline. Principal-owed work requires a waiting-since age, has no deadline, surfaces unconditionally at every session start and status request, and never expires. Parked work requires neither timestamp.

A claimed record missing the timestamp required by its ownership state is a hard registry error. A blocked state with no owner is contradictory and belongs in proposed state instead of being represented as ownerless blocked work.

### 2. Every dependency is a ticket

Every dependency, including a decision owed by a principal, is represented by an issue reference or the explicit value `none`. Explanatory prose belongs in a non-parsed notes field. A human decision that blocks work therefore becomes its own issue.

Availability is derived from those issue dependencies rather than asserted with a hand-maintained availability label. This makes the work graph machine-readable without treating prose as a dependency language.

### 3. An agent pushes only its owned typed branch

An agent pushes the typed branch it owns, never the integration branch, never with force, and never to another session's branch. A pull request is not required merely to make checkpoint evidence verifiable because CI runs on every branch push. Checkpoints retain explanatory narrative and gain a machine-readable header that identifies the CI run.

This rule does not authorize a push today. Scoped branch-push authority begins only after work item #40 is integrated and the governing guidance grants it. Until then, the existing no-push boundary remains in force. A pull request remains the only route into the integration branch.

### 4. Malformed records fail closed on planning, not reporting

Status reporting prints the readable board, places malformed entries in an unparseable section, and exits non-zero. It refuses to produce a candidate verdict from malformed evidence rather than hiding all readable information.

The hard planning failure is scoped to the dependency closure of the work being considered. Structured records are validated when written as well as when read, so a malformed value is rejected close to its source and remains visible if encountered later.

### 5. Creating the remote reference is the claim primitive

Claim order is inverted: create the remote reference first, then immediately write the claim fields. Branch names derive from the work item. A contender that loses remote reference creation stops before mutating any registry record.

A remote reference with no corresponding claim is a registry error, not available work. Releasing a held reference remains an explicitly authorized action; stale evidence never authorizes automatic release, deletion, or takeover. Claim-field writes after reference creation are still non-atomic, so disagreement remains a stop condition rather than something to infer away.

### 6. The integration checkout is principal-operated and lifecycle is remotely verified

The integration checkout mirrors the integration branch, contains no authored work, and is enforced by committed hooks. Integration testing occurs in a dedicated worktree on a scratch branch, not in that checkout. Pull requests are the only path into the integration branch.

The claimed branch and checkpoint commit are verified against the remote with an explicit distinction between ordinary lag and contradiction. Absolute local filesystem paths leave the public registry and are replaced by a host label. Local process or filesystem evidence remains diagnostic and cannot override the registry or remote reference.

### 7. Scope is declared, observed, and serialized

A claim declares path globs that are cross-checked at claim time. The observed changed-path set is derived from actual branch differences and exposes scope creep rather than trusting the declaration alone.

The repository maintains a serializing list for paths where a clean Git merge is not evidence of correctness. Collision on a serializing path is a hard stop routed to the owning work item; ordinary path overlap produces a warning for review. Neither result silently chooses one session's output.

### 8. Durability is per decision, not per session

A coordination decision is recorded when it settles, not when the session ends, because session end is not a reliable persistence hook. This per-decision rule also applies to a coordination session that holds no claim: it records the decision in the shared plan when it settles.

Nothing is durable coordination output until it is in the shared registry. External or private documents, terminal transcripts, and harness session history can support work but cannot replace the registry record.

These rules preserve the existing default-deny boundary. They do not authorize automatic takeover, release, abandonment, cleanup, conflict resolution, integration, merge, deployment, or provider effects, and they do not transfer recovery or production authority from a principal to an agent or workload identity.

## Alternatives considered

### Keep issue-first optimistic claims and prose-only reconciliation

**Rejected.** Re-fetching before an issue edit narrows but does not settle the race, and inconsistent fields cannot support dependable liveness, dependency, locality, or scope conclusions. This alternative would become credible only if the registry offered one atomic operation covering claim ownership, the remote reference, and validated fields; no such operation is available.

### Make harness state or a long-running coordinator the authority

**Rejected.** Harness state is local, proprietary, and unavailable to fresh sessions in other harnesses; a coordinator process also cannot promise action after it exits. Harnesses may supervise execution, but only the shared registry and remote Git evidence cross those boundaries. Reconsideration would require a shared, auditable, harness-neutral authority with at least the same fail-closed and public recovery properties.

### Require a pull request solely to publish checkpoint evidence

**Rejected.** Immutable branch commits and branch-triggered CI runs can supply verifiable evidence without creating a review object for every checkpoint. Pull requests remain mandatory for integration. Reconsider this if branch CI cannot provide an immutable run reference tied to the claimed commit or if repository policy no longer runs the required checks on owned branch pushes.

### Hide the board whenever one record is malformed

**Rejected.** Suppressing readable evidence makes diagnosis and unrelated reporting worse. The accepted split—readable reporting with a non-zero exit and dependency-closure-scoped refusal to plan—keeps failures visible without treating partial evidence as safe. Reconsider only if partial display is shown to cause readers to mistake malformed or incomplete output for a candidate verdict.

## Consequences

### Positive

- Ownership races move to remote Git's atomic reference creation rather than depending only on read recency.
- Liveness, dependencies, checkpoint evidence, remote branch state, locality, and changed scope become independently classifiable.
- Malformed evidence remains visible while candidate planning fails closed where that evidence matters.
- Integration checkout drift and authored work gain explicit prevention and remote verification boundaries.
- Serializing paths protect shared contracts and governed files where mergeability does not prove semantic safety.
- Decisions from coordination-only and no-claim sessions become durable when settled rather than depending on a session-end ritual.

### Negative

- Routine agent pushes publish work in progress to the public repository earlier. Secret-scanning push protection becomes an earlier boundary defense, and branch-triggered container jobs can consume additional CI capacity.
- Reference creation and claim-field updates remain separate operations. Orphaned references and disagreements become registry errors requiring explicit resolution rather than being repaired automatically.
- Principals must represent their blocking decisions as tickets and keep waiting-since evidence, increasing visible coordination overhead.
- Strict schemas and required timestamps can stop planning for work that a person could otherwise interpret informally.
- Host labels disclose less local detail than absolute paths but also provide less precise filesystem diagnostics.
- Declared scope, observed diffs, and serializing paths add maintenance and can reduce concurrency; ordinary overlap warnings still require judgment.
- A principal-operated integration checkout and separate scratch integration worktree use more local resources and add lifecycle steps.
- Per-decision recording interrupts coordination work and requires judgment about when a decision has actually settled.
