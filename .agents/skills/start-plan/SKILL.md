---
name: start-plan
description: Initialize an independent planning/review supervisor session when the human requests session startup.
argument-hint: '[planning goal or review target]'
disable-model-invocation: true
---

# Start a planning or review session

Use this skill only for a direct human request to initialize an independent Money Noodle session as a **planning supervisor** for planning, research, specification, or review. Check session kind before selecting the role: if this is a delegated assignment, remain a bounded child and contact the assigning supervisor instead. Resumption retains existing scope and authority.

## Orient

Resolve repository links below from this skill's directory. Run repository commands from this skill's checkout root (`../../..`), not from the skill directory or a different integration checkout.

1. Read [AGENTS.md](../../../AGENTS.md) first, run `node tools/coordination-status.mjs`, and inspect the repository, cwd, branch, head, and worktree status without changing them. Read the complete [parallel-work standard](../../../docs/development/parallel-work.md), [version-control standard](../../../docs/development/version-control.md), [current status](../../../docs/current-status.md), and task-relevant documents routed by AGENTS.md. Verify relevant issue bodies, comments, claims, and dependencies; unavailable registry evidence is unknown, not unclaimed work.
2. Use the active harness's supported tools and launch permissions. In **Pi only**, apply the [Pi routing policy](../../../.pi/APPEND_SYSTEM.md) and verify the effective model and thinking, without assuming startup defaults prove runtime settings or silently falling back. In **Claude Code**, follow [CLAUDE.md](../../../CLAUDE.md) and the actual Claude tool contract; do not import Pi model routes or lifecycle APIs.

## Plan or review

- For planning, separate facts, assumptions, proposals, and accepted decisions. Produce a coherent plan or implementable tickets with outcome, scope, dependencies, contracts, measurable acceptance, constraints, unresolved decisions, and handoff context. Respect shared-plan editor ownership; do not publish registry changes unless within the request's authority.
- For review, establish the exact target revision or document and acceptance criteria. Lead with actionable findings ordered by severity, with file/line or other precise evidence, impact, and recommended correction. State when no findings are substantiated and identify validation gaps. Do not silently fix the reviewed source or present self-review as independent review.
- Delegate useful audit, research, planning, and independent review non-blockingly under the current delegation contract; use fresh context for serious independent review. Read-only advice needs no source claim. Any authorized lasting source edit still requires ownership and isolation; planning/review is not permission to begin product implementation or perform integration or production effects.

## Input and response

The optional text accompanying this invocation is the planning goal or review target. Keep the startup response short: role, scope, relevant ownership/blockers, and next action. If a target is supplied, proceed within its authority and ask only about material ambiguity. With no target, initialize read-only, ask what to plan or review, and do not select or claim backlog work automatically.
