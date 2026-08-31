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

Use **Google Cloud's native OpenTelemetry-compatible backend** for the first slice, reached over OTLP, because it requires no additional account, no additional credential, no additional trust boundary, and — at first-slice volume — falls inside published free allotments.

This is deliberately the **weakest-commitment** choice in the composition. It is selected because it is the cheapest to reverse, not because it is the best long-term backend. That judgement requires measured volume, cardinality, and query-pattern evidence that does not yet exist.

The maintainer accepts the Pre-GA OTLP metric-ingestion path for this financially inert first slice. Request behavior does not depend on telemetry, only bounded metadata is emitted, and OpenTelemetry keeps the backend replaceable. Reassess before identity, tenant, personal, financial, or funded data exists.

### Cost containment from the first deployment

The following exist before the first remote deployment, not after the first surprising bill:

- a **USD 30 monthly budget ceiling** covering the first-slice project, with alerts at USD 15, USD 24, and USD 30 (50%, 80%, and 100%);
- **ingestion volume, span count, log volume, and metric cardinality are themselves observed**, so telemetry cost is visible in the same place as telemetry;
- **explicit retention configuration** starting at the accepted defaults — 7 to 14 days debug logs, 3 to 7 days detailed traces, 30 to 90 days operational metrics — never left at a provider default;
- **head sampling configured but effectively unity at first-slice volume**, with the sampling decision propagated through trace context so it can be lowered later without re-instrumenting;
- **no request or response bodies, no headers by allowlist exception only, no credentials, and no personal or financial content**, per the accepted default-to-metadata rule;
- **bounded cardinality**: route templates rather than raw paths, and no unbounded identifier promoted to a metric label.

### What telemetry is not

Telemetry is **not** audit and **not** accounting. `data-identity-observability.md` requires those to be durable, access-controlled, tamper-evident, and never silently sampled, and they expire on a different policy. The first slice produces neither, because it has no state-changing, privileged, funded, authorization, ownership, or resource-lifecycle action. **No audit obligation may be satisfied by a telemetry backend**, then or later. Establishing that separation now prevents the far more expensive mistake of discovering later that an accounting record was a log line that expired.

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
- Cost is inside published free allotments at first-slice volume and is observable as it grows.
- Retention, sampling, and cardinality are explicit configuration from day one rather than discovered defaults.
- The audit and accounting boundary is established before there is any consequential action to record.

### Negative

- The provider's native backend is a weaker query and correlation experience than a dedicated vendor.
- Colocating telemetry with the workloads it observes means a provider-wide incident can impair the evidence needed to diagnose it.
- Pre-GA ingestion paths carry a stated support risk.
- Free allotments are per account, so they will be consumed faster as projects are added, and the first real bill will arrive without warning unless the budget alert is in place first.
- Dashboards, alert rules, and retention policy are the parts that do **not** migrate if the backend changes later.

## Validation

Before this decision is considered implemented:

1. one browser request produces a single trace spanning web and API with a shared trace ID and the generated request ID;
2. both services report their artifact version and deployment identity on every signal;
3. no request body, response body, credential, header outside the allowlist, or personal data appears in any signal — verified by a deliberate negative test that sends a marker value and proves it is absent;
4. retention is explicitly configured for each signal class and matches the accepted starting defaults;
5. ingestion volume and cardinality are themselves observable;
6. a budget alert is configured and proven to fire against a test threshold;
7. a forced telemetry outage does not change request behaviour and does not trigger a rollback;
8. the forced-API-failure smoke path is visible as a distinct, attributable failure in traces;
9. measured monthly ingestion volume, span count, and cost are recorded with as-of time and largest validity threat before any backend is called permanent.

## Revisit when

- measured ingestion volume, cardinality, or query needs justify a dedicated vendor;
- the hosting provider decision changes, since the backend follows it;
- identity, tenant data, or personal data enter any signal path, which changes the redaction requirement from theoretical to enforced;
- the first durable audit or accounting requirement appears, which needs its own separate design and must not reuse this one;
- a Pre-GA ingestion path changes launch stage in either direction.
