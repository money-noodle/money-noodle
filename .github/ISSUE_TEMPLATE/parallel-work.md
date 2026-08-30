---
name: Parallel work item
about: Claimable unit linked to one shared complex-task plan
title: "Work: "
labels: "work:proposed"
assignees: ""
---

## Parent shared plan

Parent-Plan: #ISSUE

## Outcome and scope

<!-- One independently verifiable outcome. Include paths/projects/contracts and explicit exclusions. -->

## Dependencies and integration

<!-- Use "none" or a comma-separated list such as "#12, #13". -->
Depends-On: none
Integration-Owner: maintainer
Shared-Hotspots: none

## Acceptance

- [ ] Acceptance criterion
- [ ] Required focused/affected checks
- [ ] Handoff evidence recorded

## Portable claim

<!--
Preserve these exact field names for cross-harness status tooling. Use "unclaimed" until active.
Before replacing them, do the full pre-claim double-check from docs/development/parallel-work.md:
re-fetch this body and its ownership/checkpoint comments, then inspect `git worktree list --porcelain`
and branches immediately before mutation. Status output or an unclaimed body alone is insufficient.
Stop and escalate any disagreement; never overwrite earlier or ambiguous claim evidence.
After updating, add a claim checkpoint comment, re-fetch both records, and verify they agree before
creating the branch/worktree.
-->

Claim-State: proposed
Claim-Harness: unclaimed
Claim-Run-ID: unclaimed
Claim-Agent: unclaimed
Claim-Branch: unclaimed
Claim-Worktree: unclaimed
Claimed-At: unclaimed
Check-In-By: unclaimed

## Current checkpoint

<!--
Concise current state. Add milestone history as issue comments. Every ownership/checkpoint comment
must repeat the current Claim-State, Claim-Harness, Claim-Run-ID, Claim-Agent, Claim-Branch,
Claim-Worktree, Check-In-By, Checkpoint-At, and Checkpoint-Commit field lines before any prose so
read-only tooling can reconcile the append-only trail with this body. An unstructured claim-bearing
comment or disagreement is intentionally a maintainer question, never inferred ownership.
-->

Checkpoint-At: unclaimed
Checkpoint-Commit: uncommitted
Next-Action: unclaimed
Blockers: none

## Recovery and cleanup

<!-- What another agent should preserve, validate, finish, or clean if this is interrupted. -->
