# Money Noodle — Living Product Specification

> **Status:** Draft 0.44 · **Structure updated:** 2026-08-25
> This is the stable entry point for product scope, global principles, and the canonical specification map.
> Detailed normative requirements live in [`spec/`](spec/). Current implementation and latest bounded measurements
> remain separate in [`STATUS.md`](STATUS.md); [`status/README.md`](status/README.md) indexes planning and history.

## 0. How to use this specification

Money Noodle uses a hub-and-spoke specification with progressive disclosure:

1. Read this root document first.
2. Use the specification map below to identify every relevant domain module.
3. Read each relevant module completely before proposing or implementing a change.
4. Read `STATUS.md` for current implementation and measurements, then verify behavior in code.
5. Update the canonical module, acceptance criteria, and decision record together when a requirement changes.

`SPEC.md` owns the product statement, global principles, document authority, and routing map. Each domain module
owns its detailed requirements. Index summaries and compatibility pointers are not substitutes for the linked
module. A requirement has one canonical home; other documents should link to it rather than restate it. If two
canonical documents appear to conflict, stop and resolve the conflict instead of inferring precedence.

Cite named sections or stable requirement identifiers, never source line numbers. **Always name the module beside
a section number.** Numbering is inherited from the former monolithic specification and is not unique across
modules: three modules open at §3, `trading-risk-and-budget` jumps from §3 to §7, and §3.6 and §3.6a are in
different files. A number alone therefore does not identify a document. `npm run verify:agents` rejects an
unqualified citation in the always-loaded guidance.

### Legacy section numbers

Numbers are retained so the 157 preserved decisions in [`spec/decisions/`](spec/decisions/) and the immutable
[`status/archive/`](status/archive/) keep resolving; those files cannot be updated, which is why the numbers
cannot be reassigned. This table is the redirect.

| Section | Owning module |
| --- | --- |
| §2, §3.1–§3.5a | [`spec/product-and-surfaces.md`](spec/product-and-surfaces.md) |
| §3.6 | [`spec/trading-risk-and-budget.md`](spec/trading-risk-and-budget.md) |
| §3.6a, §3.6b, §3.7, §4 | [`spec/forecasting-and-evidence.md`](spec/forecasting-and-evidence.md) |
| §5 | [`spec/providers-and-market-data.md`](spec/providers-and-market-data.md) |
| §6, §8, §9 | [`spec/storage-and-architecture.md`](spec/storage-and-architecture.md) |
| §7 | [`spec/trading-risk-and-budget.md`](spec/trading-risk-and-budget.md) |
| §10, §11 | [`spec/delivery-and-acceptance.md`](spec/delivery-and-acceptance.md) |
| §12, §12.1–§12.10 | [`spec/policy-and-track-separation.md`](spec/policy-and-track-separation.md) |
| §13 | [`spec/open-decisions.md`](spec/open-decisions.md) |
| §14 | [`spec/decision-log.md`](spec/decision-log.md) |

### Specification map

| Concern | Canonical document | Read when |
| --- | --- | --- |
| Product users and surfaces | [`spec/product-and-surfaces.md`](spec/product-and-surfaces.md) | Changing UI, workflow, user-visible semantics, or provider controls |
| Forecasting and evidence | [`spec/forecasting-and-evidence.md`](spec/forecasting-and-evidence.md) | Changing forecasts, factors, qualification, scoring, calibration, outcomes, or model learning |
| Providers and market data | [`spec/providers-and-market-data.md`](spec/providers-and-market-data.md) | Adding or changing venues, feeds, adapters, variants, normalization, or contract comparability |
| Trading, risk, and budget | [`spec/trading-risk-and-budget.md`](spec/trading-risk-and-budget.md) | Touching orders, budgets, funding, paper execution, exits, arming, security, or reconciliation |
| Policy and track separation | [`spec/policy-and-track-separation.md`](spec/policy-and-track-separation.md) | Changing entry policy, paper/live parity, candidate evidence, promotion, or strategy identity |
| Storage and architecture | [`spec/storage-and-architecture.md`](spec/storage-and-architecture.md) | Changing stores, journals, repositories, runtime architecture, cadence metadata, or non-functional behavior |
| Delivery and acceptance | [`spec/delivery-and-acceptance.md`](spec/delivery-and-acceptance.md) | Planning delivery or deciding whether product requirements are accepted |
| Open decisions | [`spec/open-decisions.md`](spec/open-decisions.md) | Investigating or resolving a currently undecided question |
| Decision history | [`spec/decision-log.md`](spec/decision-log.md) | Establishing why a decision exists or recording a new accepted decision |

### Authority outside the specification

This table is canonical for document authority. [`AGENTS.md`](AGENTS.md) restates it in compressed form because it
is always loaded; if the two ever diverge, this table governs.

| Source | Authority |
| --- | --- |
| Code and versioned registries | What the system currently does and which capabilities currently exist |
| [`STATUS.md`](STATUS.md) | Compact dated projection of what is implemented and most recently measured; never live operational authority |
| [`status/roadmap.md`](status/roadmap.md) | Non-normative sequencing and pending work; never implementation authority |
| [`status/archive/`](status/archive/) | Immutable historical status and superseded measurements; read only when history is material |
| [`AGENTS.md`](AGENTS.md) | Compact always-loaded agent workflow and safety constraints; never alternate requirement or runtime authority |
| [`README.md`](README.md) | Human orientation and setup; never requirement, implementation, or operational authority |
| `reports/*.md` | Dated measurements, methods, cohorts, and caveats |
| [`docs/README.md`](docs/README.md) and indexed `docs/*.md` | Proposed, accepted, superseded, retired, reference, and exploratory designs; never an alternate requirement authority |

## 1. Product statement

Money Noodle is a personal, self-hosted crypto research and prediction terminal. It combines live prediction-market prices, crypto market data, historical/seasonal features, news, and optional LLM research into transparent forecasts for short- and long-horizon investing decisions.

The primary decision surface is active crypto **15-minute Up/Down markets** normalized across supported trading providers. Polymarket and Kalshi are implemented; Crypto.com, ForecastEx, and Robinhood are planned as read/paper-first provider integrations. Account monitoring, continuous paper shadow trading, and explicitly armed Kalshi automation are implemented; every additional provider remains live-disabled until its official API, eligibility, contract semantics, signing, funding, order lifecycle, and reconciliation behavior pass the same safety gates.

### Principles

1. **Evidence before output:** every claim and factor identifies its source, timestamp, and availability.
2. **No false precision:** unavailable data stays neutral and visibly unavailable; it is never replaced with invented history.
3. **Model and market remain distinct:** market-implied probability, model probability, and their edge are always separately labeled.
4. **Personal by default, portable later:** the persistent worker keeps cache/storage under the operator’s control, while repository interfaces can later move it to a durable database.
5. **Safe execution:** research is the default. Trading requires explicit credentials, limits, preview, and confirmation.
6. **Fast to act on, easy to audit:** overview cards support scanning; drill-downs expose every input and calculation.

## 2. Users and jobs

Canonical detail: [`spec/product-and-surfaces.md` §2](spec/product-and-surfaces.md#2-users-and-jobs).

## 3. Product surfaces

Canonical detail for §§3.1–3.5a: [`spec/product-and-surfaces.md` §3](spec/product-and-surfaces.md#3-product-surfaces).

### 3.6 Budget and automated-trading control

Canonical detail: [`spec/trading-risk-and-budget.md` §3.6](spec/trading-risk-and-budget.md#36-budget-and-automated-trading-control).

### 3.6a Objective: profit, not forecast accuracy

Canonical detail: [`spec/forecasting-and-evidence.md` §3.6a](spec/forecasting-and-evidence.md#36a-objective-profit-not-forecast-accuracy).

### 3.6b Forecast target and accuracy measurement

Canonical detail: [`spec/forecasting-and-evidence.md` §3.6b](spec/forecasting-and-evidence.md#36b-forecast-target-and-accuracy-measurement).

### 3.7 Positive-edge buy track record

Canonical detail: [`spec/forecasting-and-evidence.md` §3.7](spec/forecasting-and-evidence.md#37-positive-edge-buy-track-record).

## 4. Forecast model

Canonical detail: [`spec/forecasting-and-evidence.md` §4](spec/forecasting-and-evidence.md#4-forecast-model).

## 5. Data sources and integrations

Canonical detail: [`spec/providers-and-market-data.md` §5](spec/providers-and-market-data.md#5-data-sources-and-integrations).

## 6. Storage

Canonical detail: [`spec/storage-and-architecture.md` §6](spec/storage-and-architecture.md#6-storage).

## 7. Security and trading controls

Canonical detail: [`spec/trading-risk-and-budget.md` §7](spec/trading-risk-and-budget.md#7-security-and-trading-controls).

## 8. Technical architecture

Canonical detail: [`spec/storage-and-architecture.md` §8](spec/storage-and-architecture.md#8-technical-architecture).

## 9. Non-functional requirements

Canonical detail: [`spec/storage-and-architecture.md` §9](spec/storage-and-architecture.md#9-non-functional-requirements).

## 10. Delivery plan

Canonical detail: [`spec/delivery-and-acceptance.md` §10](spec/delivery-and-acceptance.md#10-delivery-plan).

## 11. Initial acceptance criteria

Canonical detail: [`spec/delivery-and-acceptance.md` §11](spec/delivery-and-acceptance.md#11-initial-acceptance-criteria).

## 12. Track separation and policy evaluation

Canonical detail: [`spec/policy-and-track-separation.md` §12](spec/policy-and-track-separation.md#12-track-separation-and-policy-evaluation).

### 12.1 Why this exists

See [`spec/policy-and-track-separation.md` §12.1](spec/policy-and-track-separation.md#121-why-this-exists).

### 12.2 The three lanes

See [`spec/policy-and-track-separation.md` §12.2](spec/policy-and-track-separation.md#122-the-three-lanes).

### 12.3 The mirror invariant

See [`spec/policy-and-track-separation.md` §12.3](spec/policy-and-track-separation.md#123-the-mirror-invariant).

### 12.4 The policy as data

See [`spec/policy-and-track-separation.md` §12.4](spec/policy-and-track-separation.md#124-the-policy-as-data).

### 12.5 Candidates and their evidence

See [`spec/policy-and-track-separation.md` §12.5](spec/policy-and-track-separation.md#125-candidates-and-their-evidence).

### 12.6 Storage and modules

See [`spec/policy-and-track-separation.md` §12.6](spec/policy-and-track-separation.md#126-storage-and-modules).

### 12.7 Surfaces

See [`spec/policy-and-track-separation.md` §12.7](spec/policy-and-track-separation.md#127-surfaces).

### 12.8 Delivery order

See [`spec/policy-and-track-separation.md` §12.8](spec/policy-and-track-separation.md#128-delivery-order).

### 12.9 Out of scope

See [`spec/policy-and-track-separation.md` §12.9](spec/policy-and-track-separation.md#129-out-of-scope).

### 12.10 Retired policy identity: long-shot round trip

See [`spec/policy-and-track-separation.md` §12.10](spec/policy-and-track-separation.md#1210-retired-policy-identity-long-shot-round-trip).

## 13. Open decisions

Canonical detail: [`spec/open-decisions.md` §13](spec/open-decisions.md#13-open-decisions).

## 14. Decision log

Canonical history: [`spec/decision-log.md` §14](spec/decision-log.md#14-decision-log).
