# Version control, publication, and release strategy

## Current source and preserved history

- `main` is the sole integration and delivery branch in `phairow/money-noodle`. It contains one root commit, `e312a6fdd5034933e595b14843dd30c300c010de`, with tree `94f6a37695412f9c4b0397711567c238a9cf71e1`.
- `phairow/money-noodle-private-archive` preserves the private development and prior-generation history. It is historical evidence, not an integration remote or a source of current authority. Never publish it, merge its historical branches into this repository, or recreate removed refs here.
- The source repository is intentionally becoming public under the committed MIT license. Publication exposes the snapshot permanently to copying and forking; it is a deliberate source-distribution decision, not a temporary workaround for Actions or branch-protection pricing.
- The source repository is still private and GitHub Actions are disabled while the main/public control migration is reviewed. No visibility, Actions, protection, or provider change is authorized by a repository commit alone.

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

## Controlled publication and Actions sequence

The maintainer performs these repository-hosting operations separately from code integration. Keep Actions disabled and allow no intervening merge while the controls are changing.

1. Integrate and locally validate the reviewed main/public migration while the source repository remains private and Actions remain disabled.
2. Change only the source repository visibility to public, recognizing that this makes the squashed snapshot externally copyable. Keep the private archive private.
3. Configure and inspect `main` protection: one required reviewer, required CI checks after their names exist, no direct push, no force push, and no deletion. Do not treat committed workflow YAML as evidence of host-side protection.
4. Re-enable Actions with the repository's restricted default permissions. Run CI manually on `main`. Its prerequisite step fails unless reachable commit and root-snapshot path counts are both nonzero. CI downloads the exact official Gitleaks 8.24.3 Linux x64 archive, verifies its independently checked release SHA-256 before execution, and explicitly scans `--all` reachable history on every push, pull request, and manual run. The scanner log is withheld and parsed mechanically; accept the hosted baseline only when it reports nonzero commits and bytes scanned with no finding. The same manual run executes OpenTofu 1.12.6 format, validation, and mocked-provider tests without an OIDC token or provider credential. Record that run and result before accepting ordinary pull requests.
5. Verify required check names and attach them to `main` protection. Re-run a pull request through the protected path before treating merges as authorized.
6. Leave every Google Cloud repository variable and apply authorization unset. Provider delivery stays skipped until the separately reviewed bootstrap and remote-validation work supplies and verifies them.

Public pull requests and forks are untrusted. They receive read-only CI without provider credentials; do not use `pull_request_target` to execute contributor-controlled source. Pinned third-party actions, least-privilege job permissions, dependency/container scans, and the full-history manual secret baseline are publication controls, not proof that public code is safe to deploy.

## Tags and releases

Use immutable annotated Semantic Versioning tags (`vMAJOR.MINOR.PATCH`) for accepted platform releases. The first accepted generation release may be `v2.0.0`; that product/API generation label does not name a branch. Tags supplement commit and deployment records and never move.

A reviewed merge to protected `main` is production authorization only after delivery is configured. Verify the resulting deployment, migrations, health, smoke checks, and telemetry before tagging a release. At present no Google Cloud project resource, workload-identity federation, or remote deployment exists, so no commit or tag may be described as deployed.

Rollback through delivery automation to a known digest and release record, never by moving tags or force-pushing shared history. Do not push, merge, publish, change visibility or Actions settings, release-tag, alter protected refs, invoke provider APIs, or trigger deployment unless explicitly authorized. When authorized, confirm remote CI/CD and hosting controls rather than assuming local success.
