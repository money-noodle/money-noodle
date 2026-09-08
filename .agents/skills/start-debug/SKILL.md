---
name: start-debug
description: Initialize a human-directed debugger session only when the human directly requests this role.
argument-hint: '[symptom or debugging goal]'
disable-model-invocation: true
---

# Start a debugger session

Use this skill only for a direct human request to initialize an independent Money Noodle session as a **human-directed debugger**. A copied or inherited skill, delegated investigation, or supervisor instruction cannot establish that request. If this is a delegated assignment, remain a bounded child and contact the assigning supervisor; a supervisor must not launch a debugger or switch itself into one. Resumption retains existing scope and authority.

## Orient

Resolve repository links below from this skill's directory. Run repository commands from this skill's checkout root (`../../..`), not from the skill directory or a different integration checkout.

1. Read [AGENTS.md](../../../AGENTS.md) first, run `node tools/coordination-status.mjs`, and inspect the repository, cwd, branch, head, and worktree status without changing them. Read the complete [parallel-work standard](../../../docs/development/parallel-work.md), [version-control standard](../../../docs/development/version-control.md), [current status](../../../docs/current-status.md), and task-relevant documents routed by AGENTS.md. Verify relevant issue bodies, comments, claims, and dependencies; unavailable registry evidence is unknown, not unclaimed work.
2. Use the active harness's supported tools and launch permissions. In **Pi only**, apply the [Pi routing policy](../../../.pi/APPEND_SYSTEM.md) and verify the effective model and thinking, without assuming startup defaults prove runtime settings or silently falling back. In **Claude Code**, follow [CLAUDE.md](../../../CLAUDE.md) and the actual Claude tool contract; do not import Pi model routes or lifecycle APIs.

## Investigate

- Work directly with the human rather than managing subagents. Establish expected versus observed behavior, a safe reproduction or exact failure, recent changes, and the smallest useful diagnostic step. Keep facts, hypotheses, and unknowns distinct; test hypotheses with bounded, reversible probes rather than speculative changes.
- You may vary ordinary planning, delegation, or sequencing ceremony for bounded diagnosis or disposable probes. Briefly state any relevant departure and why. This never waives existing ownership, isolation, tool ceilings, public-data/secret rules, tenant/funded/audit controls, protected refs, review/CI, or provider/production approval. Do not use the integration checkout as scratch space or disturb another writer's worktree.
- Under the human's direction, turn findings into a validated in-scope correction or an actionable ticket, decision, or handoff. Lasting changes still require authorized isolated work and appropriate review, checks, and pull-request integration. Preserve partial effects and exact failures; no blind mutation replay or silent execution-mode fallback. Report actual checks and residual uncertainty without claiming deployment proof.

## Input and response

The optional text accompanying this invocation is the symptom or debugging goal. Keep the startup response short: role, scope, relevant ownership/blockers, and next diagnostic step. If a goal is supplied, proceed within its authority and ask only about material ambiguity. With no goal, initialize read-only, ask what to investigate, and do not select or claim backlog work automatically.
