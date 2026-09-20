# Version control, publication, and release strategy

## Current source and preserved history

[`../current-status.md`](../current-status.md) owns current source identity, visibility, transfer, host protections, Actions configuration, protected-environment configuration, baseline evidence, and deployment gaps.

Public source distribution under the committed MIT license is intentional and permanent, not a workaround for Actions or branch-protection pricing. Source, issues, pull requests, reviews, commit identities and messages, Actions logs and summaries, artifacts, and caches are public or potentially externally observable. Historical archives remain evidence only: never publish them, merge their historical branches into this repository, or recreate removed refs here. Repository and owner numeric IDs are intentionally not committed; bootstrap reads both from the current repository API.

## Protected trunk and working branches

Create one short-lived branch from current `main` using `<type>/<short-kebab-description>`:

- `arch/` architecture and ADRs;
- `feat/` product behavior;
- `fix/` defects;
- `test/` validation infrastructure;
- `docs/` non-architectural docs;
- `chore/` tooling/maintenance;
- `spike/` disposable uncertainty reduction.

Keep work single-purpose and commits reviewable with imperative subjects. A claimed agent task uses the reserved branch `claim-v1/issue-<N>` and full ref `refs/heads/claim-v1/issue-<N>`, derived from the issue number and created at the current `main` commit by the claim tool described in [`parallel-work.md`](parallel-work.md#claiming-and-status). Create its dedicated worktree at `<canonical-project-root>/.worktrees/issue-<N>`, where the canonical project root is the primary checkout rather than a linked worktree; `.worktrees/` is shared-Git-ignored. Existing `claim-v1/*` refs remain preserved claim evidence and are left alone. Reserved refs are never adopted, released, renamed, repointed, deleted, or cleaned automatically. Incorporate current `main` before integration. Do not commit directly to `main`; merge only after required checks and the applicable review or temporary-exception policy. Protect `main` with required review and checks, no direct push or history rewriting, and the deployment controls in [`../operations/delivery.md`](../operations/delivery.md).

`main` is also the only ref eligible for delivery federation, artifact provenance, and production operations. Deleted migration branches, tags, pull-request refs, forks, other workflows, and sibling repositories must not obtain provider authority.

## Integration checkout

The sole integration checkout is the worktree on full symbolic ref `refs/heads/main`; authored work, merge commits, rebases, resets, conflict resolution, and history rewriting there are forbidden. Its normal state is a clean mirror of the remote `main` head, and a clean ancestor of that head is ordinary fast-forward lag rather than permission to update it. Only a separately authorized clean, conflict-free fast-forward to the verified remote head may change local `main`.

Committed hooks in `.githooks/` refuse authored commits and non-fast-forward merge commits on `refs/heads/main`. They are inert until separately authorized repository-local activation and remain bypassable defense in depth. Review, combined checks, fixes, and conflict resolution stay on the execution branch and its dedicated worktree; no separate scratch integration ceremony is required. Follow the short [pull-request handoff](parallel-work.md#checkpoints-integration-and-publication). Neither hooks nor a mirrored checkout grant pull-request, merge, push, cleanup, provider, or deployment authority.

## Scoped owned-branch publication

For native children, the [delegation contract](parallel-work.md#delegation-contract) owns named-claimant accountability and recovery; a run ending or restarting never transfers or releases its branch reservation.

A current matching claim authorizes its named execution agent to make a normal, non-force push only from the registered branch and dedicated worktree to the identically named remote branch. That remote branch was created atomically at claim time; publication may only fast-forward that same ref after verifying current ownership and the destination under [`parallel-work.md`](parallel-work.md#checkpoints-integration-and-publication). This is checkpoint-publication authority, not general Git or integration authority.

The agent may never use it to push `main` or another integration/protected branch, create or push a tag, push another claim's branch, select a differently named destination, force push, use `--force-with-lease`, make a non-fast-forward update, rewrite published history, or delete any branch, tag, or ref. Cleanup and deletion remain separate explicitly authorized operations and never happen automatically. Pull requests remain mandatory for all integration; a branch push or successful CI run does not authorize opening a pull request, integration, merge, host-control changes, provider effects, or deployment.

An unintegrated widening of publication authority cannot authorize its own publication.

The CI branch matrix remains unchanged. Existing container jobs continue to run on routine owned-branch pushes, accepting the higher short-term CI cost; any matrix reduction requires a separate scoped change.

## Restricted workload source publication target

This is the principal-accepted #68 target, **not installed authority**. Today's dedicated-worktree push rule above remains current until reviewed policy is integrated and the publisher/host transition is separately authorized and qualified. It cannot authorize its own publication. [Claimant delegation](parallel-work.md#fixed-publisher-delegation-target) preserves ownership; [catalog v2](../operations/production-control-plane.md#m1-catalog-v2--selected-not-enabled) owns consent/expiry. No personal token, App key, alternate login or protection bypass is selected if the GITHUB_TOKEN route fails qualification: stop for a new decision.

| Role | Accountable actor / evidence |
| --- | --- |
| Requester | Current named claimant, or explicitly delegated requester bound to that same claim and source permit |
| Publisher | Fixed protected-main `.github/workflows/source-publication.yml` and pinned trusted helpers, using GITHUB_TOKEN |
| Commit author | Genuine workload publication attributed by trusted run/API, exact parent/tree/diff and request marker; author text alone proves nothing |
| Last reviewable pusher / PR creator | Publisher workload identity, proven by actual host event/API evidence, not a cosmetic author substitution |
| Technical reviewer | Independent agent reviews exact candidate; not a second human and cannot approve/merge |
| Human reviewer / merger | Principal reviews and merges after exact-head checks, stale/last-push approval and conversation controls; CI-run approval is separate |

### Source request and algorithm

One comment on the existing claim issue carries canonical ASCII JSON. Dispatch to the fixed main workflow accepts **only** `issueNumber`, `commentId`, `requestDigest`. Retrieve `GET /repos/{repo}/issues/comments/{commentId}` and independently verify the comment's issue association and authenticated requester, not just body identity text.

Required request fields: `schemaVersion`, `requestId`, `claimant`, `delegationRef` (null only for direct claimant), `claimRef`, `expectedClaimSHA`, `controlSourceSHA`, `changesDigest`, `resultTreeSHA`, `approvedPaths`, `maxFiles`, `maxReplacementBytes`, `sourcePermissionRef`, `allowPRCreation`, `changes`, `issuedAt`, `expiresAt`, `requestDigest`. Each change has exact repository-relative regular-file `path`, `action` (add/replace/delete), `expectedOldBlobSHA` (null only for add), and `replacementBase64` (null only for delete). Use the catalog's canonical encoding; changes sorted by path, no duplicates. changesDigest hashes canonical change entries; requestDigest hashes the complete request except requestDigest itself, avoiding recursion.

At most **16 files**, **32 KiB (32768 bytes) total decoded complete replacement contents**, and **48 KiB (49152 bytes) complete ASCII comment**. The replacement bound is not patch size. Count metadata and base64 expansion in the comment bound. Separately cap canonical request metadata at 4 KiB (4096 bytes), measured with each replacementBase64 string replaced by null; reject unknown fields. This leaves 16 KiB below the 65,536-character comment ceiling; #74 must qualify actual API acceptance. Larger replacements are intentionally unsupported, including existing files larger than the replacement cap. Reject rather than split a change across requests or add a broker. This does not cap today's owned-worktree workflow.

1. Validate exact current claim/delegation, permit including explicit PR creation, original expiry, scope, old blobs, byte limits and digest. Reject protected refs, different claims, path traversal, symlinks, submodules, archives, arbitrary URLs, executable request content and shell interpolation. Treat submitted bytes as data, never commands.
2. Reconcile an existing deterministic request marker first: exact parent, tree, actual diff, produced commit and matching PR. A matching author string, semantic no-op, unchanged tree or cosmetic follow-up commit atop already-pushed content cannot qualify as workload publication.
3. Observe the existing claim head; it **must equal expectedClaimSHA**. Construct blobs/tree and one single-parent commit with an actual byte-level semantic change. Recheck ownership immediately before publication. Use Git blobs/trees/commits APIs, then `PATCH /repos/{repo}/git/refs/heads/claim-v1/issue-{N}` with `sha` and `force:false`. This is fast-forward exclusion, not an expected-old-SHA CAS. Conflict stops for a new reviewed request against the new head; never mechanically reparent/rebase.
4. Open the expressly permitted PR using `POST /repos/{repo}/pulls`. Before retrying after a lost acknowledgment, reconcile exact head/base and marker; ambiguous results stop. Never retarget, merge, delete or force-push. A new head invalidates checks/reviews; resubmission cannot manufacture consent or genuine authorship.

The publisher job has `contents:write`, `pull-requests:write`, `issues:read` and **no OIDC**. Only pinned trusted-main helpers and their reviewed dependency closure execute. Never install, build or execute PR/submitted source with the write token. These token permissions are not mechanically confined to one ref: fixed code and host controls are the trusted computing base.

Keep the native `pull_request` opened/synchronize/reopened route in `ci.yml`. Token-created PR activity requires the principal's **Approve workflows to run** CI admission; token pushes alone do not supply checks. That click is **not production consent**. The manual main-only CI baseline is unrelated. #74 records actual review head, tested base, tested merge-ref relation and resulting main commit, with all four required checks (`affected projects and repository gates`, `secret scan`, `container platform-api`, `container web`), stale-review dismissal, genuine last-push approval and conversation resolution. Default PR checkout tests a merge ref; do not mislabel it as the reviewed head or use unrelated green checks. Public PR builds stay read-only/provider-free and never publish provider artifacts.

The target flow has no integration protection bypass. The temporary exception below remains current only under its own conditions; retirement of its host surfaces follows agent identity (#156), not provider enablement. Agent technical review or workload attribution does not invoke it or manufacture human independence.

## Temporary sole-maintainer integration exception

The following exception exists only while the organization has no second maintainer-designated, eligible, independent, and available reviewer. It belongs exclusively to the maintainer acting personally as the human principal. It cannot be delegated to an agent, integration owner, workload identity, automation, outside collaborator, or another principal. Raw write permission does not establish policy designation or availability.

An agent or workload identity cannot invoke the exception, request that it be invoked, infer it from an issue, assignment, successful check, prior bypass, or broad instruction, or treat it as merge authority. Agents may implement and report evidence only within their separately claimed authority; they do not decide that the exception applies and do not perform the merge.

The exception may waive **only** the unavailable independent-review gate. That gate comprises exactly two approval subgates: the required approving review and last-push approval. The exception may waive either or both only because the independent reviewer is unavailable. Every other integration control remains mandatory:

1. Integration still occurs through a pull request. Stale approval never qualifies for either approval subgate, and stale-review dismissal remains in force. Conversation resolution remains mandatory. Direct push to `main`, force push, history rewriting, protection weakening, and any protection bypass beyond the two named approval subgates remain forbidden.
2. Immediately before the exception merge, all four required checks—`affected projects and repository gates`, `secret scan`, `container platform-api`, and `container web`—must have passed for the pull request's exact current head commit. Stale, missing, pending, cancelled, skipped-required, neutral-required, or failed check evidence cannot qualify. Any head change invalidates all previous required-check and exception-evidence qualification; every required check must pass again and the exception evidence must identify the new exact head.
3. The maintainer records durable public evidence identifying the pull request, its exact qualifying head commit, the resulting `main` commit, the specific reason an independent eligible reviewer was unavailable, the approval subgate or subgates waived, and every required check's name, successful conclusion, and run reference for that exact head.
4. The merge must preserve every security, tenant, audit, funded-authority, delivery, and production-approval boundary. A green check, approval, or evidence record proves a condition only; it never grants authority to an agent, workload identity, or automation.

Pull request #49 was merged personally by the maintainer without a review as commit `09d1827d05f9146046da58e5b21212093a49f509`; main CI run 33356799551 passed all four required checks for that merge commit. This is historical evidence for the bootstrap exception, not general authority and not a substitute for exact-current-head evidence on another pull request.

By the principal's 2026-09-18 decision (#74), the maintainer remains the sole reviewer for M1: agents author work, the maintainer reviews and merges it, and no second reviewer is added. The exception continues while the maintainer is the only eligible reviewer and does not expire at provider enablement. It expires immediately when a second maintainer-designated eligible independent reviewer is added; from then on another exception merge is forbidden without waiting for a documentation update. Retirement of the host bypass surface is separately complete only after authorized host-control work:

1. enables branch-protection administrator enforcement;
2. removes the active `OrganizationAdmin` bypass actor from the default-branch `stable` ruleset; and
3. records read-only verification of both resulting controls.

Expiry can precede host-control retirement; it still forbids use of the exception. This documentation does not perform those setting changes and must not be read as claiming that administrator enforcement is enabled.

The exception never authorizes a failed-check bypass, direct or force push, provider authentication, apply, rollback, deployment, or any weakening of `prevent_self_review=true`.

The `production` environment keeps the maintainer as its only required reviewer with `prevent_self_review=true` (#74 decision, 2026-09-18). Since the maintainer's 2026-09-20 decision (#189) a routine deploy — the deploy of `web` and/or `api` an ordinary code merge to `main` triggers through the push Delivery run — declares no environment and never waits there; the pull-request review of the merge is its production consent. The gate applies to non-routine operations only: a dispatched `apply`, `rollback`, or public-access change. One the maintainer did not initiate is approved through the ordinary environment review. One the maintainer initiated themselves cannot be self-approved; for that case only, the maintainer personally may use the environment administrator bypass as the production consent. The bypass is never available to an agent, workload identity or automation, is never requested or assumed by one, applies to one exact waiting operation at a time, and is used only after the four required checks passed on the merged head. GitHub's deployment review history is the durable record of each use. This path retires together with the host bypass surfaces above once agents publish under their own identity (#156). See [`../operations/delivery.md`](../operations/delivery.md) for the independent production boundary and [`../architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md`](../architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md) for the decision rationale.

## Public repository controls

Public visibility is a security boundary, not merely a hosting setting:

- Never place secret payloads, customer or production data, billing/account identifiers, private recovery material, durable provider credentials, or unredacted provider state in source, issues, pull requests, commit metadata, prompts copied into the registry, Actions output, artifacts, or caches. Use the private route in [`../../SECURITY.md`](../../SECURITY.md) for vulnerabilities and accidental disclosure.
- Public pull requests and forks are untrusted. They receive read-only CI without a provider token. Never use `pull_request_target` to execute contributor-controlled source, and never make a pull request or successful check sufficient to obtain deployment authority.
- Every action is pinned to an immutable commit. Every externally downloaded binary is exact-version and checksum verified before execution. The selected-action host allowlist, default permissions, job permissions, dependency/container scans, and full-history scan are reviewed together; no one control proves public code safe.
- OIDC trust is invariantly constrained to this exact repository, protected `refs/heads/main`, `.github/workflows/delivery.yml`, and the closed `push`, `workflow_dispatch`, and `schedule` event set. Pull requests, forks, tags, other branches, workflows, repositories, and events cannot exchange a token.
- Production apply and rollback additionally require configured federation/provider inputs, recorded apply authorization, verified `production` required-reviewer protection, and the environment approval. Apply also requires a typed confirmation. Humans retain explicit scoped approval; automation cannot infer it from a green check.

Current hosted baseline evidence and the observed strict required-check attachment are recorded in [`../current-status.md`](../current-status.md). Continue to leave every Google Cloud repository variable, secret, federation input, and apply authorization unset until separately reviewed bootstrap and remote-validation work supplies and verifies them.

## Tags and releases

Use immutable annotated Semantic Versioning tags (`vMAJOR.MINOR.PATCH`) for accepted platform releases. The first accepted generation release may be `v2.0.0`; that product/API generation label does not name a branch. Tags supplement commit and deployment records and never move.

A qualifying pull-request merge supplies only the exact release permissions defined in the [delivery transition](../operations/delivery.md#current-to-target-activation), after that transition is configured and qualified; it is not general production authorization. Verify the resulting deployment, migrations, health, smoke checks, and telemetry before tagging a release. A commit or tag may be described as deployed only when [`../current-status.md`](../current-status.md) records dated remote deployment evidence.

Rollback through delivery automation to a known digest and release record, never by moving tags or force-pushing shared history. Except for a normal owned-branch push that satisfies the scoped publication rule above, do not push, merge, publish, change visibility or Actions settings, release-tag, alter protected refs, invoke provider APIs, or trigger deployment unless explicitly authorized. When authorized, confirm remote CI/CD and hosting controls rather than assuming local success.
