# Infrastructure

> **Status:** Locally and hosted-CI validated implementation; provider-unvalidated.
> The hosted baseline ran static analysis, format/validation, and mocked-provider
> tests without a provider credential. **No provider resource has been applied**,
> and no Google Cloud project resource, federation, credential, Money Noodle
> deployment, or DNS record exists.
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
    bootstrap/              state buckets, deployer, federation, and the two
                            runtime identities. Applied by hand, by the maintainer.
    platform/               registry, budget, telemetry retention, secret boundary
    api/                    the API Cloud Run service, running as the identity bootstrap published
    web/                    the web Cloud Run service, running as the identity bootstrap published
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

### Manually managed supply-chain pins

The digest-pinned BuildKit Syft scanner is embedded in Nx project container
command strings and the [delivery workflow](../.github/workflows/delivery.yml),
so Dependabot cannot discover it. Updating it requires manual upstream version
and digest verification, followed by the container builds, delivery policy
checks, and CI image-vulnerability scan.

GitHub-hosted Dependabot's Terraform updater uses the newer Terraform-compatible
core `1.15.9`, which cannot satisfy this repository's deliberately exact OpenTofu
`required_version = "1.12.6"` constraint. The repository retains exact OpenTofu
`1.12.6`, so `.github/dependabot.yml` deliberately has no Terraform ecosystem
entry.

Updates to the `hashicorp/google` provider are therefore manual. Use the
repository-pinned OpenTofu binary, review and update the exact provider constraint
and committed `.terraform.lock.hcl` in every provider root, and regenerate every
lock for both supported platforms by running this command from each root:

```sh
tofu providers lock -platform=linux_amd64 -platform=darwin_arm64
```

Then run `pnpm check`, including the full static policy suite, and
`node tools/infra-check.mjs all`, which performs format, validation, and
mocked-provider tests without a provider API call. Validation against an actual
provider requires separate scoped authority and is not part of a routine
provider update.

Provider `8.0.0` was published on 2026-08-26, three days before this was written,
and its release notes describe resource removals, field removals, and increased
validation. `7.46.0` — the last release of the mature line, published 2026-08-25 —
is pinned instead. This is a **deliberate deferral, not an oversight**: a
foundation is a poor place to be the first user of a major version, and the
upgrade is a bounded, reviewable change once 8.x has field evidence.

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

61 OpenTofu test runs execute offline across the trust policy, service contract,
rollback behaviour, bootstrap defaults, state durability, budget, and federation
modules. 37 infrastructure static guards run in the repository gate. Nearly all are **negative** tests: a
test proving the pipeline can deploy proves nothing about who else can.

The trust policy is the piece worth understanding. `modules/delivery-trust`
declares the clause set **once** and emits it twice — as the CEL string the
provider enforces, and as an evaluator over candidate token claim sets. An output
precondition fails the plan if those two ever diverge, so a clause added to the
enforced condition without a matching check (or the reverse) cannot ship quietly.
The test table accepts scheduled read-only drift only for the same exact repository,
main ref, and delivery workflow as other authority. It feeds the policy the deleted
migration branch, a sibling repository, a fork, a reclaimed repository name, an
unauthorised branch, tag, pull request, workflow, reusable workflow, and event —
asserting not only that each is refused but **which clause** refused it, because a
denial for an accidental reason is a denial that disappears with the next edit.

## What is deliberately absent

- **Any DNS resource.** `noodle.money` is delegated to Vercel and serves the live
  v1 product. Interim validation targets `*.run.app`. A guard fails the build if
  a DNS, domain-mapping, load-balancer, or serverless-NEG resource appears.
- **Any long-lived cloud credential.** Federation only.
- **Any identity or project-IAM authority in the pipeline.** The deployer can
  administer Cloud Run and push images; it cannot create a service account, grant
  a project role, or read a secret. Runtime identities and their project-level
  telemetry grants are created by the maintainer-applied bootstrap stack and
  consumed by the service stacks (#178).
- **Any secret value.** The store is declared empty. The deployer has no Secret
  Manager administrative role because that role could grant itself value access;
  policy administration is revisited with the first real secret.
- **Any destroy path in automation.** Removing a resource is a reviewed code
  change.
- **Any public service on creation.** See the exposure order below.

## Exposure order: create private, verify, then expose

`docs/operations/delivery.md` requires a stricter order for first creation than
for an ordinary release: create the service with no public IAM, verify it
independently with a separate read-only identity and an audience-bound ID
token, and only then expose it. Exposure is a distinct reviewed step, because a
service that is public the moment it exists cannot be verified before it is
reachable.

The configuration follows that order in two steps:

1. **Create private.** `allow_unauthenticated` defaults to `false` in
   `modules/cloud-run-service` and in both the `api` and `web` stacks, and the
   delivery workflow supplies no value for it. So the apply that creates a
   service declares no `allUsers` binding at all — not a binding that is later
   narrowed. The least-privilege service-to-service grant
   (`authorised_invoker_members`) exists independently, so the web can reach a
   still-private API, and closing public access later does not break the web.
2. **Expose.** Setting `allow_unauthenticated = true` is a separate reviewed
   change, applied after the private service has been verified. It adds exactly
   `allUsers`/`roles/run.invoker` through the single `public` resource. Each
   stack publishes `contract_public_invoker_members`, so whether a service is
   public is answerable from state rather than from a provider console.

There is one writer of that binding, no `ignore_changes`, and no `import`
block: an exposure that was never reviewed shows up as drift instead of being
adopted as desired state. `tests/exposure.tftest.hcl` in the module and in both
stacks asserts the creating plan produces no public binding, and
`tools/infra-policy.test.mjs` asserts the defaults, the single writer, and that
no workflow input can collapse create and expose into one apply.

This covers the *configuration* half of the accepted order. The independent
verification between the two steps, and the separate approval that authorises
the exposure operation, are operational gates and are not expressible here.

## Delivery input and rollback contract

Provider operations remain skipped until the authorization job validates every
account-specific stack input documented in `bootstrap.md`. Service plans and
applies take an image digest plus the full source commit from one publish run;
`gh attestation verify --source-digest` binds them before OpenTofu runs. A traffic
rollback reloads digest, artifact version, source commit, and configured revision
suffix from remote state, verifies that artifact again, and applies a saved plan.
This preserves the current revision template while moving traffic to a named
prior revision.

The bootstrap gives the deployer `roles/billing.costsManager` on exactly the
selected billing account because project IAM cannot create a billing-account
budget. It grants no billing administration or payment authority.

Since #178 the deployer holds `roles/run.admin` rather than `roles/run.developer`.
A service is created private and its named invokers — the web runtime identity on
the API, and the post-apply verifier on both — are service-level
`roles/run.invoker` bindings, which `run.developer` cannot set. The role is
confined to Cloud Run: it grants no project IAM and no identity administration,
and the deployer still holds no role that could create, delete or re-grant an
identity. A first `api` or `web` plan therefore contains Cloud Run resources and
service-level bindings only.

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
   separate read-only planner workload identity, bound to same-repository pull requests,
   is the bounded follow-up. Recorded in `.github/workflows/delivery.yml`.
6. **Trace and metric retention are provider behaviour, not configuration.** The
   2026-09-15 accepted ADR-0007 amendment replaces the former 3-to-7-day trace
   and 30-to-90-day metric targets with what the provider actually delivers:
   Google's documented 30-day `_Trace` retention and 24 months of OTLP metrics
   with progressive downsampling. Both are published in the
   `telemetry_retention_policy` output as `configured = false`, so neither looks
   like a TTL this configuration sets. Log retention *is* set explicitly, at the
   accepted 14 days for application and debug logs alike — see the desired
   telemetry configuration below.
7. **Desired telemetry identity and configuration are unapplied source.**
   `modules/cloud-run-service` renders `OTEL_EXPORTER_OTLP_ENDPOINT`,
   `OTEL_EXPORTER_OTLP_PROTOCOL = http/protobuf`, `OTEL_SERVICE_NAME`,
   `OTEL_RESOURCE_ATTRIBUTES` (service, version, environment, image digest and
   source commit as distinct facts), parent-based head sampling at unity, and
   `GOOGLE_CLOUD_QUOTA_PROJECT`. The runtime identity itself, and the roles
   below, are declared by `stacks/bootstrap` since #178; the module consumes the
   published email. The runtime identity declares
   `roles/cloudtrace.agent`, `roles/logging.logWriter`,
   `roles/monitoring.metricWriter`, `roles/serviceusage.serviceUsageConsumer`
   and `roles/telemetry.writer` — the last two are what Google's current
   Telemetry API documentation requires alongside a quota project. **None of
   this is granted or applied.** It is desired configuration in source; an
   actual grant is a separately authorized operation, and no credential appears
   in any environment variable: the exporter obtains short-lived credentials
   from the service's own workload identity at runtime.
8. **Debug log routing keeps no second, longer-lived copy by accident.** A sink
   routes a copy of debug logs to their own bucket; it does not stop `_Default`
   keeping its own. `modules/telemetry-retention` therefore refuses, by
   precondition, to configure a debug window shorter than the operational one
   unless a separately authorized `_Default` exclusion has been recorded. This
   module does not create that exclusion.
9. **Cost figures are estimates** from dated published list prices against
   assumed workload parameters. Nothing is measured.
10. **Resource schemas are validated, not exercised.** `tofu validate` checks
   arguments against the provider schema; it does not prove the API accepts the
   resulting request.
