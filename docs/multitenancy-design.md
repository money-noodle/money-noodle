# Multi-tenant identity, API, and execution-cell design

> **Document type:** Architecture design
> **Design status:** Proposed
> **Implementation:** Not started
> **Created:** 2026-08-22
> **Canonical requirements:** None — proposal or exploration only
> **Decision record:** None — no accepted product decision
> **Design index:** [`docs/README.md`](README.md)

> **Status: proposed for maintainer review; not approved or implemented.**
> Written 2026-08-22. This is a follow-on to
> [`execution-engine-separation-design.md`](execution-engine-separation-design.md), not part of its initial
> behavior-preserving extraction. It changes identity, credential custody, control-plane keying, paper/live
> runtime boundaries, and the execution deployment model. It does not approve funded activation for another
> person, venue, market, strategy, or client application.
>
> **Security and durability scope.** Live balances, budgets, orders, fills, positions, P&L, account activity,
> and venue connections are private financial information even when keyed only by a pseudonymous tenant ID.
> Their confidentiality and integrity are money-safety requirements, not merely presentation/privacy concerns.
> In this document, **durability** means that acknowledged control and execution state survives process crashes,
> restarts, deployments, and ordinary allocation replacement; authoritative live state must never exist only in
> process memory or an ephemeral container filesystem. Backup, geographic redundancy, and recovery from loss of
> the persistent store are necessary but will be designed and approved separately; this document does not claim
> zero data loss for destruction of the persistence layer.

## 1. Decisions proposed

1. Introduce a first-class **tenant** as the security, budget, credential, execution, and data-isolation unit.
   V1 creates one personal tenant for each user. `userId` and `tenantId` remain separate so a later organization
   or shared account does not require re-keying every money row.
2. Replace the single shared password with an external OIDC identity provider supporting a separate account,
   MFA/passkeys, session revocation, and recovery for each user. Email is an attribute, never an identity key.
3. Put a versioned, client-neutral **application/control API** between every frontend and the data/control
   planes. Web, mobile, and integrations are OAuth clients of that API. No frontend connects to an engine or
   receives a database credential.
4. Split the post-extraction engine into three **logical** runtime classes only after immutable decision inputs
   exist:
   - one shared research/decision plane with no user credentials or private account state;
   - one separate shared paper-execution service;
   - one fenced live execution cell per tenant.
   Logical ownership does not decide physical placement: one allocation may host one cell or several cells, and
   a later backend may use supervised processes, scheduled tasks, containers, or bounded serverless invocations.
5. Do **not** run one copy of the current monolithic engine per user. It would duplicate collection, models,
   evidence, paper execution, public request traffic, and large research state. A tenant cell is a thin logical
   account-level live authorizer, OMS, ledger owner, and reconciler consuming immutable decision plans.
6. Make the tenant, not a strategy or individual venue, the live **authority** boundary. All of one tenant's
   venues and strategies remain behind one serialized account authority so global exposure, budget, rate,
   drain, and reconciliation rules cannot race. This does not require one OS process or container per tenant.
7. Store venue secrets only in a dedicated encrypted secret plane. The ordinary application database stores a
   secret reference and sanitized connection metadata, never credential material. An assigned execution runtime
   receives only the secret capabilities needed for the tenant cells it currently hosts.
8. Keep shared paper money and control completely separate from tenant live money. Every signed-in user may read
   the shared paper projection. Only a user with the `paper_manager` role may mutate paper control.
9. Implement authorization as the intersection of authenticated user, tenant membership, application roles,
   OAuth client scopes, resource ownership, step-up state, and current engine safety state. A role or token alone
   is never enough to authorize a money mutation.
10. Use tenant-keyed schemas, composite foreign keys, forced Postgres row-level security, scoped runtime
    identities, per-tenant encryption/secret scopes, and adversarial isolation tests. Process/container/serverless
    placement is a replaceable deployment policy, not the definition of tenant correctness.
11. Let authorized UI actions request **provision**, **start**, **safe stop**, and eventually **retire** through the
    application API. A separate runtime controller reconciles that desired state through an ECS-like scheduler
    adapter. Frontends never receive scheduler credentials, and creating or starting compute never arms or
    resumes trading.
12. Classify tenant balances, budgets, orders, fills, positions, P&L, account activity, and connection metadata
    as restricted private financial information. Enforce least-privilege tenant isolation across APIs, stores,
    queues, caches, logs, exports, operations tooling, and runtime capabilities—not only in frontend routes.
13. Require durable-before-effect persistence for every recovery-critical live transition. A cell may use memory
    for bounded queues and caches, but durable intent, reservation, idempotency, order identity, lifecycle,
    reconciliation, and control state must be sufficient to restart without forgetting or blindly repeating a
    financial action.

## 2. Relationship to the engine-separation design

The initial extraction in `execution-engine-separation-design.md` should remain small and behavior-preserving:
one web runtime, one standalone engine, the existing shared paper/live orchestration, and no new user. This
proposal begins only after that boundary is stable.

It changes the eventual target in these ways:

| Existing separation proposal | Multi-tenant extension |
| --- | --- |
| Next.js web/BFF is the operator surface. | A client-neutral application/control API serves web, mobile, and approved integrations; a Next.js BFF is only one client adapter. |
| One operator identity. | Separate users, tenant memberships, revocable sessions, client identities, scoped roles, and immutable actor audit. |
| One singleton engine lease. | A singleton shared-paper lease plus one independently fenced logical lease per tenant live cell, regardless of placement. |
| Venue credentials live on one engine host. | Each tenant's credentials live in its secret namespace and are delegated only to a runtime allocation currently assigned that tenant. |
| One engine owns research, paper, and live. | Shared research/decision, separate shared paper, and tenant live cells after a verified immutable-plan boundary; physical packing is deferred. |
| One private status projection. | Shared paper projections plus tenant-keyed private live projections and per-cell heartbeats. |
| Commands target one engine. | Trading commands target paper or one tenant cell; lifecycle requests target a separate runtime controller. |

The prior rejection of a process per strategy or venue remains correct. Strategies using one venue account
share cash, orders, fills, positions, rate ceilings, and reconciliation. A **tenant account authority** is
materially different: tenants must not share any of those ledgers or writers, even if a supervised process later
hosts several tenant cells.

If control-plane work starts before this follow-on, avoid singleton-only schema names. Lease, heartbeat,
projection, command, idempotency, audit, desired-runtime state, and placement records should have opaque target
identities from their first version, even while only one target and one scheduler backend exist.

## 3. Vocabulary and ownership

| Term | Meaning |
| --- | --- |
| **User** | A human login principal identified by immutable identity-provider issuer and subject. |
| **Client application** | Web UI, mobile UI, or approved integration identified by OAuth `client_id` and token audience/scopes. |
| **Tenant** | Isolation and ownership boundary for live credentials, budgets, account state, commands, projections, and execution. V1 tenants are `personal`. |
| **Membership** | A user's active relationship to a tenant. V1 has exactly one owning user per personal tenant. |
| **Role grant** | A named application role assigned to a user at a declared scope. Roles are rows/grants, not a mutable array copied into a session. |
| **Venue connection** | One tenant's configured provider/environment/account binding and secret reference. It is not live permission. |
| **Live execution cell** | Logical sole fenced writer for a tenant's live control, account ledger, orders, and reconciliation. It is not necessarily an OS process. |
| **Runtime allocation** | Physical compute assigned to host one or more logical runtime targets: a process, task, container, VM, or bounded invocation. |
| **Runtime controller** | Control-plane reconciler that turns authorized desired lifecycle state into scheduler/backend operations. It has no trading authority. |
| **Paper runtime** | The platform-owned shared simulation and bankroll. It has no path to tenant venue secrets. |
| **Decision plan** | Immutable, versioned, non-order strategy output built from an as-of snapshot. It contains no tenant, budget, or execution mode. |
| **Private financial information** | Tenant balances, budgets, orders, fills, positions, P&L, account activity, strategy activity, and connection metadata. It remains confidential without a direct personal identifier. |
| **Durable execution state** | Recovery-critical state whose successful commit survives process restart and ordinary allocation replacement. Ownership by a cell does not imply storage in that cell's memory or ephemeral filesystem. |

A user may authenticate through several clients and may have several role grants. A client application is never
a user, and an integration's client credentials never create human operator authority.

### 3.1 Authority after the split

| Concern | Authority |
| --- | --- |
| Human identity, MFA, authentication recovery | Identity provider; mapped to an immutable local user row. |
| Tenant membership and application roles | Application identity schema and authorization service. |
| Shared market observations, models, production policy, decision plans | Shared research/decision plane and compiled artifact. |
| Shared paper bankroll, ledger, fills, and control | Paper runtime only. |
| Tenant budget/control audit | That tenant's live cell durable control store. |
| Tenant cash, orders, fills, and positions | Venue responses reconciled by that tenant's live cell. |
| Venue credentials | Secret plane; usable only by the owning tenant cell. |
| Operator request | Immutable tenant- or paper-targeted command. It is intent, not applied state. |
| Frontend display | Bounded API projection. It is never execution or reconciliation authority. |

The application API validates and authorizes requests but does not place orders, mutate a live ledger, or
claim reconciliation success. Engines consume commands and publish projections; they do not know which UI
initiated a request and expose no browser/mobile endpoint.

## 4. Target topology

```text
 web UI       mobile UI       approved integrations
    \             |                    /
     +------------+-------------------+
                  | OAuth/OIDC, HTTPS
                  v
          application/control API  <----> identity provider
             |          |
             |          +---- credential-ingest service ---- KMS/secret store
             |
             +---- identity/control DB ---- shared/tenant read projections
                         |       ^
       desired lifecycle|       | commands/status/read models
                         v       |
                 runtime controller ---- scheduler backend adapter
                         |                (ECS/task, process, cluster,
                         |                 or eligible serverless backend)
                         v
                 runtime allocations
                   |              |
                   | host 1..N     | host separate paper target
                   v tenant cells  v
 shared research/decision plane -> immutable plans -> shared paper runtime
                         |
                         +---------------------------> tenant live cells
```

There is no arrow from a frontend to an engine. There is no engine callback into a UI. The UI may request a
runtime lifecycle change, but the API persists authorized desired state and a controller—not the UI—calls the
scheduler. Push notifications, webhooks, and gamified views are separate projection/notification consumers.
Every engine remains correct if every frontend is offline.

The control database is a transport, identity/authorization source, lifecycle desired-state store, and read-model
store. It does not become the order, fill, cash, position, or budget-control ledger merely because several
clients and scheduler backends use it. Scheduler task IDs and vendor state are controller details, not API or
money-domain identities.

## 5. Identity, sessions, and multiple clients

### 5.1 Authentication

Use an OIDC provider rather than extending the current `AUTH_PASSWORD` and 14-day HMAC cookie. Required provider
capabilities are:

- immutable issuer/subject identity;
- MFA or passkeys and step-up authentication;
- authorization-code flow with PKCE;
- short-lived access tokens, rotating/revocable refresh sessions, and global session revocation;
- recovery and account-disable events that can trigger a tenant safety action;
- an auditable administrative way to bootstrap the two application roles.

Recommended client handling:

| Client | Authentication/session shape |
| --- | --- |
| Web | Authorization code + PKCE; server-managed opaque session in an `HttpOnly`, `Secure`, appropriately `SameSite` cookie; ordinary CSRF protections remain. |
| Mobile | System-browser authorization code + PKCE; refresh material in OS secure storage; device sessions independently revocable. |
| User-authorized integration | Delegated OAuth consent with narrow read scopes, expiry, and revocation. No password or copied browser cookie. |
| Machine integration | Service identity and explicit non-human scopes. It receives no funded mutation scope. |

Tokens carry issuer, subject, audience, client identity, expiry, session identity, and coarse scopes. Current
membership and role grants are loaded server-side for sensitive requests so removing a role does not wait for a
long token to expire.

### 5.2 Authorization equation

For each request:

```text
effective permission = valid identity and session
                     ∩ allowed OAuth client/audience/scope
                     ∩ active tenant membership
                     ∩ current role grant at the required scope
                     ∩ ownership of the requested resource
                     ∩ step-up/typed-confirmation requirement
                     ∩ command-specific safety and revision guards
```

The tenant comes from the authenticated membership/resource relation, never from trusting a header, path ID,
JWT custom claim, or JSON body by itself. Cross-tenant denials should return the same bounded not-found response
as an absent resource where practical.

### 5.3 Initial roles

Roles are additive; neither role implies the other.

| Role | Scope | Capabilities |
| --- | --- | --- |
| `basic_user` | Personal tenant | Read shared paper information; read only that tenant's live projection/history; manage that tenant's venue connections and budget; request allowed provision/start/safe-stop/restart/retire lifecycle operations and pause/reconcile/resume/provider/mode commands for that tenant under all applicable gates. |
| `paper_manager` | Shared paper runtime | Read paper information; pause/reset/configure the shared paper runtime and its bankroll under paper guards. It grants no access to any tenant's live status, P&L, budget, credentials, or commands. |

Role grants are managed out of band in V1. There is no self-service role assignment and no third application
role hidden in frontend conditionals. Infrastructure/database administration is an operational capability, not
an application role exposed to users.

A `paper_manager` who also needs a personal live account receives both grants. A `paper_manager` grant alone
cannot enumerate tenants. UI visibility is derived from API capabilities, but hiding a control is not the
authorization check.

### 5.4 Sensitive-session events

Resume, live mode/provider enablement, material budget changes, credential rotation/deletion, runtime retirement,
and account recovery require recent step-up authentication and immutable audit. Logout does not pause a healthy
cell. User disablement, suspected account takeover, MFA reset/recovery, or tenant ownership recovery should
append a non-expiring `pause_and_drain` request before or alongside session revocation. An unacknowledged Pause
must still be displayed as unacknowledged, per the engine-separation design.

## 6. Tenant-keyed application data

### 6.1 Conceptual schema

Exact migrations are deferred, but the ownership relationships are not:

```text
identity.users(id, issuer, subject, status, created_at, ...minimal profile)
identity.tenants(id, kind, status, created_at)
identity.memberships(tenant_id, user_id, status, created_at)
identity.roles(id)                                  -- two registered values initially
identity.role_grants(user_id, role_id, scope_kind, scope_id, granted_at, revoked_at)
identity.oauth_clients(id, kind, status, allowed_scopes)
identity.user_sessions(id, user_id, provider_session_ref, client_id, revoked_at)

control.execution_cells(cell_id, tenant_id, generation, desired_runtime_state,
                        observed_runtime_state, execution_lifecycle, placement_profile, ...)
control.runtime_allocations(allocation_id, backend_id, backend_ref, generation, observed_state, ...)
control.runtime_assignments(allocation_id, runtime_target_id, assignment_generation, ...)
control.runtime_lifecycle_requests(id, runtime_target_id, desired_state, actor_user_id,
                                   actor_client_id, status, ...)
control.runtime_leases(runtime_target_id, fence, boot_id, expires_at, ...)
control.commands(id, runtime_target_id, tenant_id?, kind, schema_version, payload,
                 actor_user_id, actor_client_id, actor_session_id, status, ...)
control.command_audit(id, tenant_id?, command_id, actor_user_id, actor_client_id, event, ...)
control.venue_connections(tenant_id, connection_id, provider_id, environment,
                          secret_ref, secret_version, account_fingerprint, status, revision)
control.live_projections(tenant_id, cell_id, revision, generated_at, sanitized_payload)
control.paper_projection(runtime_target_id, revision, generated_at, sanitized_payload)
```

Tenant live budget authority and execution ledgers remain cell-owned under the first implementation. **Cell-owned
means one logical mutation authority, not process-local or memory-only storage.** The first implementation must
place every recovery-critical ledger and control record in a tenant-scoped persistent namespace that outlives
process and ordinary allocation replacement. If repositories later move into Postgres, that is a separately
reviewed money-store migration; every table and journal key must then include `tenantId`, while each tenant still
has one account-level writer.

### 6.2 Database isolation rules

- Every tenant-owned row has a non-null immutable `tenant_id`.
- Parent keys used by tenant data are unique on `(tenant_id, id)`. Foreign keys repeat both values, preventing a
  child in tenant A from referring to a connection, command, or projection in tenant B.
- Tenant tables use forced row-level security. The application pool role and cell roles do not have
  `BYPASSRLS`; table owners are not used by runtimes.
- Request transaction context is set only from a verified server-side principal and is transaction-local.
  Connection-pool reuse cannot retain a prior tenant context.
- Repository methods still require `tenantId` explicitly and include it in predicates. RLS is defense in depth,
  not permission to write unscoped queries.
- Paper tables are physically/logically separate from tenant live tables and carry no synthetic tenant that
  could accidentally grant a paper manager live access.
- A runtime allocation receives a short-lived database identity limited to its assigned target set. A
  single-tenant allocation can be limited to one target. A pooled allocation necessarily has the union of its
  assigned targets; that larger compromise blast radius must be explicit in the placement profile and cannot be
  described as cell-level process isolation.
- Migration/admin, identity API, application API, runtime controller, scheduler adapter, paper runtime,
  execution allocations, credential ingest, public read, and reporting use separate least-privilege roles.

### 6.3 Supporting several client applications

“Database support for multiple clients” means that the API and schema retain client identity and concurrency;
it does **not** mean web/mobile/integrations receive direct database access.

- Commands and sensitive reads audit both human `actor_user_id` and OAuth `actor_client_id`.
- Idempotency is unique within `(tenant_id or paper target, actor_client_id, idempotency_key)`.
- Optimistic revisions are resource-specific so a web edit and mobile edit cannot silently overwrite one
  another.
- Read projections have stable schemas, cursors, bounded pagination, and generated/observed timestamps suitable
  for reconnecting mobile clients.
- API versions are client-neutral. Frontend-specific composition may live in a web BFF or mobile layer, but
  canonical command and projection semantics do not import React/Next/mobile types.
- Per-user, per-client, per-tenant, and per-IP rate limits are separate. One integration cannot consume the
  interactive user's mutation allowance.

## 7. Shared decision plane, logical cells, and adaptable compute

### 7.1 Why the whole engine is not copied per user

The current engine intentionally co-locates shared market collection, forecasts, sentinels, paper, and one live
account. Copying it for every user would:

- issue duplicate public reads and retain duplicate research history;
- create one paper truth per user when the requirement is one shared paper surface;
- make policy/model/catalog rollout drift between user processes;
- increase the number of schedulers and evidence writers without improving account isolation;
- couple a tenant's live availability to unrelated model/report memory pressure.

The required precursor is the `AsOfSnapshot`/`DecisionPlan` boundary proposed by
`execution-engine-separation-design.md` §§4.6–4.7. The shared plane publishes an immutable plan containing
snapshot IDs/watermarks, model/policy/catalog/build hashes, strategy identity, proposed action, validity window,
and complete reason/provenance. It contains no tenant, user, capital, credential, or execution mode.

A plan is not an order. Paper and live consumers reject unknown schema/build/policy/catalog hashes, stale plans,
duplicate plan identity, missing provenance, and incompatible capabilities. Each consumer reruns the shared
pure admission/portfolio rules from the referenced immutable inputs as a corruption and mirror check. A live
cell then independently joins only its own budget, positions, risk, permissions, fresh execution quote, venue
cash, rate limits, lease, intent, and reconciliation before constructing an order instruction.

### 7.2 Logical cell boundary

Use one **logical** live cell per tenant, which is effectively one cell per user while all tenants are personal.
Do not use one authority per browser session, strategy, or venue. A process, task, or container may host one or
more cells if the selected placement profile satisfies the required isolation and deadline gates.

A cell owns for exactly one tenant:

- one fenced lease and execution lifecycle state;
- all tenant live operator intent and control revisions;
- one serialized account execution/control queue whose recovery-critical work identity and state are durable;
- all tenant venue connections and account-wide request/rate coordination;
- budget epochs and reservations keyed provider → market → policy;
- the shared tenant order/fill/position ledger across strategies;
- reconciliation, drain, managed remainders, exits, and settlement;
- tenant live projection and sanitized audit output.

The cell context knows an opaque `tenantId`/`cellId`, not the user's email, name, device, frontend, or role list.
No mutable process-global “current tenant” is allowed. Every queue item, repository handle, credential capability,
timer, and adapter call is constructed from an immutable cell context. The API has already authorized a command,
but the cell still validates target, schema, fence, revision, local state, compiled capability, and every
execution safety gate.

Logical correctness is invariant across placement: T1 never spends T2's budget or writes T2's ledger even when
their cells are co-hosted. Physical compromise and availability isolation are different claims and depend on the
placement profile.

### 7.3 Placement-neutral runtime contract

Define a runtime-controller contract in domain terms rather than exposing ECS/Kubernetes/serverless concepts:

```ts
interface RuntimeBackend {
  ensureProvisioned(request: ProvisionedRuntimeSpec): Promise<BackendOperation>;
  ensureStarted(request: StartedRuntimeSpec): Promise<BackendOperation>;
  ensureStopped(request: StoppedRuntimeSpec): Promise<BackendOperation>;
  observe(allocationId: string): Promise<ObservedAllocationState>;
}
```

This is an orchestration interface, not an engine API. The controller itself may be a supervised service, a
queue consumer, or an idempotent serverless reconciler; its durable desired state and operation identity, not
process memory, drive convergence. Calls are idempotent by runtime target generation and controller operation
ID. A backend reports opaque allocation identity, assignment generation, observed compute state, and bounded
diagnostic codes. It cannot report trading ready, reconciled, paused, or restart-safe; only the
cell can publish those financial/operational facts.

Supported placement profiles may include:

| Profile | Shape | Main tradeoff |
| --- | --- | --- |
| Dedicated service/task | One supervised process, task, container, or VM hosts one tenant cell. | Smaller tenant blast radius; higher fleet and idle cost. |
| Pooled service | One long-lived allocation hosts several independent cell contexts. | Better density; process compromise/crash and resource contention affect the assigned tenant set. |
| Scheduler-created task | A controller creates/stops allocations on demand, as with ECS tasks or cluster jobs. | Good lifecycle control; startup latency, volume attachment, secret delegation, and drain ordering become load-bearing. |
| Bounded serverless invocation | A scheduler invokes a stateless cell slice for one target/generation. | No idle process, but incompatible with current local stores and long-lived order management until authority/state are externalized and overlap is fenced. |
| Hybrid | Active/open-position cells use durable allocations; eligible dormant or bounded work uses pooled/serverless capacity. | Efficient but requires explicit, reconciled placement transitions. |

No profile is selected by this document. `placementProfile` is versioned registry/config data interpreted by the
runtime controller and can only select an implemented backend. The public API uses stable desired-state terms,
not task definitions, cluster names, function ARNs, CPU flags, or vendor status strings.

Moving a cell between allocations is a controlled takeover: block new exposure, pause/drain where required,
flush/verify durable state, end the old assignment, expire its fence/capabilities, acquire a newer fence in the
new assignment, run complete startup reconciliation, and remain paused unless a separately authorized Resume is
valid. Two allocations must never concurrently own one cell merely because a scheduler retried.

### 7.4 UI-requested lifecycle and desired state

An authorized basic user may request lifecycle actions for their tenant through the client-neutral API. The API
writes immutable desired-state/lifecycle-request records. A runtime controller with scheduler permission
reconciles them asynchronously; the frontend never calls ECS, a cluster, a process manager, or a function API
directly.

Keep compute lifecycle and trading lifecycle separate:

| User request | Controller/cell meaning | What it never means |
| --- | --- | --- |
| `provision` | Allocate cell identity, durable-state namespace, secret namespace, placement policy, and initial compute as required. Idempotent. | No credential, budget, live capability, arming, or Resume. |
| `start` | Ask the backend to run an allocation, acquire a new cell fence, load stores, and complete startup reconciliation. | “Trading active.” A newly provisioned cell starts paused; a prior explicit Stop leaves intent paused. |
| `safe_stop` | Withdraw operator intent first; cell drains/cancels/confirms/reconciles and publishes restart-safe; controller then stops/deassigns compute. | Immediate proof that the venue is safe merely because a task stopped. |
| `restart` | A composed safe stop followed by start unless an infrastructure recovery path is explicitly required. | Permission to skip drain/reconciliation or fabricate active intent. |
| `retire` | Only after credentials are revoked as required, no managed/open lifecycle remains, state retention/export rules pass, and compute is safely stopped. | Ledger deletion or venue credential revocation by implication. |

Lifecycle results are independently visible as `requested`, `provisioning`, `starting`, `running`, `stopping`,
`stopped`, `failed`, or `unknown`. Beside them the UI shows cell lifecycle such as `reconciling`, `ready`,
`active`, `draining`, `quiescent`, or `blocked`. “Task stopped” and “paused · quiescent · restart-safe” are not
synonyms.

If a cell is unobserved, a controller may ensure that no assigned allocation is running, but it cannot confirm
venue safety. The UI reports **compute stopped/unobserved; account safety unconfirmed**. The next Start requires
full authoritative reconciliation. An emergency hard stop may remain an infrastructure operation, but it is not
the ordinary user Stop and cannot produce a success-style drain result.

The runtime controller may create and terminate compute, attach scoped storage/identity, and observe scheduler
state. It cannot read venue secrets, insert trading commands other than the prescribed lifecycle sequencing,
mutate budgets/ledgers, mark reconciliation ready, or Resume.

### 7.5 Three kinds of scheduling

Do not collapse these independent schedulers:

1. **Runtime controller/scheduler** — places, starts, stops, and replaces physical allocations from desired state.
2. **Engine task scheduler** — owns market clocks, quote deadlines, managed orders, reconciliation cadence, and
   queue priorities inside the research, paper, or live runtime.
3. **External cron/serverless scheduler** — may trigger bounded idempotent work such as projection refresh,
   notification delivery, archive verification, or eligible collection/evaluation jobs.

An infrastructure cron never recomputes a contract boundary, grants an order fence, or becomes authoritative
merely because it invoked a function. Domain clocks remain in the engine task registry and take explicit UTC
clocks as required by the existing design.

Current local durable ledgers, process-local queues, managed-maker polling, heartbeat lease, and reconciliation
make a stateless function unsuitable as the live cell authority. A serverless live backend becomes eligible only
after a separate design proves all of the following:

- money/control/order state is in an authoritative transactional repository external to one invocation;
- every invocation acquires and rechecks the cell fence and overlapping invocations cannot submit;
- durable timers/workflows cover order management, cancellation confirmation, exits, and reconciliation within
  venue deadlines despite cold starts and maximum invocation duration;
- ambiguity survives timeout/crash and triggers authoritative reconciliation rather than retrying an order;
- secret delegation is target/generation-scoped and expires with the invocation;
- the same money, mirror, crash-injection, ordering, and restart-safe gates pass as a long-lived backend.

Serverless remains a good candidate for stateless APIs, authentication callbacks, read projections,
notifications/webhooks, and bounded research jobs that have no order or ledger authority. Choosing it for those
roles does not imply it is safe for funded execution.

### 7.6 Isolation properties are placement capabilities

Every backend/profile declares and is tested for:

- maximum tenant cells per allocation and resulting compromise/failure blast radius;
- persistence model, durable-commit semantics, writer exclusion, and placement migration semantics; backup and
  redundant-copy design are evaluated separately;
- database/secret/KMS capability scope and whether it is per target or the union of an assigned pool;
- CPU, memory, file, network, venue-rate, and queue isolation/backpressure;
- startup latency, maximum runtime, shutdown/drain grace, restart policy, and scheduling availability;
- ingress/egress policy, image/artifact identity, non-root/read-only execution where applicable;
- log/metric/trace separation and absence of PII/secrets;
- whether it can continuously meet each active strategy's management/reconciliation deadlines.

Dedicated containers, processes, or microVMs may provide a smaller operational blast radius, but none is declared
the security boundary merely by name. A pooled process can be an approved profile only with tenant-keyed state
and measured noisy-neighbor behavior; its process compromise exposes the union of assigned capabilities and must
be disclosed in the threat model. The design prohibits tenant-supplied code and dynamic plug-ins in every funded
profile.

### 7.7 Scoped leases and fencing

Replace the singleton lease key with `runtimeTargetId`:

- one target for shared paper;
- one target per tenant live cell;
- monotonically increasing fence independently per target and assignment generation.

Cell T1 cannot acquire T2's lease through its cell context. Every T1 entry/replacement rechecks T1's unexpired
fence and control health. Lease loss blocks T1 new exposure without intentionally stopping paper or T2. A pooled
allocation failure may make all of its assigned cells unavailable, but each recovers under its own newer fence.
Duplicate starts for one tenant are rejected by both repository writer exclusion and the target lease. Client
order identities include a bounded opaque cell/account component where venue limits permit, while full
`(tenantId, connectionId, strategyId, intentId)` identity stays durable in the owning tenant ledger.

### 7.8 Engine continuity and durable persistence

Durability here is a crash/restart property, separate from backup and high availability. For the covered failure
model, the objective is **zero loss of successfully acknowledged execution-critical commits across a process
crash, restart, deployment, or ordinary allocation replacement**. Persistent-store destruction, region loss,
and disaster-recovery RPO are outside that claim and require the separate backup/redundancy design.

The durability contract is:

- No authoritative live control or financial state may have its only copy in a heap object, process-local queue,
  timer, temporary file, container writable layer, log, metric, or frontend projection. Those may accelerate or
  display durable state but cannot be the recovery source.
- Each cell has a tenant-scoped persistent namespace that survives its hosting process. A local implementation
  must use an explicitly attached persistent volume with one-writer exclusion; a database implementation must
  use transactions and a scoped runtime identity. Placement profiles that cannot provide this are ineligible for
  funded cells.
- Every authoritative mutation carries the current cell generation/fence. The repository rejects a stale writer
  at commit time, in the same atomic operation as the mutation; checking a lease only in process memory is not
  sufficient. The cell also rechecks its fence immediately before each irreversible venue request.
- The immutable decision plan and its referenced as-of inputs are durably published before any paper or live
  consumer may act. The consuming ledger records the plan identity, hashes, and provenance needed to validate
  the action after restart.
- Operator intent, command identity/idempotency, budget revision/epoch, reservation, durable client order ID,
  selected connection/listing, and pre-submit order intent commit **before** the first venue mutation. A crash
  after that commit but before a venue response leaves an explicit ambiguous operation for reconciliation; it
  never becomes permission to submit a replacement blindly.
- Venue acknowledgements, rejections, fills, cancellations, settlement observations, and uncertainty transitions
  commit before releasing reservations, advancing a managed lifecycle, reporting terminal success, or using the
  result in another money decision. Partial fills and unresolved orders remain durable open work.
- Managed-order deadlines, cancellation/drain progress, reconciliation checkpoints, credential-version pointers,
  and any timer/work item whose loss could miss a financial obligation are recoverable from durable records.
  Wall-clock timers may be reconstructed in memory only from those records and explicit UTC deadlines.
- A successful API `202` requires the command/lifecycle request to be committed to its durable inbox. A cell
  reports `succeeded`, `quiescent`, `restart-safe`, or `reconciled` only after the corresponding authoritative
  state and audit result are durably committed.
- A durable commit has storage-level meaning, not merely completion of an in-process promise or write to an OS
  page cache. The selected repository must document and test its commit boundary (for example, synchronous
  database commit, or append/atomic replacement plus the required file and directory synchronization).
- Coherent money transitions are atomic where one transactional repository can own them. Where a venue call or
  multiple stores prevent one transaction, an append-only state machine with stable operation IDs, monotonic
  revisions, idempotent replay, and explicit `uncertain` state provides convergence. Startup never guesses across
  a torn transition.
- An active funded cell runs under supervision with bounded queues, resource limits, restart backoff, and health
  signals independent of the UI. Required order management, exits, settlement, and reconciliation take priority;
  overload sheds optional research/projection work before a money deadline. A crash loop blocks new exposure and
  remains visibly recovery-required rather than resetting state or repeatedly retrying work.
- Planned deploy, scale-down, and placement changes use safe drain and fenced takeover. An emergency termination
  may interrupt the process, but it cannot erase durable intent or be reported as a successful safe stop.

On every boot or takeover, the cell rebuilds queues and timers from durable state, validates journals/schema and
monotonic revisions, acquires a newer fence, identifies interrupted work, and completes authoritative venue
reconciliation before new exposure. Corrupt, missing, discontinuous, or contradictory recovery state fails
closed; it is never replaced with an empty ledger. The service supervisor restarts crashes with bounded backoff,
but supervision is availability assistance—not a substitute for persistence.

Memory-only data is allowed only when it is safely recomputable or disposable, such as bounded caches, current
poll scheduling, and sanitized health samples. If losing an observation could change reconstruction of an active
order, budget, control decision, or financial history promised to the user, that observation is not disposable
and must cross the durable boundary first.

The shared paper runtime follows the same persistence rule for its bankroll, reservations, orders, fills, and
settlement history, although it remains physically and authoritatively separate from every tenant live store.

## 8. Paper remains shared and separate

The paper runtime is platform-owned, not copied into each personal tenant:

- it consumes the same immutable production decision plans and reruns the same pure rule layer;
- it owns its own bankroll, reservations, fill simulation, order ledger, settlement, and lease;
- it has no tenant venue secret, tenant live projection, tenant command, or live order adapter capability;
- it publishes one bounded shared paper projection readable by signed-in users and any separately approved
  public surface;
- only `paper_manager` can send paper mutations; a paper command can never target a tenant cell;
- a tenant live Pause/budget/depletion cannot pause paper, and a paper reset cannot mutate tenant state.

SPEC §12.3 remains authoritative: a snapshot's production entry decision is identical across paper and every
live tenant cell. Tenant-specific budgets, positions, rate limits, venue account readiness, and real fills are
capital/execution differences and must be recorded as typed per-tenant skips, not smuggled into the rule layer.

If private per-user paper portfolios are desired later, they are a new execution product and budget model, not
an extra column on the shared paper ledger.

## 9. Venue credential custody and lifecycle

Credential management is a separate sensitive plane, not a generic JSON command and not a field on the user or
venue-connection row.

### 9.1 Ingest and storage

1. A recently step-up-authenticated user submits a credential only through a dedicated, size-limited,
   no-log credential route for a connection owned by that user's tenant.
2. Prefer client-side envelope encryption to a tenant/cell public ingestion key so the general application API
   handles only ciphertext. The credential screen loads no third-party scripts; strict CSP and dependency
   review remain necessary because browser encryption does not defeat compromised frontend code.
3. The credential service writes a new immutable secret version under a tenant-specific KMS key/secret policy.
   The plaintext is never written to the application DB, command payload, audit event, analytics, error tracker,
   temp file, or ordinary backup.
4. The application DB records only secret reference/version, provider/environment, creation state, last test
   time, sanitized capabilities, and a keyed account fingerprint.
5. The runtime assigned to the owning cell retrieves the version through a target- and generation-scoped
   capability, validates inbound venue account data, and returns only a sanitized connectivity result. A pooled
   allocation receives the union of its assigned secret capabilities and therefore has the corresponding blast
   radius. Adding a credential never enables live trading.

If client-side envelope encryption is deferred, credential ingest must still be a separately deployed minimal
service that receives plaintext only in memory over TLS, disables body/access logging, immediately envelope-
encrypts, and is not the general web/API runtime.

### 9.2 Connection/account uniqueness

A venue connection belongs to one tenant and one provider environment. Derive a non-reversible keyed HMAC
fingerprint from the authoritative venue account identity after the first signed read. A uniqueness check rejects
attaching the same venue account to two active tenants. Without that rule, two cells could reserve and trade the
same cash while each believed it was the sole account writer.

V1 supports at most one active account per `(tenant, provider, environment)`. Supporting subaccounts or multiple
accounts requires explicit account-level ledgers, limits, and reconciliation ownership and is deferred.

### 9.3 Rotation, revocation, and deletion

- Rotation creates a new version; it never edits secret bytes in place.
- A cell changes versions only while new entries are blocked and after the command/reconciliation state proves
  the account identity did not unexpectedly change.
- A failed or ambiguous test cannot release reservations or infer that venue orders disappeared.
- “Disable” blocks new entries but preserves enough access for cancellations, reduce-only management,
  reconciliation, and settlement.
- Destructive credential deletion requires paused/quiescent state, no unresolved lifecycle requiring the key,
  authoritative reconciliation, explicit user confirmation, and secret-store deletion audit. The UI must first
  direct the user to revoke the credential at the venue; local deletion alone does not revoke it.
- Secret values are write-only. No API, frontend, paper manager, support view, or audit export can reveal them.

## 10. Tenant budgets and live controls

Each personal tenant manages only its own live budget. Preserve existing money semantics inside the cell:

- durable budget-control amounts are integer cents with existing adverse quantization rules;
- physical cash and budget remain provider-scoped; allocation remains provider → market → policy;
- all strategies in a tenant share account/global exposure, kill switch, rate ceilings, reconciliation, and
  serialized execution;
- every reservation/order/fill/P&L row carries tenant, connection, strategy, market, instrument, and listing
  identity as applicable;
- a budget command cannot arm, resume, enable a provider, install a strategy, or widen an environment/compiled
  ceiling;
- configuration requires the same paused, quiescent, restart-safe, revision, open-position, and reservation
  guards as the single-operator system;
- displayed venue cash never silently becomes authorized budget.

The API may validate whole-cent shape and ownership. The cell performs authoritative revision, epoch, risk, and
money checks and records the result. Paper managers cannot configure tenant budgets. A basic user cannot inspect
another tenant's budget even if a command/projection UUID is guessed.

## 11. Commands, projections, and engine/UI independence

### 11.1 Targeted command envelope

Extend the engine-separation command envelope with:

- `runtimeTargetKind: 'paper' | 'tenant_live'` and opaque `runtimeTargetId`;
- non-null `tenantId` for tenant-live commands and null tenant for shared paper;
- authenticated `actorUserId`, `actorClientId`, and `actorSessionId`;
- authorization decision/version and step-up timestamp/reference;
- client-scoped idempotency key;
- expected cell boot/fence and resource revisions;
- no venue secret, raw private response, PII profile, or frontend-specific payload.

The API can append only command kinds allowed by the actor's effective permission. A paper runtime can claim only
paper commands. A live cell can claim only its exact tenant target. Engines validate again and publish
`requested`, `applying`, `succeeded`, `rejected`, or `recovery_required`; API acceptance remains `202`, not proof
that anything changed.

Credential byte changes use the credential plane. Its sanitized version-availability event may cause the cell to
test/reload under the same quiescent rules, but the secret itself never enters the control inbox.

### 11.2 Runtime lifecycle requests

Provision/start/safe-stop/restart/retire are not trading commands claimed by the engine. They use a separate
immutable request envelope containing runtime target/generation, desired compute state, placement-policy
revision, actor/session/client audit, idempotency key, expected lifecycle revision, and sanitized result.

The runtime controller claims that request and invokes the selected backend. For `safe_stop`, it first ensures a
non-expiring cell `pause_and_drain` command exists and waits for that exact generation to acknowledge quiescent,
restart-safe state before stopping compute. Backend success can establish only allocation state. It cannot mark
the cell reconciled, safe, active, or resumed. `start` and `provision` never enqueue Resume.

The application API returns `202` and clients follow both lifecycle-request status and the separately projected
cell state. Backend retries use the original controller operation ID and target generation; they do not create a
second cell authority.

### 11.3 Read models

Expose client-neutral bounded resources, not the engine's internal `Dashboard` object:

- shared paper summary/history/status;
- `me` identity, memberships, role-derived capabilities, sessions/devices, and connected clients;
- tenant venue-connection metadata without secrets;
- tenant budget/control/reconciliation/risk/task summary;
- tenant live orders/fills/positions/P&L with required exact-versus-whole-cent labels;
- command status/audit visible only to its authorized scope.

Private routes are `Cache-Control: private, no-store`. Every projection includes source generation time, database
observation time, revision, runtime target, build/protocol identity, and heartbeat age. An absent/stale tenant
heartbeat means **that cell is unobserved**, not stopped or safe. T1's failure does not make T2 or paper stale.

### 11.4 Mechanical boundaries

Add dependency/invariant checks forbidding:

- any frontend package → engine package, engine store, venue adapter, scheduler SDK, secret broker internals, or
  database driver;
- application API → scheduler SDK/credentials, live order functions, execution ledgers, reconciliation mutation,
  or paper internals;
- runtime controller/backend adapter → venue adapters, secrets, budgets, ledgers, reconciliation authority, or
  Resume;
- engine → React, Next route/component, mobile, notification, webhook, OAuth UI, scheduler SDK, or runtime
  controller mutation code;
- research/decision plane → tenant identity, credentials, budgets, or live projections;
- paper runtime → tenant commands, tenant secrets, live adapter mutations, or tenant ledgers;
- tenant cell T1 repository/credential/command access → T2 resources;
- gamified/integration modules → funded commands, budgets, policy, forecasts, or order paths.

## 12. Private financial information, PII, and security isolation

Tenant financial records are security-sensitive whether or not a jurisdiction labels every field as regulated
financial data or PII. Disclosure can reveal wealth, losses, trading behavior, strategy, counterparties/venues,
and account activity; unauthorized mutation can move money or conceal an unsafe account state. The required
properties are therefore confidentiality **and** integrity, with tenant isolation enforced at every hop. An
opaque UUID, encryption at rest, or a hidden UI control is not an authorization boundary.

### 12.1 Data classes

| Class | Examples | Storage/access rule |
| --- | --- | --- |
| Shared/public research | Market observations, catalog, sanitized shared paper results | No user identity; separately bounded public/signed projections. |
| Restricted tenant financial | Budget, balances, live orders/fills/positions/P&L, strategy/account activity, commands, connection status | Default-deny and tenant-keyed; owning user and narrowly scoped owning cell/API paths only as required. No routine cross-tenant support access. |
| Identity/PII | Email, display name, identity subject mapping, devices, recovery/admin events | Identity schema/service only; engines never receive profile fields. |
| Secrets | Venue keys, signing material, refresh tokens, KMS material | Secret/identity provider only; never ordinary DB/projections/logs. |
| Restricted audit/diagnostics | IP/user agent, venue account ID, raw signed response, security events | Separate retention/access; sanitized before support or user projection. |

A venue order history and P&L are personal financial data even when they contain no name. Treat pseudonymous
`tenantId` as confidential correlation data, not as anonymization.

### 12.2 Required controls

- TLS for every hop; encryption at rest for databases, persistent volumes, and object storage; per-tenant data
  keys for live volumes/secrets where supported. A later backup design must preserve the same classification and
  tenant-scoped restore authority.
- Default-deny authorization for private financial information across APIs, repositories, object keys, caches,
  queues, search indexes, exports, support tools, and observability. Tenant identity is derived from the verified
  principal/resource relation and propagated as immutable scoped context; user-supplied IDs never establish it.
- Support and operations have no routine ability to browse tenant financial information. Any necessary
  break-glass access is narrowly scoped, recently reauthenticated, time-limited, reason-bound, alerted, and
  immutably audited.
- Data minimization: the cell receives no profile; the research/paper services receive no tenant; the API does
  not receive reusable venue secrets after ingestion.
- No secrets, raw signed payloads, emails, account IDs, order descriptions supplied by users, or access tokens in
  logs, metrics labels, traces, crash reports, notifications, analytics, or URLs.
- Pseudonymous cell IDs in operations tooling, with identity resolution limited to an audited support/security
  path.
- Separate persistent namespaces and recovery permissions for identity, control, tenant execution, shared paper,
  research, and secrets. A recovery or migration operation for one tenant cannot read or overwrite another
  tenant or start a second writer. Backup/restore mechanics are specified separately.
- Explicit retention for profile/session data, command/security audit, tenant financial history, raw venue
  diagnostics, paper evidence, and research observations. “Delete account” first pauses/drains, revokes sessions
  and venue secrets, and then follows the disclosed financial/audit retention policy rather than deleting an
  active ledger.
- User export is assembled by an authorized privacy job from that tenant only, contains no credential bytes or
  another user's data, is encrypted, expires, and is audited.
- Production data is never copied to development. Fixtures use synthetic tenant/account identities.
- Dependency pinning, CSP, secret scanning, image scanning, patching, and an external security review are gates
  before accepting credentials from multiple people.

Infrastructure administrators remain a high-trust boundary. Per-tenant application encryption reduces accidental
and workload compromise but does not by itself protect against a fully compromised KMS/database administrator.
That residual risk must be stated rather than hidden behind “encrypted at rest.”

## 13. Failure and compromise behavior

| Failure | Required behavior |
| --- | --- |
| Web/mobile/integration outage | Engines continue; controls unavailable only through that client. |
| Application API outage | Cells continue safe lifecycle work; new remote commands unavailable. Apply the approved control-plane lease-loss rule to new live exposure. |
| Identity provider outage | Existing short-lived sessions behave per policy; no new login/step-up. No bypass login. |
| Tenant T1 cell-context crash/failure | T1 becomes stale and recovers behind a newer T1 fence and full T1 reconciliation. A dedicated allocation limits compute impact to T1; a pooled allocation may also restart its assigned cells, each under its own fence. |
| Runtime controller/scheduler outage | Running allocations continue according to their own lease/control policy; lifecycle requests remain pending. The UI does not report desired state as observed state. |
| Tenant T1 venue outage | T1's affected connection fails closed without intentionally degrading another tenant or shared paper data. |
| Paper crash/depletion | Paper becomes stale/depleted; no tenant live intent or budget changes. |
| Shared decision plane stale | Paper and every cell reject stale plans/new entries; position management and reconciliation continue where safe. |
| T1 lease/control loss | T1 blocks new exposure; T2 and paper retain their independent fences. |
| Compromised integration token | Effective scope limits reads; no funded mutation scope exists; revoke client grant/session. |
| Suspected user takeover | Revoke sessions and append T1 non-expiring pause/drain; do not claim safety until cell acknowledgement. |
| Compromised T1 execution context | Tenant-keyed repositories must prevent accidental T2 access. A full allocation compromise reaches every capability assigned to that allocation, so the blast radius is T1 when dedicated and the assigned pool when shared. Platform emergency handling blocks/revokes affected cells and reconciles each venue account. |
| Duplicate venue account across tenants | Reject connection before live capability; never allow two account writers. |
| Scheduler/allocation host loss with persistent store intact | Start a replacement only behind a newer fence; load the same durable tenant namespace and complete authoritative reconciliation before new exposure. No in-memory state is assumed to survive. |
| Persistent-store or region loss | Outside this document's zero-loss claim. Block the cell and do not fabricate state or automatically fail over; recovery, RPO, redundancy, and restore are governed by the separate approved backup/disaster-recovery design. |

A shared decision-plane compromise remains capable of proposing bad plans to many cells. Mitigations are pinned
artifacts, signed/versioned plans, independent pure-rule recomputation, strict freshness/schema/catalog checks,
cell-local risk ceilings, and separated authorities. No process, container, scheduler, or serverless label
eliminates that risk.

## 14. Frontend and integration rules

- Web and mobile are peers of the application API. Neither is the canonical owner of business state.
- API capability responses drive presentation, but server authorization remains authoritative.
- Mobile push contains only a generic event and opaque reference; the app authenticates and fetches current
  private state. Do not put P&L, position, venue, or user identity in lock-screen payloads by default.
- Webhooks are opt-in, signed, replay-protected, bounded, retryable, and sanitized. Their destinations and
  signing keys are tenant secrets with independent rotation.
- Gamified clients are read-only in V1. Scores, streaks, rewards, social features, LLM text, or engagement
  mechanics cannot change a budget, role, policy, provider permission, execution mode, Resume, or order.
- No public leaderboard or social share may derive from private live performance without a separate explicit
  privacy design and per-user consent. Shared paper data is the default gamified input.
- A delegated integration sees only scopes explicitly consented by the user and revocable per client. Live
  mutation scopes are absent, not merely unchecked in the integration UI.
- API deprecation windows must account for mobile clients that update slowly. Unknown command/projection schema
  versions fail closed; engines do not keep insecure legacy mutation protocols indefinitely.

## 15. Security and correctness gates

Before a second user's data or credential enters production, automate at least:

1. **Cross-tenant API matrix:** for every tenant resource and mutation, user/client A cannot read, infer, update,
   or affect B by ID, cursor, idempotency key, search, export, error, cache, or timing-friendly enumeration.
2. **RLS/foreign-key tests:** application, reporting, paper, and cell roles cannot bypass policies; a connection
   reused after tenant A's transaction cannot see A while serving B; cross-tenant foreign keys fail.
3. **Cell/placement capability tests:** T1 code cannot claim T2 commands/lease, select T2 repositories, or
   publish a T2 result even with a guessed ID. A dedicated allocation cannot read T2 secrets/volume. A pooled
   allocation's union capabilities are enumerated, bounded to its assignment set, and tested against every
   unassigned tenant.
4. **Role grid:** test both roles individually, together, revoked, wrong scope, stale session, wrong OAuth client,
   and missing step-up. `paper_manager` never gains tenant-live access.
5. **Client grid:** web and mobile produce identical command semantics; integration/service tokens cannot reach
   funded mutations; per-client idempotency and revisions are deterministic.
6. **Secret non-disclosure:** canary secrets never appear in DB payloads, command/audit rows, logs, traces,
   errors, projections, exports, backups, or frontend responses. Secret values are never readable after write.
7. **Paper/live boundary:** paper has no live credential or adapter mutation capability; paper reset/depletion
   changes no tenant row; tenant commands change no paper state.
8. **Mirror invariant:** a grid of immutable snapshots produces the same entry decision in decision, paper, and
   every live-cell consumer with no execution-mode or tenant parameter in the rule layer.
9. **Plan integrity:** stale, duplicate, reordered, unknown-build, unknown-policy, missing-provenance, and tampered
   plans cannot create an order.
10. **Money isolation:** all budget/reservation/P&L aggregates re-narrow by tenant and strategy as applicable;
    exact arithmetic tests pin adverse rounding and prevent A's cash or wins funding B.
11. **Account uniqueness:** two tenants cannot attach the same authoritative venue account; rotation cannot
    silently change account identity.
12. **Fence/failure injection:** duplicate cell starts, allocation replacement, scheduler retry, lease loss,
    and crashes before/after every durable commit, venue call, command/local audit/database acknowledgement,
    credential rotation, drain, and reconciliation never lose an acknowledged transition, double-submit, or
    falsely report safe. Restart reconstructs active queues, timers, reservations, and ambiguous operations from
    persistence alone.
13. **Resource isolation by profile:** deliberately overload T1 API/cell, optional research, and gamified reads;
    measure the impact on required T2 management/reconciliation and paper deadlines. A pooled profile is rejected
    if it exceeds its declared bound.
14. **Persistence/privacy drill:** kill and replace a cell at every write boundary while its persistent namespace
    remains intact; prove the replacement reconstructs the same authoritative state without exposing or
    overwriting another tenant. Export/delete workflows respect active positions, secret revocation, and
    retention. Backup/restore drills belong to the separate disaster-recovery design.
15. **Lifecycle/backend conformance:** every backend proves idempotent provision/start/stop observation, stale
    assignment rejection, safe-stop sequencing, unknown-state reporting, no start-to-Resume path, and no backend
    status capable of asserting reconciliation/restart safety.
16. Existing `mirror-invariant`, `strategy-isolation`, `venue-target-integrity`, `budget-ledger`, and
    `policy-manifest` invariants pass unchanged. Add a new multi-tenant isolation invariant rather than weakening
    any existing assertion.

A penetration test and threat-model review are release gates, not post-launch backlog, because users will submit
reusable financial credentials and private trading history.

## 16. Delivery plan

Every funded migration begins paused, quiescent, restart-safe, and authoritatively reconciled. A successful
software deploy does not itself resume trading.

### Phase M0 — approve product and threat boundaries

- Approve personal-tenant semantics, two-role matrix, shared-paper ownership, client types, and whether live
  integrations are permanently absent or merely deferred.
- Select the identity provider, secret/KMS system, and application API deployment; approve the placement-neutral
  runtime contract, first scheduler adapter to prototype, required durable-commit semantics, and per-tenant
  process-restart RTO without yet declaring containers, pooled processes, or serverless to be the isolation
  model. Host-loss RPO and redundancy remain a separate design decision.
- Complete data classification, retention/export/deletion policy, abuse model, and jurisdiction/privacy review.

**Gate:** this design and corresponding later `SPEC.md` decisions are approved before schema or runtime work.

### Phase M1 — complete behavior-preserving web/engine extraction

- Implement the accepted portions of `execution-engine-separation-design.md` without adding a user or splitting
  current paper/live behavior.
- Use opaque runtime-target keys in new control-plane records so the schema is not singleton-only.

**Gate:** the existing extraction gates pass; no multitenant claim is made.

### Phase M2 — create immutable decision plans and separate paper/live internally

- Implement/verify as-of snapshots and production `DecisionPlan` replay under the extensibility track.
- In one process first, make paper and live explicit consumers while preserving ordering and the mirror invariant.
- Move paper into a separate no-secret runtime allocation that is never co-hosted with funded live cells, and
  dual-run/compare before switching authority. Its backend remains replaceable.

**Gate:** complete plan equality, mirror, timing, fill, settlement, and crash characterization; paper has no import
or runtime capability path to live credentials/orders.

### Phase M3 — identity and client-neutral read API

- Add OIDC users, personal tenants, memberships, role grants, OAuth clients, RLS, and audit actor fields.
- Migrate the existing operator to one personal tenant and both/selected roles explicitly.
- Serve shared paper and the existing tenant's private projection through the versioned API; adapt web as the
  first client. Keep mutations on the existing accepted path until read isolation is proven.

**Gate:** role/client/cross-tenant/RLS tests pass; current shared password routes are removed from public attack
surface after a bounded session migration.

### Phase M4 — tenant-keyed commands, runtime controller, and one live cell

- Key lease, heartbeat, commands, idempotency, projection, audit, desired runtime state, and assignments by
  runtime target/tenant.
- Implement the runtime-controller contract and one backend adapter with idempotent provision/start/safe-stop;
  keep vendor task identity out of API/domain schemas.
- Extract the existing operator's thin live execution core into one logical tenant cell. Its first placement is a
  reversible implementation choice, not the permanent isolation decision.
- Inventory every process-local queue, timer, reservation, managed-order transition, reconciliation checkpoint,
  and control value; either persist it before it becomes authoritative or prove it is reconstructible from an
  identified durable record. Restart tests must rebuild the cell with an empty heap and no prior process state.
- Preserve current credentials through an explicit paused migration into the secret plane; never copy them into
  a general migration log or command.

**Gate:** one-tenant outputs and money state match the prior engine; the §7.8 empty-heap restart and
commit-boundary crash matrix proves no acknowledged execution-critical transition is lost; lifecycle/backend,
duplicate/fence, and credential tests pass; funded reactivation is a separate manual act.

### Phase M5 — second-tenant non-funded placement canary

- Provision a second synthetic/demo tenant and logical cell with separate tenant state, secret scope, lease,
  quotas, and logs.
- Exercise at least the intended first production placement and one materially different prototype where
  practical (for example dedicated tasks versus a pooled worker). Record capability/blast-radius differences
  rather than forcing identical claims.
- Exercise simultaneous web/mobile sessions, UI-requested provision/start/safe-stop, commands, exports,
  recovery, scheduler retries/outage, noisy-neighbor load, and account uniqueness.
- Run paper or venue demo only; no second person's funded credential yet.

**Gate:** the full §15 isolation matrix and external security review pass for the selected launch profile, with
measured caveats and rejected profiles recorded.

### Phase M6 — controlled multi-user launch

- Admit users gradually; credential setup defaults disconnected/live-disabled with zero budget.
- Require explicit budget, provider capability, environment opt-in, typed live arming, reconciliation, and Resume
  independently for every tenant.
- Alert on stale cell, duplicate-account attempt, credential test/rotation, lease loss, blocked drain, and
  cross-tenant authorization denial spikes.

**Gate:** each tenant is activated independently after cell reconciliation; one tenant's activation never changes
paper or another tenant.

### Phase M7 — mobile and integrations

- Add mobile via the same API and OIDC contracts after web parity.
- Add read-only gamified/integration scopes, consent, revocation, webhook/push privacy, and API compatibility
  policy.
- Any future funded integration mutation requires a separate design and cannot inherit a human role through a
  client credential.

## 17. Alternatives considered

### A. One full engine process/container per user

Rejected. It gives process isolation but duplicates shared collection, forecasting, evidence, and paper state;
it also multiplies provider traffic and resource use. Use a shared no-PII decision plane and thin tenant live
cells instead.

### B. One live cell per venue or strategy

Rejected. It splits account-wide cash, exposure, orders, rate limits, and reconciliation across writers. The
tenant cell is the account authority and remains internally modular.

### C. One pooled live process hosting multiple tenant cells

Retained as a placement option, not selected as the architecture. It can be operationally efficient if each
logical cell keeps its own fence, ledger, queue, repositories, credential capabilities, and timers. Its
unavoidable cost is that process compromise/crash and some resource failures affect the assigned tenant set.
It may be approved only after the pooled-profile isolation, noisy-neighbor, secret-scope, and recovery gates
pass; it must never be described as equivalent to a dedicated allocation.

### D. Separate database/schema for every tenant

Deferred as a universal rule. It improves some blast-radius properties but creates migration, connection,
reporting, and fleet costs and still does not isolate shared application credentials. Forced RLS, composite
keys, scoped allocation identities, tenant-keyed durable state, and secret scopes are the baseline. Higher-risk
profiles may later use a database or microVM per tenant without changing the API/domain identities.

### E. Frontends connect directly to Postgres or an engine

Rejected. Direct DB clients make role/schema changes public protocol, expand credential and RLS risk, and bypass
client-neutral command validation/audit. Direct engine clients couple UI availability and authentication to the
money process. All frontends use the application API.

### F. Store encrypted venue credentials in the ordinary application DB

Rejected as the target. Application compromise would place ciphertext, metadata, and decryption path together;
secret lifecycle and access audit would be coupled to general queries/backups. Use a dedicated secret plane with
target/generation-scoped runtime capabilities and per-tenant scope.

### G. Give every frontend the user's application roles in a long-lived token

Rejected. Roles change, clients need different scopes, and a compromised integration would inherit interactive
control. Effective permission is computed server-side from current grants and client scope, with step-up for
sensitive acts.

### H. Make paper a tenant

Rejected. Shared paper is a platform runtime with different readers/managers and no live credentials. Pretending
it is an ordinary tenant makes it easier for generic tenant code or a paper manager to acquire live capability.

### I. Let a frontend call ECS, a cluster, or a function service directly

Rejected. The product requirement is that a UI action can request compute lifecycle, not that the client owns
cloud credentials or scheduler semantics. The API records authorized desired state and the runtime controller
performs idempotent backend operations. This preserves audit, client parity, safe-stop sequencing, and backend
portability.

### J. Keep live state in memory and reconstruct it from the venue after restart

Rejected. Venue reconciliation is authoritative for venue cash, orders, fills, and positions, but it cannot
reconstruct operator intent, budgets, reservations, decision provenance, idempotency outcomes, management
progress, or the complete financial history promised by the application. A crash between submission and response
also requires a pre-existing durable client identity to reconcile without a duplicate order. Memory may cache
state, but it cannot be the sole system of record for a funded cell.

## 18. Decisions requested in review

1. Approve one **personal tenant per user** in V1 while keeping user and tenant identities separate?
2. Confirm that shared paper is one platform ledger visible to all signed-in users, with only `paper_manager`
   allowed to mutate it?
3. Confirm the exact `basic_user` permissions, especially whether it may Resume/live-enable after step-up or
   whether those controls require a future additional role?
4. Approve a client-neutral application/control API as canonical, with Next.js web, mobile, and integrations as
   clients and no direct database/engine access?
5. Approve OIDC/MFA/passkeys rather than building local multi-user password storage? Which provider and account
   recovery policy are acceptable?
6. Approve shared research/decision + separate paper + one logical live cell per tenant, while explicitly
   deferring whether physical allocations are dedicated, pooled, containerized, VM-based, or serverless?
7. Is one active `(tenant, provider, environment)` venue account sufficient for V1, and should duplicate venue
   accounts across tenants be rejected unconditionally?
8. Approve a dedicated credential-ingest/secret plane and client-side envelope encryption as the target? Which
   KMS/secret service is acceptable?
9. Approve forced RLS/composite tenant keys and target-scoped runtime capabilities as invariants while placement
   profiles declare their actual capability union, or require a dedicated database/microVM for every funded
   tenant from launch?
10. What profile, audit, financial-history, raw-diagnostic, and deleted-account retention periods are required,
    and what export/deletion promise should users see?
11. Are gamified integrations permanently read-only with respect to live trading (recommended), or is delegated
    funded control a future requirement needing its own design?
12. Should disabling/recovering a user always request tenant pause-and-drain, accepting that an offline cell can
    only acknowledge later?
13. What per-tenant process-restart RTO, durable-commit/replay guarantees, placement blast radius, and maximum
    noisy-neighbor impact must be measured before admitting a second funded user? Host-loss RPO and redundancy
    will be decided in the separate backup/disaster-recovery design.
14. Approve UI-requested `provision`, `start`, `safe_stop`, `restart`, and eventually `retire` as asynchronous
    desired-state operations, with Start never meaning Resume and Stop succeeding safely only after cell drain?
15. Which backend should be the first prototype (for example a local supervisor, ECS-like task scheduler, or
    pooled service), and what evidence would make a serverless live backend eligible later?
16. Approve the §7.8 durability contract, including durable-before-effect ordering and zero loss of acknowledged
    execution-critical commits for process/restart/allocation-replacement failures? Which persistent repository
    and commit semantics should the first tenant cell prove, with backup/redundancy deliberately deferred?

Until these are answered, implementation should stop at design and non-money prototypes. In particular, do not
copy the current monolithic engine per user, place user credentials in Postgres, add `tenantId` only to frontend
payloads, expose scheduler credentials to a client, hard-code vendor task identity into the API, or claim that a
process/container/serverless label proves isolation.
