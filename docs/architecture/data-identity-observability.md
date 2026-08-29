# Data, identity, and observability standards

## Data placement

Validate at ingestion and retain rejection/degradation reasons. Distinguish unknown, absent, stale, invalid, and zero. Contracts define units, precision, timezone, identifiers, schema versions, and null semantics.

Classify data before selecting a store:

- **Operational state/read models:** current frequently accessed data for interfaces, authorization, coordination, and status. A centralized PostgreSQL-compatible database is the leading hypothesis, not an accepted decision. Evaluate correctness, tenancy, availability, operations, scaling, and portability.
- **Historical/analytical:** immutable or versioned inputs, events, large payloads, exports, experiments, model datasets, and infrequent records. Prefer inexpensive durable S3-compatible object storage with open formats, checksums, encryption, lifecycle, and tested restore. Catalog lineage, retention, object version, and integrity separately from object keys.
- **Telemetry:** OpenTelemetry-based vendor-neutral collection for logs, metrics, and traces. Keep high-cardinality detail hot briefly, aggregate/downsample useful history, and move justified long-term data to cheap storage. Budget sampling/retention by value without dropping required audit/accounting.
- **Audit/accounting:** durable append-only consequential-action and resource-usage records separate from disposable debug telemetry.

### Accepted operational direction

- PostgreSQL, MongoDB, and S3-compatible object storage are available candidates. Select by data model, consistency, query, lifecycle, operational, and cost requirements; do not duplicate data across them without explicit ownership and reconciliation.
- Start with one primary database region. In-region high availability, backup failure domains, and restore testing remain required even without multi-region writes.
- Use separate PostgreSQL schemas for bounded project/domain ownership when the operational design demonstrates that migrations, pooling, observability, and access control scale.
- Default tenant isolation to shared tenant-keyed tables with mandatory tenant identifiers, composite tenant/resource keys, and PostgreSQL row-level security. Large or regulated tenants may receive dedicated schemas or databases through the same repository contracts. Do not use schema-per-tenant as the general default.
- During database unavailability, safe read-only degradation is acceptable. State-changing, funded, or authority-dependent work fails closed rather than operating on uncommitted or unverifiable state.
- Every committed operational state change produces an immutable event through a transactional outbox/audit mechanism. Current-state tables remain the primary operational model; the event record supports delivery, audit, reconstruction, and reconciliation rather than making full event sourcing the default.
- Minimize data loss as a primary durability goal; recovery time may be traded against cost and complexity. Funded state, identity, authorization, and audit target no acknowledged transaction loss under ordinary database failure and less than one minute of potential loss under regional catastrophe where feasible. Rebuildable read models and telemetry may use relaxed class-specific targets. Historical objects are versioned and recoverable from a separate failure domain.

### Accepted historical and analytical direction

- Use Scaleway's S3-compatible object storage as the initial historical/analytical store through a portable object-storage adapter.
- Do not add a second provider/region yet. Keep object manifests, checksums, versioning, inventory, and restore procedures replication-ready so another failure domain can be added later without changing domain code.
- Large, infrequent, historical, and analytical access may have high latency and runs outside interactive request paths.
- Initially, bounded jobs read object data directly through the storage contract; do not add a warehouse or query engine before access patterns justify one. User interfaces and lightweight APIs consume derived read models rather than scanning objects.
- Use schema-versioned UTF-8 JSON documents initially. Store datasets as reasonably sized immutable chunks rather than large files or streaming JSON Lines. Define and test a bounded byte/record/time-window target per dataset; readers load or stream as many chunks as needed without requiring the whole dataset in memory. A manifest/catalog records each chunk's stable identity, sequence or partition, schema and producer versions, checksum, byte and record counts, tenant/subject scope, and event-time range. Readers must detect missing, duplicate, corrupt, or incompatible chunks rather than trusting object listing order.
- Age/size movement thresholds and retention periods remain configurable open decisions. Do not hard-code them into domain logic or silently delete unclassified data; expose inventory, age, size, and cost so policy can be set from evidence.
- Privacy deletion and immutable-retention rules remain unresolved, but storage must be designed now to locate data by tenant/subject, apply deletion or legal/audit holds, and prove the result. Do not wait for the first request to make objects discoverable or deletable.

Open decisions include store ownership by domain, quantitative RTO by data class, replication timing/provider, movement thresholds, retention classes, deletion/hold policy, chunk-size/compression policy by dataset, and any future analytical query engine.

## Telemetry, traceability, and accounting

### Accepted telemetry direction

- Standardize instrumentation and collection on OpenTelemetry while keeping storage/export backends replaceable.
- Select managed or self-hosted backends from measured total cost, operational burden, query needs, and portability. No telemetry vendor is chosen yet.
- The monetary budget is open. Instrument ingestion volume, cardinality, retention, query use, and cost from the start; support configurable quotas, sampling, and retention so unknown cost cannot grow invisibly.
- Begin with configurable defaults of 7–14 days for debug logs, 3–7 days for detailed traces, 30–90 days for operational metrics, and long-term aggregated metrics. Security, audit, and accounting follow separate durable retention policy.
- Alert routes are configurable by environment, tenant/scope, severity, and operator preference. Expose safe user-visible incident and degradation status.

Do not record every interaction as durable audit. Define a versioned engagement-event catalog containing only interactions that answer a stated product or learning question. Record event purpose, fields, scope, sensitivity, sampling, aggregation, retention, and opt-out/consent behavior before collection. Ordinary reads and UI gestures may be aggregated, sampled, or omitted.

State-changing, privileged, funded, authorization, ownership, resource-lifecycle, provider, and accounting actions remain durable and reconstructable. Their structured envelope contains event ID, UTC event/ingestion times, actor type/ID, tenant/scope, client channel, service/deployment version, action, targets, outcome, trace/correlation ID, and causation/parent ID. State changes additionally include before/after versions, policy/config version, idempotency key, and external identifiers. Link effects to causes so chains can be traversed backward without timestamp inference. Track which user or process acquired, consumed, produced, modified, or released governed resources.

Default telemetry and engagement events to metadata and explicitly allowlisted redacted fields while payload-retention policy is unresolved. Do not capture raw request/response bodies, secrets, credentials, or unnecessary financial/personal content by default.

Audit is not application logging. Audit/accounting events are durable, access-controlled, tamper-evident, and not silently sampled; logs/traces may expire. Specifically permissioned Money Noodle administrators may inspect scoped platform debug data, and organization administrators with debug privilege may inspect only their tenant's redacted data. Viewing or exporting debug telemetry does not require a dedicated audit event. Regular users receive safe status and their own activity, not debug output or cross-tenant telemetry.

## Identity and ownership model

Keep these concepts separate until a schema is accepted:

- **Human identity:** authenticates a person and is not owned by an employer.
- **Actor/principal:** a human session, service account, or workload identity that acts.
- **Owning entity:** a person or organization that owns resources but does not gain login capability by existing.
- **Resource scope:** a hierarchical organization/project/account-like container.
- **Membership/role binding:** grants a principal a fixed role at a scope.
- **Permission:** a server-enforced action on a resource, not UI visibility.

### Accepted hierarchy direction

- Every human receives a personal root scope. **Portfolio** is the preferred current product/domain name for the primary resource container. A user or organization may own a portfolio. What portfolios contain and how projects, financial accounts, resources, or child portfolios relate to them remains deliberately undefined until those domains are designed.
- People and organizations may own organizations, portfolios, projects, accounts, and other ownable resources where the owning domain permits it.
- Each ownable entity has exactly one direct owner and one ownership parent. Ownership may transfer but is never silently shared.
- Organizations may nest. Ownership edges form a strict cycle-free hierarchy; an entity cannot own itself directly or transitively.
- Memberships and other non-owning associations form a separate graph. Humans, organizations, and groups may be members of organizations where policy permits. Membership grants scoped access without creating another owner or ownership parent. Derived association and delegation rules must terminate deterministically and reject cycles that could make authority ambiguous.
- Human identities remain independent. Employers and organizations grant revocable membership rather than owning employee credentials. A person may join multiple organizations and use multiple interfaces concurrently.
- Owning entities do not authenticate or act merely because they exist. Human principals authorize actions. Workload principals may execute autonomous or background work under an explicit, bounded, revocable human authorization; every effect remains attributable to both the workload principal and originating authorization.
- Deactivation is the initial response when a person or entity leaves or becomes unavailable. It does not automatically delete or transfer owned resources; transfer is a separate controlled operation. Resources of a deactivated sole owner freeze ordinary activity while protective stops, reconciliation, cleanup, and recovery remain available.
- Ordinary ownership transfer requires approval from both current and receiving owners. One specifically authorized Money Noodle platform administrator may override the workflow for recovery; a second administrator is not required. The override still requires strong authentication, explicit reason and scope, tamper-evident audit, notification, and subsequent review.
- Organizations require verification by an owner or authorized delegate before receiving verified capabilities. Verification evidence, renewal, revocation, and delegated-verifier rules remain open.

Open decisions include the exact portfolio/resource taxonomy, membership and delegated-association semantics, inheritance boundaries, organization verification, and custodial relationships.

## Authorization and privacy

Authorization defaults to deny and evaluates principal, active tenant/scope, action, resource, bindings, and inheritance boundaries on every server/job/admin path. Record consequential authorization outcomes and policy versions.

### Accepted role direction

- Begin with fixed system-defined roles; custom roles are deferred.
- Role grants are additive and scoped. Do not implement general explicit-deny rules.
- A grant explicitly states whether it applies only to its scope, selected descendants, or all descendants. A child scope cannot silently reduce an inherited grant; reduction or revocation happens at the grant's origin so effective access remains explainable.
- A grantor may delegate only an equal or strict subset of the grantor's own effective permissions, using the available fixed roles and scopes. User A can therefore give User B the same access or less, never more. Delegation cannot amplify privilege.
- Role bindings are simple grants without expiration, spending limits, market restrictions, or approval conditions. Financial limits and risk controls belong to separate policy domains and still constrain every role.
- Keep platform operations, organization administration, membership, billing/ownership, project control, resource use, debug access, experiments, and funded authority as distinct permissions. No generic admin role silently implies all of them.
- Funded authority is always separate from ordinary project or organization administration.
- Service accounts and workload identities are visible and manageable within their owning organization and scope.

Self-healing is the primary repair actor. Portfolio owners and explicitly delegated operators may invoke repair within their scope; Money Noodle platform operators may perform cross-tenant recovery; ordinary members may not. Funded repair is a distinct permission. Break-glass recovery is time-bounded and fully audited.

There is no universal second-approver or step-up-authentication rule. A specifically designed sensitive operation may still require reauthentication or MFA when its threat model justifies it.

Enforce tenant isolation at service/repository boundaries and again in storage where supported, including jobs, caches, telemetry, exports, and backups. Encrypt sensitive data in transit/at rest. Define retention, deletion, export, backup, and restore before storing sensitive tenant data.
