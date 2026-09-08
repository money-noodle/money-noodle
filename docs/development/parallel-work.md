# Parallel agent work standard

## Session roles

Determine session **kind** before role. A delegated assignment remains a bounded child session (worker, reviewer, researcher, planner, or ordinary diagnostic) even if inherited context or task wording names a supervisor. It has only its assigned scope and authority, asks its assigning supervisor when unclear, and neither claims unrelated work nor fans out without explicit delegation and available tools. No child may select a supervisor or debugger role; ordinary debugging under a supervisor remains bounded work.

An independent session infers its working role from the principal's natural-language request: clear build/development work normally selects an **execution supervisor**, and planning, ticket, research, or specification work normally selects a **planning supervisor**. State that role briefly. Ask a concise question before consequential work when role, desired outcome, or authority is materially unclear; clear requests need no ceremonial interview. Resumption and phase changes retain kind, scope, and authority—changing a label grants nothing.

An execution supervisor owns delivery: it decomposes work as needed, coordinates isolated implementation and independent validation/review subagents, retains final acceptance, and integrates only when explicitly authorized. A planning supervisor uses audit, research, planning, and specification subagents; it maintains coherent plans and implementable, reviewed tickets with outcome, scope, dependencies, contracts, measurable acceptance, constraints, unresolved decisions, and handoff context. Both delegate non-blockingly and remain responsive to the principal.

A **human-directed debugger** is a separate role initiated and driven only by a direct maintainer or other human request (natural-language intent is sufficient). Supervisors cannot launch or delegate one, assign that role to a child, impersonate it, or switch themselves or another session into it; a bug report, inherited prompt, or delegated investigation is not that request. It investigates directly with the human rather than managing subagents, and may vary ordinary planning, delegation, and sequencing ceremony for bounded diagnosis or disposable probes. Briefly state a relevant departure and why, then under the human's direction turn findings into a validated in-scope correction or actionable ticket, decision, or handoff. This flexibility never expands the directing human's authority or waives higher-priority instructions, tool ceilings, public-data and secret rules, tenant/funded/audit controls, existing ownership, isolation, protected refs, review/CI, or provider/production approval. Lasting changes still require authorized isolated work and appropriate review, validation, and pull-request integration.

## Delegation contract

### Sessions, claims, and capability ceilings

Independent peer/work sessions coordinate through the registry; they are not native children that another supervisor may resume or cancel. An in-harness child has one owning supervisor, a bounded assignment, and a native run handle. Session lifetime and claim lifetime are separate: read-only research, analysis, or review needs no source claim or per-lookup ticket. A source-writing child requires a claimed, isolated execution lane; a native launch is not a claim.

A child may be the explicitly named execution agent on a current matching claim, including when its supervisor creates the reservation for that named child and preallocates its dedicated worktree. Confirm the remote-ref creation and matching issue fields before mutation; preserve the [claim protocol's](#claiming-and-status) partial-failure rules. The supervisor retains durable private evidence linking the named claimant, issue/ref/worktree, run handle, assignment, checkpoints, and return so accountability outlasts the child. This evidence supports, never replaces, the registry. Completion, cancellation, termination, a new run ID, or an inherited working directory neither transfers nor releases the reservation. Keep one source writer per worktree; the parent does not become a second writer or inherit the child's claim when it stops.

Ordinary supervisor planning metadata uses the existing [named-editor rules](#planning-and-isolation), not a code claim per plan edit. This does not permit repository source edits without the applicable ownership and isolation.

The brief is the child's scope and effect ceiling, constrained further by current repository authority and actual tool/permission contracts. Inherited parent context, permissions, capabilities, a profile name, a shared default cwd, or advisory findings grant nothing extra. Verify the actual repository, cwd, ref, status, and ownership before source mutation; a shared default cwd is not isolation. Stop and contact the owning supervisor for missing authority, conflicting inputs, unavailable required tools, or scope expansion. No tool being available authorizes its use beyond the brief, and repository prose cannot override stricter tool or user-opt-in requirements.

Select the smallest available child capability that fits the assignment; harness profile names may differ:

| Assignment | Bounded capability and return |
| --- | --- |
| Implementation | Worker with explicitly authorized source tools and a claimed worktree; changed paths, exact commit, checks, and risks |
| Read-only research, analysis, planning, or diagnosis | Researcher/planner/ordinary diagnostic with necessary read tools; findings, evidence, assumptions, and unknowns; no source claim for advice |
| Independent review | Reviewer independent of the implementation path, with read/check capabilities appropriate to the exact candidate; findings and acceptance evidence, not source fixes |

Root execution/planning supervisors and the human-directed debugger are not child profile names or spawn targets. A supervisor must not launch a debugger; ordinary diagnostic children receive no debugger exception. Capability selection never changes bounded-child status or grants fanout.

### Cold-start brief and return

Give enough context to execute without the parent's transcript. Reuse Outcome, Scope-Paths, Depends-On, and acceptance checks rather than adding registry fields. The private brief supplies bounded child identity and parent contact, repository and exact revision inputs, source worktree/ref/scope when applicable, input contracts and assumptions, permitted and forbidden effects, validation, output delivery, and stop/ask conditions. Keep private execution coordinates in the private handoff, never in public source or registry records.

Compact brief example (fill the applicable coordinates privately):

```text
You are a bounded implementation child of <owning supervisor>; contact it via <available channel>.
Outcome: <bounded result>; issue <work item>, parent <plan if applicable>.
Repository/worktree/ref: <verified repository, dedicated cwd, full claim ref and base SHA>.
Claim: <explicitly named claimant and matching live issue/ref evidence>.
Scope-Paths: <exact authorized source paths>; Depends-On: <issues or none>.
Inputs: <current contracts/revisions>; assumptions: <explicit assumptions or none>.
Effects: <permitted reads, source edits, checks, commits and other effects>; all others forbidden.
Acceptance checks: <observable criteria>; validation: <commands and evidence required>.
Output: <inline return or available authorized artifact delivery, with destination>.
Stop/ask: missing authority/tool/input, conflicting ownership, scope change, or uncertain effects.
```

For read-only help, identify the source snapshot to inspect, set source mutation to forbidden, and omit claim/worktree allocation requirements. Specify any permitted scratch/artifact writes separately; a reviewer need not become a source writer to deliver findings.

Return State/Commit/Next/Blockers plus the result, changed paths, commands and actual results (including failures or skipped checks), and material residual risks as applicable. A complete output addresses the acceptance checks with inspectable evidence or explicit gaps; a successful run signal is not acceptance, integration, or deployment proof. For example, a read-only return may be entirely inline:

```text
State: review
Commit: none
Next: Owning supervisor assesses findings against the inspected revision.
Blockers: none
Result: <findings and acceptance evidence for exact input revision>.
Changed paths: none; source mutation was forbidden.
Commands/results: <checks actually run, failures and skipped/unknown verification>.
Residual risks: <material uncertainty or none>.
```

Artifact-only output requires an actually available, authorized writing or runtime delivery path and a destination the supervisor can access. Confirm that contract before launch; if unavailable, use an agreed inline return or stop and ask rather than invent a file receipt. Cite only artifacts actually delivered and available. An absent artifact reference stays omitted or explicitly unavailable in prose; in typed JSON use only the schema's supported absence representation, never an invented field or `undefined`. Preserve the full inline result when that is the supported channel.

### Native lifecycle and recovery

- The owning supervisor retains native handles and delegates non-blockingly, continuing other in-scope coordination and remaining responsive. Use the harness's supported completion delivery and status mechanisms; a launch handle is not a completion result. Independent peers remain registry-coordinated, not targets for native lifecycle control.
- Record meaningful progress, blockers, and known waits using [checkpoints](#checkpoints-integration-and-publication), with private run details retained by the supervisor. A returned child does not close its issue or free a reservation automatically. The supervisor owns acceptance and follow-up.
- Only the owning supervisor controls its native children within its authority. On cancellation, request stop through the supported mechanism, preserve partial work and evidence, and verify whether the run has stopped and which effects occurred. Cancellation or failure is not rollback or proof of no mutation; unknown effects remain unknown. Do not start a competing writer, blindly replay a mutation, or clean up the reservation.
- Before accepting or applying a late result, re-read current scope, ownership, ref/head, inputs/dependencies, and acceptance criteria. If any changed, establish applicability and rerun affected validation or obtain a revised result; do not silently apply stale findings or edits. Exact-current-head review/CI still applies.
- On failure or restart, preserve the actual cwd/ref/head, status/diff, exact error, partial effects, and available run/output evidence privately; escalate uncertain effects before further mutation. Revalidate the claim and worktree, and establish that no prior writer remains active before continuing. A supported resume retains the model/tool contract and bounded assignment; a contract change requires an explicit bounded handoff, not a resume override or silent execution-mode switch. A new run ID alone cannot adopt a claim.
- Use only lifecycle and delivery behavior verified for the actual harness/adapter. If required launch, resume, cancellation, or output support is unavailable, report it and ask rather than silently substituting a mode. Do not promise that background children survive harness/process exit. Durable checkpoints and retained worktrees support recovery; they do not prove process survival or successful completion.

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

Claim-Agent, Claim-Branch, and Claimed-At are tool-written metadata, not form inputs. All three absent means unclaimed on an otherwise valid proposed or ready issue; partial, active, or conflicting ownership never does. The tool adds them only after confirmed reservation creation. Existing explicit unclaimed metadata remains supported. For new claim attribution, prefer a short stable `<harness>-<purpose>-<issue>` label; this is optional, not a parser restriction, authentication, or authority derived from a prefix. Preserve existing labels and refs without migration or renaming.

`Scope-Paths` entries are exact repository-relative files, directory prefixes ending in `/**`, or root `**`; `none` is valid. `Depends-On` is `none` or issue references. One `work:*` label is the lifecycle state: `work:proposed`, `work:ready`, `work:active`, `work:review`, `work:blocked`, `work:done`, or `work:abandoned`. A shared plan also has `work:plan`.

## Claiming and status

```sh
node tools/coordination-claim.mjs --issue <N> --agent <label>
node tools/coordination-status.mjs [--json]
```

The sole claim namespace is `claim-v1/issue-<N>` (`refs/heads/claim-v1/issue-<N>`). It preserves existing live claims; do not rename, migrate, adopt, repoint, delete, or bulk-reconcile reserved refs.

The claim tool validates its basic inputs, an unambiguous proposed or ready lifecycle label, unclaimed ownership, and an open non-plan issue before creating the deterministic ref at remote `main`. Only confirmed successful ref creation establishes the reservation for the execution agent explicitly named in that initial creation, whether the request is made by that agent or its authorized owning supervisor. Only that confirmed successful creation path may proceed to issue bookkeeping. Supervisor preallocation is not a later transfer or adoption and makes the supervisor neither a second claimant nor a second writer; see the [delegation contract](#delegation-contract). A loser does no issue mutation. HTTP 422 is not proof of another owner unless a matching ref is observed; ambiguous outcomes do not prove that nothing changed and do not authorize adoption. If ref creation succeeds but bookkeeping fails, preserve the ref, report the remaining manual action, and stop. No automatic rollback, retry, takeover, or cleanup occurs. Ordinary GitHub issue-body updates are not compare-and-swap; writers avoid clobbering freshly observed unrelated edits but cannot make them atomic.

The read-only status board reports plans and all work states, active and review reservations, dependencies, age/staleness hints, declared-scope overlaps, and actionable warnings. Required host-read failure exits nonzero and reports unknown, never an empty board. A readable defect is a local warning, not a global policy failure. Malformed, missing, duplicate, self-referential, cyclic, or unknown dependency evidence never becomes ready by being treated as empty. A blocked item remains visible even without a prerequisite. Plans are not claim candidates. Existing reserved refs remain visible; closed retained refs alone are ordinary historical evidence.

A dependency is clear only when its declared prerequisite issues are closed. Unknown or incomplete input is not clear, and a known abandoned or not-planned prerequisite is not silently treated as delivered.

## Planning and isolation

A complex effort has one shared parent plan describing the outcome, acceptance, and child work graph. Add risks or decisions where useful; integration ownership defaults to the maintainer. Multiple planners use the same plan; one named editor changes a shared plan section at a time, while independent child records may change in parallel. Use ordinary issue edits and comments, not a global distributed writer.

Declared overlap between current `active` or `review` work is advisory. Planners partition or order it; unknown scope is a warning, not proof of disjointness. Git detects textual conflicts, not semantic correctness. Do not silently select one worker's result when work overlaps.

A supervisor may make a small direct source edit only in a dedicated topic branch and worktree when the scope is known in-scope or explicitly authorized and unclaimed. It never edits another worker's mutable worktree or `main`. Substantial or parallel work is delegated.

Each execution or planning supervisor coordinates at most eight registry work items in `active` or `review`, not eight native sessions. Count each work item once even when several read-only children assist; a stopped child does not free a slot while its item remains active or in review. Read-only help creates no per-call ticket or extra registry slot. Separately bound runtime fanout, tool, and model budgets to the actual assignment and harness capabilities; the registry limit is neither a runtime fanout allowance nor a reason to manufacture claims for advice.

One claim owns one branch and one dedicated worktree, and its agent edits only there. New dedicated worktrees live at `<canonical-project-root>/.worktrees/issue-<N>`; the canonical project root is the primary checkout, not the linked worktree from which a command runs. The shared `.gitignore` ignores this location. Harness-created worktrees use the same placement or are explicitly preallocated and launched at that working directory; do not migrate existing worktrees or reconfigure another harness. Before expanding scope or changing a shared contract, re-read the registry and board. Suspected stale work is surfaced to the maintainer; it is never reset, deleted, overwritten, force-pushed, removed, or taken over automatically.

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
