# Version control and release strategy

## Preserved state

- `archive/v1-final` is the immutable annotated tag for final v1 `main` before the rebuild, commit `4b71b61894622b1c01f3552f9c7af5592cb2800a`. Never move/delete it.
- `release/v1` is the maintainable v1 line. Only explicitly requested critical fixes merge to it; never merge v2 work into it.
- `main` remains v1 production until cutover, then becomes the protected production trunk whose merges deploy.
- `v2` is the temporary integration branch rooted at the reset. Do not merge later v1 work into it merely to align history.

## Working branches

Create one short-lived branch from the current integration target (`v2` before cutover, `main` afterward) using `<type>/<short-kebab-description>`:

- `arch/` architecture and ADRs;
- `feat/` product behavior;
- `fix/` defects;
- `test/` validation infrastructure;
- `docs/` non-architectural docs;
- `chore/` tooling/maintenance;
- `spike/` disposable uncertainty reduction.

The current foundation branch is `arch/v2-foundation`. Keep work single-purpose and commits reviewable with imperative subjects. Incorporate the latest target before merge. Do not commit directly to `main`, `v2`, or `release/v1`; merge only after review and required checks.

## Tags and cutover

Use immutable annotated Semantic Versioning tags (`vMAJOR.MINOR.PATCH`) for accepted v2 releases. Do not invent retroactive v1 semver; its archive tag is stable. Tags supplement commit/deployment records and never move.

Before cutover, configure and validate production CD and branch protection. Freeze incompatible writes; verify archive refs; run the complete v2 validation plan; merge v2 to `main` without rewriting history. Merge approval authorizes automated deployment. Verify the resulting tree, deployment, migrations, health, and smoke checks, then tag `v2.0.0`. Keep v1 archive/maintenance refs and remove `v2` only after verification.

Rollback through deployment automation to a known artifact/tag, never by moving tags or force-pushing shared history. Do not push, merge, release-tag, alter protected refs, or trigger deployment unless requested. When requested, confirm remote CI/CD rather than assuming local success.
