# ADR-0005: Delivery trust, workload identity, and secret custody

> **Status:** Accepted
> **Date accepted:** 2026-08-29
> **Repository controls revised:** 2026-08-30
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

Agents are intended technical operators for routine work through reviewed automation, short-lived identity, least privilege, default-deny inputs, independent post-operation verification, and durable redacted evidence. They receive no standing cloud authority and cannot infer approval from assignment, workflow access, or a successful check. Routine operations do not bypass the pipeline through a cloud console, developer laptop, or durable local credential.

Humans retain explicit scoped approval of production effects, provider/domain account ownership, root recovery, break-glass custody, and responsibility for the protected production approval. One-time bootstrap and authorized recovery are bounded human procedures that must be reconciled into code and remote state, not alternative routine control planes.

### Three separate principals

| Principal | May | May not |
| --- | --- | --- |
| **Deployer** (CI, federated) | Push images to the registry, read and write remote infrastructure state, create and update the declared infrastructure, deploy service revisions, reassign revision traffic | Read tenant data, read secret values that runtime workloads consume, serve requests, act interactively |
| **Web workload identity** | Call the API origin, export telemetry | Read the registry, read infrastructure state, read any secret, reach a database, run jobs, hold provider authority |
| **API workload identity** | Read only the secrets it is explicitly granted, export telemetry, serve requests | Write the registry, write infrastructure state, deploy anything, read another service's secrets or future schema |

Developer access is separate from all three and is least-privilege. No principal in this design holds funded authority, because none exists in the current platform.

### Artifact trust

Artifacts are built once from a reviewed commit and deployed **by digest**, never by a mutable tag. Every deployment records the image digest, the source commit, the build workflow run, and the generated SBOM. Dependency, secret, and container scans run before publication. Build provenance attestation is produced at publish time and the deployment step verifies that the digest it is asked to deploy carries an attestation from this repository's exact workflow on protected `main`. A digest without verifiable provenance is not deployed.

### Secret custody

A managed secret store is declared and reachable from the first apply even though the first slice stores nothing in it, so that the first capability needing a credential does not also have to invent custody. Every secret, when one exists, records owner, consuming principal, rotation interval, revocation procedure, and recovery path. Laptop environment files are never canonical. Secret values never enter Git, images, build logs, telemetry, status views, issue comments, pull requests, Actions summaries/artifacts/caches, commit metadata, prompts copied into public coordination, or agent handoffs.

Runtime configuration that is genuinely non-secret is typed configuration, not a secret. Putting non-secrets in the secret store obscures which values actually matter.

### Browser boundary

The browser receives no deployment credential, no provider identifier, no workload identity token, and no infrastructure topology. This is already an accepted quality attribute; it is restated here because it is the boundary most easily eroded by a convenience change in a web framework.

## Alternatives considered

### Store a long-lived provider key as a GitHub secret

The common pattern, and the one the alternative provider documents. Rejected as the founding design. GitHub's encrypted secret storage is sound, but the credential is long-lived, has no intrinsic expiry, is copied wherever it is used, and its compromise is silent until an audit finds it. For a platform whose stated trajectory includes funded trading authority, a standing long-lived deployment key is the wrong first habit. It remains acceptable **only** as an explicitly recorded risk with compensating controls, if the maintainer selects a composition that offers nothing better.

### One shared principal for CI and both runtimes

Rejected. It would let a compromised presentation container publish images or mutate infrastructure, collapsing the trust boundaries the accepted architecture exists to establish.

### Deploy by mutable tag such as `latest`

Rejected. It breaks attribution, makes rollback ambiguous, and lets the deployed artifact change without a reviewed commit.

### Defer secret-store selection until a secret exists

Rejected. The first capability that needs a credential would then have to design custody, rotation, revocation, and access control under delivery pressure. Declaring an empty store now costs approximately nothing.

### Grant the deployer broad administrative rights for convenience

Rejected. It contradicts default-deny and makes the CI principal the most powerful identity in the platform, reachable from any workflow change.

## Consequences

### Positive

- No long-lived cloud credential exists to leak, rotate, or forget.
- Compromise of the GitHub account does not by itself yield standing provider access, because tokens are short-lived and trust is ref-constrained.
- Separate principals make blast radius explicit and mechanically testable.
- Digest-plus-attestation deployment makes "what is running" answerable from the commit.
- Secret custody exists before the first secret, so no capability has to improvise it.

### Negative

- Federation setup is more work than pasting a key, and misconfigured trust conditions fail in confusing ways.
- The trust condition must be revisited whenever branch protection, environments, or the deployment ref change.
- Provider choice is constrained by federation support, which is exactly why this decision drove ADR-0004.
- Attestation verification adds a CI step and a failure mode that can block an otherwise good deployment.

## Validation

Before this decision is considered implemented:

1. no provider key exists in GitHub secrets, the repository, any image layer, or any workflow log;
2. a workflow run on an unauthorized ref, and one from a fork, both **fail** to obtain deployment credentials;
3. the deployer principal cannot read a value placed in the secret store for a runtime principal;
4. the web workload identity cannot pull from the registry or read infrastructure state;
5. the API workload identity cannot deploy a revision or write infrastructure state;
6. deployment by a digest lacking valid provenance is rejected;
7. a secret scan over the repository, images, and workflow logs finds nothing;
8. rotating and revoking a test secret works and is observable, before any real secret exists.

Negative tests are mandatory here. A test proving the pipeline *can* deploy proves nothing about who else can.

## Revisit when

- the selected provider changes its federation or attestation mechanism;
- the first real operational secret is introduced, which will exercise custody for the first time;
- identity, tenant data, or provider integrations are added, each of which adds principals;
- funded authority is contemplated, which requires a separate and stricter authority design;
- branch protection, repository visibility, public-contribution controls, deployment environments, or the deployment ref change.
