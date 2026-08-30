# ADR-0006: Infrastructure-as-code tool and remote state

> **Status:** Accepted
> **Date accepted:** 2026-08-29
> **Owners:** Platform foundation; accepted by maintainer
> **Related architecture:** [`../overview.md`](../overview.md)
> **Evidence:** [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md)
> **Depends on:** [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md), [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md)

## Context

`delivery.md` requires reviewed idempotent infrastructure as code, desired configuration in source control, mutable state in an encrypted durable remote backend with concurrency locking, versioning and backup, detected and surfaced drift, and tested reconstruction. It also forbids committing raw state to Git and treats click-only provider changes as exceptions that must be reconciled back into code.

`principles.md` places provider-neutral modules and provider composition in `infra/`, and the accepted source and deployment map reserves that directory for exactly this, "created only after provider/IaC decisions" with web and API as separate modules or stacks.

`standards.md` makes TypeScript the default for applications, services, jobs, infrastructure, and tooling, while permitting another language where a bounded project has a documented material advantage. That default is deliberately challenged below rather than followed mechanically.

## Decision

### Tool

Use **OpenTofu** with the **HashiCorp Configuration Language**, pinned to an exact version in the workspace, invoked through Nx targets so infrastructure participates in the same affected-work computation as every other project.

OpenTofu is preferred over Terraform because the licence is permissive and the tool is foundation-governed, which removes a licensing question from a decision that will be expensive to revisit. The two are configuration-compatible at the level this repository will use, so the choice is reversible at low cost — which is itself part of the argument.

This is a **documented departure from the TypeScript default** in `standards.md`. The material advantage is that the ecosystem's provider coverage, plan and drift semantics, state model, and reviewability are the properties this decision is actually buying, and no TypeScript-based tool supplies them without adding a compile and synthesis step between the reviewed source and the executed plan.

### Layout

```text
infra/
  modules/            provider-neutral building blocks, no environment values
  stacks/web/         the web deployment's own state
  stacks/api/         the API deployment's own state
  stacks/platform/    shared entry point, DNS, registry, identity pools, telemetry
```

Web and API hold **separate state**, so applying one cannot lock, mutate, or break the other. Values crossing stacks pass as explicit declared inputs or by reading a published output, never by one stack reaching into another's internals.

### State backend

State lives in dedicated **Google Cloud Storage** buckets in the maintainer-owned account and selected `us-west1` region, separated by stack, with:

- **encryption at rest**, provider-managed at minimum;
- **object versioning enabled from the first apply**, not retrofitted;
- **locking on every operation that writes state** — native backend locking where the backend offers it, otherwise conditional-write lockfile locking, which must be proven by test rather than assumed;
- **access restricted to the deployer principal** from ADR-0005; developers do not hold standing write access to state;
- **a tested restore**, exercised at least once before the first production apply.

State is never committed to Git, never printed in logs or CI output, and never copied to a laptop. State may contain values that are sensitive even when no secret was ever declared, so it is treated as sensitive by default.

### Pipeline behaviour

- Pull requests run `plan` for affected stacks and publish the plan for review. A plan is evidence, not authorization.
- `apply` runs only from the pipeline on the authorized ref, using federated short-lived credentials, with **deployment concurrency serialized** so two applies to one stack cannot interleave.
- Drift is detected on a schedule and surfaced as a reported condition. **Drift is never auto-corrected silently**: a difference between reviewed desired state and observed reality is information the maintainer must see.
- A manual provider change is an exception that must be reconciled back into code, and the drift report is how it becomes visible.
- Destroy is not available to ordinary automation. Removing a resource requires a reviewed code change.

## Alternatives considered

### Terraform

The obvious alternative and functionally near-identical for this use. Not selected only because of the licence question; if the maintainer prefers it, switching is a low-cost change and does not invalidate the layout, state, or pipeline decisions above.

### Pulumi with TypeScript

Attractive because it honours the TypeScript default in `standards.md`, gives real types and testability, and lets infrastructure share tooling with the rest of the monorepo. Not selected because it inserts a program-execution step between the reviewed source and the executed plan, which makes review of *what will actually change* harder rather than easier; because its default managed state service adds a third-party custody question this decision is trying to keep narrow; and because for a first slice of roughly a dozen resources, general-purpose language power is not the constraint. Revisit if infrastructure grows enough that HCL's abstraction limits become the actual bottleneck.

### AWS CDK, Terraform CDK, or a provider-native template language

Rejected. Provider-native templates deepen lock-in in the one layer where portability was explicitly preserved. CDK variants add synthesis without removing the underlying state and plan model.

### Provider console configuration with periodic import

Rejected outright by `delivery.md`. Click-only infrastructure is an exception requiring reconciliation, not an operating model.

### One shared state for all stacks

Rejected. It couples web and API deployment lifecycles through a single lock, directly contradicting the accepted independent-deployment quality attribute.

### Committing state to Git, or storing it locally

Rejected. It is explicitly forbidden, and it makes concurrent work by more than one agent or machine unsafe.

## Consequences

### Positive

- Desired infrastructure is reviewable in the same pull request as the code it serves.
- Separate per-stack state preserves independent deployment and rollback at the infrastructure layer, not just the application layer.
- Locking makes concurrent agent or harness work safe by construction rather than by convention.
- Versioning and tested restore make state a recoverable artifact rather than a single point of unrecoverable failure.
- Surfaced drift turns out-of-band changes into visible information instead of silent divergence.

### Negative

- A non-TypeScript tool in a TypeScript-default repository means a second language, toolchain, and set of review skills.
- HCL abstraction limits will eventually be felt if the infrastructure grows substantially.
- Conditional-write locking, where used instead of native backend locking, is a newer and less-exercised path that must be proven by test.
- Serialized applies slow parallel work whenever two changes touch the same stack.
- State is sensitive and must be handled as such forever, including in backups and in incident response.

## Validation

Before this decision is considered implemented:

1. the exact tool version is pinned and identical locally and in CI;
2. `plan` runs on pull requests for affected stacks and publishes reviewable output;
3. `apply` runs only from the pipeline, on the authorized ref, with federated credentials;
4. two concurrent applies to one stack are proven to **block**, not to interleave — this is a mandatory negative test;
5. state object versioning is enabled and a restore from a prior version is exercised;
6. an out-of-band console change is detected and reported as drift, and is not auto-corrected;
7. applying the web stack demonstrably does not lock or modify the API stack;
8. no state content appears in logs, artifacts, CI output, or the repository;
9. a from-scratch reconstruction into a disposable scope succeeds, proving the code is the source of truth.

## Revisit when

- the hosting provider decision changes, since the backend follows it;
- infrastructure grows past the point where HCL's abstraction limits are the real constraint;
- a second standing environment is introduced, which changes stack and state layout;
- the selected backend gains or loses native locking;
- OpenTofu and Terraform diverge enough that configuration compatibility no longer holds.
