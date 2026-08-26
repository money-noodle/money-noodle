# Provider and policy attribution visibility

> **Document type:** Product design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-26
> **Canonical requirements:** [`spec/product-and-surfaces.md`](../spec/product-and-surfaces.md), [`spec/providers-and-market-data.md`](../spec/providers-and-market-data.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> **Decision:** Add one read-only attribution vocabulary to signed order, open-position, and performance surfaces.
> It changes presentation and cohort selection only. It grants no forecast, entry, ranking, execution, budget,
> reconciliation, provider-capability, or promotion authority.

## 1. Problem

The durable order already records provider, provider variant, market, forecast model, buy policy, and execution
policy for current generations, but the signed product exposes only fragments:

- provider controls show the selected variant;
- the Policy dialog shows active component versions;
- performance splits live/paper and provider/market totals;
- decision history filters only track and terminal state;
- open-order rows show a venue label but not the complete issuance identity.

This is sufficient while one provider/variant dominates production, but it will silently blend cohorts as soon as
another variant or provider becomes active. Execution generations already coexist historically, so the ambiguity
exists now even before a second funded adapter.

A 2026-08-26 read of 4,864 ledger rows found 1,858 current-v22 edge entry rows. All 1,858 carried provider,
provider variant, market, forecast-model, buy-policy, and issuance execution-policy identity. The caveat is that
all current rows belonged to one provider/variant/market/model combination; this implementation proves attribution
and prevents blending rather than establishing comparative provider performance.

## 2. Scope

### 2.1 Shared dimensions

The signed read model uses these dimensions:

1. execution track: `live` or `paper`;
2. provider;
3. provider variant;
4. market;
5. forecast model;
6. buy policy;
7. execution policy.

Selections within one dimension are OR. Different dimensions combine with AND. An empty selection means “all”.
Result state remains an independent history-only filter.

### 2.2 Identity rules

A pure attribution boundary owns normalization and matching:

- provider is `providerId`, falling back only to historical `venue`; this is authoritative because venue and
  provider were the same before `providerId` existed;
- market uses `normalizeMarketId`, because the production market was the only historical market before stamping;
- provider variant, forecast model, buy policy, and execution policy never default to current values;
- a missing non-inferable identity is the explicit `unattributed` facet;
- issuance execution policy comes from `entryDecision.executionPolicyVersion`, with the same row's
  `entryExecutionDecision.policyVersion` as a legacy execution-stamp fallback; it is never inferred from date;
- buy policy and forecast model come from the immutable issuance snapshot and remain `unattributed` when that
  snapshot was not retained.

No migration or ledger rewrite is permitted. Historical absence remains visible.

### 2.3 Surface behavior

**Decision history** validates query dimensions, filters before pagination, returns applied filters and facet
counts, and labels every rendered order with normalized provider, variant, market, forecast, buy, and execution
identity.

**Open orders** use the same pure matcher over the already bounded signed control payload. Filtering is local and
adds no ledger read or venue request.

**Performance** computes trading records from the filtered edge-order cohort while retaining live and paper as
separate cards and denominators. Forecast calibration, account funding, risk eligibility, sentinels, and promotion
state remain unfiltered because they answer different questions or carry authority. The UI states this boundary.

**Current market cards** remain venue-independent forecasts. Provider filtering may narrow which venue quote or
entry comparison is shown, but it must not recompute the forecast, mutate the production ranking, or alter the
execution-readiness payload. A policy selection different from the active policy produces an explicit no-current-
cohort state rather than replaying history into a live card.

**Public/stateless surfaces** do not gain order-level provider, policy, contract, or funded information. This is an
authenticated worker read model only.

## 3. API and bounded-read contract

`/api/trading/history` remains the owning paginated order-detail route. It accepts repeatable comma-separated
filters for the seven dimensions, rejects unknown parameter shapes, filters the edge strategy before pagination,
and returns facets over the unfiltered edge-history population.

`/api/performance` accepts the same filters. Its existing on-demand full-ledger read remains on-demand; the fixed
dashboard poll and public projection are unchanged. The response includes attribution facets and applied scope.
Only order-derived trade records, provider rows, and maker execution diagnostics use the filtered cohort.
Account-wide or policy-authoritative objects continue to use their existing complete populations.

Facet values are opaque version identities. The client displays them but does not parse a suffix to assign
semantics. `unattributed` is a reserved query token, not a durable ID.

## 4. Isolation and safety

- The helper is pure and imports no store, policy evaluator, budget, or order module.
- Execution and collection import graphs do not import the filter UI or query parser.
- Filtering never writes durable data.
- Live/paper totals are never added into one P&L figure.
- Strategy scope stays `edge-binary-buy`; retired strategy history cannot enter these records.
- Provider capability comes only from the provider/market registries; a facet cannot enable a provider.
- The public projection remains unchanged.

## 5. Tests and acceptance

1. A grid covers all dimensions, multi-select OR, cross-dimension AND, and empty scope.
2. Provider and market historical fallbacks are exact; non-inferable fields remain `unattributed`.
3. Filtering occurs before pagination and facet counts come from the complete scoped strategy population.
4. Unknown query values fail closed rather than becoming “all”.
5. Filtered performance ties exactly to direct filtered order aggregation and keeps tracks separate.
6. Open-order filtering changes only rendered rows.
7. Existing mirror, strategy-isolation, venue-target, budget-ledger, and policy-manifest invariants pass unchanged.
8. Anonymous and stateless route behavior remains unchanged.
9. Typecheck, full tests, build, specification/design/status verification, lint, and `git diff --check` pass.

## 6. Explicit non-goals

This design does not add per-provider policy overrides, select or promote a variant, alter provider funding or
ranking, introduce a durable policy registry, backfill historical identity, add a provider adapter, or change any
order behavior. Durable parameter-diff and policy-lineage unification remains a separate structural design.
