# Version control, publication, and release strategy

## Current source and preserved history

- `main` is the sole integration and delivery branch in the public GitHub Free organization repository `money-noodle/money-noodle`. Its public delivery history is one intentionally squashed root snapshot; it does not preserve private development history or migration-diary detail.
- The personal `phairow/money-noodle-private-archive` preserves the private development and prior-generation history. It is historical evidence, not an integration remote or a source of current authority. Never publish it, merge its historical branches into this repository, or recreate removed refs here.
- Public source distribution under the committed MIT license is intentional and permanent, not a workaround for Actions or branch-protection pricing. Source, issues, pull requests, reviews, commit identities and messages, Actions logs and summaries, artifacts, and caches are public or potentially externally observable.
- The 2026-08-30 transfer from the personal source repository preserved the immutable repository ID, issues, pull requests, branches, and host protections. The repository and owner numeric IDs are intentionally not committed; bootstrap reads both from the current repository API.
- As of 2026-08-30, Actions are enabled with read-only default workflow permission, host-enforced full-SHA action pinning, and a selected-action allowlist that includes Trivy's pinned transitive `aquasecurity/setup-trivy` action. Private vulnerability reporting, secret scanning, and secret-scanning push protection are enabled. `main` protection strictly requires `affected projects and repository gates`, `secret scan`, `container platform-api`, and `container web`, plus one approval, stale-review dismissal, last-push approval, conversation resolution, admin enforcement, and no force push or deletion.
- The `production` environment has a protected-branch policy and required owner reviewer with `prevent_self_review=true`. The initiating actor therefore needs a distinct eligible actor to approve a deployment; the configured owner reviewer alone is not sufficient deployment authority. No repository provider/apply variable or secret, Google Cloud federation, or deployment exists, so provider effects remain mechanically blocked independently of that approval.

## Protected trunk and working branches

Create one short-lived branch from current `main` using `<type>/<short-kebab-description>`:

- `arch/` architecture and ADRs;
- `feat/` product behavior;
- `fix/` defects;
- `test/` validation infrastructure;
- `docs/` non-architectural docs;
- `chore/` tooling/maintenance;
- `spike/` disposable uncertainty reduction.

Keep work single-purpose and commits reviewable with imperative subjects. Incorporate current `main` before integration. Do not commit directly to `main`; merge only after review and required checks. Protect `main` with required review and checks, no direct push or history rewriting, and the deployment controls in [`../operations/delivery.md`](../operations/delivery.md).

`main` is also the only ref eligible for delivery federation, artifact provenance, and production operations. Deleted migration branches, tags, pull-request refs, forks, other workflows, and sibling repositories must not obtain provider authority.

## Public repository controls

Public visibility is a security boundary, not merely a hosting setting:

- Never place secret payloads, customer or production data, billing/account identifiers, private recovery material, durable provider credentials, or unredacted provider state in source, issues, pull requests, commit metadata, prompts copied into the registry, Actions output, artifacts, or caches. Use the private route in [`../../SECURITY.md`](../../SECURITY.md) for vulnerabilities and accidental disclosure.
- Public pull requests and forks are untrusted. They receive read-only CI without a provider token. Never use `pull_request_target` to execute contributor-controlled source, and never make a pull request or successful check sufficient to obtain deployment authority.
- Every action is pinned to an immutable commit. Every externally downloaded binary is exact-version and checksum verified before execution. The selected-action host allowlist, default permissions, job permissions, dependency/container scans, and full-history scan are reviewed together; no one control proves public code safe.
- OIDC trust is invariantly constrained to this exact repository, protected `refs/heads/main`, `.github/workflows/delivery.yml`, and the closed `push`, `workflow_dispatch`, and `schedule` event set. Pull requests, forks, tags, other branches, workflows, repositories, and events cannot exchange a token.
- Production apply and rollback additionally require configured federation/provider inputs, recorded apply authorization, verified `production` required-reviewer protection, and the environment approval. Apply also requires a typed confirmation. Humans retain explicit scoped approval; automation cannot infer it from a green check.

The initial hosted manual baseline on `main`, [run 33292553091](https://github.com/money-noodle/money-noodle/actions/runs/33292553091), completed successfully on 2026-08-30. It exercised the repository gates, OpenTofu 1.12.6 format/validation/mocked tests with no provider credential, nonzero full-history Gitleaks coverage, both OCI builds, SBOM/provenance generation, and image-vulnerability scanning. This is hosted CI evidence, not provider or deployment validation.

The four observed CI contexts are attached to `main` protection in strict mode. Continue to leave every Google Cloud repository variable, secret, federation input, and apply authorization unset until separately reviewed bootstrap and remote-validation work supplies and verifies them.

## Tags and releases

Use immutable annotated Semantic Versioning tags (`vMAJOR.MINOR.PATCH`) for accepted platform releases. The first accepted generation release may be `v2.0.0`; that product/API generation label does not name a branch. Tags supplement commit and deployment records and never move.

A reviewed merge to protected `main` is production authorization only after delivery is configured. Verify the resulting deployment, migrations, health, smoke checks, and telemetry before tagging a release. At present no Google Cloud project resource, workload-identity federation, or remote deployment exists, so no commit or tag may be described as deployed.

Rollback through delivery automation to a known digest and release record, never by moving tags or force-pushing shared history. Do not push, merge, publish, change visibility or Actions settings, release-tag, alter protected refs, invoke provider APIs, or trigger deployment unless explicitly authorized. When authorized, confirm remote CI/CD and hosting controls rather than assuming local success.
