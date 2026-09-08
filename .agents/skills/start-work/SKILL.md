---
name: start-work
description: Initialize an independent execution/work supervisor session when the human requests session startup.
argument-hint: '[task or issue]'
disable-model-invocation: true
---

# Start an execution session

Use this skill only for a direct human request to initialize an independent Money Noodle session as an **execution supervisor**. Check session kind before selecting the role: if this is a delegated assignment, remain a bounded child and contact the assigning supervisor instead. Resumption retains existing scope and authority.

## Orient

Resolve repository links below from this skill's directory. Run repository commands from this skill's checkout root (`../../..`), not from the skill directory or a different integration checkout.

1. Read [AGENTS.md](../../../AGENTS.md) first, run `node tools/coordination-status.mjs`, and inspect the repository, cwd, branch, head, and worktree status without changing them. Read the complete [parallel-work standard](../../../docs/development/parallel-work.md), [version-control standard](../../../docs/development/version-control.md), [current status](../../../docs/current-status.md), and task-relevant documents routed by AGENTS.md. Verify relevant issue bodies, comments, claims, and dependencies; unavailable registry evidence is unknown, not unclaimed work.
2. Use the active harness's supported tools and launch permissions. In **Pi only**, apply the [Pi routing policy](../../../.pi/APPEND_SYSTEM.md) and verify the effective model and thinking, without assuming startup defaults prove runtime settings or silently falling back. In **Claude Code**, follow [CLAUDE.md](../../../CLAUDE.md) and the actual Claude tool contract; do not import Pi model routes or lifecycle APIs.

## Work

- Establish the requested outcome, bounded scope, acceptance checks, dependencies, and material unknowns before implementation. Resolve architecture and contract decisions first; proposals and historical behavior are not accepted authority.
- Own delivery and final acceptance. Delegate substantial or parallel work non-blockingly under the current delegation contract, using isolated claimed writers and independent validation/review. Preserve handles and partial work on failure; do not silently switch execution modes. Make direct edits only where the current ownership and isolation rules permit.
- Follow the engineering workflow and checkpoint/handoff rules. This initialization grants no additional publication, pull-request, merge, provider, deployment, or funded authority; preserve all security and tenant boundaries.

## Input and response

The optional text accompanying this invocation is the task or issue. Keep the startup response short: role, scope, relevant ownership/blockers, and next action. If a task is supplied, proceed within its authority and ask only about material ambiguity. With no task, initialize read-only, ask what to work on, and do not select or claim backlog work automatically.
