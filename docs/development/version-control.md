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

Keep work single-purpose and commits reviewable with imperative subjects. Initial post-#42 claims use the remote reference represented by the reserved derived branch `claim-v1/issue-<N>` and full ref `refs/heads/claim-v1/issue-<N>`; the dedicated claim module creates that ref at the verified current `main` commit before writing ownership. The exact #42 bootstrap branch `arch/remote-reference-claim-primitive` is the sole pre-activation exception. Reserved refs are never adopted, released, renamed, repointed, deleted, or cleaned automatically. Incorporate current `main` before integration. Do not commit directly to `main`; merge only after required checks and the applicable review or temporary-exception policy. Protect `main` with required review and checks, no direct push or history rewriting, and the deployment controls in [`../operations/delivery.md`](../operations/delivery.md).

`main` is also the only ref eligible for delivery federation, artifact provenance, and production operations. Deleted migration branches, tags, pull-request refs, forks, other workflows, and sibling repositories must not obtain provider authority.

## Scoped owned-branch publication

A current matching claim normally authorizes its named execution agent to make a normal, non-force push only from the registered typed branch and worktree to the identically named remote branch. For a derived claim, the remote branch was created atomically at claim time; publication may only fast-forward that same ref after the complete pre-push checks. The agent follows the pre-push verification and exact checkpoint-evidence contract in [`parallel-work.md`](parallel-work.md#scoped-owned-branch-publication). This is checkpoint-publication authority, not general Git or integration authority.

The agent may never use it to push `main` or another integration/protected branch, create or push a tag, push another claim's branch, select a differently named destination, force push, use `--force-with-lease`, make a non-fast-forward update, rewrite published history, or delete any branch, tag, or ref. Cleanup and deletion remain separate explicitly authorized operations and never happen automatically. Pull requests remain mandatory for all integration; a branch push or successful CI run does not authorize opening a pull request, integration, merge, host-control changes, provider effects, or deployment.

The rule becomes available only after the change introducing it is integrated. It therefore does not authorize publication of the issue #40 implementation branch; that branch requires separate explicit maintainer authorization before any push. A future unintegrated widening cannot authorize its own publication either.

The CI branch matrix remains unchanged. Existing container jobs continue to run on routine owned-branch pushes, accepting the higher short-term CI cost; any matrix reduction requires a separate scoped change.

## Temporary sole-maintainer integration exception

The following exception exists only while the organization has no second maintainer-designated, eligible, independent, and available reviewer. It belongs exclusively to the maintainer acting personally as the human principal. It cannot be delegated to an agent, integration owner, workload identity, automation, outside collaborator, or another principal. Raw write permission does not establish policy designation or availability.

An agent or workload identity cannot invoke the exception, request that it be invoked, infer it from an issue, assignment, successful check, prior bypass, or broad instruction, or treat it as merge authority. Agents may implement and report evidence only within their separately claimed authority; they do not decide that the exception applies and do not perform the merge.

The exception may waive **only** the unavailable independent-review gate. That gate comprises exactly two approval subgates: the required approving review and last-push approval. The exception may waive either or both only because the independent reviewer is unavailable. Every other integration control remains mandatory:

1. Integration still occurs through a pull request. Stale approval never qualifies for either approval subgate, and stale-review dismissal remains in force. Conversation resolution remains mandatory. Direct push to `main`, force push, history rewriting, protection weakening, and any protection bypass beyond the two named approval subgates remain forbidden.
2. Immediately before the exception merge, all four required checks—`affected projects and repository gates`, `secret scan`, `container platform-api`, and `container web`—must have passed for the pull request's exact current head commit. Stale, missing, pending, cancelled, skipped-required, neutral-required, or failed check evidence cannot qualify. Any head change invalidates all previous required-check and exception-evidence qualification; every required check must pass again and the exception evidence must identify the new exact head.
3. The maintainer records durable public evidence identifying the pull request, its exact qualifying head commit, the resulting `main` commit, the specific reason an independent eligible reviewer was unavailable, the approval subgate or subgates waived, and every required check's name, successful conclusion, and run reference for that exact head.
4. The merge must preserve every security, tenant, audit, funded-authority, delivery, and production-approval boundary. A green check, approval, or evidence record proves a condition only; it never grants authority to an agent, workload identity, or automation.

Pull request #49 was merged personally by the maintainer without a review as commit `09d1827d05f9146046da58e5b21212093a49f509`; main CI run 33356799551 passed all four required checks for that merge commit. This is historical evidence for the bootstrap exception, not general authority and not a substitute for exact-current-head evidence on another pull request.

The exception expires immediately when a second maintainer-designated eligible independent reviewer is added, or before provider delivery is enabled, whichever happens first. Once either condition is reached, another exception merge is forbidden without waiting for a documentation update. Retirement of the host bypass surface is separately complete only after authorized host-control work:

1. enables branch-protection administrator enforcement;
2. removes the active `OrganizationAdmin` bypass actor from the default-branch `stable` ruleset; and
3. records read-only verification of both resulting controls.

Expiry can precede host-control retirement; it still forbids use of the exception. This documentation does not perform those setting changes and must not be read as claiming that administrator enforcement is enabled.

The exception never authorizes a failed-check bypass, direct or force push, provider authentication, environment administrator bypass, production self-review, apply, rollback, deployment, or any weakening of `prevent_self_review=true`. Provider delivery must remain disabled until the exception has expired and the retirement controls above are complete. See [`../operations/delivery.md`](../operations/delivery.md) for the independent production boundary and [`../architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md`](../architecture/decisions/ADR-0011-agent-coordination-and-isolation-protocol.md) for the decision rationale.

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

A pull-request merge to protected `main` that satisfies the applicable integration policy is production authorization only after delivery is configured. Verify the resulting deployment, migrations, health, smoke checks, and telemetry before tagging a release. A commit or tag may be described as deployed only when [`../current-status.md`](../current-status.md) records dated remote deployment evidence.

Rollback through delivery automation to a known digest and release record, never by moving tags or force-pushing shared history. Except for a normal owned-branch push that satisfies the scoped publication rule above, do not push, merge, publish, change visibility or Actions settings, release-tag, alter protected refs, invoke provider APIs, or trigger deployment unless explicitly authorized. When authorized, confirm remote CI/CD and hosting controls rather than assuming local success.
