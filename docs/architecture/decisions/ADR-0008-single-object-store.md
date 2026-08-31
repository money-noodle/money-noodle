# ADR-0008: Single object store on Google Cloud Storage

> **Proposal only — not current authority.** The accepted Scaleway/S3-compatible historical-store direction remains current. Nothing in this record authorizes Google Cloud Storage for historical or analytical data, changes a provider boundary, or guides implementation unless the maintainer separately accepts this proposal and changes its status to Working.

> **Status:** Proposed
> **Date proposed:** 2026-08-30
> **Owners:** Platform foundation; proposed for maintainer acceptance
> **Related architecture:** [`../data-identity-observability.md`](../data-identity-observability.md)
> **Evidence:** [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md)
> **Would supersede only if accepted:** the Scaleway object-storage direction in [`../data-identity-observability.md`](../data-identity-observability.md)
> **Depends on:** [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md), [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md)

## Context

`data-identity-observability.md` accepts Scaleway's S3-compatible object storage as the initial historical and analytical store, reached through a portable object-storage adapter. [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md) then selected Google Cloud Run, Artifact Registry, and Cloud DNS for compute, registry, and the public entry point. Together those two accepted records commit the platform to two providers.

ADR-0004 does not treat that as incidental. It records it as an accepted negative consequence, in these words: "**A second provider.** Scaleway object storage is already accepted, so the platform now spans two accounts, two IAM models, two bills, and two audit scopes before it has a user." `deployment-composition.md` states the same thing as the strongest counterargument to its own accepted selection — "It splits the platform across two providers on day one" — and its non-cost comparison records that the losing composition would have consolidated "compute, registry, DNS, secrets, telemetry, and the already-accepted object store under **one** provider, one bill, one IAM model, one audit scope." Consolidation was the strongest argument that lost.

The decisive fact is that the accepted Scaleway direction is **entirely unbuilt**. A repository-wide search on 2026-08-30 finds Scaleway named in exactly three documents — `data-identity-observability.md`, `deployment-composition.md`, and ADR-0004 — and nowhere else. There is no provider block in any `.tf` file, no object-storage adapter, no client dependency, no credential, no account, no bucket, and no stored object. The only object storage that exists is the infrastructure-state buckets accepted by [`ADR-0006`](ADR-0006-infrastructure-as-code-and-remote-state.md), which are Google Cloud Storage and hold state, not historical or analytical data.

Under this proposal, consolidating now would be a **documentation supersession, not a migration**. Its whole cost would be editing current documentation. That is true only until the first historical dataset lands; after that the same change means moving objects, rewriting keys, revalidating checksums and manifests, re-testing restore, and retiring a second set of credentials. This proposal exists because that window is open and will not reopen.

`principles.md` requires cloud-specific services to stay behind narrow adapters with open protocols and exportable formats, permits cloud-specific deployment composition, and forbids cloud-specific domain logic. This proposal concerns composition only.

## Decision

The following is the decision that **would** take effect only if this proposal were separately accepted and became Working. Until then, it has no current storage, provider, infrastructure, or deployment authority.

**Google Cloud Storage would become the platform's single object store.** Scaleway would not be used for any purpose — not object storage, not compute, not registry, not DNS, not secrets, not telemetry. Historical and analytical data would land in Google Cloud Storage buckets in the maintainer-owned account and the Working `us-west1` region.

- The platform would hold **one provider account, one IAM model, one bill, and one audit scope**. This would resolve the negative consequence ADR-0004 accepted rather than leave it standing.
- Historical and analytical buckets would be **separate buckets** from the ADR-0006 infrastructure-state buckets, with their own IAM, lifecycle, versioning, and retention. Sharing a provider would not mean sharing a bucket.
- The **portable object-storage adapter requirement would remain unchanged**. The store would be reached only through that port; no provider SDK would enter `apps/web`, `services/platform-api`, or any domain or application layer. The proposed decision would drop a second provider account, not the abstraction.
- The **schema-versioned UTF-8 JSON chunk and manifest contract would remain unchanged**. Chunk identity, sequence or partition, schema and producer versions, checksums, byte and record counts, tenant and subject scope, event-time range, and the requirement that readers detect missing, duplicate, corrupt, or incompatible chunks are properties of the format, not of the provider. They would carry to any target unchanged, and they are what would make this reversible.
- The current direction's restriction against adding another historical object-storage provider or region would remain, but its accepted Scaleway selection would be replaced. This proposal would remove that existing provider boundary only after acceptance.
- Accepting this record would not itself create an account, bucket, credential, or dataset.

### What acceptance would not reopen

ADR-0004's compute selection would stand unchanged. That decision turned on credential posture — Cloud Run's ecosystem was the only one examined in which the delivery pipeline authenticates without a long-lived cloud key at rest — and nothing in this proposal bears on that finding. The proposal would consolidate onto the provider ADR-0004 already chose; it would not re-argue the choice.

ADR-0004 is Working, so the [`decision index`](README.md) permits correcting it in place. If this proposal became Working, ADR-0004's no-longer-current two-provider consequence and other current documents would be corrected as consequential updates; a separate superseding record is required only for a Settled decision, not for ADR-0004.

## Alternatives considered

### Keep Scaleway for historical and analytical data as accepted

Rejected. It preserves a two-provider footprint whose only remaining justification is that it was written down first. Nothing has been built on it, so continuity costs nothing to abandon and everything to keep: a second account to own and recover, a second IAM model to reason about at every tenancy boundary, a second bill, a second audit scope, a second credential to store and rotate, and a second place where a data-residency or deletion obligation must be proved. ADR-0004 accepted that price as unavoidable because the object-storage decision was already accepted and considered permanent — `deployment-composition.md` classifies historical object storage as "Already committed" in its exit-cost table. That premise is the one this proposal would retire if accepted: an unbuilt decision is not committed.

### Use Scaleway for everything, including compute

Rejected, and deliberately not reopened. Consolidation onto Scaleway would also produce one provider, one bill, one IAM model, and one audit scope, and would additionally deliver EU residency by construction and a free production TLS entry point. ADR-0004 weighed exactly that trade and ranked credential posture above consolidation, because Scaleway's documented GitHub Actions pattern stores a long-lived IAM application key as a repository secret and no OIDC workload-identity exchange for CI was found in its IAM documentation. That evidence has not changed, and it would additionally reintroduce the unresolved warm-window billing question, which leaves Scaleway compute somewhere between `€0` and ≈`€44.50` per month. Reversing an accepted hosting decision on the strength of a consideration that decision already weighed and ranked lower is not a supersession, it is a re-litigation. If Scaleway later ships OIDC workload-identity federation for CI, the correct path is to revisit ADR-0004 first; this record follows whatever ADR-0004 says.

### Defer the choice until the first historical dataset exists

Rejected. Deferral looks neutral and is not. The accepted text currently names Scaleway, so deciding nothing is deciding to split the platform across two providers by default, and the first person to implement the historical store will implement what the accepted document says. Deferral also ends at precisely the moment the change becomes expensive: the dataset that would trigger the decision is the same dataset that turns a paragraph edit into a data migration with checksums, manifests, and tested restore. A choice that gets strictly more costly the longer it waits, and that commits by silence in the meantime, is not a candidate for deferral.

## Consequences

These consequences are proposal analysis only. They would apply only after separate acceptance and promotion to Working.

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
