# ADR-0010: Agent-operated production control plane

> **Status:** Proposed
> **Date proposed:** 2026-08-30
> **Owners:** Platform operations; proposed for maintainer acceptance
> **Related architecture:** [`../overview.md`](../overview.md)
> **Related operations:** [`../../operations/production-control-plane.md`](../../operations/production-control-plane.md)
> **Depends on:** [`ADR-0005`](ADR-0005-delivery-trust-and-secret-custody.md), [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md)

## Context

Money Noodle intends agents to perform routine technical production work, but an agent must not become an approval authority, hold a durable provider credential, receive a secret payload, or turn a laptop or cloud console into a second control plane. Existing delivery records establish federated CI, separate workload identities, managed secret custody, protected production approval, and remote state. They do not yet define which surface owns each production operation, what an approval authorizes, how execution is independently verified, or how secrets are created and rotated without crossing public or agent-visible surfaces.

Forcing every operation through one deployment workflow would be unsafe in the other direction. Read-only diagnosis needs a scoped operational API, while migrations, restore, repair, and secret lifecycle need bounded administrative jobs with narrower identities and failure semantics than a general deployer. An unlisted operation must not fall back to arbitrary shell access.

The detailed, versioned catalog and evidence contract are kept in [`production-control-plane.md`](../../operations/production-control-plane.md). This record decides the durable authority and boundary shape rather than duplicating that catalog.

Proposed ADR-0008 and ADR-0009 are coordinated but remain independent. If ADR-0009 is accepted, its read-only administrative view is one implementation of the operational-read surface here. This record neither accepts nor promotes either proposal and does not depend on their proposed storage or ingestion choices.

## Decision

### Humans authorize; agents operate; workloads execute

A human retains provider and domain account ownership, root recovery, break-glass custody, and explicit approval of production effects. An agent may prepare a plan, request a grant, initiate an authorized operation, observe it, independently verify the result, and report redacted evidence. The agent cannot approve its own request or infer authorization from issue assignment, repository write access, a green check, or a prior operation.

Execution uses a separate, short-lived workload identity selected by the operation catalog. The approval binds one catalog operation and version, environment, targets, parameter and plan digests, expected state, maximum effects, expiry, recovery path, and single-use nonce. The executor rejects missing, expired, replayed, stale, or broader grants before obtaining mutation authority. A protected-branch merge may be the human grant for the exact automatic forward deployment it names; it is not standing approval for infrastructure, migration, repair, restore, secret, access, cost, or DNS operations.

### Three control surfaces, not one generic administrative path

- **Reviewed CI/CD** builds and deploys immutable artifacts and applies source-controlled infrastructure and configuration. It receives federated, short-lived identity and serialized access to the relevant state.
- **Bounded administrative jobs** perform migrations, scheduled work, reconciliation, repair, backup and restore, secret versioning and rotation, workload-access changes, and other non-interactive operations. Each job exposes an allowlisted, schema-validated operation rather than arbitrary command or provider access, and uses a purpose-specific identity.
- **Scoped read-only operational APIs and read jobs** expose safe status, versions, drift, telemetry, incident diagnostics, cost, backup readiness, and secret metadata without payloads. Reads use ordinary server authorization; sensitive exports or privileged reads receive their own evidence. A read is not forced through deployment CI merely to make it machine-readable.

Unknown operations and unbounded shell, console, database, state, or provider access default to deny. Adding an operation requires a reviewed catalog version and negative tests before authority is granted.

### Verification and evidence are part of the operation

Workflow success is not proof of the intended effect. After execution, the operator verifies through a separately permissioned read path and provider-observed or authoritative application state. Verification records the observation source and as-of time and compares intended, recorded, and observed state. Failed or unavailable verification leaves the operation `unverified` or `blocked`; it never reports success and triggers the cataloged rollback, forward-recovery, or reconciliation path.

Every consequential request, authorization decision, execution attempt, external effect, verification, recovery action, and terminal result is linked in durable, append-only, tamper-evident audit. Public coordination and CI summaries contain only redacted evidence references and safe digests. Telemetry may help diagnosis but does not satisfy audit.

### Secret payloads take a separate data path

OpenTofu declares secret containers, metadata policy, IAM, and consumer references, but never supplies or reads a secret value and never places one in state. A provider-generated value is generated and written inside the managed secret boundary by a bounded administrative job. An externally supplied value enters through a payload-blind private ingress directly to the managed store. In both cases agents and public automation receive only lifecycle state such as accepted, pending, active, superseded, or revoked.

Rotation creates a new version, validates consumer access without revealing the value, refreshes or restarts each declared consumer, verifies use of the new version, and only then disables or destroys the old version according to policy. Recovery means regeneration or fresh external ingress, never revealing an existing value to an agent. If the recovery path is unavailable, creation, rotation, revocation, and access changes fail closed.

### Bootstrap and break-glass stay exceptional

Humans must retain provider/account and billing ownership, payment and legal acceptance, root recovery and MFA custody, registrar recovery, and production approval. Until a constrained bootstrap runner has been implemented and independently validated, the maintainer also executes the initial reviewed bootstrap plan that creates remote state and federation. Every created resource is then imported or migrated into reviewed code and remote state.

A future short-lived agent-operated bootstrap runner may reduce that manual execution only if it exposes the exact reviewed plan rather than a shell, receives sealed account inputs the agent cannot read, has API and resource allowlists, uses a non-exportable expiring credential, emits durable redacted evidence, and is destroyed after independent verification. It cannot remove the human trust-root actions above. The current general-purpose agent shell does not satisfy those conditions.

Break-glass is a human-custodied, incident-bound, strongly authenticated session with a maximum 60-minute grant, an exact scope and reason, no secret export, and complete private audit. It exists only when the normal control plane is unavailable and delay creates greater harm. It is never a routine deployment method. The result is reconciled into code and authoritative state and independently reviewed before the incident closes.

## Alternatives considered

### Let agents approve and execute routine changes

**Rejected.** Delegating approval collapses intent, authorization, and execution into one compromise path. Agent assignment and technical ability are not accountable human consent for production effects.

### Require a human to execute every provider command

**Rejected.** It preserves approval but makes a laptop and console the routine control plane, produces manual drift, weakens reproducibility, and prevents agents from being the intended technical operators. Human-only action is limited to the irreducible trust root and exceptional recovery.

### Route every read and mutation through deployment CI

**Rejected.** It gives diagnosis deployment-shaped latency and authority, encourages overpowered deployer credentials, and makes scheduled and data operations look like artifact releases. Separate read APIs and bounded jobs preserve least privilege and failure isolation.

### Give an administrative job a general shell or provider SDK token

**Rejected.** A generic operator endpoint is an undocumented alternative control plane. Each operation needs a schema, scope, idempotency and concurrency rule, verification, recovery, and evidence contract before its identity receives authority.

### Put secret values in workflow inputs, repository secrets, or OpenTofu variables

**Rejected.** Workflow inputs and runner contexts can reach logs and agent-visible process state, while infrastructure state remains sensitive indefinitely. Payload-blind ingress and in-boundary generation keep orchestration separate from secret custody.

### Allow emergency console access without a catalog entry

**Rejected.** An undocumented exception becomes the path used under pressure and cannot be reconstructed. Break-glass is explicitly cataloged, expiring, audited, verified, and reconciled.

## Consequences

### Positive

- Routine production work is agent-operable without delegating approval or creating a durable agent credential.
- CI/CD, administrative jobs, and operational reads have distinct identities and least-privilege failure domains.
- Every mutation has bounded replay, concurrency, verification, and recovery behavior before implementation.
- Secret lifecycle is orchestratable without exposing payloads to agents, public automation, or OpenTofu state.
- Bootstrap and break-glass gaps are visible rather than becoming silent manual operating paths.

### Negative

- The control plane needs an authorization-grant store, operation registry, purpose-specific workload identities, durable audit, and independently permissioned verification paths that do not yet exist.
- Some operations need multiple phases and consumer acknowledgements, making rotation, migration, and restore slower than a direct provider command.
- A distinct eligible production approver and requester/executor identity are operational prerequisites; the current protected environment is not usable when one actor would initiate and self-approve.
- Payload-blind external secret ingress is a new protected surface whose compromise would bypass the agent boundary even though it would not expose the value to the agent.
- The minimized initial bootstrap still includes human technical execution until the constrained-runner controls are implemented and proven.
- This proposal grants no current provider authority; implementation and remote validation remain separate work.
