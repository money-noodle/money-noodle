# Parallel agent work standard

## Registry and records

GitHub Issues are the shared work registry. Chat history, local sessions, worktrees, and harness storage are supporting evidence, never the registry. A **principal** holds authority, an **agent** performs bounded work, and a **workload identity** is a machine credential.

This repository and its issues are public. Do not put secrets, credentials, customer or production data, billing or account identifiers, private recovery material, local filesystem paths, transcripts, or full prompts in issues, comments, branch names, or commits. See [`../../SECURITY.md`](../../SECURITY.md).

Use the Issue Forms at `.github/ISSUE_TEMPLATE/parallel-work.yml` and `.github/ISSUE_TEMPLATE/shared-plan.yml`. Readers accept both GitHub Issue Form heading output and existing `Field: value` lines. Retired fields are ignored; malformed or contradictory surviving fields remain visible rather than being silently repaired.

The work-item form asks only for Outcome, Scope-Paths, Depends-On (default `none`), and Acceptance checks. Put optional parent links and notes in Outcome. The shared-plan form asks only for Outcome and acceptance and Work graph; risks and decisions fit within those sections.

The tools read these structured fields from both new and existing records:

```text
Scope-Paths: none | <comma-space list>
Depends-On: none | #12, #13
Dependency-Notes: <optional prose>
Claim-Agent: unclaimed | <short label>
Claim-Branch: none | claim-v1/issue-<N>
Claimed-At: none | <ISO-8601 instant>
Integration-Owner: <optional github-login; defaults to maintainer>
Parent-Plan: <optional issue reference>
```

Claim-Agent, Claim-Branch, and Claimed-At are tool-written metadata, not form inputs. All three absent means unclaimed on an otherwise valid proposed or ready issue; partial, active, or conflicting ownership never does. The tool adds them only after confirmed reservation creation. Existing explicit unclaimed metadata remains supported.

`Scope-Paths` entries are exact repository-relative files, directory prefixes ending in `/**`, or root `**`; `none` is valid. `Depends-On` is `none` or issue references. One `work:*` label is the lifecycle state: `work:proposed`, `work:ready`, `work:active`, `work:review`, `work:blocked`, `work:done`, or `work:abandoned`. A shared plan also has `work:plan`.

## Claiming and status

```sh
node tools/coordination-claim.mjs --issue <N> --agent <label>
node tools/coordination-status.mjs [--json]
```

The sole claim namespace is `claim-v1/issue-<N>` (`refs/heads/claim-v1/issue-<N>`). It preserves existing live claims; do not rename, migrate, adopt, repoint, delete, or bulk-reconcile reserved refs.

The claim tool validates its basic inputs, an unambiguous proposed or ready lifecycle label, unclaimed ownership, and an open non-plan issue before creating the deterministic ref at remote `main`. Only a confirmed create success establishes the creator's reservation. A loser does no issue mutation. HTTP 422 is not proof of another owner unless a matching ref is observed; ambiguous outcomes do not prove that nothing changed and do not authorize adoption. If ref creation succeeds but bookkeeping fails, preserve the ref, report the remaining manual action, and stop. No automatic rollback, retry, takeover, or cleanup occurs. Ordinary GitHub issue-body updates are not compare-and-swap; writers avoid clobbering freshly observed unrelated edits but cannot make them atomic.

The read-only status board reports plans and all work states, active and review reservations, dependencies, age/staleness hints, declared-scope overlaps, and actionable warnings. Required host-read failure exits nonzero and reports unknown, never an empty board. A readable defect is a local warning, not a global policy failure. Malformed, missing, duplicate, self-referential, cyclic, or unknown dependency evidence never becomes ready by being treated as empty. A blocked item remains visible even without a prerequisite. Plans are not claim candidates. Existing reserved refs remain visible; closed retained refs alone are ordinary historical evidence.

A dependency is clear only when its declared prerequisite issues are closed. Unknown or incomplete input is not clear, and a known abandoned or not-planned prerequisite is not silently treated as delivered.

## Planning and isolation

A complex effort has one shared parent plan describing the outcome, acceptance, and child work graph. Add risks or decisions where useful; integration ownership defaults to the maintainer. Multiple planners use the same plan; one named editor changes a shared plan section at a time, while independent child records may change in parallel. Use ordinary issue edits and comments, not a global distributed writer.

Declared overlap between current `active` or `review` work is advisory. Planners partition or order it; unknown scope is a warning, not proof of disjointness. Git detects textual conflicts, not semantic correctness. Do not silently select one worker's result when work overlaps.

A planner may make a small direct edit only in a dedicated topic branch and worktree when the scope is known in-scope or explicitly authorized and unclaimed. It never edits another worker's mutable worktree or `main`. Substantial or parallel work is delegated. A planner has at most eight active or review children.

One claim owns one branch and one dedicated worktree, and its agent edits only there. Before expanding scope or changing a shared contract, re-read the registry and board. Suspected stale work is surfaced to the maintainer; it is never reset, deleted, overwritten, force-pushed, removed, or taken over automatically.

## Checkpoints, integration, and publication

Append a checkpoint when state changes meaningfully, before a known long wait, and before ending a session:

```text
State: <active|review|done|abandoned|blocked>
Commit: <full SHA or none>
Next: <one line>
Blockers: <one line or none>
```

Add concise useful narrative or a CI link as needed. Run focused local checks while working and one combined `pnpm check` before handoff when the combined workspace is available. Required hosted checks remain required on the exact current head; local results and CI results are not deployment validation. Verify deployment only when the affected component is deployed and such verification is configured; a task without a deployed component does not wait for a nonexistent deployment.

A current matching claim authorizes only a normal, non-force push of its named branch from its dedicated worktree to the identically named remote branch. It never authorizes a push to `main`, tags, another branch, force push, history rewrite, deletion, pull-request mutation, merge, provider action, or deployment. Pull requests remain the only integration route.

For integration, review the scope and diff, run focused local checks while working and the applicable combined check once, then push the owned branch when authorized. Open one explicitly authorized pull request with a few sentences on changes, tests, and risks. Link related issues, using a closing keyword when fully satisfied, rather than duplicating completion records. Use GitHub's required review and CI on the exact current head; the principal merges. No hold record, scratch integration worktree, duplicate checkpoint evidence, or issue-body edit merely to recopy CI is required.

The integration owner manages contracts, merge order, compatibility, and acceptance. Planner or worker status does not confer integration authority. Fixes and conflicts stay on the execution branch; never hand-edit the integration checkout.

A dedicated worktree persists while agent-owned. Cleanup is separately authorized. Do not infer content preservation from ancestry or `git cherry`; use the merged pull request or a reviewed content comparison appropriate to the changed paths.

## The temporary integration exception is not agent authority

[`version-control.md`](version-control.md#temporary-sole-maintainer-integration-exception) exclusively owns the temporary sole-maintainer exception, including its exact approval, check, evidence, expiry, provider, security, tenant, audit, and funded-authority conditions. Only the maintainer acting personally as the human principal may use it. It is never agent, planner, integration-owner, workload-identity, automation, or collaborator authority.
