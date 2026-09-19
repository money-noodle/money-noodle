# ADR-0007: First telemetry backend and cost containment

> **Status:** Working
> **Date accepted:** 2026-08-29
> **Owners:** Platform foundation; accepted by maintainer
> **Related architecture:** [`../data-identity-observability.md`](../data-identity-observability.md)
> **Evidence:** [`../../operations/deployment-composition.md`](../../operations/deployment-composition.md)
> **Depends on:** [`ADR-0004`](ADR-0004-first-remote-hosting-composition.md)

## Context

`data-identity-observability.md` accepts OpenTelemetry as the instrumentation and collection standard while keeping storage and export backends replaceable, requires that backends be selected from measured total cost, operational burden, query needs, and portability, states that no telemetry vendor is chosen, notes that the monetary budget is open, and requires ingestion volume, cardinality, retention, query use, and cost to be instrumented from the start so that unknown cost cannot grow invisibly. It sets configurable starting retention defaults of 7 to 14 days for debug logs, 3 to 7 days for detailed traces, and 30 to 90 days for operational metrics.

The accepted architecture requires W3C trace context and a generated request ID to cross from web to API, bounded request, latency, outcome, artifact, and route metadata, and no bodies or personal data. The first slice has no identity, no tenant, and no database, so there is no personal or tenant data to redact yet — which makes this the safest moment to establish redaction defaults, before there is anything to leak.

Telemetry is the element of the deployment composition most likely to become an unbudgeted recurring cost, because volume grows with instrumentation quality rather than with user value.

## Decision

### Instrumentation

Both deployments instrument with **OpenTelemetry** and export **OTLP**. No backend vendor SDK is imported by any project. Domain and application layers import no telemetry library at all; instrumentation is an adapter concern, consistent with the accepted dependency direction.

Each deployment carries its own service identity, and every signal carries the artifact version and the deployment identity so a trace can be attributed to a specific image digest.

### Backend

Use **Google Cloud's native OpenTelemetry-compatible backend** for the first slice, reached over OTLP, because it requires no additional account, no additional credential, no additional trust boundary, and keeps the initial integration narrow. Actual allowance eligibility and total cost remain unmeasured.

This is deliberately the **weakest-commitment** choice in the composition. It is selected because it is the cheapest to reverse, not because it is the best long-term backend. That judgement requires measured volume, cardinality, and query-pattern evidence that does not yet exist.

The maintainer accepts the Pre-GA OTLP metric-ingestion path for this financially inert first slice. Request behavior does not depend on telemetry, only bounded metadata is emitted, and OpenTelemetry keeps the backend replaceable. Reassess before identity, tenant, personal, financial, or funded data exists.

### Cost containment from the first deployment

The following exist before the first remote deployment, not after the first surprising bill:

- dated estimates, measured service/revision/operation/SKU cost attribution and configurable actual/forecast alerts under the owning [cost policy](../../operations/delivery.md#cost-estimates-and-operational-bounds), using #85’s 2026-09-09 research as incomplete synthetic evidence, not an invoice, allowance or spending authority; no fixed USD 30 ceiling remains normative;
- **ingestion volume, span count, log volume, and metric cardinality are themselves observed**, so telemetry cost is visible in the same place as telemetry;
- **explicit retention configuration** starting at the accepted defaults — 7 to 14 days debug logs, 3 to 7 days detailed traces, 30 to 90 days operational metrics — never left at a provider default;
- **head sampling configured but effectively unity at first-slice volume**, with the sampling decision propagated through trace context so it can be lowered later without re-instrumenting;
- **no request or response bodies, no headers by allowlist exception only, no credentials, and no personal or financial content**, per the accepted default-to-metadata rule;
- **bounded cardinality**: route templates rather than raw paths, and no unbounded identifier promoted to a metric label.

### Accepted amendment, 2026-09-15: attainable retention

The retention targets above were written before the provider's actual contract
was read. Two of the three signal classes are not configurable at all, so the
accepted first-slice policy is what the provider actually delivers, stated
plainly rather than aspirationally:

| Signal | Accepted first-slice policy | What that is |
| --- | --- | --- |
| Application and debug logs | 14 days, explicitly configured | A real setting on real log buckets. Debug logs are routed to their own bucket *and* still copied to `_Default`, so both windows are set to 14 days; a shorter debug setting would be a claim the routing does not deliver. |
| Traces | Google's documented 30-day `_Trace` retention | Provider behaviour, not an IaC-configurable deletion guarantee. A deliberate exception to the former 3-to-7-day target. |
| OTLP metrics | Google's documented 24 months with progressive downsampling | Original frequency for one week, one-minute intervals for the next five weeks, then ten-minute intervals. Not 24 months of full-resolution detail, and not a configurable TTL. |

These exceptions apply to the financially inert, allowlisted-metadata first
slice. No additional backend, archive, deletion job or recovery store is added
to emulate the former trace and metric periods. Audit and accounting retention
remain separate and unchanged. Desired configuration is not observed retention:
[`#8`](https://github.com/money-noodle/money-noodle/issues/8) records actual
ingestion and available provider configuration evidence, without pretending to
have observed months of ageing.

Public primary sources inspected 2026-09-15:
[Trace quotas and retention](https://docs.cloud.google.com/trace/docs/quotas),
[Monitoring data retention](https://docs.cloud.google.com/monitoring/quotas#data_retention),
[Telemetry API overview and authentication](https://docs.cloud.google.com/stackdriver/docs/reference/telemetry/overview).
Revalidate a changed provider contract at implementation pickup rather than
silently substituting incompatible behaviour.

### Accepted amendment, 2026-09-15: a narrow telemetry authentication exception

"No backend vendor SDK is imported by any project" above is narrowed, not
abandoned. An exact-version Google authentication library is permitted **only**
in isolated server-side telemetry authentication adapters, where it supplies
short-lived credentials from the Cloud Run service's own workload identity to
standard OTLP exporters through the exporter's documented async headers factory.

The exception does not permit a proprietary tracing or metrics SDK, and does not
permit a provider import in any inner layer. Signal instrumentation and
serialization remain OpenTelemetry with replaceable exporters; only workload
authentication is provider-specific. It authorizes no stored service-account
key, no local ADC or file-credential fallback, no browser exposure, no secret
consumption, no identity impersonation and no general cloud-operation
capability. The production token source is the metadata-server-only `Compute`
client, so "no file fallback" is a property of the class rather than a review
note.

Exactly two files may hold the exception, and lint enforces that rather than
describing it:

- `apps/web/src/adapters/telemetry/workload-identity-headers.ts`
- `services/platform-api/src/adapters/telemetry/workload-identity-headers.ts`

`tools/verify-boundary-rules.mjs` proves the rule by probe: an import of the
authentication library anywhere else, telemetry in an inner API layer, and
telemetry in the web's presentation layer are each written to disk and required
to fail lint.

Google's current Telemetry API documentation requires a quota project plus
`roles/serviceusage.serviceUsageConsumer` and `roles/telemetry.writer`. Those
are reconciled into `infra/modules/cloud-run-service` as **desired
configuration** alongside the existing per-signal roles. Nothing is granted by
this record: an actual grant is a separately authorized operation under
[catalog v2](../../operations/production-control-plane.md#m1-catalog-v2--selected-not-enabled),
and independent observation and every deployment and audit authority boundary
are preserved.

### What telemetry is not

Telemetry is **not** audit and **not** accounting. `data-identity-observability.md` requires those to be durable, access-controlled, tamper-evident, and never silently sampled, and they expire on a different policy. The status request itself produces neither financial accounting nor consequential application audit, but M1 delivery operations do produce the separate sanitized journal/witness evidence specified by [catalog v2](../../operations/production-control-plane.md#field-level-custody-and-bounded-reconstruction). **No audit obligation may be satisfied by a telemetry backend**, then or later. Establishing that separation now prevents the far more expensive mistake of discovering later that an accounting record was a log line that expired.

### Failure behaviour

Telemetry loss degrades observability, never request behaviour. Export failures are bounded and buffered within declared limits and then dropped. A telemetry outage is reported as degraded and does **not** trigger a deployment rollback, consistent with the accepted failure rules.

## Alternatives considered

### A dedicated observability vendor

Deferred, not rejected. Query experience, correlation, and alerting are typically better, and a vendor-neutral OTLP pipeline means switching later is a configuration change. It is not selected now because it adds an account, a credential, a bill, and a trust boundary to prove a status page, and because choosing on marketing rather than on measured volume would violate the accepted requirement to select from measured evidence.

### Self-hosted collector plus storage

Rejected for now. It contradicts the preference for short-lived isolated execution, adds resident infrastructure and its own availability and upgrade burden, and would make the observability system a larger operational surface than the system it observes.

### A Grafana-stack backend

Noted as attractive on portability grounds — Prometheus remote write, Loki push, and Tempo OTLP are unusually portable targets — and it is what one of the compared compositions offers natively. Not selected here only because ADR-0004 did not select that provider. If ADR-0004 is decided the other way, this ADR's backend follows it without changing anything else.

### Defer telemetry until after the first deployment

Rejected. The first slice exists partly to prove that trace context crosses the web-to-API boundary, which is untestable without telemetry. Retrofitting instrumentation is also how bodies and identifiers accidentally get captured.

### Capture request and response bodies by default for debugging

Rejected. The payload-retention policy is explicitly unresolved, and a default that is harmless on a public status endpoint becomes a privacy and financial-data incident the moment a private route ships.

## Consequences

### Positive

- Instrumentation is portable by construction; the backend is the only replaceable part.
- No additional account, credential, or trust boundary is added for the first slice.
- Cost must be measured and attributable; free allotments remain conditional, shared and subject to unknown usage.
- Retention, sampling, and cardinality are explicit configuration from day one rather than discovered defaults.
- The audit and accounting boundary is established before there is any consequential action to record.

### Negative

- The provider's native backend is a weaker query and correlation experience than a dedicated vendor.
- Colocating telemetry with the workloads it observes means a provider-wide incident can impair the evidence needed to diagnose it.
- Pre-GA ingestion paths carry a stated support risk.
- Shared allowance scope varies by SKU, and other usage can exhaust it; alerts are not hard caps and require independent notification verification.
- Dashboards, alert rules, and retention policy are the parts that do **not** migrate if the backend changes later.

The [delivery acceptance](../../operations/delivery.md#status-rendering-and-trace-evidence) owns cross-service trace, marker-redaction, forced-failure and telemetry-outage checks; its [cost policy](../../operations/delivery.md#cost-estimates-and-operational-bounds) owns measured attribution, retention bounds and alert qualification. Existing unapplied budget defaults and unsupported trace/metric retention configuration are gaps, not satisfied policy. No provider or deployment evidence exists to promote this record.
