# ADR-0005: Delivery trust, workload identity, and secret custody

> **Status:** Working
> **Date accepted:** 2026-08-29
> **Repository controls revised:** 2026-08-30
> **Amended:** 2026-09-19 — identity creation and project-level grants are maintainer-applied
> **Owners:** Platform foundation; accepted by maintainer
> **Related architecture:** [`../overview.md`](../overview.md)
> **Evidence:** [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md)
> **Depends on:** [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md)

## Context

`delivery.md` requires short-lived workload identity and CI federation in preference to long-lived cloud keys, project-scoped delivery credentials separate from developer access, immutable attributable artifacts, and a durable managed source of truth for every operational secret. `principles.md` requires default-deny authorization at every boundary. The accepted architecture additionally requires that the browser never receive a deployment credential and that web and API hold separate least-privilege identities.

The first slice needs **no** operational secret: ADR-0003 established that the API base URL, service name, contract compatibility range, and telemetry destination are typed non-secret configuration. That makes this the cheapest possible moment to establish the trust design, because getting it wrong costs nothing to fix now and a great deal later, once identity, tenant data, provider integrations, and eventually funded authority exist.

This decision was the deciding factor in [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md). It is recorded separately because it is a durable platform property that outlives any particular hosting provider.

## Decision

### CI authenticates by federation, never by a stored cloud key

GitHub Actions obtains provider credentials by presenting its per-job OIDC token to a workload identity pool and exchanging it for a short-lived access token. **No provider access key, secret key, service account key file, or equivalent long-lived credential is stored in GitHub, in the repository, in an image, or on a developer machine.**

The identity pool's trust condition is constrained to the organization-owned `money-noodle/money-noodle` repository, protected `main`, and the delivery workflow. Every Money Noodle configuration boundary rejects a ref allowlist other than exactly `refs/heads/main` and a workflow allowlist other than exactly `.github/workflows/delivery.yml`; a stack input cannot reauthorize a deleted or additional branch or workflow. A token minted for a deleted migration branch, a tag, a fork, a pull request from an untrusted source, another workflow, or another repository must not be exchangeable for deployment authority.

The closed event set is `push`, `workflow_dispatch`, and `schedule`. Schedule is permitted only inside the same immutable-repository, exact-`main`, exact-`.github/workflows/delivery.yml` conjunction so the declared read-only drift job can authenticate. It does not authorize another scheduled workflow, ref, repository, event, or an apply.

[`../../current-status.md`](../../current-status.md) owns current source identity, visibility, and preserved-history facts. The public-source security boundary is stable regardless of those volatile host details: source, issues, pull requests, commit metadata, Actions logs and summaries, artifacts, and caches are public or potentially externally observable and permanently copyable. Secret payloads, customer or production data, billing/account identifiers, private recovery material, durable provider credentials, raw state, and unredacted incident evidence never enter those surfaces.

Public pull requests remain untrusted, execute with read-only CI permissions, and never receive a provider token. `pull_request_target` does not execute contributor-controlled source. Every action is pinned to an immutable commit, and each externally downloaded binary is exact-version and checksum verified before execution. Host-side protection of `main` and the production environment is mandatory; workflow text alone is not evidence that either protection exists.

Any composition that cannot satisfy this without a stored key must record that gap explicitly as an accepted risk, with a named compensating control — a narrowly scoped credential, a documented rotation schedule, and a revocation procedure — rather than adopting a stored key silently.

### Agents execute reviewed automation; humans retain approval and recovery

Agents are intended technical operators for routine work through reviewed automation, short-lived workload identity, least privilege, default-deny inputs, independent post-operation verification, and durable redacted evidence. They receive no standing cloud authority and cannot infer approval from assignment, workflow access, or a successful check. Routine operations do not bypass the pipeline through a cloud console, developer laptop, or durable local credential.

Humans retain explicit scoped approval of production effects, provider/domain account ownership, root recovery, break-glass custody, and responsibility for the protected production approval. One-time bootstrap and authorized recovery are bounded human procedures that must be reconciled into code and remote state, not alternative routine control planes.

### Runtime separation and purpose-specific operation identities

| Workload identity | May | May not |
| --- | --- | --- |
| **Deployer** (CI, federated) | Push images to the registry, read and write remote infrastructure state, create and update the declared infrastructure, deploy service revisions, reassign revision traffic, bind service-level `run.invoker` | Create, delete or re-grant an identity, set project IAM, read tenant data, read secret values that runtime workloads consume, serve requests, act interactively |
| **Web workload identity** | Call the API origin, export telemetry | Read the registry, read infrastructure state, read any secret, reach a database, run jobs, hold provider authority |
| **API workload identity** | Read only the secrets it is explicitly granted, export telemetry, serve requests | Write the registry, write infrastructure state, deploy anything, read another service's secrets or future schema |

This table describes the existing unapplied foundation identity split, not permission to reuse one mutation token for every M1 effect. The accepted [catalog v2](../../operations/production-control-plane.md#m1-catalog-v2--selected-not-enabled) further separates operation-specific executors, independent verification, journal writer, witness writer and the no-OIDC source publisher. No additional service or durable credential is selected. Developer access is separate and least-privilege. No workload identity in this design holds funded authority, because none exists in the current platform.

Every resource declared under `infra/` names exactly one owning execution identity, with a recorded justification for the permission, in [`tools/delivery/execution-identities.mjs`](../../../tools/delivery/execution-identities.mjs). A static test derives the resource addresses from the committed configuration and fails on an unowned resource, an orphaned claim, or an identity claiming an operation its catalog row does not permit. Creating a service and exposing it therefore have different owners under different approval classes, and every binding that establishes the deployer's own authority belongs to the human bootstrap principal rather than to any workload identity. The [provider-disabled adapters](../../../tools/delivery/README.md) alongside it implement the grant, journal and witness contracts and enforce this conjunction — exact `refs/heads/main`, exact `.github/workflows/delivery.yml`, the closed event set, and no mutation for the scheduled read-only path — before any token exchange. They create no identity, ref, issue or provider path; federation remains unconfigured and `infra/` remains unapplied.

### Accepted amendment 2026-09-19: identities and project-level grants are maintainer-applied

The first authorized service deploy planned seven resources for `api` and failed
on the first, with `IAM_PERMISSION_DENIED` on `iam.serviceAccounts.create`.
Nothing was created. The cause was a contradiction in this record's own
implementation rather than a misconfiguration: `modules/cloud-run-service` asked
the deployer to create each runtime service account and to grant it five
project-level telemetry roles, while the bootstrap validation above refuses the
deployer both `roles/resourcemanager.projectIamAdmin` and every
identity-administration role. Under this decision the deployer could never have
performed that apply, and the only ways to make it work were to grant CI the
broad rights this record rejects, or to move the work.

The maintainer chose to move the work. **Creating an identity and granting it a
project role are bootstrap operations, performed by the human principal.** The
`bootstrap` stack now creates one runtime service account per deployable service
and grants each exactly the telemetry write roles it needs, and publishes their
emails as a non-sensitive contract output. The `api` and `web` stacks read that
contract and declare no `google_service_account` and no `google_project_iam_member`
at all. **The delivery pipeline manages Cloud Run resources and service-level IAM
bindings, and nothing else.**

The deployer's Cloud Run role becomes `roles/run.admin` in place of
`roles/run.developer`, because a service is created private and its named
invokers are service-level `roles/run.invoker` bindings that `run.developer`
cannot set. The role is confined to Cloud Run. It grants no project IAM and no
identity administration, and the forbidden-role set above is unchanged: no owner,
no editor, no project-IAM administration, no service-account administration, no
Secret Manager role. The deployer keeps `roles/iam.serviceAccountUser`, so it may
*act as* the runtime identities it deploys without being able to create, delete
or re-grant them.

This narrows the deployer rather than widening it, and it makes the separation
mechanical: an identity the pipeline cannot create is an identity the pipeline
cannot quietly re-permission. It changes no gate — the environment approval, the
typed apply confirmation and the provenance requirement are untouched — and it
applies nothing. The bootstrap re-apply and the service applies remain maintainer
operations under the existing #75 approvals; `../../../infra/bootstrap.md`
records the exact delta to expect.

### Sole-principal target and current safeguards

The [staged delivery contract](../../operations/delivery.md#current-to-target-activation) replaces neither current environment gates nor host protections merely by being accepted. Restricted GITHUB_TOKEN publication must prove genuine workload author/pusher attribution; the principal remains human reviewer/merger, with independent agent technical review, exact-head checks and no bypass. CI admission is not production consent. After separately authorized qualification, the reviewed merge supplies separately consumed artifact, forward and one conditional rollback slot for its exact bundle, not broader operational authority.

### Artifact trust

Artifacts are built once from a reviewed commit and deployed **by digest**, never by a mutable tag. Every deployment records the image digest, the source commit, the build workflow run, and the generated SBOM. Dependency, secret, and container scans run before publication. Build provenance attestation is produced at publish time and the deployment step verifies that the digest it is asked to deploy carries an attestation from this repository's exact workflow on protected `main`. A digest without verifiable provenance is not deployed.

### Secret custody

A managed secret store is declared and reachable from the first apply even though the first slice stores nothing in it, so that the first capability needing a credential does not also have to invent custody. Every secret, when one exists, records owner, consuming workload identity, rotation interval, revocation procedure, and recovery path. Laptop environment files are never canonical. Secret values never enter Git, images, build logs, telemetry, status views, issue comments, pull requests, Actions summaries/artifacts/caches, commit metadata, prompts copied into public coordination, or agent handoffs.

Runtime configuration that is genuinely non-secret remains typed configuration. Private native mappings (even when not credential payloads) use Actions environment Secrets for controlled runtime injection only under the [field-level custody inventory](../../operations/production-control-plane.md#field-level-custody-and-bounded-reconstruction); they never become a readable archive or recovery vault. Canonical M1 audit is sanitized Git/issue evidence, with explicit unknown-on-missing-history limits, not an additional private store. Operational secret payload custody and tenant/financial audit obligations remain unchanged.

### Browser boundary

The browser receives no deployment credential, no provider identifier, no workload identity token, and no infrastructure topology. This is already an accepted quality attribute; it is restated here because it is the boundary most easily eroded by a convenience change in a web framework.

## Alternatives considered

### Store a long-lived provider key as a GitHub secret

The common pattern, and the one the alternative provider documents. Rejected as the founding design. GitHub's encrypted secret storage is sound, but the credential is long-lived, has no intrinsic expiry, is copied wherever it is used, and its compromise is silent until an audit finds it. For a platform whose stated trajectory includes funded trading authority, a standing long-lived deployment key is the wrong first habit. It remains acceptable **only** as an explicitly recorded risk with compensating controls, if the maintainer selects a composition that offers nothing better.

### One shared workload identity for CI and both runtimes

Rejected. It would let a compromised presentation container publish images or mutate infrastructure, collapsing the trust boundaries the accepted architecture exists to establish.

### Deploy by mutable tag such as `latest`

Rejected. It breaks attribution, makes rollback ambiguous, and lets the deployed artifact change without a reviewed commit.

### Defer secret-store selection until a secret exists

Rejected. The first capability that needs a credential would then have to design custody, rotation, revocation, and access control under delivery pressure. Declaring an empty store now costs approximately nothing.

### Grant the deployer broad administrative rights for convenience

Rejected. It contradicts default-deny and makes the CI workload identity the most powerful identity in the platform, reachable from any workflow change.

## Consequences

### Positive

- No long-lived cloud credential exists to leak, rotate, or forget.
- Compromise of the GitHub account does not by itself yield standing provider access, because tokens are short-lived and trust is ref-constrained.
- Separate workload identities make blast radius explicit and mechanically testable.
- CI cannot create or re-permission an identity at all, so the separation above is a property of what the deployer can reach rather than of what its configuration currently says.
- Digest-plus-attestation deployment makes "what is running" answerable from the commit.
- Secret custody exists before the first secret, so no capability has to improvise it.

### Negative

- Federation setup is more work than pasting a key, and misconfigured trust conditions fail in confusing ways.
- The trust condition must be revisited whenever branch protection or the deployment ref changes. It does not depend on which jobs declare a GitHub environment, because no `attribute.environment` is mapped — removing the `production` gate from the routine deploy (#189, 2026-09-20) therefore needed no change to it. The other side of that is that an environment can never be the credential boundary here; the job guard, per-commit qualification, provenance verification and exposure guard are.
- Adding a deployable service now needs a bootstrap re-apply before its first service apply, because its runtime identity must exist first. That is a deliberate handoff to the human principal, and it is one more step than a self-service pipeline would take.
- Provider choice is constrained by federation support, which is exactly why this decision drove ADR-0004.
- Attestation verification adds a CI step and a failure mode that can block an otherwise good deployment.

The owning [delivery acceptance](../../operations/delivery.md#first-release-acceptance-and-exposure-order) and [catalog fixtures](../../operations/production-control-plane.md#downstream-negative-fixture-contract) carry the remaining negative trust, provenance, custody, first-exposure and independent-verification requirements. They are future qualification, not evidence sufficient to mark this Working record Settled.
