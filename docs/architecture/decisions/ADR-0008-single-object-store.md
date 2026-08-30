# ADR-0008: Single object store on Google Cloud Storage

> **Status:** Proposed
> **Date proposed:** 2026-08-30
> **Owners:** Platform foundation; proposed for maintainer acceptance
> **Related architecture:** [`../data-identity-observability.md`](../data-identity-observability.md)
> **Evidence:** [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md)
> **Supersedes:** the Scaleway object-storage direction in [`../data-identity-observability.md`](../data-identity-observability.md)
> **Depends on:** [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md), [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md)

## Context

`data-identity-observability.md` accepts Scaleway's S3-compatible object storage as the initial historical and analytical store, reached through a portable object-storage adapter. [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md) then selected Google Cloud Run, Artifact Registry, and Cloud DNS for compute, registry, and the public entry point. Together those two accepted records commit the platform to two providers.

ADR-0004 does not treat that as incidental. It records it as an accepted negative consequence, in these words: "**A second provider.** Scaleway object storage is already accepted, so the platform now spans two accounts, two IAM models, two bills, and two audit scopes before it has a user." `deployment-composition.md` states the same thing as the strongest counterargument to its own accepted selection — "It splits the platform across two providers on day one" — and its non-cost comparison records that the losing composition would have consolidated "compute, registry, DNS, secrets, telemetry, and the already-accepted object store under **one** provider, one bill, one IAM model, one audit scope." Consolidation was the strongest argument that lost.

The decisive fact is that the accepted Scaleway direction is **entirely unbuilt**. A repository-wide search on 2026-08-30 finds Scaleway named in exactly three documents — `data-identity-observability.md`, `deployment-composition.md`, and ADR-0004 — and nowhere else. There is no provider block in any `.tf` file, no object-storage adapter, no client dependency, no credential, no account, no bucket, and no stored object. The only object storage that exists is the infrastructure-state buckets accepted by [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md), which are Google Cloud Storage and hold state, not historical or analytical data.

Consolidating now is therefore a **documentation supersession, not a migration**. Its whole cost is editing a paragraph. That is true only until the first historical dataset lands; after that the same change means moving objects, rewriting keys, revalidating checksums and manifests, re-testing restore, and retiring a second set of credentials. This record exists because that window is open and will not reopen.

`principles.md` requires cloud-specific services to stay behind narrow adapters with open protocols and exportable formats, permits cloud-specific deployment composition, and forbids cloud-specific domain logic. This decision is composition.

## Decision

**Google Cloud Storage is the platform's single object store.** Scaleway is not used for any purpose — not object storage, not compute, not registry, not DNS, not secrets, not telemetry. Historical and analytical data lands in Google Cloud Storage buckets in the maintainer-owned account and the accepted `us-west1` region.

- The platform holds **one provider account, one IAM model, one bill, and one audit scope**. This resolves the negative consequence ADR-0004 accepted rather than leaving it standing.
- Historical and analytical buckets are **separate buckets** from the ADR-0006 infrastructure-state buckets, with their own IAM, lifecycle, versioning, and retention. Sharing a provider is not sharing a bucket.
- The **portable object-storage adapter requirement is unchanged**. The store is reached only through that port; no provider SDK enters `apps/web`, `services/platform-api`, or any domain or application layer. What this decision drops is a second provider account, not the abstraction.
- The **schema-versioned UTF-8 JSON chunk and manifest contract is unchanged**. Chunk identity, sequence or partition, schema and producer versions, checksums, byte and record counts, tenant and subject scope, event-time range, and the requirement that readers detect missing, duplicate, corrupt, or incompatible chunks are properties of the format, not of the provider. They carry to any target unchanged, and they are what makes this reversible.
- `data-identity-observability.md`'s "do not add a second provider or region yet" instruction still holds, and now holds without exception. This record removes the one carve-out the accepted direction had already made.
- No account, bucket, credential, or dataset is created by accepting this record.

### What this does not reopen

ADR-0004's compute selection stands unchanged. That decision turned on credential posture — Cloud Run's ecosystem was the only one examined in which the delivery pipeline authenticates without a long-lived cloud key at rest — and nothing in this record bears on that finding. This record consolidates onto the provider ADR-0004 already chose; it does not re-argue the choice.

ADR-0004 itself is not edited. `decisions/README.md` requires that consequential changes supersede a record rather than silently rewriting its accepted decision, so ADR-0004 keeps its "A second provider" consequence as written and this record is where the change is visible.

## Alternatives considered

### Keep Scaleway for historical and analytical data as accepted

Rejected. It preserves a two-provider footprint whose only remaining justification is that it was written down first. Nothing has been built on it, so continuity costs nothing to abandon and everything to keep: a second account to own and recover, a second IAM model to reason about at every tenancy boundary, a second bill, a second audit scope, a second credential to store and rotate, and a second place where a data-residency or deletion obligation must be proved. ADR-0004 accepted that price as unavoidable because the object-storage decision was already accepted and considered permanent — `deployment-composition.md` classifies historical object storage as "Already committed" in its exit-cost table. That premise is the one this record retires: an unbuilt decision is not committed.

### Use Scaleway for everything, including compute

Rejected, and deliberately not reopened. Consolidation onto Scaleway would also produce one provider, one bill, one IAM model, and one audit scope, and would additionally deliver EU residency by construction and a free production TLS entry point. ADR-0004 weighed exactly that trade and ranked credential posture above consolidation, because Scaleway's documented GitHub Actions pattern stores a long-lived IAM application key as a repository secret and no OIDC workload-identity exchange for CI was found in its IAM documentation. That evidence has not changed, and it would additionally reintroduce the unresolved warm-window billing question, which leaves Scaleway compute somewhere between `€0` and ≈`€44.50` per month. Reversing an accepted hosting decision on the strength of a consideration that decision already weighed and ranked lower is not a supersession, it is a re-litigation. If Scaleway later ships OIDC workload-identity federation for CI, the correct path is to revisit ADR-0004 first; this record follows whatever ADR-0004 says.

### Defer the choice until the first historical dataset exists

Rejected. Deferral looks neutral and is not. The accepted text currently names Scaleway, so deciding nothing is deciding to split the platform across two providers by default, and the first person to implement the historical store will implement what the accepted document says. Deferral also ends at precisely the moment the change becomes expensive: the dataset that would trigger the decision is the same dataset that turns a paragraph edit into a data migration with checksums, manifests, and tested restore. A choice that gets strictly more costly the longer it waits, and that commits by silence in the meantime, is not a candidate for deferral.

## Consequences

### Positive

- The platform spans one account, one IAM model, one bill, and one audit scope, which is the consequence ADR-0004 accepted as a cost and this record removes.
- The change costs a documentation edit rather than a data migration, because nothing was built on the superseded direction.
- The historical store is reachable from the platform's workloads with a scoped service identity, so no second long-lived provider key is introduced anywhere — consistent with the property ADR-0004 optimised for.
- Residency, retention, lifecycle, deletion, and legal-hold policy are enforced in one IAM and one policy model instead of two, which matters most for exactly the data class that will later hold tenant and personal content.
- The portable object-storage port and the schema-versioned chunk and manifest contract survive intact, so the decision is reversible as a composition change rather than a domain change.

### Negative

- **Concentration risk.** Compute, registry, DNS, secrets, telemetry, infrastructure state, and now historical and analytical data share one provider, one billing account, and one account-compromise and failure domain. A provider-wide incident reaches the workloads, the evidence needed to diagnose them, and the historical record at the same time.
- EU data residency is no longer available as a property of the platform's shape. Scaleway's footprint would have made residency a consequence of the provider; ADR-0004 already records that residency "becomes an explicit decision rather than a property of the provider", and this record extends that to the data class most likely to carry personal or tenant content. Residency remains achievable, because the provider offers EU locations, but it must now be chosen, configured, and proved rather than inherited.
- Provider free allotments are per billing account, so historical storage, requests, and egress now draw on the same allotments as compute, registry, state, and telemetry, and will consume them faster.
- If a genuine multi-provider requirement appears later — a regulatory residency obligation, a customer contract, or a deliberate second failure domain — establishing it will cost materially more than establishing it now would have, because it will involve moving objects with revalidated checksums, manifests, and tested restore rather than editing a paragraph. This decision spends a cheap option to remove a present cost.
- The portable adapter's portability stays unproven. Exercised against one implementation only, provider-specific behaviour in lifecycle rules, object-versioning semantics, conditional writes, and IAM conditions can leak into the port without anything failing.

## Validation

Before this decision is considered implemented:

1. `data-identity-observability.md` names exactly one object store, and no accepted document still presents a two-provider object-storage footprint as current;
2. no Scaleway account, credential, IAM identity, or bucket exists, and a repository-wide search finds Scaleway only in superseded, historical, or comparison context;
3. historical and analytical buckets are separate from the ADR-0006 infrastructure-state buckets and carry their own IAM, lifecycle, versioning, and retention;
4. the store is reached only through the portable object-storage port, proved by a negative test showing that no provider SDK is reachable from a domain or application layer;
5. the schema-versioned chunk and manifest contract is exercised end to end against the store, including deliberate detection of a missing, duplicate, corrupt, and version-incompatible chunk;
6. a restore from object versioning is exercised rather than assumed, and its result is recorded with an as-of time;
7. the workload reaches the store with a scoped service identity and no long-lived key at rest;
8. storage, request, and egress cost for the historical store is observable against the accepted monthly ceiling before the first dataset is retained.

## Revisit when

- a stated regulatory or contractual obligation makes EU residency or a non-Google store mandatory;
- a second failure domain for historical objects is justified by measured value at risk rather than by symmetry;
- the first historical dataset is designed, since that is when chunk size, lifecycle thresholds, and retention move from open decisions to enforced configuration;
- ADR-0004's hosting decision is revisited for any reason, since this record follows it rather than standing beside it;
- provider concentration becomes the largest recorded platform risk in its own right;
- measured storage, request, or egress cost becomes a material share of the accepted budget ceiling.
