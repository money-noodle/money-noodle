# Parallel agent work standard

## Purpose and source of truth

Parallel work should increase throughput without hidden overlap, conflicting authority, or abandoned state. This protocol is harness-neutral: Pi, Claude Code, GitHub Copilot, and other agents coordinate through the same repository and GitHub records.

GitHub Issues are the canonical work registry because they are remote, branch-independent, auditable, and visible across harnesses, worktrees, and machines. A GitHub Project may add views later without replacing issues. Chat history, local session lists, worktrees, and harness-specific storage are supporting evidence, never the shared registry.

Harness bridge files such as `CLAUDE.md` and `.github/copilot-instructions.md` only route agents to root `AGENTS.md`; they do not duplicate requirements or status. A harness that does not auto-discover `AGENTS.md` must use an equivalent thin bridge.

Every agent session begins by reading `AGENTS.md` and running:

```bash
node tools/coordination-status.mjs
```

The command retrieves every page of issues, comments for every open issue, labels, and open pull requests; reconciles all plausible ownership comments plus the latest creation-ordered claim/checkpoint comment with the issue body; and compares registered locality with locally observable branches and worktrees without modifying anything. Local Git commands disable optional locks so status inspection cannot refresh the index. It is a triage aid, never a claim lock or sufficient permission to claim. If any required registry record is unavailable or malformed, the whole registry result is coordination-unknown rather than empty. Inspect Git/worktrees manually and ask the maintainer before entering potentially overlapping scope. Never interpret an unreachable registry as an empty registry.

### Status output contract

Human output remains the default. `node tools/coordination-status.mjs --json` emits one JSON document using schema version `1.0`; warnings still produce exit status 2, so consumers must read the document rather than treating a nonzero status as absent output. The versioned fields are:

- top level: `schemaVersion`, `generatedAt`, `advisory`, `coordinationKnown`, `local`, `registry`, `warnings`, and `errors`;
- `local`: the raw short status plus parsed local `branches` and `worktrees` evidence;
- `registry`: `repository`, required/missing `labels`, `plans`, `workItems`, `pullRequests`, and flattened `maintainerQuestions` when `coordinationKnown` is true; it is `null` when required evidence cannot be retrieved or validated;
- each work item: GitHub identity/state, structured `claim` and `checkpoint`, `deadline` (`current`, `overdue`, `invalid`, or `unknown`), dependency evidence (`clear`, `blocked`, or `unknown` plus issue-number sets), metadata for all plausible claim comments and the latest creation-ordered unresolved comment, `claimCommentResolution`, local evidence (`matched`, `not-observed`, `contradiction`, or `not-applicable`), reconciliation, questions, and triage;
- `triage`: `candidate`, `blocked`, `claimed`, `review`, `proposed`, or `question`; every item also carries `candidateSafety: not-established` because even a candidate needs the full pre-claim protocol;
- `warnings`: missing-label and maintainer-question records; `errors`: why `coordinationKnown` is false.

Fields may be added compatibly within major version 1. Consumers must ignore unknown fields and fail closed on an unsupported `schemaVersion`, `coordinationKnown: false`, `registry: null`, unknown enum value, or maintainer question. A `candidate` means only that body and label both say ready, ownership and deadline fields remain unclaimed, declared dependencies are proved clear, and currently retrieved evidence has no contradiction. It never proves absence of a race, an external harness session, or later evidence. Check-in timestamps are strict, calendar-valid ISO instants with `T` and `Z` or an explicit offset; date-only, zone-less, normalized-impossible, and informal values are invalid.

## Plan for parallelism

A complex task starts as one shared parent plan—normally a parent issue, with a version-controlled plan document linked when the design needs diagrams or substantial detail. The shared plan owns the outcome, architecture context, work graph, acceptance, major risks, integration owner, and current completion state. All agents work from and contribute to this plan; private per-session plans are temporary reasoning and cannot silently diverge from it.

Create child issues only where each unit has:

- one independently verifiable outcome;
- explicit project/path and contract scope plus exclusions;
- declared inputs, outputs, dependencies, and blockers;
- acceptance checks and handoff artifact;
- identified shared files, schemas, contracts, infrastructure, generated outputs, and integration order.

Represent dependencies as a directed acyclic graph and group ready items into parallel waves. Keep child state, dependency changes, newly discovered work, integration order, and accepted plan changes reflected in the shared parent plan. Parallelize across stable boundaries; serialize shared decisions and contract changes that would make downstream work speculative. Prefer contract-first work: one owner changes an OpenAPI/schema/event contract, then independent consumers work against the accepted version.

Do not split work merely to keep agents busy. Tasks are not safely parallel when they edit the same source, migration sequence, lockfile, generated artifact, architecture decision, or infrastructure state unless one task explicitly owns integration.

## Coordinator and execution authority

The primary or root agent session is the **coordinator**. It is coordination-only, even when a requested change is small. An **execution session** is a separate delegated subagent or maintainer-authorized agent session that performs one bounded repository change. The **integration checkout** is the worktree on the sole integration branch, `main`; it is not an implementation worktree.

The coordinator may:

- inspect repository files, status, refs, worktrees, diffs, issue records, and check results with read-only operations;
- plan outside tracked repository files and maintain shared issue plan, claim, checkpoint, and dependency metadata;
- establish a claim, branch, and worktree for a named execution session, delegate the work, and review its commits and evidence;
- perform a conflict-free Git integration of reviewed execution commits only when the designated integration owner has explicitly authorized that integration operation, and push or merge only when separately authorized under the version-control rules.

The coordinator must not edit tracked repository files in any checkout, run writing format/fix operations as a substitute for delegation, create ordinary change commits, or implement or repair work in the integration checkout. A version-controlled plan or documentation edit is a repository change, not claim/plan metadata. Authorized integration may apply unchanged reviewed commits and create normal merge metadata; it does not permit hand-editing, conflict resolution, drive-by fixes, or unreviewed amendments in the target checkout. A conflict or needed correction returns to an execution session on its delegated branch.

Every repository change—including documentation, tests, generated artifacts, tooling, configuration, and implementation—must be performed by an execution session. Each delegated change has its own claimed bounded scope, short-lived typed branch based on the current integration target, and dedicated mutable worktree; the execution session edits, validates, and commits only there. Its output is reviewed and integrated into the target branch rather than recreated or edited directly in the integration checkout. Delegation does not grant the execution session permission to push, merge, alter protected refs, or deploy; those operations retain their existing explicit authorization and integration-owner requirements.

If the harness cannot create or delegate a subagent, the coordinator stops before changing repository files and asks the maintainer to start or authorize a separate execution session. Tool limitations, urgency, or a change's small size do not allow the coordinator to become the executor.

### The temporary integration exception is not agent authority

[`version-control.md`](version-control.md#temporary-sole-maintainer-integration-exception) defines a temporary exception under which only the maintainer acting personally as the human principal may waive unavailable independent pull-request approval. It is not coordinator, execution-session, integration-owner, workload-identity, automation, or collaborator authority. An agent or workload identity cannot invoke it, request that it be invoked, infer it from an issue, assignment, green check, successful run, prior bypass, or broad instruction, or treat it as authority to merge.

A claim, completed acceptance checklist, successful required check, durable evidence record, integration ownership, or instruction to prepare a pull request does not establish that the exception applies. Agents stop after their authorized implementation, checks, commit, and handoff unless separately authorized for another operation; they do not recommend or ask for the exception as a way around unavailable review. Only the maintainer personally decides whether its documented conditions are met and performs any qualifying merge.

Even for the maintainer, the exception waives only independent approval: pull-request integration, exact-current-head required checks, conversation and last-push controls, and durable exception evidence remain mandatory. Direct push, force push, history rewriting, failed-check bypass, protection weakening, provider authentication, production self-review, environment administrator bypass, apply, rollback, and deployment remain forbidden. The exception expires before provider delivery is enabled and never transfers account ownership, recovery, tenant, audit, funded-authority, provider, or production authority to an agent or workload identity.

## Work states and portable claim record

Use labels `work:proposed`, `work:ready`, `work:active`, `work:blocked`, `work:review`, `work:done`, and `work:abandoned`, plus an `area:*` label when useful. The issue records or links:

- task/parent IDs, scope, exclusions, dependencies, and acceptance;
- branch and worktree description;
- `Claim-Harness` such as `pi`, `claude-code`, `copilot`, or `other`;
- an opaque `Claim-Run-ID` when the harness provides one;
- a human-readable `Claim-Agent` or session name;
- `Claimed-At`, `Check-In-By`, and latest checkpoint;
- shared hotspots, integration owner, and recovery/handoff notes.

Harness/run identifiers are diagnostic, not identity or authority. This repository and its issue registry are public: issue bodies, comments, checkpoints, branch names, commit metadata, and copied prompt text are externally observable. Do not publish local session-file paths, credentials, full prompts, transcripts, customer or production data, billing/account identifiers, private recovery material, or secrets. Use the issue template at `.github/ISSUE_TEMPLATE/parallel-work.md`; preserve its machine-readable field names so status tooling remains portable.

Use issue comments as an append-only checkpoint trail; editing an ownership comment is ambiguous and becomes a maintainer question. Every ownership or checkpoint comment includes the current exact `Claim-State`, `Claim-Harness`, `Claim-Run-ID`, `Claim-Agent`, `Claim-Branch`, `Claim-Worktree`, and `Check-In-By` field lines so read-only tooling can reconcile it; checkpoint comments also include `Checkpoint-At` and `Checkpoint-Commit`. Explanatory prose may follow those fields. Update the issue body's structured claim fields when ownership, branch, state, or deadline changes. Body edits, labels, comments, branch creation, and worktree creation are not one atomic operation: any plausible ownership wording—including “started work” or “taking ownership”—is retained as intent evidence, and a newer matching comment cannot hide competing structured ownership. An unresolved unstructured claim-bearing comment, edited claim comment, or disagreement becomes a maintainer question; never overwrite or infer away one merely because another record is newer. A session existing inside a harness does not prove its claim is alive; the registry checkpoint does.

### Explicit claim-comment reconciliation

Append-only history needs an explicit release path rather than permanent ambiguity or deletion. The issue-body field `Reconciled-Claim-Comment-IDs` is `none` or a canonical comma-space-separated list of exact positive GitHub comment IDs, such as `123, 456`. It is authorization metadata, not claimant evidence: only the maintainer or the issue's declared `Integration-Owner` may change it, and the current `Claim-Agent` may not authorize its own dismissal of intent. A maintainer instruction may direct an execution session to apply the exact approved IDs, but the session never chooses them itself. GitHub's issue history remains the audit record; status tooling validates the declared authority boundary but cannot authenticate who typed a body edit.

Use the field only after reading the complete append-only trail and deciding that each named historical claim comment is reconciled or superseded by an authorized release, handoff, or takeover. Update the field together with the structured body state, then append a new fully structured checkpoint and re-fetch status. The comments are never edited or deleted. JSON retains every entry in `claimComments`, marks each `reconciled` or `unresolved`, and exposes `claimCommentResolution` with `status` (`none`, `valid`, or `invalid`), authority, raw/requested/reconciled/unresolved IDs, and validation problems; `latestClaimComment` remains visible while `latestUnresolvedClaimComment` drives body reconciliation.

The whole resolution is invalid and no ID is reconciled when the field is malformed or duplicated, repeats an ID, lacks a distinct declared integration owner, names an unknown or non-claim comment, or names an edited comment. Any unlisted older or later intent remains unresolved and can still question. A future comment never inherits authorization merely because an earlier ID was listed. This mechanism can make an authorized takeover or release-to-ready consistent; it never makes a candidate safe to claim and never permits automatic takeover.

## Claim and isolation protocol

Before an execution session edits, either that session or the coordinator acting on its behalf completes the claim steps below. A coordinator-created claim must name the delegated execution session; the coordinator may prepare its branch and worktree but never edits in it. Immediately before its first repository change, the execution session verifies the current status, full issue body and comments, registered scope and identity, branch, and worktree. It does not replace a matching pre-registered claim, and it stops on any conflict.

The session registering the claim:

1. Fetches refs and runs the coordination status command.
2. Inspects Git status, `git worktree list --porcelain` (including lock reasons), local/remote branches, open PRs, and every active/blocked claim touching the intended scope.
3. Reads the parent plan/dependencies plus the candidate issue's full body and ownership/checkpoint comments. A body or status row saying `work:ready`, `proposed`, or `unclaimed` makes the item only a candidate; it is not proof that nobody has started.
4. Immediately before mutating claim fields, re-fetches that issue's body and comments and re-runs the local worktree/branch inspection. Do not claim from a cached status result.
5. Stops without changing claim metadata or creating another worktree if any comment, branch, locked worktree, harness trail, or unexplained change indicates current or ambiguous prior intent touching the scope. Record the discovery and ask the integration owner or maintainer to reconcile it; do not decide that the apparent earlier claimant is stale or overwrite it.
6. If the double-check is clear, claims the item by updating the structured harness/run/agent/branch/worktree/scope/deadline fields and applying `work:active`, then adds an append-only claim checkpoint comment.
7. Re-fetches the issue and verifies that its own structured claim and comment still agree before creating the dedicated typed branch/worktree. If another claim raced, stop and preserve both records for maintainer resolution. One active claim owns one mutable worktree; agents never share one.
8. Rechecks the registry, comments, and worktrees before expanding scope or changing a shared contract.

Use a meaningful task/session name in any harness that supports naming. Harness-native resume, fork, clone, or session-browser features may help continue work but never replace the issue claim.

A claim is an advisory coordination lease, not a repository lock or permission to bypass review. If overlap appears, stop at a clean boundary, checkpoint both records, and ask the integration owner or maintainer to repartition or serialize work.

## Checkpoints, stale work, and cleanup detection

Checkpoint after meaningful milestones, before a known long wait, and before ending a session. Record completed evidence, current branch/commit or uncommitted-state warning, checks, blockers, next action, and next `Check-In-By`. Do not emit empty heartbeat noise.

A claim is **suspected stale**, never automatically abandoned, when:

- an active, blocked, or review claim has an expired, invalid, or unknown `Check-In-By`; a later comment does not extend the structured deadline by itself;
- its branch/worktree is missing or contradicts the issue, including locally observed registered worktrees marked locked or prunable;
- its PR is merged/closed while the issue remains active;
- it reports active work but has no recoverable branch/commit and an unexplained dirty worktree exists;
- another agent discovers unfinished overlapping changes not represented by a claim.

The status command highlights what it can prove from GitHub and local Git. A ready item is dependency-clear only when `Depends-On` is `none` or every referenced issue is closed with exactly one `Claim-State: done` field and exactly one `work:done` work-state label; duplicate, malformed, additional, missing, self-referential, or ambiguously completed evidence is unknown, while an open dependency is blocked. Claim-bearing open issues remain visible even if a work label is missing, and body/label/comment or locally observed branch/worktree disagreements become maintainer questions. The command cannot enumerate every proprietary harness session or prove remote locality, so `not-observed` is not a contradiction and mandatory registration remains what makes cross-harness discovery possible.

A new agent surfaces suspected stale evidence and asks the maintainer whether to resume, hand off, extend, clean up, abandon, or authorize a completion plan. It should include a concrete proposed recovery/completion path—remaining work, reusable evidence, branch strategy, checks, risks, and cleanup—linked into the shared parent plan. Planning unfinished work is allowed before takeover; modifying or claiming it is not. Never reset, delete, overwrite, force-push, remove a worktree, or take over another claim automatically.

On approved takeover:

- preserve prior branches, commits, and issue history;
- record authorization and reason;
- choose explicitly between the existing branch and a recovery branch;
- replace claim metadata and deadline;
- add the approved completion/recovery steps to the shared parent plan;
- independently validate inherited work before trusting it.

Future automation or agent skills may create/checkpoint claims after this process is stable. They must remain harness-neutral at the registry boundary and ask rather than auto-release, auto-clean, or auto-take over.

## Integration and completion

The integration owner manages shared contracts, merge order, compatibility, and final acceptance. Coordinator status does not confer integration ownership or permission to push or merge, and integration ownership does not remove the requirement for explicit authorization. The temporary maintainer-only exception above cannot be delegated through integration ownership or a work-item instruction. Delegated commits receive review and required checks before an authorized, conflict-free integration into the target branch; fixes and conflict resolution return to an execution worktree instead of being authored in the integration checkout. Dependents incorporate the accepted dependency version before completion. Never resolve overlap by silently selecting one agent's output.

Before releasing a claim, the agent:

1. runs focused and affected checks;
2. records commits/diff, evidence, unresolved risks, and deployment impact;
3. pushes or opens a PR only when authorized;
4. sets `work:review`, `work:done`, `work:blocked`, or `work:abandoned` accurately;
5. leaves explicit continuation and cleanup instructions;
6. removes a worktree only after changes are preserved and removal is authorized/safe.

An unfinished agent checkpoints and marks work blocked or abandoned; it never leaves an apparently active claim. A merged task is not complete until integration checks and, for `main`, production deployment verification succeed.
