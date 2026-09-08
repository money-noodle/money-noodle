# Parallel agent work standard

## Registry and terms

GitHub Issues are the work registry: remote, branch-independent, auditable, and visible across harnesses, worktrees, and machines. Chat history, local session lists, worktrees, and harness storage are supporting evidence, never the registry. A **principal** is a person holding authority, an **agent** is an AI session executing bounded work, and a **workload identity** is a machine credential something runs as.

Harness bridge files such as `CLAUDE.md` and `.github/copilot-instructions.md` only route agents to root `AGENTS.md`; they never duplicate requirements or status. Pi discovers `AGENTS.md` directly and needs no bridge.

This repository and its issues are public. Never put secrets, credentials, customer or production data, billing or account identifiers, private recovery material, local filesystem paths, transcripts, or full prompts into an issue, comment, branch name, or commit message.

## Issue body schema

Use the Issue Forms at `.github/ISSUE_TEMPLATE/parallel-work.yml` and `.github/ISSUE_TEMPLATE/shared-plan.yml` and keep their field names so tooling stays portable.

```text
Scope-Paths: none | <comma-space list>
Depends-On: none | #12, #13
Dependency-Notes: <free prose or none>
Claim-Agent: unclaimed | <short label>
Claim-Branch: none | claim/issue-<N>
Claimed-At: none | <ISO-8601 instant>
Integration-Owner: <github-login>
```

A `Scope-Paths` entry is one exact repository-relative file, a literal directory prefix ending in `/**`, or root `**`. Entries are comma-space separated, unique, and sorted, and are read as literal POSIX repository paths. `Depends-On` is `none` or a comma-space list of issue references; explanatory prose belongs in `Dependency-Notes`.

Work state lives in exactly one `work:*` label — `work:proposed`, `work:ready`, `work:active`, `work:review`, `work:done`, `work:abandoned` — plus `work:plan` on a shared plan and `area:*` where useful. The label is the single source of state; the body carries no separate state field.

## Claiming work

Creating the remote reference is the claim, because that creation is atomic. Issue `<N>` derives branch `claim/issue-<N>` and ref `refs/heads/claim/issue-<N>`.

```sh
node tools/coordination-claim.mjs --issue <N> --agent <label>
```

The tool requires the issue to be open, to carry exactly one of `work:proposed` or `work:ready`, and to have `Claim-Agent: unclaimed`. It then creates the ref at the current remote `main` commit. HTTP 201 means the claim is yours: the tool writes the claim fields, swaps the label to `work:active`, and prints the branch and the exact `git worktree add` command. HTTP 422 means another agent claimed it first — nothing is mutated, the holder is printed, and the tool exits nonzero. Any other result also mutates nothing.

If ref creation succeeds but a later issue update fails, the tool prints the exact remaining manual step and exits nonzero. Perform that step or ask the maintainer. Nothing is rolled back, adopted, released, renamed, or deleted automatically, and a ref is never created retroactively for an already-written claim.

Existing `claim-v1/*` refs are historical evidence. Leave them alone.

One claim owns one branch and one dedicated worktree, and its agent edits only there. Two sessions never share a worktree. Before expanding scope or changing a shared contract, re-read the registry and re-check the board.

## Status board

```sh
node tools/coordination-status.mjs [--json]
```

Read-only. It reports active claims (issue, agent, branch, scope paths, age since `Claimed-At`); ready work whose `Depends-On` issues are all closed; blocked work with its open dependencies named; proposed work; scope overlaps between active claims; and warnings for malformed fields, a claim ref with no matching active issue, an active issue with no claim ref, and a claim older than three days.

It exits nonzero only when it genuinely cannot read the registry — network, authentication, or a malformed API response — never as a policy signal. It is a triage aid, not a lock: a row reading `unclaimed` makes an item a candidate, not proof that nobody has started. An unreachable registry means unknown, never empty.

## Plan for parallelism

A complex effort starts as one shared parent plan, normally a parent issue with a version-controlled plan document linked when the design needs diagrams or detail. The plan owns the outcome, work graph, acceptance, risks, integration owner, and completion state. Private per-session plans are temporary reasoning and cannot silently diverge from it.

Create a child issue only where the unit has one independently verifiable outcome, declared scope and exclusions, declared dependencies, and acceptance checks. Represent dependencies as a directed acyclic graph and group ready items into waves. Parallelize across stable boundaries; serialize shared decisions and contract changes. Prefer contract-first work: one owner changes an OpenAPI, schema, or event contract, then consumers work against the accepted version. Do not split work merely to keep agents busy.

Declared `Scope-Paths` overlap between two active claims is a **warning** on the board, not a block. The planner narrows scope or serializes the work; Git's own merge remains the real backstop for conflicting edits. Tasks are not safely parallel when they touch the same source, migration sequence, lockfile, generated artifact, decision record, or infrastructure state unless one task explicitly owns integration.

A planner holds at most **eight** concurrently dispatched execution sessions, counting its own active and review claims. This bounds unreviewed work per planner; the maintainer owns the repository-wide total and may raise or lower the cap for a specific effort.

## Roles

A **planner** plans, breaks work into issues, reviews returned work, and integrates when explicitly authorized. A planner may make a small edit directly when the change is small and no active claim covers those paths — still on a typed branch, still through a pull request. It delegates when the work is substantial or when several sessions run in parallel. Several planners may run concurrently; they share no local state, so what another session has claimed comes from the registry and refs, never from a session list or worktree inspection.

The hard rule: **no hand-editing in the integration checkout while integrating someone else's work.** Authorized integration applies reviewed commits and creates normal merge metadata; conflicts, corrections, and drive-by fixes go back to the execution branch.

A **worker** is an execution session that takes one claim, one branch, and one dedicated worktree, and edits only there. It validates and commits in that worktree and hands the result back for review.

## Checkpoint comments

When state meaningfully changes, append a comment. Comments are appended, never edited or deleted.

```text
State: <active|review|done|abandoned|blocked>
Commit: <full sha or none>
Next: <one line>
Blockers: <one line or none>
```

That is the whole header; explanatory narrative goes beneath it. CI results live in GitHub authoritatively — link a run rather than transcribing verdicts. Checkpoint after meaningful milestones, before a known long wait, and before ending a session. Do not emit empty heartbeat noise.

## Publication

A current matching claim authorizes its named agent to make a normal, non-force push only from its dedicated worktree and owned branch to the remote branch of the identical name. Before pushing, confirm the local branch, worktree, commit, and current claim agree, and inspect the outgoing changed paths for public-source safety.

This authority permits checkpoint publication only. It does not authorize pushing `main` or any other protected ref; creating or pushing a tag; pushing another claim's branch or a differently named destination; force push, `--force-with-lease`, non-fast-forward update, or any history rewrite; deleting a branch, tag, worktree, or ref; creating or modifying a pull request; merging; or causing provider or deployment effects. Pull requests remain the only integration route. When the remote branch is already a pull request's source, a permitted push advances that head and immediately invalidates prior checks and reviews.

## Staleness

A claim whose `Claimed-At` is older than three days surfaces on the board as a warning. There is no automatic expiry, takeover, release, or cleanup. Also treat as suspected stale a claim whose branch is missing or contradicts the issue, whose dedicated worktree is missing or locked, whose pull request is merged or closed while the issue stays active, or where an agent finds unfinished overlapping changes no claim represents.

Surface suspected stale work to the maintainer with a proposed recovery path and ask whether to resume, hand off, clean up, or abandon it. Planning unfinished work is allowed; claiming or modifying it is not. Never reset, delete, overwrite, force-push, remove a worktree, or take over another claim automatically. On an approved takeover, preserve prior branches and history, record the authorization, replace the claim metadata, and validate inherited work before trusting it.

## Integration and completion

The integration owner manages shared contracts, merge order, compatibility, and final acceptance. Planner status confers neither integration ownership nor permission to push or merge. Delegated commits get review and required checks before an authorized, conflict-free integration. Never resolve overlap by silently selecting one agent's output.

Before releasing a claim, the agent runs the affected checks, records commits and evidence, sets `work:review`, `work:done`, or `work:abandoned` accurately (or hands the item to its `Integration-Owner` as `work:blocked`), and leaves continuation notes. A merged task is not complete until integration checks and, for `main`, deployment verification succeed.

A dedicated worktree persists while its claim is agent-owned. It is retired once the claim is `done` or `abandoned` and the work is in the integration branch — proved by patch identity, because squash merges make ancestry checks report merged work as unmerged. `git cherry <integration-branch> <branch>` reporting no `+` commits is that proof. Retiring a worktree never deletes its branch or ref.

## The temporary integration exception is not agent authority

[`version-control.md`](version-control.md#temporary-sole-maintainer-integration-exception) defines a temporary exception under which only the maintainer, acting personally as the human principal, may waive unavailable independent pull-request approval. It is not planner, execution-session, integration-owner, workload-identity, automation, or collaborator authority. An agent or workload identity cannot invoke it, request that it be invoked, infer it from an issue, assignment, green check, successful run, prior bypass, or broad instruction, or treat it as authority to merge. A claim, a completed acceptance checklist, a successful required check, or an instruction to prepare a pull request establishes none of it. Agents stop after their authorized implementation, checks, commit, and handoff.
