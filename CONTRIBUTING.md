# Contributing

Thank you for helping untangle the Money Noodle. Product experiences may be playful, but financial, security, and infrastructure changes must use precise domain language and preserve the boundaries in the [architecture overview](docs/architecture/overview.md).

## Public and untrusted by default

Public forks and pull-request code are untrusted. Never include secrets, credentials, customer data, production data, billing/account identifiers, private recovery material, provider state, or production snapshots in source, fixtures, issues, pull requests, commits, or CI output. Use synthetic data.

A pull request receives read-only validation with no provider identity. It cannot deploy, mutate infrastructure, approve itself for production, or gain authority merely by targeting `main`. Do not introduce `pull_request_target` execution of contributor-controlled source. New actions must be pinned to immutable commits, and downloaded binaries must be exact-version and checksum verified.

For vulnerabilities or accidental secret disclosure, stop and follow [SECURITY.md](SECURITY.md); never open a public issue.

## Coordinate the change

Human contributors should create a short-lived typed branch from current `main`; the branch forms are documented in [version control guidance](docs/development/version-control.md). Open or join an issue before changing architecture, security controls, shared contracts, or other contested areas. Small isolated human contributions do not require an agent claim unless a maintainer asks for one.

Agent contributors must follow [AGENTS.md](AGENTS.md) and the [parallel-work claim protocol](docs/development/parallel-work.md): verify the shared issue registry, use the registered short-lived branch and dedicated worktree, stay within the delegated scope, and do not push, merge, or invoke providers without explicit authority.

Commit metadata, issue comments, prompts copied into issues, and review evidence are public. Use an identity and content intended for publication.

## Validate and review

Before requesting review:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm audit --audit-level high
```

Run `pnpm container` when Docker is available, plus focused OpenTofu or project checks for affected boundaries. Do not weaken or skip a gate to make a change pass. Update owning documentation and diagrams when their truth changes.

Every change requires review before integration. Strict `main` protection requires all four hosted CI contexts and a qualifying approval. Production effects have separate authorization gates: federation/provider/apply variables must exist, and the protected environment prevents self-review and requires a distinct eligible approving actor. The configured owner reviewer alone is not deployment authority. A green pull request is evidence for review, not deployment authorization or deployed validation.

By contributing, you agree that your contribution is licensed under the repository's [MIT license](LICENSE).
