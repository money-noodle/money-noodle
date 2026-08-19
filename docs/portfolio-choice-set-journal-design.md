# Prospective portfolio choice-set journal

> Approved 2026-08-19 after the corrected historical replay withdrew the apparent contract-selection
> leak. This is an observation-only evaluation lane under SPEC §12. It changes no forecast, entry gate,
> persistence rule, regime rule, retry, sizing, portfolio constraint, execution style, budget, order, or
> exit behavior. Collection begins only when the built runtime initializes the v1 store; no historical
> choice set is backfilled.

## 1. Decision and question

The old `analyze:contract-selection` comparison was not a decision-time choice set. Forecast history can
reconstruct much of the state, but it does not retain failed dashboard observations, effective runtime
caps, or the overwritten `portfolioDecisions` map. The corrected v17-v19 replay reproduces production's
choice in 331 of 339 positive-control snapshots and leaves chosen minus replay-preferred at −0.9pp ±2.7pp
(95%) over 232 independent settlement windows. That withdraws the ranking-defect claim; it does not explain
why the ordered cohort differs from all admitted rows.

The next question is narrower and prospective:

> When production durably issues a positive-edge live order, did it issue the highest production-ranked
> candidate from the exact state it had, and what did any differing choice earn relative to that candidate?

No alternative ranking formula is being screened. V1 records production's own ranking and execution drain.
A later ranking candidate requires a separate named design and a new prospective cohort.

## 2. Prospective boundary and unit

V1 writes one immutable record per **durably issued live positive-edge order**. The id is derived from the
order id. The order ledger is made durable first; the detached journal write follows and is never awaited by
execution. A store failure cannot delay or refuse an order.

This boundary deliberately excludes cycles that issue no order. V1 answers selection conditional on an
issued intent, matching the historical claim being corrected. It does not estimate the admitted-to-ordered
conversion gap by itself. Recording every 15-second no-order cycle would be a different, much larger skip
journal and must be designed separately.

Multiple orders issued from one dashboard calculation get separate records. Each carries its drain sequence,
the pre-issuance account-wide exposures, and earlier issue/skip actions from that drain. Settlement windows,
not records or assets, are the independent unit in reporting.

## 3. Immutable record

Store version: `portfolio-choice-set-v1`.

### 3.1 Cohort and selected intent

- record id, UTC `recordedAt`, dashboard `calculationAt`, and drain sequence;
- `strategyId=edge-binary-buy`, `executionMode=live`, market/provider/variant;
- forecast-model, buy-policy, and entry-execution-policy versions;
- issued order id/logical id, symbol, contract, side, close, and exact entry-decision snapshot;
- issued quantity, all-in whole-cent stake, fee, payout, expected profit, and authorization ceiling.

### 3.2 Effective state

- exact `PortfolioConstraints` value used by `selectPortfolio`, including effective environment overrides;
- account-wide active live exposures, with strategy id and order id retained so shared-cap effects remain
  visible rather than being narrowed to this strategy;
- proposed stake, live stake cap, provider-allocation spendable cents, and effective issuance stake ceiling;
- adaptive regime-gate state, effective classified-regime requirement, and live operational readiness;
- earlier drain actions before this issuance, including the exact reason for any skipped ranked candidate.

### 3.3 Candidate set

Every standalone-qualified candidate represented in the cycle's production `portfolioDecisions` is stamped,
including candidates refused before `selectPortfolio` and candidates it did not select:

- stable candidate id, symbol, exact Kalshi contract, side, and close;
- selected-side probability, confidence, bid, ask, fee rate, spread, and net edge;
- the exact side-specific persistence observations available to production;
- eligibility/retry/cooldown state and their production reasons;
- asset admission, classified path label/admission, and whether it reached the live drain;
- production-sized quantity, stake, fee, payout, expected profit, adjusted expected contribution, rank,
  portfolio state, and reason when those values exist;
- whether production initially selected it and whether it was the order issued by this record.

Missing is missing. A candidate refused before sizing has no zero-valued size. Legacy meanings are never
filled in later.

### 3.4 Resolution

The store resolves each candidate against its exact Kalshi contract after close. Resolution events may add
only `outcome` and `resolvedAt`; they cannot rewrite decision-time fields. Unsupported, missing, or
contradictory venue resolution remains unresolved or is marked invalid, never substituted from another
venue.

## 4. Storage and safety boundary

Files:

- `data/portfolio-choice-sets.json`
- `data/portfolio-choice-sets.journal.jsonl`

`lib/portfolio-choice-set-store.ts` is the only writer and imports `server-only`. Normal writes append.
At 50 MB, that owner may atomically compact to the snapshot and truncate its journal. Malformed snapshots or
journals are moved to `*.corrupt-*`; history is never hand-edited. V1 is worker-local and omitted from the
stateless/public projection.

The pure record/replay/report module has no order, budget, reconciliation, or store dependency. Shared
orchestration may import the store only to launch detached writes after authoritative order persistence and
to launch detached resolution maintenance. Policy, persistence, sizing, portfolio, live-order, budget, and
reconciliation modules may not import the store or any report result.

## 5. Pre-registered evaluation

One formulation is fixed for v1:

1. On every resolved record, identify the highest-ranked candidate that production marked selected and live
   execution marked drain-eligible at that issuance state.
2. Compare the issued candidate with that production-preferred candidate at the same prospectively stamped
   ask and fee, held to exact Kalshi settlement.
3. Average repeated records and assets inside each `closesAt`, then estimate the paired mean difference and
   95% clustered interval across settlement windows.
4. Report all records first. Report differing-choice records separately, but never use that survivor-only
   cohort as the primary estimate.

Integrity precedes economics: join the authoritative order ledger after the store boundary and report any
live positive-edge order missing its choice-set record, then report the share where issued equals
production-preferred, missing candidate terms, unresolved contracts, duplicate ids, and any issued candidate
absent from its own choice set. A failed integrity check blocks an effect estimate.

First diagnostic review requires 30 resolved independent windows. Any claim about a differing choice requires
both **60 resolved independent windows overall and 20 independent windows with a differing choice**. With one
pre-registered comparison there is no within-generation multiple-comparison adjustment. Adding another rank
formula starts a new version/family and must state its correction before collection.

The deciding quantity is issued minus production-preferred clustered return. A zero or uncertain difference
is a result. No threshold can auto-promote, auto-change ranking, or alter a portfolio constraint. Any policy
change remains manual and requires a new policy-manifest version, committed evidence, and a written reason.

## 6. Required tests

- first decision event is immutable; duplicates cannot alter it;
- resolution patches only settlement fields and only once;
- duplicate journal events are idempotent and compaction is owner-only;
- corrupt storage is quarantined and no historical record is backfilled;
- candidate missing values remain missing rather than becoming zero;
- account-wide exposures retain every strategy while reports narrow the evaluated strategy explicitly;
- settlement-window clustering averages repeated records before uncertainty;
- the issued order is present in its own choice set on a positive fixture;
- dependency tests fail if a money-moving module imports the store or result;
- `mirror-invariant`, `strategy-isolation`, and other invariant suites remain unchanged.

## 7. Implementation map

| Path | Role |
| --- | --- |
| `lib/portfolio-choice-set.ts` | immutable schema, event replay, integrity and clustered report (pure) |
| `lib/portfolio-choice-set-store.ts` | prospective boundary, append journal, exact Kalshi resolution, compaction |
| `lib/paper-execution.ts` | build the already-computed state snapshot and launch detached writes after durable live intent |
| `scripts/analyze-portfolio-choice-sets.mjs` | read-only prospective diagnostic |
| `data/portfolio-choice-sets*` | worker-local evidence; never committed or hand-edited |

## 8. Explicitly unchanged

- No buy-policy or policy-manifest version bump: observation is not policy.
- No new candidate policy and no ranking change.
- No change to paper/live mirror decisions, caps, sizing, retry, maker/taker selection, or exits.
- No historical order, forecast, `portfolioDecisions`, or sentinel is backfilled.
- No LLM, API route, dashboard probability, or public/stateless path reads this evidence.
