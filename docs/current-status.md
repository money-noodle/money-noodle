# Current repository status

> **Status:** Current implemented, hosted, and deployment truth
> **Host controls last verified:** 2026-08-31T07:55:00Z
> **Scope:** Volatile repository ownership, host configuration, validation evidence, and deployment gaps

This document owns current repository and host truth. Architecture documents own accepted boundaries and intent, engineering standards own command contracts, and dated evidence keeps its original as-of context. Entry points link here rather than repeating facts that can change through GitHub configuration or delivery work.

## Repository and host controls

- The GitHub Free `money-noodle` organization owns the public MIT-licensed source repository `money-noodle/money-noodle`. Protected `main` is its sole integration and delivery branch.
- Public history begins with one intentionally squashed root snapshot. The personal `phairow/money-noodle-private-archive` privately preserves development and prior-generation history; it is historical evidence, never current authority or a delivery source. The transfer preserved the public repository's immutable ID, issues, pull requests, branches, and host protections.
- Organization membership reports only the maintainer as an active organization administrator. The repository reports two write-role outside collaborators, but raw repository permission or outside-collaborator status does not make either person a maintainer-designated, eligible, independent, and available reviewer.
- GitHub Actions are enabled with read-only default workflow permissions, host-enforced full-SHA action pinning, and a selected-action allowlist that includes Trivy's pinned transitive `aquasecurity/setup-trivy` action. Private vulnerability reporting, secret scanning, and secret-scanning push protection are enabled.
- Strict `main` protection requires `affected projects and repository gates`, `secret scan`, `container platform-api`, and `container web`. It also requires one approval, stale-review dismissal, approval of the latest push, and conversation resolution, and it prohibits force pushes and deletion. Branch-protection administrator enforcement is currently disabled.
- The active default-branch `stable` ruleset separately requires pull-request controls and has an always-allowed `OrganizationAdmin` bypass actor. [`development/version-control.md#temporary-sole-maintainer-integration-exception`](development/version-control.md#temporary-sole-maintainer-integration-exception) owns the narrow stable policy for that temporary host exception and its retirement.
- The protected `production` environment is restricted to protected branches, has only the maintainer as required reviewer, sets `prevent_self_review=true`, and reports administrator bypass capability. The initiating actor therefore needs a distinct eligible actor to approve a deployment; the configured owner reviewer alone is not sufficient deployment authority, and policy forbids use of the environment administrator bypass.

## Implementation, validation, and deployment

- The first-slice workspace implements pnpm/Nx projects for the Next.js web, Fastify platform API, API-owned OpenAPI document, generated TypeScript client, and separate OCI artifacts. The accepted [`architecture source and deployment map`](architecture/overview.md#source-and-deployment-map) owns the detailed paths and boundaries.
- The initial hosted `main` baseline, [run 33292553091](https://github.com/money-noodle/money-noodle/actions/runs/33292553091), passed on 2026-08-30. It exercised repository gates, OpenTofu 1.12.6 formatting, validation, and mocked tests without provider credentials, nonzero full-history Gitleaks coverage, both OCI builds, SBOM and provenance generation, and image-vulnerability scanning. This is hosted CI evidence, not provider or deployment validation.
- The platform-status behavior is implemented and locally and CI validated. Hosted CI covers affected formatting, lint, types, tests and coverage, contracts, builds, dependency and full-history secret scans, no-provider OpenTofu checks, container builds, provenance and SBOM generation, and HIGH/CRITICAL image-vulnerability gates.
- Repository and production-environment Actions variables and secrets are empty. No Google Cloud project resource, workload-identity federation, provider credential, repository provider/apply variable or secret, provider delivery, or Money Noodle deployment exists. Every provider path remains mechanically blocked before authentication. The committed OpenTofu composition is unapplied, and nothing here has been remotely deployed or provider-validated.
- The platform has no real-money authority. Simulation and funded balances, ledgers, execution authority, presentation, and audit remain structurally separate.
