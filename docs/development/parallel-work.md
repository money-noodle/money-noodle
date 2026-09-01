# Parallel agent work standard

## Purpose and source of truth

Parallel work should increase throughput without hidden overlap, conflicting authority, or abandoned state. This protocol is harness-neutral: Pi, Claude Code, GitHub Copilot, and other agents coordinate through the same repository and GitHub records. Here, a **principal** is a person holding authority, an **agent** is an AI session executing bounded work, and a **workload identity** is a machine credential something runs as.

GitHub Issues are the canonical work registry because they are remote, branch-independent, auditable, and visible across harnesses, worktrees, and machines. A GitHub Project may add views later without replacing issues. Chat history, local session lists, worktrees, and harness-specific storage are supporting evidence, never the shared registry.

Harness bridge files such as `CLAUDE.md` and `.github/copilot-instructions.md` only route agents to root `AGENTS.md`; they do not duplicate requirements or status. A harness that does not auto-discover `AGENTS.md` must use an equivalent thin bridge.

Every agent session begins by reading `AGENTS.md` and running:

```bash
node tools/coordination-status.mjs
```

The command retrieves every page of issues, comments for every open issue, labels, open pull requests, and reserved `claim-v*` references; directly fetches a reserved reference's corresponding issue when it is closed or absent from the normal board; dispatches implicit-v1 and explicit-v2 body validation; reconciles all plausible ownership comments plus the latest creation-ordered claim/checkpoint comment with the issue body; verifies current schema-v2 agent ownership against its derived remote reference; and retains v1 locality comparison with locally observable branches and worktrees without modifying anything. Local Git commands disable optional locks so status inspection cannot refresh the index. It is a triage aid, never a claim lock or sufficient permission to claim. If required host evidence is unavailable or structurally unreadable, the whole registry result is coordination-unknown rather than empty. A structurally readable but semantically malformed issue body or reserved reference instead remains visible and fails closed only for affected planning decisions. Inspect Git/worktrees manually and ask the maintainer before entering potentially overlapping scope. Never interpret an unreachable registry as an empty registry.

### Status output contract

Human output remains the default. `node tools/coordination-status.mjs --json` emits one JSON document using schema version `1.0`; warnings still produce exit status 2, so consumers must read the document rather than treating a nonzero status as absent output. The versioned fields are:

- top level: `schemaVersion`, `generatedAt`, `advisory`, `coordinationKnown`, `local`, `registry`, `warnings`, and `errors`;
- `local`: the raw short status plus parsed local `branches` and `worktrees` evidence;
- `registry`: `repository`, required/missing `labels`, `plans`, `workItems`, paginated `remoteClaims`, `pullRequests`, and flattened `maintainerQuestions` when `coordinationKnown` is true; it is `null` when required evidence cannot be retrieved or validated;
- each work item: GitHub identity/state, `registrySchema` version/dispatch/validation evidence, normalized `scopePaths`, structured `claim` and `checkpoint`, agent `deadline` (`current`, `overdue`, `invalid`, or `unknown`), principal `waiting` evidence, dependency evidence (`clear`, `blocked`, or `unknown` plus issue-number sets), metadata for all plausible claim comments and the latest creation-ordered unresolved comment, `claimCommentResolution`, v1-only local evidence (`matched`, `not-observed`, `contradiction`, or `not-applicable`), reconciliation, questions, and triage;
- `triage`: `candidate`, `blocked`, `claimed`, `review`, `proposed`, or `question`; every item also carries `candidateSafety: not-established` because even a candidate needs the full pre-claim protocol;
- `warnings`: missing-label and maintainer-question records; `errors`: why `coordinationKnown` is false.

Fields may be added compatibly within major version 1. The top-level status-output `schemaVersion: 1.0` is distinct from each issue body's registry schema version. Consumers must ignore unknown fields and fail closed on an unsupported status `schemaVersion`, unsupported or invalid `registrySchema`, `coordinationKnown: false`, `registry: null`, unknown enum value, or maintainer question. A `candidate` means only that body and label both say ready, ownership and liveness fields remain unclaimed, declared dependencies are proved clear, and currently retrieved evidence has no contradiction. It never proves absence of a race, an external harness session, or later evidence. Check-in timestamps are strict, calendar-valid ISO instants with `T` and `Z` or an explicit offset; date-only, zone-less, normalized-impossible, and informal values are invalid.

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

Every repository change—including documentation, tests, generated artifacts, tooling, configuration, and implementation—must be performed by an execution session. Each delegated change has its own claimed bounded scope, short-lived typed branch based on the current integration target, and dedicated mutable worktree; the execution session edits, validates, and commits only there. Its output is reviewed and integrated into the target branch rather than recreated or edited directly in the integration checkout. Delegation grants no publication authority except the normal owned-branch push described in [Scoped owned-branch publication](#scoped-owned-branch-publication). It never grants permission to push another ref, open a pull request, merge, alter protected refs, or deploy; those operations retain their existing explicit authorization and integration-owner requirements.

If the harness cannot create or delegate a subagent, the coordinator stops before changing repository files and asks the maintainer to start or authorize a separate execution session. Tool limitations, urgency, or a change's small size do not allow the coordinator to become the executor.

### The temporary integration exception is not agent authority

[`version-control.md`](version-control.md#temporary-sole-maintainer-integration-exception) defines a temporary exception under which only the maintainer acting personally as the human principal may waive unavailable independent pull-request approval. It is not coordinator, execution-session, integration-owner, workload-identity, automation, or collaborator authority. An agent or workload identity cannot invoke it, request that it be invoked, infer it from an issue, assignment, green check, successful run, prior bypass, or broad instruction, or treat it as authority to merge.

A claim, completed acceptance checklist, successful required check, durable evidence record, integration ownership, or instruction to prepare a pull request does not establish that the exception applies. Agents stop after their authorized implementation, checks, commit, and handoff unless separately authorized for another operation; they do not recommend or ask for the exception as a way around unavailable review. Only the maintainer personally decides whether its documented conditions are met and performs any qualifying merge.

Even for the maintainer, the exception waives only the unavailable independent-review gate, comprising exactly the required approving review and last-push approval subgates. Stale approval never qualifies, and stale-review dismissal remains in force. Pull-request integration, conversation resolution, every required check on the exact current head, and durable exception evidence remain mandatory. Any head change invalidates all previous required-check and exception-evidence qualification. Direct push, force push, history rewriting, any other protection bypass or weakening, failed-check bypass, provider authentication, production self-review, environment administrator bypass, apply, rollback, and deployment remain forbidden. The exception expires before provider delivery is enabled and never transfers account ownership, recovery, tenant, audit, funded-authority, provider, or production authority to an agent or workload identity.

## Work states and portable claim record

Use labels `work:proposed`, `work:ready`, `work:active`, `work:blocked`, `work:review`, `work:done`, and `work:abandoned`, plus an `area:*` label when useful. The issue records or links task/parent IDs, declared repository scope, exclusions, strict ticket dependencies and separate dependency notes, acceptance, branch and portable host evidence, harness/run/session evidence, liveness, current checkpoint, integration owner, and recovery/handoff notes.

Harness/run identifiers are diagnostic, not identity or authority. This repository and its issue registry are public: issue bodies, comments, checkpoints, branch names, commit metadata, and copied prompt text are externally observable. Do not publish local worktree or session-file paths, credentials, full prompts, transcripts, customer or production data, billing/account identifiers, private recovery material, or secrets. Use the Issue Forms at `.github/ISSUE_TEMPLATE/parallel-work.yml` and `.github/ISSUE_TEMPLATE/shared-plan.yml`; preserve their machine-readable field names so status tooling remains portable. GitHub can require inputs and constrain dropdown choices, but it cannot enforce the cross-field semantics below.

### Registry schema version 2

`Registry-Schema-Version: 2` is the explicit current issue-body schema. A body with no version field is an implicit version 1 record; readers continue to support untouched v1 and v2 records together. An explicit unsupported version, duplicate field, malformed v2 record, or unmanaged host edit remains visible in JSON and the human board's unparseable section, exits nonzero, and cannot produce a candidate or claim decision. The top-level status-output schema remains separately versioned as `1.0`.

Version 2 adds `Scope-Paths`, `Claim-Host`, `Waiting-Since`, strict `Depends-On`, and `Dependency-Notes`; it removes `Claim-Worktree` and `Shared-Hotspots`. `Scope-Paths` is `none` or unique repository-relative paths/globs and never a local path. `Depends-On` is exactly `none` or a canonical comma-space list such as `#12, #13`; all prose belongs in `Dependency-Notes`. Scope declaration and validation do not establish remote-reference ownership or implement the three-layer scope comparison deferred to #42 and #44.

Liveness is state-specific:

- `active` and `review` are agent-owned and require complete `Claim-Harness`, `Claim-Run-ID`, `Claim-Agent`, `Claim-Branch`, `Claim-Host`, `Claimed-At`, and strict `Check-In-By` evidence, with `Waiting-Since: unclaimed`;
- `blocked` is principal-owned by the named `Integration-Owner`, requires a strict `Waiting-Since`, carries no agent ownership or deadline, surfaces on every status request, and never expires; an impeded agent-owned item remains `active` and records its blocker as a ticket;
- `proposed` and `ready` are parked and carry no ownership or liveness timestamps;
- `done` and `abandoned` carry no current liveness and may retain either complete historical ownership evidence or none, never a partial owner.

The repository writer in `tools/coordination-write.mjs` constructs the complete proposed v2 body and matching checkpoint before any host mutation. It rejects invalid writes with zero mutation, pre-write collisions without overwriting, unsupported versions without reinterpretation, and every proposed/ready to active/review transition unless invoked through the dedicated claim module's module-private entry point. A first valid write sends at most one body update request; this is an ordinary host update, **not** server-side compare-and-swap. The writer re-reads for detection only. Body, state-label, and append-only comment updates are separate non-atomic host surfaces, so each stage is verified and returns explicit recoverable partial-state evidence. Success requires one final snapshot in which the complete body, sole state label, and operation-marked append-only comment all agree; late body drift is a collision, while late label or comment drift is a recoverable partial result. A stable `Coordination-Write-ID` makes retries resume without another body request once the proposed body is observable and without a duplicate comment; when a failed request left the original body unchanged, a retry may safely make the still-needed body request. Comments are appended, never edited.

The same writer executes shared-plan migration and cross-surface writes. A v2 plan checkpoint comment repeats its complete `Registry-Schema-Version`, `Plan-State`, `Integration-Owner`, and `Last-Plan-Update` record. Plan state `proposed` maps to `work:proposed`, `active` maps to `work:active`, and `complete` maps to `work:done`; the separate `work:plan` label is preserved.

The supported GitHub adapter is deliberately single-record and explicitly invoked; it performs no discovery, loop, background action, automatic migration, or bulk migration. Prepare an exact body snapshot, complete JSON field map, and matching comment in local files, then preview without any GitHub call:

```sh
node tools/coordination-write.mjs --dry-run --repo money-noodle/money-noodle --issue 123 --kind work-item --expected-body-file /tmp/body.md --values-file /tmp/values.json --comment-file /tmp/comment.md --operation-id unique-write-id
```

Replace `--dry-run` with `--apply` only when the principal has authorized that one issue mutation and the pre-write protocol has just been repeated. Apply mode uses the GitHub CLI API adapter and the same validation, collision, partial-state, idempotency, and final coherent-verification contract as mocked tests. Neither mode infers an issue, fetches a body snapshot on the caller's behalf, or authorizes migration merely because a record is v1.

An implicit-v1 body migrates deterministically only when that one record is next written through the integrated supported writer. A collision with prematurely introduced v2-only fields fails closed for explicit reconciliation. There is no bulk migration. Untouched v1 bodies remain valid mixed-version inputs, and historical comments are never migrated, edited, backfilled, or reinterpreted. The #41 bootstrap used deterministic fixtures and mocked host ports before integration; the integrated writer is now authoritative for supported per-record writes, while initial agent ownership is established only through the remote-reference primitive below.

Use issue comments as an append-only checkpoint trail; editing an ownership comment is ambiguous and becomes a maintainer question. A schema-v2 ownership or checkpoint comment includes the current exact `Claim-State`, `Claim-Harness`, `Claim-Run-ID`, `Claim-Agent`, `Claim-Branch`, `Claim-Host`, `Claimed-At`, `Check-In-By`, and `Waiting-Since` field lines so read-only tooling can reconcile it. An implicit-v1 comment retains its v1 claim fields, including `Claim-Worktree`; comments are interpreted under the body/comment contract in force when created and are never rewritten as v2. It then includes the complete checkpoint evidence header, in this exact order, before explanatory narrative:

```text
Checkpoint-Evidence-Version: 1
Checkpoint-State: <the exact current Claim-State>
Checkpoint-At: <strict ISO instant>
Checkpoint-Commit: <full 40-hex commit or uncommitted before one exists>
Checkpoint-Changed-Path-Count: <base-10 non-negative integer>
Checkpoint-Checks-Verdict: <passed|pending|failed|cancelled|skipped|missing|unavailable|mixed>
Checkpoint-CI-Run: <immutable full Actions run URL or unavailable>
Checkpoint-CI-Commit: <full 40-hex tested commit or unavailable>
Checkpoint-Security-Impact: <none|present|unknown>
Checkpoint-Tenant-Impact: <none|present|unknown>
Checkpoint-Provider-Impact: <none|present|unknown>
Checkpoint-Deployment-Impact: <none|present|unknown>
Checkpoint-Residual-Risk-Count: <base-10 non-negative integer>
Next-Action: <one line>
Blockers: <one line>
```

`Checkpoint-State` equals `Claim-State`. The changed-path count is derived from the actual comparison with the registered base, not estimated. The checks verdict summarizes required hosted checks conservatively: `passed` means every required check succeeded for the exact checkpoint commit; `pending`, `failed`, `cancelled`, `skipped`, `missing`, `mixed`, and `unavailable` are never collapsed into passing prose. Use `unavailable` before authorized publication creates a run. `Checkpoint-CI-Run` is either `unavailable` or the immutable full `https://github.com/money-noodle/money-noodle/actions/runs/<positive-integer>` URL. When a run exists, `Checkpoint-CI-Commit` is the exact tested commit and equals `Checkpoint-Commit`; otherwise it is `unavailable`. Each impact flag is exactly `none`, `present`, or `unknown`. The narrative names each required check and actual conclusion or explains unavailable hosted CI, describes every present or unknown impact, and lists exactly the declared number of residual risks. An incomplete or malformed header is not evidence.

The version 1 evidence-header requirement is prospective and applies only to checkpoint comments created after issue #40 is integrated. Historical checkpoint comments remain immutable, valid evidence under the checkpoint contract in force when they were created; do not edit, backfill, migrate, or reinterpret them. Integrated schema validation checks every field of a present version 1 evidence header against the current body while deliberately leaving pre-header history under its original contract. The complete header still requires independent verification against Git and hosted evidence; syntactic and semantic validity alone does not prove that a run or impact claim is true.

Any branch-head change immediately invalidates the prior CI run and checks verdict, even when the changed path appears unrelated. A checkpoint for the new head uses that new exact commit and fresh CI evidence; it never copies a run from an earlier commit. Update the issue body's structured claim and checkpoint fields when ownership, branch, state, deadline, or current evidence changes. Body edits, labels, comments, branch creation, and worktree creation are not one atomic operation: any plausible ownership wording—including “started work” or “taking ownership”—is retained as intent evidence, and a newer matching comment cannot hide competing structured ownership. An unresolved unstructured claim-bearing comment, edited claim comment, or disagreement becomes a maintainer question; never overwrite or infer away one merely because another record is newer. A session existing inside a harness does not prove its claim is alive; the registry checkpoint does.

### Explicit claim-comment reconciliation

Append-only history needs an explicit release path rather than permanent ambiguity or deletion. The issue-body field `Reconciled-Claim-Comment-IDs` is `none` or a canonical comma-space-separated list of exact positive GitHub comment IDs, such as `123, 456`. It is authorization metadata, not claimant evidence: only the maintainer or the issue's declared `Integration-Owner` may change it, and the current `Claim-Agent` may not authorize its own dismissal of intent. A maintainer instruction may direct an execution session to apply the exact approved IDs, but the session never chooses them itself. GitHub's issue history remains the audit record; status tooling validates the declared authority boundary but cannot authenticate who typed a body edit.

Use the field only after reading the complete append-only trail and deciding that each named historical claim comment is reconciled or superseded by an authorized release, handoff, or takeover. Update the field together with the structured body state, then append a new fully structured checkpoint and re-fetch status. The comments are never edited or deleted. JSON retains every entry in `claimComments`, marks each `reconciled` or `unresolved`, and exposes `claimCommentResolution` with `status` (`none`, `valid`, or `invalid`), authority, raw/requested/reconciled/unresolved IDs, and validation problems; `latestClaimComment` remains visible while `latestUnresolvedClaimComment` drives body reconciliation.

The whole resolution is invalid and no ID is reconciled when the field is malformed or duplicated, repeats an ID, lacks a distinct declared integration owner, names an unknown or non-claim comment, or names an edited comment. Any unlisted older or later intent remains unresolved and can still question. A future comment never inherits authorization merely because an earlier ID was listed. This mechanism can make an authorized takeover or release-to-ready consistent; it never makes a candidate safe to claim and never permits automatic takeover.

### Remote-reference claim primitive

`tools/coordination-claim.mjs` is the only supported initial-claim entry point. For issue `<N>`, derivation version 1 is exactly short branch `claim-v1/issue-<N>` and full ref `refs/heads/claim-v1/issue-<N>`, where `<N>` is a canonical positive ASCII base-10 safe integer. The parser is exactly `^claim-v([1-9]\d*)/issue-([1-9]\d*)$`; unsupported reserved versions and malformed or differently numbered names fail closed. Mutable issue, claimant, harness, host, timestamp, title, label, scope, and base metadata are not derivation inputs, and a caller cannot choose another branch.

Immediately before its sole mutation, the claim module verifies that the repository argument and current repository are exactly `money-noodle/money-noodle`, the default branch is `main`, and the expected full base commit equals current remote `main`. It then permits only this create operation:

```http
POST /repos/money-noodle/money-noodle/git/refs

{"ref":"refs/heads/claim-v1/issue-<N>","sha":"<verified-current-remote-main-sha>"}
```

Success requires HTTP 201, an exact response naming the requested ref and commit object, and an agreeing exact-ref read. HTTP 422 is never success: a now-present ref means the contender lost and performs zero registry mutation, while an absent ref is failure. A timeout, conflict, malformed or lost response, server failure, or ref observed after an ambiguous result never grants adoption. No automatic adoption, release, takeover, update, repoint, rename, deletion, rollback, or cleanup capability exists.

A ref already present with a parked body is orphaned and requires principal reconciliation. An agent-owned prepared body without its ref is a contradiction and the ref is never created retroactively. A matching ref plus the exact prepared body may resume only the same operation's incomplete body/label/comment writer surfaces; a conflicting identity, body, comment, or operation marker stops. If ref creation succeeds but no body claim becomes observable, preserve the orphan. If the body succeeds but a later writer surface fails, retry the same operation ID without another ref mutation.

Schema-v2 active/review ownership must use its exact derived branch and have exactly one matching ref. The sole rollout exception is issue #42 on `arch/remote-reference-claim-primitive`, established through the pre-integration body-first protocol; another branch for #42 or that branch on another issue is invalid. Untouched terminal legacy done/abandoned evidence remains preserved without automatic derivation, migration, rename, or ref creation. #42's unintegrated implementation uses mocked ref-host ports only and creates no live remote ref. Activation is blocked while any active/review claim other than that exact #42 bootstrap exists.

## Claim and isolation protocol

Before an execution session edits, either that session or the coordinator acting on its behalf completes the claim steps below. A coordinator-created claim must name the delegated execution session; the coordinator may prepare its branch and worktree but never edits in it. Immediately before its first repository change, the execution session verifies the current status, full issue body and comments, registered scope, identity, branch and host, plus its locally dedicated worktree. It does not replace a matching pre-registered claim, and it stops on any conflict.

The session registering the claim:

1. Fetches refs and runs the coordination status command.
2. Inspects Git status, `git worktree list --porcelain` (including lock reasons), local/remote branches, open PRs, and every active/blocked claim touching the intended scope.
3. Reads the parent plan/dependencies plus the candidate issue's full body and ownership/checkpoint comments. A body or status row saying `work:ready`, `proposed`, or `unclaimed` makes the item only a candidate; it is not proof that nobody has started.
4. Immediately before mutating claim fields, re-fetches that issue's body and comments and re-runs the local worktree/branch inspection. Do not claim from a cached status result.
5. Stops without changing claim metadata or creating another worktree if any comment, branch, locked worktree, harness trail, or unexplained change indicates current or ambiguous prior intent touching the scope. Record the discovery and ask the integration owner or maintainer to reconcile it; do not decide that the apparent earlier claimant is stale or overwrite it.
6. If the double-check is clear, invokes the integrated claim module with the exact current remote-main base, body snapshot, complete proposed ownership/checkpoint, and operation ID. The module derives `claim-v1/issue-<N>`, creates that remote ref first, and only the contender receiving and verifying the qualifying HTTP 201 proceeds to the issue writer. Every loser and every ambiguous result performs zero registry mutation.
7. Re-fetches the issue, exact derived ref, and append-only comments and verifies that its own complete body, sole label, operation comment, branch, host, and ref agree before creating the dedicated local worktree. If any evidence raced or disagrees, stop and preserve it for maintainer resolution. One active claim owns one mutable worktree; agents never share one.
8. Rechecks the registry, reserved refs, comments, and worktrees before expanding scope or changing a shared contract.

Use a meaningful task/session name in any harness that supports naming. Harness-native resume, fork, clone, or session-browser features may help continue work but never replace the issue claim.

A claim is an advisory coordination lease, not a repository lock or permission to bypass review. If overlap appears, stop at a clean boundary, checkpoint both records, and ask the integration owner or maintainer to repartition or serialize work.

## Scoped owned-branch publication

A current, fully reconciled claim normally authorizes its named execution agent to make a normal, non-force push only from its dedicated local worktree and owned typed branch to the remote branch with the identical `Claim-Branch` name. Immediately before pushing, re-fetch the issue body and comments, refs, worktrees, and open pull requests; run coordination status; verify zero warnings; verify the local branch, worktree, commit, registered `Claim-Host`, and current claim all agree; and inspect the outgoing commit and changed paths for public-source safety. A mismatch, warning, unexpected remote head, scope expansion, or uncertain authority stops the push.

This narrow authority permits checkpoint publication only. When the identically named remote branch is already the source branch of an existing pull request, a permitted push automatically advances that pull request's head. The new head immediately invalidates all prior checks and reviews; the applicable checks and reviews must qualify again for the exact current head. This automatic consequence is branch publication, not authority for any separately controlled pull-request operation.

The authority does **not** authorize any of the following:

- pushing the integration branch or any other protected ref;
- creating or pushing a tag;
- pushing another claim's branch or using a differently named remote destination;
- force push, `--force-with-lease`, non-fast-forward update, amend/rebase of published history, or any other history rewrite;
- deleting a branch, tag, worktree, or any other ref, or performing automatic cleanup;
- creating a pull request, changing pull-request metadata, retargeting, closing, reopening, or merging a pull request, or invoking an integration exception;
- integrating, changing host settings, or causing provider or deployment effects.

Pull requests remain the only integration route. Branch publication, a green check, and a complete evidence header prove conditions only; none grants integration, merge, provider, deployment, recovery, or cleanup authority. Branch/ref deletion and cleanup each require separate explicit authorization and never follow automatically from review, integration, expiry, or stale evidence.

The authority is not self-activating. It begins only after issue #40 is integrated into the governing guidance. The #40 implementation branch cannot use the rule it is introducing and requires separate explicit maintainer authorization before its own first push. A later change that widens this authority likewise cannot rely on the unintegrated widening to publish itself.

The current CI branch matrix intentionally remains unchanged. Routine owned-branch pushes therefore continue to run the existing container jobs at higher short-term CI cost; reducing that matrix is separate work and cannot be coupled to checkpoint publication.

## Checkpoints, stale work, and cleanup detection

Checkpoint after meaningful milestones, before a known long wait, and before ending a session. Record the complete machine-readable evidence header above the retained explanatory narrative, including completed evidence, exact branch commit or uncommitted-state warning, changed-path count, honest required-check verdict and immutable run evidence, impacts, residual risks, blockers, next action, and the state-appropriate `Check-In-By` or `Waiting-Since` liveness. Do not emit empty heartbeat noise.

A claim is **suspected stale**, never automatically abandoned, when:

- agent-owned active or review work has an expired, invalid, or unknown `Check-In-By`; a later comment does not extend the structured deadline by itself;
- principal-owned blocked work lacks valid `Waiting-Since` evidence; it never expires and always surfaces rather than becoming automatically stale;
- its branch or host evidence is missing or contradicts the issue, or its dedicated local worktree is missing, locked, prunable, shared, or otherwise inconsistent;
- its PR is merged/closed while the issue remains active;
- it reports active work but has no recoverable branch/commit and an unexplained dirty worktree exists;
- another agent discovers unfinished overlapping changes not represented by a claim.

The status command highlights what it can prove from GitHub and local Git. A ready item is dependency-clear only when `Depends-On` is `none` or every referenced issue is closed with exactly one `Claim-State: done` field and exactly one `work:done` work-state label; duplicate, malformed, additional, missing, self-referential, or ambiguously completed evidence is unknown, while an open dependency is blocked. Claim-bearing open issues remain visible even if a work label is missing, and body/label/comment/schema disagreements become maintainer questions. Implicit-v1 locally observed branch/worktree disagreements also remain questions. The command now proves exact derived-branch/ref presence for schema-v2 ownership, but it cannot enumerate every proprietary harness session or prove host locality and the complete remote lifecycle/checkpoint lag taxonomy; #43 owns that later verification. Mandatory registration remains what makes cross-harness discovery possible.

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
3. makes only a normal owned-branch push under the scoped publication rule above; pull-request creation, metadata changes, retargeting, closing, reopening, and merging still require separate explicit authorization, although the push may advance an existing pull request's source-branch head as described above;
4. sets `work:review`, `work:done`, or `work:abandoned` accurately, or hands the item to its named `Integration-Owner` as principal-owned `work:blocked` with `Waiting-Since`;
5. leaves explicit continuation and cleanup instructions;
6. removes a worktree only after changes are preserved and removal is authorized/safe.

An unfinished agent checkpoints and either remains accurately active with a ticket blocker, completes a principal-owned blocked handoff, or marks the work abandoned; it never leaves an apparently active claim without current liveness. A merged task is not complete until integration checks and, for `main`, production deployment verification succeed.
