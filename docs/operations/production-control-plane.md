# Production operation control plane and catalog

> **Status:** Working design authority under [`ADR-0010`](../architecture/decisions/ADR-0010-agent-operated-production-control-plane.md); not implemented, not applied, and not production authority
> **Catalog ID:** `money-noodle.production-operations`
> **Catalog version:** `2` (M1 subset); broader v1 design retained, non-invocable
> **Prepared:** 2026-08-30 under GitHub issue #20
> **Accepted:** v1 on 2026-09-07; M1 v2 direction on 2026-09-13 by the principal
> **Owning decision:** [`ADR-0010`](../architecture/decisions/ADR-0010-agent-operated-production-control-plane.md)
> **Related authority:** [`delivery.md`](delivery.md), [`../architecture/data-identity-observability.md`](../architecture/data-identity-observability.md)

This document is the normative catalog for routine production operations. The M1 v2 section is the current first-release contract; broader v1 material below is design context only and cannot authorize an M1 call. It designs machine-readable control surfaces; it does not create one. Acceptance settled that design and authorizes implementation through reviewed code and pipeline changes; it granted no provider or production authority and built nothing. No M1 publisher, journal, witness or provider operation is enabled by this document. Current implementation and deployment truth belongs to [current status](../current-status.md); no real-money authority exists.

## M1 catalog v2 — selected, not enabled

The principal accepted the [#68 engineering packet on 2026-09-13](https://github.com/money-noodle/money-noodle/issues/68#issuecomment-5656747952). This section owns M1 effect authority, schemas, custody and recovery. It narrows the broader v1 design below; it does not activate any operation. Unknown fields, versions, operations, targets or unbounded effects deny. The current workflow and host gates remain unchanged pending the [delivery transition](delivery.md#current-to-target-activation).

### Supported effects and stable slots

Every row uses `money-noodle.production-operations/v2`. `E` is the original consent's finite `expiresAt`, never refreshed by retry, epoch, configuration change or recovery. `R` is the original finite read-scope validity. Reads have zero provider mutation effects, finite pages/bytes/time and source/as-of; failure is unknown, not healthy or zero. `infrastructure.plan` permits only separately declared native lock bookkeeping, never an apply. Actual private targets, numeric effect limits, read budgets and expiry are supplied and approved in #75; a missing bound denies the operation.

| Operation | Approval; executor → independent verification source | Target/effect bound; expiry | Preconditions and recovery | Stable permission slot |
| --- | --- | --- | --- | --- |
| `status.read` | R0; status reader → authoritative response | Fixed health/status paths; R | Exact scope; unknown on failure | none |
| `deployment.read` | R0; provider reader → Service/revision state | Approved service vector; R | Known incarnation; unknown on failure | none |
| `drift.read` | R0; drift reader → desired/provider comparison | Enumerated stacks; R | Consistent snapshot; report only | none |
| `telemetry.diagnose` | R0; telemetry reader → correlated signals | Fixed query/window/cardinality; R | Redaction; no export | none |
| `cost.read` | R0; cost reader → billing observation | Approved scope/window; R | Source/as-of; missing is not zero | none |
| `workload.access.read` | R0; IAM reader → effective policy | Enumerated policies; R | Unknown blocks dependent changes | none |
| `operation.evidence.read` | R0; Git reader → journal/witness | Exact indexed documents; R | Inconsistency blocks | none |
| `source.publish` | Source permit; fixed publisher → Git/PR reader | At most 16 files, one fast-forward commit, one PR; E | [Publication contract](../development/version-control.md#restricted-workload-source-publication-target); reconcile or stop | `source-publication` |
| `artifact.publish` | H1 separate slot; registry writer → registry/provenance reader | Finite image/platform tuple vector; E | Qualifying reviewed build; unknown blocks | `artifact-publication` |
| `service.deploy` | H1 forward; service executor → separate GCP/probe reader | One forward vector, at most 2 services; E | Exact digests/configuration/state; block or granted rollback | `release-forward` |
| `service.rollback` | H1 conditional; service executor → separate GCP/probe reader | One predecessor vector, at most 2 services; E | Verified predecessors; no invented fallback | `release-rollback` |
| `infrastructure.plan` | R0; non-apply planner → plan/state comparator | One stack; declared lock bookkeeping only; R | Consistent state; no raw publication; discard stale plan | none |
| `infrastructure.apply` | H1, H2 if destructive; stack executor → provider/state reader | One saved plan, finite resource/action counts; E | Lock/state/recovery; ambiguity blocks | `infrastructure-apply` |
| `configuration.change` | H1; configurator → config/behavior reader | Finite exact keys/targets; E | Expected version; inverse only if explicitly granted | `configuration-change` |
| `workload.access.change` | H2; IAM executor → separate IAM/probe reader | Finite bindings and explicit conditional inverse; E | Fresh etag; no self-grant; otherwise block | `access-change`, optional `access-inverse` |
| `telemetry.configuration.change` | H1; telemetry configurator → telemetry reader | Finite exporters/retention/settings; E | Redaction/cost verification; degraded is not healthy | `telemetry-change` |
| `cost.control.change` | H2; cost configurator → cost reader | Finite policies/notification tests; E | No payment authority or implicit shutdown | `cost-control-change` |
| `bootstrap.initialize` | HB; principal → independent readers | One genesis/witness initialization plus enumerated human state/federation resources; E | Exact later manifest; reconcile partial effects | `bootstrap-initialize` |

There is **one conditional rollback permission per approved release bundle**, not one per target, transport call, retry or epoch. A release bundle has separate artifact-publication, release-forward and (only with verified predecessors) release-rollback slots. The rollback vector is fixed at approval, is a subset of the forward target vector, and cannot exceed two services. No verified predecessor means no rollback slot; partial failure does not mint a smaller new grant. Source publication is a separate permit, not artifact publication, HB or production consent. Ancillary journal/witness bookkeeping creates no provider grant.

Other v1 operations remain **non-invocable in M1**, including `incident.state.read`, `job.state.read`, `data.quality.read`, `backup.read`, `secret.metadata.read`, `operation.evidence.export`, `schema.migrate`, `schedule.change`, `schedule.run`, `reconciliation.run`, `repair.execute`, `backup.create`, `restore.execute`, `drift.reconcile`, every `secret.*` mutation, `incident.mitigation.execute` and `dns.certificate.cutover`. The broader secret/break-glass design below is retained, not an M1 adapter or permission. An unlisted inverse, deletion, restore or sensitive export requires separately accepted authority, not a recovery shortcut.

### Consent, artifact and owner binding

The fixed trusted-main helpers evaluate grants; M1 adds no authorization service. The original principal's source permit, explicit operation approval, or qualifying reviewed merge supplies consent. The [qualified merge](delivery.md#current-to-target-activation) can supply only the explicitly identified release slots, without a second routine deployment approval. It does not supply infrastructure, configuration, IAM, telemetry, cost, secret or bootstrap authority. Agent technical review is not human consent.

Canonical encoding is RFC 8785 JSON canonicalization over allowlisted JSON values, UTF-8 bytes, no duplicate keys, no unknown fields, finite integers for counts, UTC RFC 3339 timestamps, lowercase SHA-256 hex digests and full Git object IDs. Public identifiers are bounded ASCII strings; sizes below include their encoding. Null means explicitly absent, never wildcard. Arrays representing sets are sorted and duplicate-free before digesting. A digest of a secret value or a low-entropy private identifier is not sanitization and must not be published.

`grantKey = SHA256(JCS([repositoryIdentity, originalApprovalIdentity, permissionSlot]))`.

`repositoryIdentity` is the fixed public repository identity binding established at bootstrap and independently compared to the immutable host repository identity (native numeric IDs remain private). `originalApprovalIdentity` is the immutable consent record identity: for a merge, the repository/PR, exact approved head and resulting protected-main commit; for explicit consent, the original issue/comment ID plus canonical consent digest. Edits invalidate the record; they never renew it. Epoch and workflow/run/attempt identity are excluded from the key. Operation, configuration or target changes cannot recreate a spent key; changed consent needs a genuinely new principal decision, and cannot override unresolved effects. The same original consent cannot be relabeled with a new approval identity by a retry.

Each consent contains `requestId`, `approvalRef`, `principal`, `requester`, `catalog`, `version`, `operation`, `permissionSlot`, `environment`, `executorClass`, `verifierClass`, `repositoryIdentity`, `originalApprovalIdentity`, `issuedAt`, `notBefore`, `expiresAt`, `reasonRef`, `policyDigest`, `controlSourceSHA`, `controlDependencyDigest`, `sourceSHA`, `inputDigest`, `planDigest` (null when inapplicable), `targetVector`, `artifactVector`, `effectBounds`, `readBounds`, `transportPhases`, `recovery`, `verificationContractDigest`, and `recoveryContractDigest`. The target vector contains exact objects `{logicalIncarnation, configurationVersion, expectedSafeVersions, intendedSafeVersions, actionCounts}`. artifactVector contains the exact tuple/digest objects defined below (empty only for a non-artifact effect); readBounds is `{maxPages, maxBytes, timeoutSeconds, validUntil}`. effectBounds maps allowlisted action IDs to finite maximum counts. transportPhases is the ordered finite list of `{phaseId, actionId, targetIds, maxSubmissions}`; no ambiguous submission is repeated even if a transport limit remains. recovery is null or `{condition, permissionSlot, targetVector, expiresAt}` referring to the separately approved slot, never an implicit new slot. Recovery has its own exact conditional vector and original expiry; it never implies a general inverse.

Each artifactVector entry is `{tuple, artifactDigest}`. For artifact publication, each tuple is `(deployableProject, buildTarget, outputPlatform, sourceSHA, configurationVersion, configurationDigest, builderIdentity, buildInvocation)` and maps to exactly one `artifactDigest`. Forward and rollback bind that tuple/digest plus target incarnation, expected revision/configuration/traffic and exact destination. Web/API may have different digests. A different build invocation, source, platform, configuration or digest is not an equivalent retry. Verify provenance, SBOM and scans before deployment; a mutable tag or version label is not a digest. `ARTIFACT_VERSION` remains the public release label under #69, not a claim that the label is the source SHA or image digest.

`executorOwner = {workflowPath, workflowSHA, runId, runAttempt, jobId}` is immutable from admission. Reruns and new runs cannot adopt it. For human-only HB genesis, executorOwner instead has the disjoint exact form `{principal, bootstrapInvocationId, controlSourceSHA}` and cannot be converted into a workflow owner. The executor identity class and verifier class must equal the catalog row. Every external phase checks original expiry, exact bindings, owner exclusion and expected versions before token exchange and again immediately before submission. Expiry prohibits new submissions, including rollback, but never suppresses read-only post-effect evidence. Target configuration versions never silently rebind native resources.

### Indexed journal schema and nonrecursive witness

Selected design: `refs/heads/operation-journal-v1` in this existing repository, from a metadata-only root containing no application files or `.github/workflows`. Never merge it into `main`, trigger delivery from it, routinely rewrite it or delete it. No journal or witness is created by this policy. Git history is canonical sanitized evidence; the designated issue/comment witness is independently permissioned corroboration, not another database or immutable store.

Before genesis, the protected-main exact HB manifest and principal consent record hold the sanitized initialization intent, fixed bootstrap owner, epoch and original expiry. Human initialization creates only the enumerated journal root/witness; the genesis event and request snapshot record `bootstrap-initialize` as spent and link that original consent. Lost creation acknowledgments are reconciled by exact identity/content reads, never repeated on an assumption of absence. Independently confirm genesis/witness acknowledgment before any ordinary mutation or further bootstrap state/federation phase. A partial initialization stays blocked for separately authorized reconciliation; it cannot mint a second HB invocation. No uncreated journal is presumed to authorize its own creation.

All documents use `schemaVersion: 1`; required fields are exact, and an unknown schema fails closed. Event IDs are unique bounded ASCII identifiers; snapshots reference exact events, not time-inferred ordering. A sequence is a strictly increasing integer per epoch for every journal event, including acknowledgment events. The previous event/commit link is null only at authorized genesis. An event records its parent commit, never its own containing commit (avoiding a hash cycle). eventType is one of `genesis`, `intent`, `witness-ack`, `submission`, `observation`, `verification`, `abandonment`, `restoration`; phase uses the state vocabulary below. outcome is `pending`, `unknown` or a listed terminal state. errorClass is an allowlisted stable code, never raw provider text. A restoration event records separately approved epoch authority and previous safe anchor, never revives old grants.

| Path/record | Required fields in addition to schemaVersion | Semantics |
| --- | --- | --- |
| `control/current.json` | `epoch`, `sequence`, `latestEventId`, `activeRequestId`, `pendingIntent`, `witness` | One global active M1 provider request. Nullable pendingIntent is `{eventId, sequence}`. Nullable witness is the last confirmed `{epoch, sequence, eventId, journalCommit, commentId}`. |
| `requests/{grantKey}.json` | `grantKey`, `consent`, `executorOwner`, `consumedSlots`, `phase`, `latestEventId`, `outstandingIntent`, `uncertainty` | Consent and owner immutable; spent slots never cleared. outstandingIntent identifies exact external phase/action vector or null after verified closure. |
| `targets/{logicalIncarnation}.json` | `logicalIncarnation`, `configurationVersion`, `expectedSafeVersions`, `observedSafeVersions`, `ownerRequestId`, `blockedReason`, `latestEventId`, `observedAt` | Unknown observations explicit; a target stays blocked until authoritative reconciliation plus old-owner exclusion. |
| `events/{eventId}.json` | `eventId`, `epoch`, `sequence`, `previousEventId`, `parentCommit`, `eventType`, `requestId`, `grantKey`, `consentDigest`, `executorOwner`, `permissionSlot`, `phase`, `causationId`, `intendedCounts`, `realizedCounts`, `observations`, `outcome`, `errorClass`, `uncertainty`, `occurredAt`, `recordedAt`, `witnessAck` | Immutable, never replaced. Observations contain safe comparison result, source class and as-of; unknown count is null, not zero. witnessAck is null except on acknowledgment. |
| Witness comment | `epoch`, `sequence`, `eventId`, `journalCommit`, `grantKey`, `executorOwner` | Binds one exact durable intent commit; immutable by policy. Duplicate matching comments add no authority. |
| Witness issue-body pointer | `epoch`, `sequence`, `eventId`, `journalCommit`, `commentId` | Current corroborated intent only, mutable; never treated as canonical audit or Git CAS. |

The event's referenced immutable consent supplies catalog/operation, principal/approval, original validity, policy/control/source/input/artifact/plan bindings, target/effect vector and verification/recovery contract. Each event can therefore be joined by fixed references without scanning history. Every event also stores the grant-bound input/artifact/plan comparisons needed for its phase in observations; a verifier never treats executor-produced success text as evidence. `consumedSlots` maps stable slot IDs to `{grantKey, admissionEventId}`; the slot is spent at admission, before external effects, and remains spent on failure or abandonment.

Transition protocol (fixed serialized journal/witness workflows, no implicit owner transfer):

1. Read journal head `H`; fetch indexed snapshots and required event with `GET /repos/{repo}/contents/{path}?ref={H}`. Read the designated witness issue-body pointer and comment directly by ID. Validate the exact previous acknowledgment relation, epoch, consent key, expiry, finite bounds, expected state and no outstanding competing owner. Allow at most one global active M1 provider request, including publication; source publication has its separate claim serialization.
2. Append intent event at sequence `n`, atomically updating control/request/target snapshots with pending intent and spent slot. Create blobs, `POST .../git/trees` with `base_tree`, then `POST .../git/commits` with sole parent `H`, and `PATCH .../git/refs/heads/operation-journal-v1` with `sha` and `force:false`. Concurrent sibling commits cannot both fast-forward. A loser rereads/re-evaluates; never mechanically reparent an admission. GitHub has no expected-old-SHA parameter.
3. Read back stable head and exact event commit `C`. The independently permissioned witness writer checks expected previous pointer, appends the comment for `(epoch,n,event,C,grantKey,owner)`, reads it back, then updates and confirms the compact issue-body pointer. Issue PATCH is not CAS; unexpected pointer changes block. One fixed serialized witness writer is part of the trusted boundary.
4. Append `witness-ack` event at sequence `n+1`, sole parent `C`, atomically clearing pendingIntent and setting control.witness to the confirmed pointer. `witnessAck` contains that pointer; its causationId names the intent. This acknowledgment changes no consent, spent state or executor owner. **Do not witness the acknowledgment** or advance the issue pointer to its commit. For mutation, require head to be this exact acknowledgment, whose parent/event and witness comment/pointer match the intent. The next intent builds on that acknowledgment and obtains a fresh witness. Thus latest event may be acknowledgment while pointer names the preceding intent, without recursion.
5. Only after journal plus witness confirmation may the original owner exchange a mutation token. Repeat durable intent and corroboration before each external phase. Record submission/observation/verification as append-only events with atomic snapshot updates; evidence-only events never authorize a call. Before another call a new intent/ack relation must be established. Completion releases the global slot only after quiescence and old-owner exclusion; an abandoned or unknown call does not release it by timeout.

| Job | Permission ceiling |
| --- | --- |
| Journal writer | `contents:write`; no issues/provider mutation |
| Witness writer | `contents:read`, `issues:write`; no Git/provider mutation |
| Provider executor | Repository reads; operation-specific federated mutation identity |
| Verifier | Repository reads; separate GCP read-only identity and bounded probe permission |

These repository tokens exceed individual refs/issues. Fixed workflows, pinned complete executable dependencies, host protections and administrators are the **trusted computing base**, not mechanically ref-scoped token containment. Git append-only policy and witness corroboration do not prove provider fencing or distributed exactly-once execution.

Per ordinary transition: at most 8 snapshot/event documents of 16 KiB each, witness pointer/comment at most 4 KiB each, 40 GitHub requests, 512 KiB transferred, 120-second deadline, and 2 contention reevaluations. Counts include retries/readback; abort on the first exhausted budget or rate-limit failure. A lost comment acknowledgment may inspect GraphQL `comments(last:20)` once, never scan all comments/history; absence proves nothing. These are design limits, not benchmark results. Admission limits stop new mutations, never discard post-effect evidence: fixed evidence-only reconciliation appends observations in separately bounded batches under the same limits without exchanging a mutation token.

### Faults and interrupted calls

States are `requested → admitted/spent → intent-corroborated → submitted → observed → verified`; failures become `blocked`, `unverified` or `failed`. Recovery terminals are `rolled-back-and-verified` or `recovered-and-verified`, retaining independent observation. `completed` and a green workflow are not verified production outcomes.

| Observation | Required response |
| --- | --- |
| Intent exists, witness absent | Pending/unknown; no token. Absence may be indistinguishable from deleted evidence. |
| Git or comment acknowledgment lost | Read exact event/pointer and at most the bounded recent-comment window; reconcile matching result, never infer no effect from absence. Matching duplicates grant nothing extra. |
| Previously confirmed witness missing/inconsistent | Block; never recreate it and infer execution authority. |
| Witness pointer updated but ack missing | Original owner may append exact acknowledgment after readback; no provider call before it. New runs can only record facts, not adopt owner. |
| Audit append fails after effect | Keep spent slot and outstanding intent; block target/global admission; append later observations only. |
| Evidence-only repair | Fixed code may corroborate existing facts or record abandonment; cannot change consent, expiry, original owner or revive a spent grant. |
| Authorized restoration | Pause mutations first, independently assess old authority/uncertainty, approve new epoch through protected main. Old grants remain invalid/spent; new epoch alone is not new consent. |

Matching rollback of **journal and witness within the same epoch may be undetectable** under trusted-host/admin assumptions; main need not also roll back. No exact historical reconstruction or rollback-detection guarantee is claimed. Restoration pauses mutations, not a healthy application.

Never automatically repeat an ambiguous mutation. Bounded reads and pure computation may repeat. Enumerate necessary transport phases separately from permission cardinality; requests/targets cannot multiply consent. Reconciliation requires:

| Operation | Authoritative observations |
| --- | --- |
| Artifact publication | Manifest/digest lookup plus provenance; exact project/platform/source/configuration/builder/build-invocation tuple maps to one digest. |
| Cloud Run create/update/traffic | Exact Service and known Operation; native name/UID, generation, observed generation, terminal condition, reconciling, etag, revision/digest and traffic comparisons. CreateService/UpdateService Operation metadata and response are typed Service. |
| IAM | `getIamPolicy`, expected etag, exact intended delta. Stale etag requires new planning, never overwrite. |
| OpenTofu apply | Original saved-plan digest, state lineage/serial and native lock plus independent provider observation. Lost plan before apply aborts; uncertain apply is never blindly repeated. |

A matching resource GET does not exclude an outstanding asynchronous call. GitHub cancellation does not fence GCP. Verified terminal/continuation requires **authoritative quiescence and proof that the old owner cannot submit more calls**. New approval cannot override uncertain in-flight effects. Pin federation, impersonation and token-exchange chains so mutation identities cannot self-mint, extend authority or grant access. #76 must test actual mint/submission lifetime bounds, clock skew and asynchronous completion. Target-specific `operations.list` discovery/filter/drain guarantees remain unproven; unsupported exclusion stays blocked, not an invitation to build a generic drain/replay engine.

### Field-level custody and bounded reconstruction

The accepted M1 limitation expressly refines the prior private-reference/exact-reconstruction promises in this catalog and its linked general audit standard **for M1 production-operation evidence only**. Canonical records preserve sanitized intent/consent/causation and allowlisted observations, not every private external identifier or raw plan. Missing required historical detail remains unknown and blocks only the affected operation (global provider serialization may consequently pause new mutations). No unrelated tenant, identity, financial audit/accounting retention or reconstruction obligation is weakened. There is no additional vault, object archive, repository or control service. Existing GCS OpenTofu state is infrastructure state, not an operation audit archive; telemetry and GitHub Deployment statuses are not canonical audit (prior Deployment statuses expire after 90 days).

The following inventory is exhaustive for the M1 fields above and associated private inputs. Public means permanently copyable, not harmless by masking. A public logical ID is a deliberately assigned opaque label, never a native account/resource identifier. Retention is class-specific: `durable` means no routine expiry/deletion or history rewrite of canonical consent/events/spent indexes during M1; snapshots supersede in Git without deleting history. `run` means bounded trusted execution memory/private temporary files only, erased on completion/expiry; lost runtime material is unknown, not reconstructed from logs. `configured` means until separately authorized replacement/removal, not historical readback. No new numeric archival promise is made.

| Fields / purpose and consumer | Sensitivity; permitted storage/injection | Writers / readers / deletion authority | Retention; freshness, recovery and bootstrap custody |
| --- | --- | --- | --- |
| Source request schemaVersion, requestId, claimant, delegationRef, claimRef, expectedClaimSHA, controlSourceSHA, changesDigest, resultTreeSHA, approvedPaths, maxFiles, maxReplacementBytes, sourcePermissionRef, allowPRCreation, issuedAt, expiresAt, requestDigest; changes path/action/expectedOldBlobSHA/replacementBase64; result marker/commit/PR; publisher input and reconciliation | Public source data only; one same-issue comment and Git/PR result, no private input transport | Current claimant/delegate submits; fixed publisher reads/writes exact permitted ref/PR; public readers; deletion/cleanup separately authorized, never automatic | durable request/result evidence under claim preservation; validate current ownership/head and original expiry; HB does not grant source publication |
| repositoryIdentity, originalApprovalIdentity, requestId, approvalRef, principal, requester, reasonRef; attribute consent | Public safe identity/references; original issue/comment and journal consent | Principal supplies consent; fixed journal writer indexes; public readers; no routine deletion | durable; recheck immutable host identity privately and exact consent digest; principal enumerates genesis binding before HB |
| catalog, version, operation, permissionSlot, environment, executorClass, verifierClass, issuedAt, notBefore, expiresAt; evaluate authorization | Public; consent/journal | Principal approves; fixed writer; public readers; no routine deletion | durable; original times never renewed; principal supplies original HB window |
| policyDigest, controlSourceSHA, controlDependencyDigest, sourceSHA, verificationContractDigest, recoveryContractDigest; pin executable policy | Public; reviewed Git and journal | Reviewed source authors then fixed writer; public/verifier readers; no routine deletion | durable; exact protected-main policy/helper and full executable dependency closure; initial control artifact is Git source, not new OCI runner |
| inputDigest, planDigest, configurationDigest; equality checks | Public only for an explicitly allowlisted non-sensitive representation; private full-input/plan digests stay run-private | Trusted planner/executor; independent comparator reads privately; no public raw-value hash; executor erases run copy | durable safe comparison/digest, run private detail; lost saved plan aborts before apply; principal retains HB inputs privately for that execution, not in an invented archive |
| artifactVector, tuple, buildTarget, deployableProject, outputPlatform, builderIdentity, buildInvocation, artifactDigest, sourceSHA; artifact provenance | Public safe tuple and digest; Git/provenance/registry allowlisted evidence, never private registry URL | Qualified builder/registry writer; independent provenance reader; artifact removal needs separate authority | durable tuple/evidence; artifact retention explicitly bounded in operation manifest; missing predecessor/artifact blocks rollback |
| logicalIncarnation, configurationVersion, targetVector, effectBounds, readBounds, transportPhases, recovery, expectedSafeVersions, intendedSafeVersions, observedSafeVersions; scope and compare effects | Public safe labels/counts/version comparisons; journal | Fixed writer from approved manifest/verifier; public readers; no routine deletion/rebinding | durable; private mapping must match version and provider observation at each phase; HB establishes first mapping |
| grantKey, consumedSlots, executorOwner, phase, outstandingIntent, ownerRequestId, blockedReason; ownership/spending | Public safe workflow/run IDs and indexes; journal | Fixed journal writer; admission/verifier/public readers; no routine deletion | durable; immutable owner and spent state survive epochs; HB initializes empty indexes only once |
| schemaVersion, eventId, eventType, epoch, sequence, latestEventId, previousEventId, parentCommit, causationId, consentDigest, pendingIntent; causal chain | Public; journal events/snapshots | Fixed journal writer; verifier/public; no routine deletion | durable; exact indexed links checked, not timestamp inference; HB records genesis and epoch authority |
| activeRequestId, witness, witnessAck, journalCommit, commentId; corroboration | Public; Git plus designated issue/body/comments | Journal writer writes ack; separate witness writer writes comment/pointer; public reads; no routine deletion | durable comments/history, current mutable pointer; missing/inconsistent blocks; principal enumerates designated witness and initialization in HB |
| intendedCounts, realizedCounts, observations, source class, observedAt, occurredAt, recordedAt, outcome, errorClass, uncertainty; verification | Public allowlisted comparison and timestamps only; journal | Independent reader observes, fixed writer records; public readers; no routine deletion | durable; explicit observation validity/window from manifest; unknown is not zero; HB verifier records sanitized observations |
| Native repository IDs, project/billing/resource/operation names and UIDs, private service URLs, IAM members/etags, federation mappings, notification addresses; bind actual effect | Private operational inputs, not necessarily secret payloads; Actions environment Secrets inject to fixed trusted jobs only, or principal-held HB execution input | Principal configures/replaces/removes; designated trusted executor/reader gets minimum needed; agents/public never read values | configured injection plus run copies; Secrets APIs have no value readback/history; version-bound mapping cannot be silently replaced; missing old detail blocks affected recovery |
| Raw saved plan/state, lineage/serial, full native responses; apply and reconcile | Private; saved plan/run memory, existing locked versioned GCS state after bootstrap; no Git, Actions logs/artifacts/caches | Enumerated stack workload writes state, separately scoped reader verifies; principal approves retention/removal; no routine agent deletion | run plan; state retention/versioning under ADR-0006; native lock/current state plus provider verification; initial human state migrated under exact HB procedure |
| OIDC, access and audience-bound verifier ID tokens; authenticate bounded calls | Private ephemeral process memory, never Git, logs, artifacts, dispatch or durable Secrets | Trusted federation exchange only; exact executor or verifier consumer; expire/revoke under grant | run and bounded mint/submission lifetime; no self-extension; #76 proves exclusion; no durable provider credential at bootstrap |
| Account ownership, MFA, recovery material and external secret payloads; irreducible trust root / future runtime use | Private principal custody; payloads only approved managed secret boundary, never M1 journal or Actions input archive | Principal retains ownership/recovery; future secret roles remain non-invocable in M1 | Existing ownership/recovery policy unchanged; no new store selected; principal attests HB custody safely without publishing payloads |

Actions environment Secrets are **runtime injection only**, not canonical audit, secret archive or recovery vault. Masking is not a disclosure guarantee. Approval and bootstrap must enumerate who can write/inject/read each private field and verify output allowlisting before mutation; no uncreated audit store authorizes its own creation. Private account/recovery custody remains the principal's existing responsibility, not a new repository store. If that input cannot be supplied safely, the corresponding HB/ordinary operation stays blocked.

### Downstream negative fixture contract

These are measurable requirements for #70 provider-disabled adapters and #71–#73 assembly, not functioning adapters supplied by documentation tests. Every denial fixture asserts zero mutation-token exchanges and zero provider submissions unless a prior effect is explicitly part of the fixture; then it asserts no additional submission, spent state retained and no verified-success result.

| Fixture ID | Synthetic input/fault | Required result |
| --- | --- | --- |
| slot-epoch | Same original consent/slot, new epoch/run/configuration | Same grant key; deny second consumption |
| slot-vector | Two targets, two transport phases, repeated attempt | At most one forward and one conditional rollback vector; no per-target grants |
| expiry | now equals expiresAt, or notBefore is future | Deny; no renewal by retry or inverse |
| effect-bound | Third service, missing finite count, extra action or changed tuple digest | Deny whole request |
| sibling-race | Two children of same journal head | At most one fast-forward admission; loser reevaluates, no reparent |
| witness-ack | Intent C, pointer to C, ack child A | Accept corroboration at A without witnessing A; next intent must parent A |
| witness-missing | Intent exists but no witness ever confirmed | Pending/unknown, zero calls |
| witness-deleted | Previously confirmed witness disappears | Block; recreated comment cannot restore authority |
| lost-ack | Git/comment response lost; exact matching readback or last:20 inconclusive | Reconcile matching evidence only; inconclusive stays unknown, no duplicate effect |
| audit-after-effect | Submission succeeded, append failed | Spent/outstanding retained; evidence-only repair cannot adopt owner |
| matched-rollback | Journal and witness both reverted within epoch | Do not assert detection; document trusted-host limitation |
| stale-publication | Current claim head differs from expectedClaimSHA | Stop/resubmit; no reparent or publication |
| hostile-publication | Symlink/submodule/path escape/URL/archive/shell payload, no-op tree or forged bot author | Reject without executing source or claiming workload attribution |
| oversized-publication | 17 files, 32769 replacement bytes or 49153 ASCII comment bytes, or 4097 metadata bytes | Reject; 16/32768/49152 boundary still requires all other checks; no splitting workaround |
| ambiguous-call | Lost mutation response, matching GET, cancelled run but unproven quiescence/exclusion | Block; no automatic mutation replay, even with new approval |
| private-before-public | API/web exposure before respective independent private verification | Deny IAM grant; no predecessor means no rollback; only explicit H2 inverse can correct access |
| output-leak | Synthetic marker in raw plan, private mapping, response or token | No marker or derived secret verifier in public logs/artifacts/evidence; safe error only |

#74 must then prove actual publisher actor/check/host behavior; #75 approves exact costed manifests; #76 proves bootstrap and token/exclusion bounds; #8 proves remote journeys and #77 accepts the milestone. API assumptions and mocks never substitute for those later qualifications. None is a prerequisite to writing provider-disabled policy/source.

## Broader v1 design — not an M1 invocation surface

The following surfaces, rows, audit and secret/break-glass requirements preserve the accepted broader design for later separately authorized work. For overlapping operations, the v2 supported-effects, custody and fault contracts above exclusively govern M1. In particular the v1 rollback/retry language cannot create an M1 permission, and its private-audit references do not select an additional store.

## Invariants and actors

Humans retain account and billing ownership, recovery, break-glass custody, and explicit scoped approval of production effects. Agents are the intended technical operators: they plan, request approval, initiate execution, observe, independently verify, and report. Short-lived workloads execute. These are separate roles even when one platform coordinates the handoff.

| Actor | Responsibility | Must not do |
| --- | --- | --- |
| Human principal | Accept one bounded production effect or an exact scheduled charter; retain account/recovery authority | Delegate approval implicitly, disclose secret payloads, approve an unbounded shell |
| Agent operator | Prepare intent/plan, request a grant, invoke an allowlisted interface, verify through a read path, report redacted evidence | Approve, merge without instruction, hold a durable credential, receive a secret payload, improvise a provider command |
| Authorization service | Validate permission and bind a grant to exact operation inputs, plan, state, expiry, nonce, and recovery | Broaden scope after approval or treat authentication as approval |
| Execution workload | Use one purpose-specific short-lived identity to perform the granted operation | Reuse the grant, exceed catalog effects, approve, expose credentials or values |
| Verification reader | Observe authoritative application/provider state with read-only permission independent of executor output | Infer success from workflow exit status or mutate while verifying |
| Audit writer/store | Append linked request, decision, execution, effect, verification, and recovery records | Sample, overwrite, or use disposable telemetry as the record |
| Runtime consumer | Read only its declared active secret versions and refresh as specified | List unrelated secrets, read OpenTofu state, expose values in health or telemetry |

No browser, issue, prompt, repository file, commit metadata, Actions log/summary/artifact/cache, OpenTofu plan/state, or agent-visible process context carries a secret payload, durable provider credential, account/billing identifier, production snapshot, private recovery material, or unredacted incident evidence.

## Execution and approval model

### Surfaces

| Code | Surface | Boundary |
| --- | --- | --- |
| `CD` | Reviewed CI/CD | Immutable artifact publication/deploy/rollback and source-controlled infrastructure/configuration. Federated identity, protected `main`, serialized per state/target. |
| `AJ` | Bounded administrative job/API | Schema-validated, non-interactive operation with fixed maximum effects, timeout, retry, checkpoint, and purpose-specific identity. No arbitrary shell or generic provider proxy. |
| `OA` | Scoped operational API/read job | Read-only, redacted application/provider observations. Server authorization on every request; provider integration remains outside browser and request-serving inner layers. |
| `SI` | Private payload-blind secret ingress | Direct person/provider-to-managed-store data path. Orchestration sees lifecycle status only. |
| `HX` | Human exception | Initial trust-root bootstrap or break-glass only; time-bounded where possible and reconciled into code/state. |

### Approval classes

| Code | Meaning |
| --- | --- |
| `R0` | Standing read permission at an exact scope; no one-time production-effect approval. Sensitive export and privileged read remain separately authorized and evidenced. |
| `H1` | Single-use human grant for one exact production effect, including a sensitive export. A protected-branch review/merge may supply this only for the exact automatic forward deploy it identifies; any configured environment gate still applies. |
| `H2` | Single-use high-consequence human grant after recovery readiness and a fresh plan are proven. Used for restore, destructive migration, secret revocation, access, cost ceiling, and DNS/certificate change. |
| `SC` | Human-approved versioned schedule/reconciliation charter. Each conforming invocation needs no live approval; changing scope, code, cadence, identity, limits, or effects needs a new `H1` grant. |
| `HB` | Human-only bootstrap or break-glass authority. Never an agent credential or standing routine grant. |

A mutation grant contains: grant and request IDs; catalog ID/version and operation ID; environment; tenant/resource targets; requester and authorizing principal; executor identity class; safe normalized parameters or their digest; source/artifact/plan digest; expected resource/config/schema versions; allowed effects and maximum cardinality; idempotency key; concurrency/lease scope; issued/not-before/expiry times; single-use nonce; verification contract; rollback or forward-recovery contract; and reason/change reference. Raw values, credentials, provider state, account identifiers, and secret material are excluded.

The authorization service compares this envelope with current policy and state immediately before token exchange and again before commit where an operation has phases. Authentication, repository write access, a green plan, an issue assignment, or a previous grant is never approval. The executor cannot widen a target set or substitute a new plan after approval.

### Catalog completeness and versioning

`money-noodle.production-operations/v1` describes the broader design allowlist, not the invocable M1 subset. An interface rejects an unknown operation ID, catalog version, field, target type, or effect. A new routine read or mutation requires a reviewed catalog version, compatible machine-readable schema, purpose-specific permissions, negative tests, and an implementation/rollback transition. Removing or narrowing an operation is compatible after callers have migrated; broadening effects, approval, identity, or target semantics requires a new catalog version.

The tables below cover the known routine classes. In the **Evidence** column, `AE` means the durable operation audit envelope defined later; `RA` means an authorized read/access record and trace. Public reports contain only safe evidence references.

## Version 1 operation coverage matrix

### Read and diagnostic operations

| Operation ID | Read or mutation | Surface | Authority / approval / identity | Idempotency and concurrency | Verification | Recovery or failure behavior | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `status.read` | Read | `OA` | Platform/user status permission; `R0`; API/read identity | Cache validator and bounded polling; no mutation | Source/as-of and safe artifact/schema version | Return stale/unknown, never invented healthy | `RA`; response source/as-of |
| `deployment.read` | Read | `OA` | Platform operations; `R0`; deployment reader | Version cursor; bounded provider/read-model fan-out | Compare desired commit/digest/config with observed revision | Mark partial/stale/unknown; no inline repair | `RA`; compared versions |
| `infrastructure.plan` | Read/plan | `CD` | Platform operations; `R0` to request; planner identity cannot apply | State lock or consistent snapshot; plan keyed by source/state digest | Re-plan from same source and state | Redact and discard stale plan; never treat plan as approval | `RA`; plan digest, source/state versions |
| `drift.read` | Read | `CD` or `OA` | Platform operations; `R0`; read-only drift identity | Per-stack serialized refresh; schedule overlap denied | Compare reviewed desired state with provider-observed state | Report only; unknown on provider failure | `RA`; diff digest and as-of |
| `telemetry.diagnose` | Read | `OA` | Debug access at exact tenant/platform scope; `R0`; telemetry reader | Bounded time/query/cardinality and export size | Correlate independent signals; preserve unknown | Redact; deny cross-scope; private incident path for sensitive evidence | `RA`; query bounds; export gets `AE` |
| `incident.state.read` | Read | `OA` | Platform operations or scoped user status; `R0`; incident reader | Versioned incident cursor | Compare incident state and source/as-of | Return unavailable/unknown without exposing exploit detail | `RA` |
| `cost.read` | Read | `OA` | Billing/ownership; `R0`; cost reader distinct from deployer | Versioned read model; bounded refresh | Source/as-of and reported-versus-derived label | Missing is unknown, never zero | `RA`; source/as-of |
| `job.state.read` | Read | `OA` | Job/data operations at exact scope; `R0`; job-state reader | Version/checkpoint cursor; bounded history | Compare schedule, invocation, lease, migration, repair and reconciliation state | Mark stale/blocked/unknown; no inline retry or repair | `RA`; charter/invocation/checkpoint versions |
| `data.quality.read` | Read | `OA` | Data operations at exact tenant/resource scope; `R0`; quality reader | Bounded dataset/version cursor | Source/as-of, rule version, sample and exclusions | Unknown/invalid remains distinct from zero/healthy | `RA`; rule/result versions |
| `backup.read` | Read | `OA` | Data operations at exact scope; `R0`; backup inventory reader | Consistent inventory cursor | Check recency, integrity, failure domain, restore-test status | Mark recovery unavailable and block dependent mutations | `RA`; inventory/check timestamps |
| `workload.access.read` | Read | `OA` | IAM/security permission at exact scope; `R0`; policy reader | Policy version cursor; bounded effective-access expansion | Compare declared and effective grants; run excessive-scope checks | Unknown policy fails closed for dependent mutations | `RA`; policy version and check results |
| `secret.metadata.read` | Read, no payload | `OA` | Secret lifecycle permission; `R0`; metadata-only identity | Version cursor; list bounds | Compare owner, consumers, lifecycle state, due dates | Payload endpoint does not exist; deny unknown scope | `RA`; no value/hash/derived verifier |
| `operation.evidence.read` | Read | `OA` | Audit/platform/security permission at exact scope; `R0`; audit reader | Immutable cursor and bounded chain traversal | Verify tamper-evident chain/signature and causation links | Unavailable evidence is unknown and blocks claims of verified success | `RA`; access decision and chain verification |
| `operation.evidence.export` | Sensitive read/export | `AJ` | Audit/security export permission; `H1`; bounded export identity | Export request ID; fixed query digest, size and expiry | Re-read manifest/count/checksum through separate audit reader | Revoke access and destroy expired export; never publish privately scoped content | `AE`; query/manifest digest, recipient scope, expiry |

### Delivery, infrastructure, and data operations

| Operation ID | Read or mutation | Surface | Authority / approval / identity | Idempotency and concurrency | Verification | Recovery or failure behavior | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `service.deploy` | Mutation | `CD` | Deploy permission; `H1` (exact protected merge may be grant); federated per-service deployer | Artifact digest + target idempotency; per-service serialized rollout | Independent health, contract, artifact/config and smoke reads | Automatic prior-revision rollback when safe; otherwise block/reconcile | `AE`; commit, digest, plan, revision, checks |
| `service.rollback` | Mutation | `CD` | Deploy/recovery permission; `H1`; federated per-service deployer | Target prior revision; serialized per service; replay returns current state | Readiness, contract, traffic and artifact observation | Forward-recover to known digest if prior revision unavailable | `AE`; from/to revisions and reason |
| `infrastructure.apply` | Mutation | `CD` | Infrastructure permission; `H1`, or `H2` for destructive effects; federated stack deployer | Saved-plan digest; state lock; serialized per stack; nonce | Re-plan equality plus drift/provider observation | Provider-specific compensation or reconcile; never blind re-apply | `AE`; source/state/plan digests and effects |
| `configuration.change` | Mutation | `CD` | Configuration permission; `H1`; configuration deployer | Expected config version; serialized per owner | Read deployed config version and behavior | Roll back compatible config or forward-recover | `AE`; redacted before/after versions |
| `schema.migrate` | Mutation | `AJ` invoked by `CD` | Schema owner; `H1`, `H2` if destructive; migration identity | Migration ID; single owner; DB lock/fencing; resume checkpoints | Schema version, compatibility and data-quality queries | Expand/contract rollback or declared forward recovery; restore only if tested | `AE`; migration/checkpoint/version results |
| `schedule.change` | Mutation | `CD` | Job operations; `H1`; scheduler configurator | Expected schedule version; serialized per schedule | Read active cadence, limits, identity, code version | Restore prior schedule or disable safely | `AE`; before/after charter |
| `schedule.run` | Mutation | `AJ` | Approved `SC`; purpose-specific job identity | Invocation/idempotency key; partition lease/fence; overlap policy | Output checkpoint, invariants and downstream observation | Retry boundedly, reconcile uncertain effects, terminal cleanup | `AE`; charter version, invocation, effects |
| `reconciliation.run` | Mutation/read-repair | `AJ` | Data/platform operations; `SC` within auto-repair allowlist, otherwise `H1`; reconciler identity | Scope cursor, idempotent repairs, lease/fence | Compare intended, recorded, provider-observed state after repair | Ambiguity fails closed for administrative review | `AE`; mismatches, allowed repairs, unresolved items |
| `repair.execute` | Mutation | `AJ` | Scoped repair permission; `H1`; repair identity | Exact targets and expected versions; per-target fence | Re-read invariants and external effects | Compensation or freeze/block pending review | `AE`; reason, targets, before/after versions |
| `backup.create` | Mutation | `AJ` | Data operations; `SC` or `H1`; backup identity | Backup ID and source checkpoint; one active per source class | Integrity/checksum, inventory, encryption, failure-domain check | Retry/resume; alert and mark recovery unavailable | `AE`; backup reference, class, integrity, as-of |
| `restore.execute` | Mutation | `AJ` | Data recovery permission; `H2`; isolated restore identity | Restore ID; exclusive target fence; exact backup/version | Integrity plus application/schema and sampled/full invariant checks | Revert target or forward-recover per tested runbook; block if no safe path | `AE`; grant, backup reference, RPO/RTO observations |
| `drift.reconcile` | Mutation | `CD` | Infrastructure permission; `H1`; federated stack deployer | Fresh reviewed plan; state lock; serialized stack | Provider observation and clean follow-up drift read | Roll back/reconcile; never silently auto-correct from scheduled read | `AE`; prior drift and resulting state |

### Secret, access, incident, cost, and domain operations

| Operation ID | Read or mutation | Surface | Authority / approval / identity | Idempotency and concurrency | Verification | Recovery or failure behavior | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `secret.container.create` | Mutation, metadata only | `CD` | Secret administration; `H1`; metadata/IAM deployer with no value access | Stable secret contract ID; state lock; one owner | Container policy, owner and no-value-access negative check | Remove empty container or reconcile policy | `AE`; metadata/policy versions only |
| `secret.version.generate` | Mutation, payload internal | `AJ` | Secret lifecycle permission; `H2`; generator can add one version but cannot reveal/list values | Rotation request ID; per-secret lease; no retry after ambiguous write without reconcile | Version lifecycle state and consumer canary, never value/hash | Reconcile ambiguous create; revoke failed version; regenerate | `AE`; opaque version reference and state only |
| `secret.version.ingress` | Mutation, external payload | `SI` + `AJ` | Human/provider supplies payload; `H2` authorizes lifecycle; ingress identity writes one bound secret/version | One-time ingress token bound to secret/request, expiry and single use | Receipt plus consumer canary; orchestrator sees no payload | Destroy rejected/pending version; request fresh ingress, never retrieve | `AE`; receipt/status only; private ingress audit |
| `secret.rotate` | Mutation | `AJ` | Secret lifecycle permission; `H2`; rotation orchestrator plus consumer-specific identities | Per-secret lease; phase checkpoints; one active rotation | Every declared consumer acknowledges new version and functional canary passes | Keep old version active during overlap; abort/revoke new on failure | `AE`; phase/consumer states, no payload |
| `secret.revoke` | Mutation | `AJ` | Secret lifecycle/recovery permission; `H2`; revoker identity | Exact version/access target; per-secret lease; replay reports revoked | Access denial plus consumer health/recovery validation | Block if replacement/recovery unavailable unless incident break-glass grant explicitly accepts outage | `AE`; reason, impact, denial checks |
| `secret.consumer.refresh` | Mutation | `AJ` or `CD` | Workload operations; `H1`, or phase of approved rotation; consumer deployer | Expected config/secret version; per-consumer serialization | Runtime reports safe active-version reference and canary | Roll back consumer or keep overlap; never log value | `AE`; consumer and version references |
| `workload.access.change` | Mutation | `CD` | IAM/security permission; `H2`; policy deployer cannot use granted access | Fresh policy plan; expected policy version; serialized resource | Effective-access positive and excessive-scope negative tests | Revoke grant and reconcile; fail closed on unverifiable policy | `AE`; policy diff, tests, expiry if temporary |
| `telemetry.configuration.change` | Mutation | `CD` | Platform/debug administration; `H1`; telemetry configurator | Expected config version; serialized owner | Signal flow, redaction marker absence, retention/cost observation | Restore prior config; telemetry loss is degraded, not silent | `AE`; config versions and redaction test |
| `incident.mitigation.execute` | Mutation | `AJ` or `CD` | Platform operations; `H1`, `H2` when data/access/destructive; mitigation identity | Incident + action idempotency key; target fence | Independent symptom and invariant checks | Roll back, reconcile, or escalate to break-glass | `AE`; incident/action/effect chain |
| `cost.control.change` | Mutation | `CD` | Billing/ownership; `H2`; budget-policy deployer without payment authority | Expected policy version; serialized budget scope | Read effective ceiling/alerts and notification test | Restore prior policy; never detach billing or auto-shutdown implicitly | `AE`; redacted policy versions and test |
| `dns.certificate.cutover` | Mutation | `CD` | Domain ownership + platform operations; `H2`; DNS/certificate deployer | Change set ID; zone lock; TTL/certificate preconditions | Authoritative DNS, TLS chain/renewal, web/API smoke from independent probes | Time-bounded record rollback and prior route retained until verified | `AE`; change set, observations, rollback window |

## Independent verification and terminal states

Execution and verification use different evidence sources and permissions. The same agent may coordinate both, but the verification call cannot use the mutation token or trust executor-produced success text. At minimum it reads authoritative application state and, where an external effect exists, provider-observed state. It compares intent, audit record, and observation without relying on timestamp ordering alone.

Terminal states are `verified`, `rolled-back-and-verified`, `recovered-and-verified`, `unverified`, `blocked`, or `failed`. `completed` is not a terminal production result. An unavailable verifier leaves the result `unverified` and invokes the cataloged safe response. Quantitative evidence includes as-of time, sample, exclusions, uncertainty, and largest validity threat.

## Audit and evidence contract

The broader audit design is durable, append-only, access-controlled, tamper-evident, and never sampled. M1 uses the explicitly bounded sanitized Git journal/witness contract above; it does not promise a private external-reference archive or complete private reconstruction. It is separate from logs, traces, job summaries, and the operational read models proposed elsewhere.

Each operation chain records, as applicable:

- event ID, event/ingestion UTC times, catalog ID/version, operation and phase;
- request and grant IDs, requester, authorizing principal, execution workload, verifier, tenant/resource scope, reason, grant expiry and policy version;
- source commit, artifact, normalized-input, plan, expected-state and authorization digests;
- idempotency key, lease/fencing generation, attempt, checkpoints, and causation/parent/correlation IDs;
- safe target classes, before/after versions, declared maximum and realized effect counts, outcome and stable error class;
- external request/resource references in the private audit domain, never public provider/account identifiers;
- verification source/as-of, intended-recorded-observed comparison, recovery action, terminal state, and residual uncertainty.

The authorization decision is appended before token exchange. Each external effect and recovery action is appended around its commit boundary. Where a provider call and audit append cannot be atomic, the job uses a durable intent/outbox and reconciliation; it does not claim distributed exactly-once execution.

A public issue/checkpoint, commit status, or Actions summary may report catalog/operation version, safe source/artifact/plan digests, terminal state, check names, redacted timestamps, and an opaque evidence reference. It must not contain raw plans/state, secret identifiers or values, account/billing/provider identifiers, tenant/customer data, private incident detail, recovery material, or a URL/token that grants audit access. Evidence access itself is scoped and attributable.

If required audit storage is unavailable before a consequential mutation, execution does not start. If append fails after an uncertain external effect, the operation freezes further work, preserves its durable intent/checkpoint, and enters reconciliation; it never retries blindly or reports success.

## Secret lifecycle without payload exposure

### Secret contract

Before a first value exists, non-secret metadata defines a stable internal contract ID, owning capability/person, classification, source type (`provider-generated` or `external`), consuming workload identities and exact versions/aliases allowed, rotation interval and overlap, refresh/canary behavior, revocation trigger, regeneration or re-ingress recovery, and evidence retention. Public source may define generic contracts, but account-specific names and opaque managed-store references remain in private operational configuration/audit.

OpenTofu owns containers, IAM, lifecycle policy, and references only. It must not own a version resource whose create/read path puts the payload in configuration, plan, state, output, or provider debug logs. A policy test rejects secret-value variables, outputs, data sources, command arguments, summaries, and artifacts.

### Creation and secure ingress

- **Provider-generated:** a bounded job asks the provider/approved generator to generate and write directly to one pending managed-store version. The value never returns through the operation response. The generator has add-version authority for one contract and no value-read or policy-admin authority.
- **Externally supplied:** after `H2` approval, the system issues a short-lived, single-use ingress capability bound to one secret contract and request. The person or external provider submits over the private ingress directly to the managed store. The agent, workflow dispatcher, shell, issue, and OpenTofu process receive only receipt and lifecycle status. Until this surface is implemented, direct human entry into the provider's protected secret interface is an explicit payload-ingress exception, not routine technical operation, and is privately audited.

Reject size/format/classification failures before activation without echoing the value. Do not compute or publish payload hashes, previews, entropy scores, or equality indicators that could leak information. Scanner findings name only surface and location; a detected value follows [`../../SECURITY.md`](../../SECURITY.md) and is revoked before public cleanup.

### Distribution, activation, refresh, and rotation

Consumers receive identity-based access to an exact active version or controlled alias, never a copied value through CI. A workload reads into bounded process memory, excludes it from logs/crash dumps/telemetry, and reports only a safe version reference and refresh state. Each consumer declares whether refresh is live, on next invocation, or through a serialized restart/deploy.

Rotation is a state machine: `requested → pending-version → canary → consumer-refresh → active → old-disabled → old-destroyed` (where policy permits). The old version remains available during the declared overlap until every required consumer verifies the new version. A failed or missing acknowledgement aborts activation or leaves both versions in bounded overlap and alerts; it never silently revokes the last known recovery value. Concurrent rotation is fenced per secret.

### Revocation and recovery

Emergency revocation still requires an exact authorization unless break-glass is invoked. Before revocation the operation proves a replacement or recovery route, enumerates consumers, and states the expected outage. Provider-generated values are recovered by regeneration; external values by fresh private ingress. Existing values are never recovered by revealing them to an agent. A lost owner/recovery route blocks ordinary revoke/rotate/access changes and escalates to the human account-recovery procedure.

Verification proves access policy, consumer acknowledgement and functional behavior while also proving that deployer, agent, planner, public runner, unrelated workload, and OpenTofu state cannot read the value. Audit records lifecycle state and opaque references, never payload or derived verifier.

## Bootstrap and human-only exceptions

The exceptions are exhaustive for version 1. An operation not listed here does not become a new human exception; it is denied until the catalog changes.

| Exception / catalog ID | Surface / authority | Why human-only now | Bounds, verification, reconciliation and evidence |
| --- | --- | --- | --- |
| Account/billing ownership and legal acceptance (`trust-root.account-own`) | `HX`; `HB`; human owner identity | These establish the external account trust root and liability | No agent credential. Private ownership/recovery attestation; declare/import manageable resources into code/state and verify drift. |
| Root recovery, MFA, recovery channels and custody (`trust-root.recovery-own`) | `HX`; `HB`; human recovery identity | Recovery material must remain outside agent/public systems | Human-custodied and periodically tested privately; use is an incident with private audit and access review. |
| Initial project and billing link (`bootstrap.project-link`) | `HX`; `HB`; human owner identity | Federation and remote state do not yet exist | One minimum project/link; maintainer confirms effective ownership/billing privately; bootstrap imports/declares it and verifies clean drift. |
| Initial state, deployer and federation (`bootstrap.federation-execute`) | `HX`; `HB`; human bootstrap identity | The pipeline cannot authenticate as an identity or store state before they exist | Exact reviewed plan and one execution; migrate local state, remove local artifacts, verify restore and negative federation tests; private `AE`. |
| Protected production approval (`authorization.approve`) | Protected host/authorization service; authorizing principal | Accountable consent cannot be delegated to the execution workload | Exact, expiring, single-use grant; requester/executor cannot self-approve; authorization decision is appended before token exchange. |
| External payload entry before `SI` exists (`secret.version.ingress.manual`) | `HX`; `H2`; human value custodian | The value cannot pass through an agent or public workflow | Direct protected provider UI, one bound version and private receipt; metadata-only automation verifies consumer refresh. Retire when `SI` is validated. |
| Domain registrar ownership and recovery (`trust-root.domain-own`) | `HX`; `HB`; human domain owner | Registrar recovery precedes managed DNS authority | Human custody and private recovery test; ordinary records/certificates remain in reviewed code and `dns.certificate.cutover`. |
| Break-glass (`break-glass.execute`) | `HX`; `HB`; separate human emergency identity | Normal control plane is unavailable and delay would cause greater harm | Exact incident scope, maximum 60 minutes, strong auth, private `AE`, no secret export; independent verification plus immediate drift/code/state reconciliation and subsequent review. |

### Can a short-lived agent bootstrap runner reduce the maintainer procedure?

**Potentially, but not with the current general-purpose agent shell and not enough to remove the trust root.** The agent would otherwise inherit the maintainer's ambient account authority and could issue calls outside the reviewed plan or print private inputs. Short token lifetime alone does not constrain effects or payload visibility.

A safe runner must be implemented and independently validated with all of these controls:

1. an immutable reviewed bootstrap artifact and exact saved plan;
2. a provider/resource/action allowlist and no shell, arbitrary network egress, state readback, or general provider proxy;
3. sealed account inputs delivered directly to the runner and mechanically unavailable to agent prompts, process inspection, logs, and artifacts;
4. a non-exportable, least-privilege credential minted after a human approves the exact plan, expiring no later than the bounded run;
5. one execution, fixed maximum resource count, no destroy, durable private audit, and output allowlisting/redaction;
6. independent provider observation, state migration/restore test, negative federation tests, credential revocation, and runner destruction.

Once proven, an agent may request and monitor that runner, reducing the maintainer's technical steps to private input, plan approval, and independent account-level confirmation. The human still creates/owns the account and billing relationship, retains recovery, supplies protected approval, and can revoke the bootstrap authority. Until then [`../../infra/bootstrap.md`](../../infra/bootstrap.md) remains the documented maintainer-executed procedure.

## Break-glass procedure boundary

Break-glass starts only from a declared incident when normal automation is unavailable or unable to contain harm within the required time. The human custodian records the reason, exact resources/actions, expected effects, recovery path, maximum 60-minute expiry, and independent verifier before access is issued. The session uses a separate emergency identity, strong authentication and maximum available logging; it does not reuse a deployer or runtime identity and never exports secrets.

The agent may prepare options and later verify redacted state but cannot receive the emergency credential or secret material. On expiry, access is revoked automatically. Drift is captured immediately. Every change is represented in source and imported/reconciled into authoritative state, normal automation is revalidated, and a subsequent human review confirms closure. If reconciliation cannot finish before incident closure, the affected capability stays blocked with an owned follow-up; break-glass is not extended into routine access.

## Negative cases and required denial behavior

| Case | Required behavior |
| --- | --- |
| Missing, expired, self-issued, or unrecognized approval | Deny before mutation token exchange; append denial with no provider effect. |
| Excessive operation, target, parameter, effect count, identity, or tenant scope | Deny the whole request; never silently narrow a financially or operationally consequential request. |
| Replayed grant, nonce, idempotency key used with different inputs, or completed request | Return prior safe status or deny; never execute another effect. |
| Concurrent execution on the same stack, schema, schedule, restore target, secret, access policy, or fenced resource | Serialize or reject; stale holder cannot commit. |
| Stale plan, source, artifact, policy, config, schema, expected state, recovery test, or provider observation | Invalidate grant and re-plan/re-authorize; approval never follows changed inputs. |
| Secret payload appears in input, output, argument, environment, state, plan, log, artifact, trace, issue, prompt, or evidence | Stop the path, prevent further publication, revoke/rotate at source first, preserve private evidence, and follow `SECURITY.md`; never echo the value. |
| Verification fails or is unavailable | Mark `unverified`/`blocked`; execute declared safe rollback/recovery or freeze for reconciliation; never report success. |
| Recovery/rollback path is unavailable, stale, untested, or lacks an owner | Deny the mutation unless an exact break-glass grant documents why delay is worse and accepts the bounded consequence. |
| Unknown operation/catalog version or arbitrary command/provider endpoint | Deny; require a reviewed catalog change and implementation. |
| Executor identity does not exactly match the catalog or can approve/use broader authority | Deny and alert; no fallback identity. |
| Audit store unavailable before mutation or append uncertain after effect | Do not start, or freeze and reconcile respectively; never continue unaudited. |
| Read crosses tenant/permission scope or requests raw provider/secret data | Deny without confirming resource existence; record safe authorization outcome. |
| Partial secret rotation or consumer refresh | Keep bounded overlap where safe, do not revoke the last working version, and surface blocked consumers. |
| Break-glass exceeds scope/expiry or normal automation becomes available | Revoke immediately and return to the ordinary operation path. |

## Control-plane views

The [architecture overview](../architecture/overview.md#agent-operated-production-control-plane-decided-not-implemented) owns the current M1 identity, journal/witness and custody diagrams. They show selected design, not installed controls. Broader administrative jobs and secret ingress remain outside M1; ADR-0008/0009 remain Proposed.

## Acceptance and implementation handoff

ADR-0010 and this catalog remain Working, not Settled. #68 supplies policy and source-contract tests, not functioning adapters. #70 implements provider-disabled schemas, indexed journal/witness transitions, fixed publication and independent verification contracts. #71–#73 assemble build-once artifacts, bounded telemetry and affected delivery/recovery. #74 qualifies the actual host transition, #75 approves exact operations, #76 performs enumerated human bootstrap and proves token bounds, and #8/#77 supply remote evidence and acceptance. The broader #21/#22 operation/secret surfaces are not pulled into M1.

No journal/ref/witness creation, protection change, credential, provider operation or deployment is authorized by catalog acceptance. Current production environment safeguards remain binding until the separately authorized and verified transition in [delivery](delivery.md#current-to-target-activation). Repository-only completion has deployment **not applicable**; local documentation tests cannot prove host or provider behavior.
