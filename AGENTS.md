# Money Noodle v2 Agent Guide

## Mission and phase

Money Noodle v2 is a clean rebuild. The current order of work is:

1. understand and document the problem;
2. establish and validate the architecture;
3. implement in small vertical slices;
4. test each slice and the boundaries around it;
5. validate the deployed system against explicit acceptance criteria.

Do not skip architecture to recreate familiar v1 behavior. A prototype may reduce an architectural uncertainty, but it must be isolated, disposable, and clearly identified as a spike rather than production code.

The known architectural concerns are rapid and explainable risk reasoning, useful visual presentation, forecasting from point-in-time data, data quality, parallel experimentation, process isolation, deployability, security, and multitenancy. These are drivers, not a complete specification. Ask for the product outcome and constraints when they are not documented; do not infer them from v1.

## V1 is evidence, not authority

Nothing from v1 is a requirement, fact, accepted design, or proven result merely because it exists or is written confidently. This includes code, documentation, reports, configuration, schemas, environment variables, provider choices, thresholds, and operational practices. The few files retained by the v2 reset may also contain v1 assumptions.

V1 is preserved at the immutable `archive/v1-final` tag and on `release/v1`. Consult it only when history is relevant. When using it:

- first state the v2 question independently;
- label the v1 material as a hypothesis or historical observation;
- identify its data, date, assumptions, and failure modes;
- reproduce or revalidate any load-bearing claim with v2 evidence;
- prefer a simpler or materially different design when it better meets the current drivers.

Never copy v1 implementation into v2 without an explicit rationale and current tests. Similar behavior is not proof that the old boundary or abstraction should survive.

## Authority and claims

For the desired system, authority descends in this order:

1. the maintainer's current instruction;
2. accepted v2 specifications and architecture decisions;
3. implemented behavior, which says only what the system currently does;
4. tests and dated validation reports, which are evidence within their documented scope;
5. historical material, including all v1 content.

Resolve contradictions visibly instead of choosing silently. Distinguish facts, assumptions, hypotheses, decisions, and unknowns in design work. Cite the artifact or reproducible command behind consequential claims. A test proves only the property it actually exercises.

Do not present estimates, forecasts, simulations, paper results, or backtests as realized outcomes. Record sample size, as-of time, exclusions, uncertainty, and the largest known validity threat with quantitative findings.

## Architecture before implementation

Do not begin production feature implementation until the maintainer has accepted a baseline architecture appropriate to that feature. The baseline should cover, at the level needed to make the next decisions:

- system context, actors, use cases, and out-of-scope behavior;
- measurable quality attributes and failure budgets;
- domain boundaries and dependency direction;
- trust boundaries, identity, authorization, and tenant isolation;
- data ownership, lineage, schemas, quality states, retention, and recovery;
- forecast and experiment lifecycles, including leakage prevention;
- risk evaluation, authorization, execution, and audit boundaries;
- runtime processes, deployment topology, scaling, and failure isolation;
- user-facing read models and visual explanations;
- observability, incident response, and safe degradation;
- alternatives, tradeoffs, unresolved risks, and validation plans.

Use diagrams where relationships or data flow are easier to inspect visually. Record durable, cross-cutting choices as short architecture decision records: context, options, decision, consequences, status, and validation. Do not write an ADR to justify a decision after silently coding it.

Prefer technology-neutral requirements before selecting infrastructure. A technology choice must identify the constraint it satisfies, alternatives considered, operational cost, security implications, and an exit path when lock-in is material.

As records are introduced, keep a small navigable set rather than a diary: an architecture overview, accepted ADRs, bounded specifications, current status, experiment definitions, and dated validation reports. Proposed text does not become accepted merely by being committed.

## Design principles to evaluate

These are v2 defaults to test through architecture work, not claims that a particular implementation already exists:

- Keep domain decisions deterministic and separate from I/O, orchestration, presentation, and vendor adapters.
- Separate observation, forecast, risk, authorization, execution, and reconciliation. A forecast must not acquire execution authority by being returned from the same process.
- Make risk decisions explainable under time pressure: include inputs, source/as-of times, quality, uncertainty, policy version, decision, and reasons. Missing, stale, contradictory, or unauthorized inputs fail closed at authority boundaries.
- Keep canonical writes owned by one boundary. Derive purpose-built, rebuildable read models for rich visual surfaces instead of forcing the UI onto transactional models.
- Treat source time and ingestion time separately. Preserve provenance and schema/version information so point-in-time reconstruction is possible.
- Make forecasting reproducible from versioned inputs, code/configuration, horizons, and evaluation cohorts. Prevent future-data leakage and compare against declared baselines.
- Give every experiment an identity, hypothesis, owner, cohort/assignment rule, metrics, guardrails, start/stop criteria, and isolated state. Experiments must not silently mutate production policy or share execution authority.
- Design long-running work, scheduled work, and request/response services explicitly. Do not assume local disk, process residency, ordering, or serverless behavior without documenting it.
- Carry authenticated tenant context from the trusted boundary to every tenant-owned read, write, cache key, event, job, metric, and audit record. Client-supplied tenant identifiers are never authorization.
- Use least privilege and defense in depth. Test cross-tenant denial, not only same-tenant success.
- Prefer reversible increments and explicit compatibility boundaries over a large coupled build.

Money Noodle v2 begins with **no real-money authority**. Adding any funded capability requires explicit maintainer approval plus an accepted threat model, deterministic limits, independent authorization, idempotency, reconciliation, kill controls, tamper-evident audit, sandbox/paper evidence, and failure-path tests. Never deploy, enable external side effects, rotate credentials, or move funds without an explicit instruction.

## Data, security, and privacy

- Validate external data at ingestion and retain the reason for rejection or degradation.
- Represent unknown, absent, stale, invalid, and zero as different states.
- Define units, precision, timezone, identifiers, and null semantics in contracts; do not rely on naming conventions alone.
- Never commit secrets, private keys, tokens, customer data, or production snapshots. Do not print secret values in commands or handoffs.
- Encrypt sensitive data in transit and at rest using managed controls where possible. Document key ownership and rotation.
- Authorization belongs server-side and defaults to deny. Administrative and service access must be scoped and audited.
- Tenant isolation must be enforced at repository/service boundaries and, where supported, again in storage policy. Background jobs and caches require the same isolation as HTTP requests.
- Logs, traces, analytics, exports, backups, and error reports are part of the data boundary; redact and scope them accordingly.
- Define retention, deletion, export, backup, and restore behavior before storing sensitive tenant data.

## Implementation and validation workflow

For each change:

1. Inspect the current branch, accepted v2 records, and relevant source. Do not rely on memory.
2. Write the problem, scope, assumptions, acceptance criteria, and risks.
3. Resolve architecture-impacting decisions before production code. Use a bounded spike only for an explicit uncertainty.
4. Implement the smallest end-to-end slice that preserves boundaries. Avoid speculative frameworks and generalized abstractions without a second demonstrated use.
5. Add tests at the cheapest effective level and negative tests at trust, tenant, data-quality, and authority boundaries.
6. Run all relevant repository checks plus focused tests. Never weaken a gate merely to make it pass.
7. Validate the acceptance criteria independently of the implementation path and record remaining uncertainty.
8. Update architecture, specification, decision, and operational records in the same change when their truth changed.

Favor pure domain tests, schema/contract tests, adapter integration tests, and a small number of end-to-end journeys. Use deterministic clocks, random seeds, and fixtures. Add regression tests for defects. Risk rules need boundary and invariant/property tests; forecasting needs leakage, calibration, baseline, and walk-forward checks; multitenancy needs explicit cross-tenant attack cases; process isolation needs crash, retry, duplication, and partial-failure tests; deployment needs migration, startup, health, rollback, and restore checks.

Read the current package/build manifests before naming commands. Do not assume v1 commands or the retained CI workflow apply to v2. If a required check does not yet exist, report that gap rather than claiming completion. Never delete or rewrite a failing test without explaining why its asserted requirement is invalid.

## Branch and tag strategy

### Preserved state

- `archive/v1-final` is the immutable annotated tag for the final v1 `main` tip before the rebuild (`4b71b61894622b1c01f3552f9c7af5592cb2800a`). Never move or delete it.
- `release/v1` preserves the maintainable v1 line. Only explicitly requested critical v1 fixes branch from and merge back to it. Never merge v2 work into it.
- `main` represents the current releasable major version. It remains v1 until the v2 cutover, then becomes the protected v2 trunk.
- `v2` is the temporary integration branch rooted at the v2 reset. It is the base and merge target until cutover; do not merge later v1 commits into it merely to make histories look current.

### Working branches

Create a short-lived branch from the current integration target for every bounded change. While building v2, that target is `v2`; after cutover it is `main`.

Use `<type>/<short-kebab-description>`:

- `arch/` architecture and ADRs;
- `feat/` product behavior;
- `fix/` defects;
- `test/` test or validation infrastructure;
- `docs/` non-architectural documentation;
- `chore/` tooling and maintenance;
- `spike/` disposable uncertainty reduction.

The initial branch is `arch/v2-foundation`. Keep branches single-purpose, incorporate the latest target before merge, and do not mix opportunistic cleanup into them. Prefer reviewable commits whose imperative subject states the change or finding. Do not commit directly to `main`, `v2`, or `release/v1`; merge only after review and required checks pass.

Use annotated, immutable Semantic Versioning tags (`vMAJOR.MINOR.PATCH`) for v2 releases after acceptance. Do not retroactively invent a v1 semantic version; its archive tag is its stable marker. Tags identify source; deployment and environment promotion are separate, auditable actions. Never retag a different commit.

At v2 cutover: freeze writes to both lines, verify the v1 archive refs, run the complete v2 validation plan, merge v2 into `main` without rewriting history, verify that the resulting source tree is the accepted v2 tree, tag `v2.0.0`, and deploy only with explicit approval. Keep `release/v1` and `archive/v1-final`; remove the temporary `v2` branch only after the cutover is verified. Roll back through the deployment system to a known tag—never by moving a tag or force-pushing shared history.

Do not push branches, merge, tag a release, alter protected refs, or deploy unless the maintainer requested that action. If a push is requested, confirm remote CI rather than assuming local checks predict it.

## Handoff standard

Report the branch, changed paths, architecture or requirement decisions, checks run and exact failures, evidence collected, security/tenant impact, deployment impact, and unresolved risks. Say explicitly when work is only a proposal, spike, unvalidated implementation, or locally validated change. Completion means the documented acceptance criteria are met—not merely that code was written.
