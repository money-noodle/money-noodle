# Infrastructure

> **Status:** Unvalidated implementation. Locally validated by static analysis and
> offline tests only. **No provider resource has been applied**, and no Google
> Cloud account, project, resource, credential, or DNS record has been created,
> inspected, or authenticated against.
> **Owner:** GitHub issue #14 (`cc-gcp-delivery-foundation`), parent plan #2
> **Implements:** [`ADR-0004`](../docs/architecture/decisions/ADR-0004-first-remote-hosting-composition.md) through [`ADR-0007`](../docs/architecture/decisions/ADR-0007-first-telemetry-backend.md), with dated comparison evidence in [`deployment-composition.md`](../docs/operations/deployment-composition.md)

All Google Cloud coupling lives here. No provider SDK appears in `apps/` or
`services/` inner layers, and this directory contains no domain logic.

## Layout

```text
infra/
  .terraform-version        exact tool pin, read by tools/infra-check.mjs and the workflow
  bootstrap.md              the one-time, auditable bootstrap procedure
  modules/                  provider-neutral building blocks; no environment values
    delivery-trust/           the OIDC trust conjunction — no provider, fully offline
    workload-identity-federation/
    state-bucket/
    artifact-registry/
    cloud-run-service/
    secret-store/
    budget-guardrail/
    telemetry-retention/
  stacks/
    bootstrap/              state buckets, deployer, federation. Applied once, by hand.
    platform/               registry, budget, telemetry retention, secret boundary
    api/                    the API Cloud Run service and its own identity
    web/                    the web Cloud Run service and its own identity
```

Each stack holds **separate state** under its own bucket and prefix, so applying
one cannot lock, mutate, or break another.

## Pinned versions

| Component | Version | Source | Verified |
| --- | --- | --- | --- |
| OpenTofu | `1.12.6` | https://github.com/opentofu/opentofu/releases/latest | 2026-08-29 |
| `hashicorp/google` provider | `7.46.0` | https://github.com/hashicorp/terraform-provider-google/releases | 2026-08-29 |
| `opentofu/setup-opentofu` | `v2.0.2` (`a1320f89…`) | https://github.com/opentofu/setup-opentofu/releases/latest | 2026-08-29 |
| `google-github-actions/auth` | `v3.0.0` (`7c6bc770…`) | https://github.com/google-github-actions/auth/tags | 2026-08-29 |
| `docker/login-action` | `v4.6.0` (`dbcb8138…`) | https://github.com/docker/login-action/tags | 2026-08-29 |
| `actions/attest-build-provenance` | `v4.2.2` (`4d101475…`) | https://github.com/actions/attest-build-provenance/releases/latest | 2026-08-29 |

Provider `8.0.0` was published on 2026-08-26, three days before this was written,
and its release notes describe resource removals, field removals, and increased
validation. `7.46.0` — the last release of the mature line, published 2026-08-25 —
is pinned instead. This is a **deliberate deferral, not an oversight**: a
foundation is a poor place to be the first user of a major version, and the
upgrade is a bounded, reviewable change once 8.x has field evidence.

`.terraform.lock.hcl` files are committed and carry checksums for `linux_amd64`
and `darwin_arm64`, so CI and a developer machine resolve identical artifacts.
Regenerate with:

```sh
tofu providers lock -platform=linux_amd64 -platform=darwin_arm64
```

## Commands

```sh
# Static guards. No OpenTofu needed; these run inside `pnpm check`.
node --test tools/infra-policy.test.mjs tools/infra-delivery-policy.test.mjs

# OpenTofu-native checks. Needs the pinned binary.
node tools/infra-check.mjs fmt        # or: pnpm nx run infra:infra-fmt
node tools/infra-check.mjs validate   # or: pnpm nx run infra:infra-validate
node tools/infra-check.mjs test       # or: pnpm nx run infra:infra-test
node tools/infra-check.mjs all
```

The `infra:*` target names are deliberately outside the `lint`/`test`/`build` set
that `pnpm check` runs across every project, so the repository check stays
runnable on a machine without OpenTofu. `tools/infra-check.mjs` **fails** rather
than skipping when the tool is missing: a gate that passes silently because its
tool is absent is worse than no gate.

Every check here is static. `init` runs with `-backend=false`, and every
`tofu test` mocks the provider, so none of them can reach a provider API.

## Testing

47 OpenTofu test assertions run offline across the trust policy, service
contract, rollback behaviour, state durability, budget, and federation modules.
30 static guards run in the repository gate. Nearly all are **negative** tests: a
test proving the pipeline can deploy proves nothing about who else can.

The trust policy is the piece worth understanding. `modules/delivery-trust`
declares the clause set **once** and emits it twice — as the CEL string the
provider enforces, and as an evaluator over candidate token claim sets. An output
precondition fails the plan if those two ever diverge, so a clause added to the
enforced condition without a matching check (or the reverse) cannot ship quietly.
The test table then feeds it a sibling repository, a fork, a reclaimed repository
name, an unauthorised branch, a tag, a pull request, an unauthorised workflow, an
externally defined reusable workflow, and a scheduled run — asserting not only
that each is refused but **which clause** refused it, because a denial for an
accidental reason is a denial that disappears with the next edit.

## What is deliberately absent

- **Any DNS resource.** `noodle.money` is delegated to Vercel and serves the live
  v1 product. Interim validation targets `*.run.app`. A guard fails the build if
  a DNS, domain-mapping, load-balancer, or serverless-NEG resource appears.
- **Any long-lived cloud credential.** Federation only.
- **Any secret value.** The store is declared empty.
- **Any destroy path in automation.** Removing a resource is a reviewed code
  change.

## Outstanding before an apply can be trusted

These are honest gaps, not oversights. None can be closed without a provider.

1. **Nothing has been applied.** Every claim here is about configuration text,
   not observed behaviour.
2. **State locking is untested.** ADR-0006 requires proving two concurrent
   applies block rather than interleave. That needs two real applies.
3. **Restore is untested.** Versioning is configured; a restore has not been
   exercised. `bootstrap.md` step 7 covers it.
4. **The trust condition is modelled, not observed.** The offline evaluator and
   the golden CEL string agree with each other. Only a real token exchange proves
   Google evaluates the condition the way the model does. `bootstrap.md` step 5
   is the negative test that closes this.
5. **Pull-request plans are not implemented.** ADR-0006 expects them; granting
   them would disclose sensitive state to anyone who can open a pull request. A
   separate read-only planner principal, bound to same-repository pull requests,
   is the bounded follow-up. Recorded in `.github/workflows/delivery.yml`.
6. **Trace and metric retention are not configurable** through this provider, so
   ADR-0007's 3-to-7-day trace and 30-to-90-day metric targets are *not* met by
   configuration. Log retention is set explicitly. The gap is published in the
   `telemetry_retention_policy` output rather than left to look satisfied.
7. **Cost figures are estimates** from dated published list prices against
   assumed workload parameters. Nothing is measured.
8. **Resource schemas are validated, not exercised.** `tofu validate` checks
   arguments against the provider schema; it does not prove the API accepts the
   resulting request.
