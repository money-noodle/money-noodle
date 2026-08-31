# ADR-0002: API-owned OpenAPI contract and generated client

> **Status:** Working
> **Date accepted:** 2026-08-29
> **Owners:** Platform API owns the contract; interface projects own presentation mapping
> **Related architecture:** [`../overview.md`](../overview.md)

## Context

Money Noodle requires versioned REST/OpenAPI contracts, runtime wire validation, one generated TypeScript client for TypeScript interfaces, and interface-neutral APIs. Hand-maintained request functions or shared TypeScript domain types would permit server/client drift and leak transport/framework values into core rules.

Contract ownership must also support independent deployment: an API and consumer need a provable compatibility range and ordered rollout without rebuilding every project for an unchanged contract.

## Decision

The platform API owns editable canonical OpenAPI 3.1 source at:

```text
services/platform-api/openapi/platform-api.v1.yaml
```

The document is the wire authority for public v1 operations. It contains stable operation IDs, schemas, examples, security declarations, cache behavior, standard problems, and version metadata. API route conformance and runtime request/response validation derive from or are checked against that document.

A pinned generator produces:

```text
packages/platform-api-client/src/generated/
```

Generated files are reproducible, committed only if the accepted tool workflow requires it, and never manually edited. The package exposes transport operations/models only. Each consumer maps transport DTOs to its own presentation or application values; generated models do not become domain entities.

Versioning rules:

- public v1 operations use `/v1`;
- additive optional fields and operations may remain in v1;
- a required-field removal, meaning change, incompatible enum narrowing, or other breaking wire change requires a new major contract such as `/v2` plus a migration plan;
- `info.version` identifies the contract release independently from the deployed artifact version;
- the API reports attributable artifact and safe schema versions without exposing topology or secrets;
- CI compares changes with the accepted baseline and rejects unapproved breakage.

Errors use `application/problem+json` following RFC 9457 with a stable Money Noodle error code, safe title/detail, HTTP status, instance/request reference, and trace/request ID as appropriate. Errors do not expose stack traces, secrets, provider payloads, tenant existence, or internal addresses.

Future state-changing operations include explicit idempotency, expected resource version, principal/scope, client identity, and correlation semantics when their capability design requires them. Those fields are not invented for the first read-only operation.

## Tooling boundary

This ADR chooses ownership and correctness properties, not a generator by brand. The scaffolding task must compare maintained generators/runtime-validation approaches against:

- OpenAPI 3.1 support;
- deterministic output;
- Node.js/TypeScript and fetch compatibility;
- runtime response validation or enforceable API conformance;
- nullable/optional/date/decimal fidelity;
- problem-details support;
- security/dependency posture;
- Nx caching and generation-drift checks.

The selected tool and exact version are pinned in the workspace. If runtime adapters need generated schemas, they remain HTTP-adapter artifacts and cannot enter domain/application code.

## Alternatives considered

### Hand-author one OpenAPI document and duplicate route schemas

Clear contract-first review, but duplicated validators can drift. Rejected unless CI can prove exact conformance from one source.

### Generate OpenAPI from framework route code

Good route/schema locality, but framework code becomes the editable contract source and can weaken independent review. Deferred unless the generated document is stable, version-controlled as governed output, and compatibility/conformance checks prove it is canonical.

### Share TypeScript interfaces between web and API

Rejected. Compile-time types do not validate network input, do not support non-TypeScript clients, and tend to leak domain/framework types across deployment boundaries.

### Hand-maintain fetch code in each interface

Rejected. It duplicates auth, error, timeout, version, and DTO behavior and makes future clients diverge.

### GraphQL/protobuf for the first API

Rejected for this slice because accepted engineering direction is REST/OpenAPI. A future bounded protocol needs a separate material-advantage decision.

## Consequences

### Positive

- One reviewable wire authority serves all interfaces.
- Generation and compatibility checks expose drift before deployment.
- Runtime validation protects both inbound and outbound boundaries.
- The API can deploy compatible additions before consumers.
- Non-TypeScript clients can generate from the same language-neutral contract later.

### Negative

- Generation and conformance tooling add CI cost and version-management work.
- OpenAPI source can become unwieldy without API-owned components and naming discipline.
- Transport/domain mapping adds deliberate code at each boundary.
- Compatibility policy requires retained baselines and an explicit deprecation process.

## Validation

The scaffold/implementation tasks must prove:

- OpenAPI lint and semantic validation;
- deterministic regeneration from a clean checkout;
- no uncommitted generation drift;
- API request and response conformance, including negative invalid-response tests;
- consumer compilation through the generated package only;
- compatibility checks against the accepted v1 baseline;
- RFC 9457 content type and redacted stable errors;
- unknown enum/schema behavior fails safely rather than being guessed.