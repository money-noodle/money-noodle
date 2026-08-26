# Policy and track separation

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-25  
> **Canonical for:** live/paper/evaluation lanes, the mirror invariant, policy candidates, evidence, promotion, and retired strategy identity.  
> **Read with:** [`trading-risk-and-budget.md`](trading-risk-and-budget.md) for execution/capital differences and [`forecasting-and-evidence.md`](forecasting-and-evidence.md) for model evidence.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

## 12. Track separation and policy evaluation

### 12.1 Why this exists

Three lanes are needed and only two exist. Live runs the active policy with real money. Paper is supposed to run the *same* policy with a simulated version of live's maker execution, so that `paper − live` isolates real queue, venue, reconciliation, and capital effects rather than mixing in a taker fill assumption. The always-fills benchmark belongs in a separate ask-fill shadow. There is no lane for a change the desk is considering but has not adopted.

Before buy policy v17 unified the tracks on 2026-08-17, the missing third lane let speculative changes leak into paper — paper traded XRP that live withheld, and paper ignored the adaptive regime gate that live obeyed — while one-off evaluations were written three separate times and thrown away (`missedBuyCounterfactual`, `buildMakerShadow`, and the regime-gate sentinel loop in `data/regime-gate.json`). The historical failure motivates this section; the current rule layer now enforces the mirror invariant below.

Both failures are the same mistake. Paper's entire value is that exactly one variable differs from live. Add a second and the subtraction stops meaning anything: when the books disagree, nothing distinguishes a policy difference from a fill difference from a cohort live never traded.

### 12.2 The three lanes

| Lane | Policy | Money | Execution | Answers |
|---|---|---|---|---|
| **Live** | active | real | current versioned execution policy: managed maker by default, the established narrow high-edge IOC route, and any explicitly bounded production execution experiment; real fills | What did the desk actually earn? |
| **Paper mirror** | active, *identical* | simulated | independent maker/IOC simulation with the same versioned episode boundary, deterministic experiment assignment, and route decision | Was the decision right under comparable execution, and what did real execution/capital cost? |
| **Evaluation** | candidate, non-production | none | never places an order | Should this change be adopted? |

### 12.3 The mirror invariant

**For any prediction snapshot, the entry decision is identical for live and paper. The tracks may differ only in execution and capital.**

This is structural, not a convention to remember: the rule layer takes no execution-mode parameter, so a divergence cannot be expressed. Concretely, `qualifiesAsBuyEdge`, `hasTradableEdge`, `bestEntry`, `bestEntryForSide`, `bestVenueEntry`, `qualifiesVenueBuyEdge`, `downEntryEnabled` and `assetAdmitted` lose their `mode` argument; the paired environment variables collapse to `MONEY_NOODLE_ALLOW_DOWN_ENTRY` and `MONEY_NOODLE_EXCLUDED_ASSETS`, one rule set for both tracks; and the adaptive regime gate, previously checked only in `runLive`, applies to both.

Portfolio selection was expected to need merging and does not: `runLive` and `runPaper` already call the same `selectPortfolio` with the same `portfolioConstraints()`, differing only in which book's exposures they pass, which is correct because the books are separate. The surrounding differences — maker retry accounting, live stake caps, funding headroom — are execution, and forcing them into one path would push live-only concerns into the mirror.

**What remains per-track, deliberately:**

| Differs | Why |
|---|---|
| Fill model — real venue execution vs simulated execution | Paper originally filled at the ask, then used a static dashboard bid and ask-touch rule. Neither represented live. *(Maker simulation implemented 2026-08-14: independent paper management uses live's shared pricing transitions, exact quote/depth, public aggressor trade prints, displayed queue-ahead depletion, issuance-sized quantity, and concurrent two-second management. Ask touch is telemetry only. Authoritative matched-live fills are retained as a separate overlay rather than replacing the independent simulation.)* *(Extended 2026-08-20 under `paper-managed-execution-route-ioc-v4`: paper now takes the route `evaluateEntryExecutionPolicy` chooses rather than always resting, and the standalone exit simulates its own immediate-or-cancel sweep of displayed depth under `paper-ioc-exit-depth-v1` instead of completing unconditionally. Live's `post_only_race`, venue errors, and reconciliation contradictions remain unmirrorable and are `mirror-fidelity-and-skip-attribution-design.md`.)* *(Extended 2026-08-21 under `paper-managed-execution-route-ioc-requalify3-calibrated-v6`: a versioned, bounded `queueClearFraction` in `[0, 0.5)`, default `0` = exact prior conservative model, held in `data/paper-fill-calibration.json`, adopted only by a recorded manual act to model real cancel/FIFO advance so the paper queue stays conservative but can be calibrated on held-out mirror evidence without ever reading a live fill. A read-only held-out review `npm run analyze:paper-fill-calibration` reports cells/agreement/capture/precision and the live-only upper bound and never promotes. See `docs/paper-fill-calibration-design.md`.)* *(Refined 2026-08-25 by `docs/paper-execution-fidelity-v2-design.md`: keep the ordinary two-second/12-second action clock; separate create acceptance, accepted-order queue, and economic settlement; apply the neutral queue transform at every queue join with exact no-change parity; then require prospective create/acknowledgement, event-time-bounded final-read grace, queue-family, and combined-generation evidence before any manual paper-model adoption. A grace may delay classification but never extend executable time.)* |
| Budget, stake sizing, bankroll | Paper is not capital-constrained; matching it would hide policy outcomes behind sizing noise. |
| Hourly filled-order limit, live risk stops, reconciliation gate | Venue and capital protections, not predictions. |
| Position and correlation caps | Same constants, counted separately, because the books are separate. |

The consequence is intended: `paper − live` is the desk's total execution and capital cost. To make that decomposable rather than inferred, every live skip is recorded durably per settlement window with its reason **and a typed class named by the gate itself**, beside the single `lastLiveSkip` slot the dashboard still renders. *(Implemented 2026-08-20, `live-skip-v1`.)* Records are episodes rather than per-cycle rows, operator intent separates a system `stop` from an `operator` pause, and `none` — nothing qualified — is excluded from the withheld classes so it cannot inflate a drag figure. The comparison then attributes each missing live trade to fill drag, limit drag, or stop drag.

### 12.4 The policy as data

Candidates cannot be expressed while the rules are module constants. The buy policy becomes a value:

```ts
export interface BuyPolicy {
  version: string;
  minNetEdge: number; maxNetEdge: number; minEstimateQuality: number;
  minSelectedSideProbability: number; minEntryPrice: number; maxEntryPrice: number;
  downEnabled: boolean; excludedAssets: string[];
  requiredSnapshots: number; observationSpanMs: number; warmupMs: number; lateCutoffMs: number;
}
export const PRODUCTION_BUY_POLICY: BuyPolicy = { /* the current constants */ };
```

Rule functions take a `BuyPolicy`, defaulting to production. The exported constants remain as the fields of that object so existing readers and the published manifest keep working. This is what turns an ad-hoc analysis script into production code: the same evaluator scores production and every candidate, so a candidate's number can never come from a different implementation than the one that trades.

### 12.5 Candidates and their evidence

A **candidate** is an immutable, named parameter set with a status. It never places an order, never touches a budget, and cannot affect either trading lane.

| Status | Meaning |
|---|---|
| `screening` | Retroactive scoring only. Cheap, instant, recomputable, and never sufficient for promotion. |
| `collecting` | Committed sentinels are accumulating forward evidence. |
| `promotable` | Sentinel evidence meets the stated criteria; promotion remains a manual act. |
| `production` | The active policy. Exactly one at a time. |
| `retired` | Superseded or refuted; the record and its evidence are retained. |

**Two kinds of evidence, and the distinction is load-bearing:**

*Retroactive screening* replays a candidate's rules over recorded snapshots. The forecast journal already carries what this needs — every 15-second snapshot with both sides' actionable asks, and settlement outcomes patched in on resolution. It answers "what would a 4pp floor have done?" over all history in seconds, which is how a dozen ideas get filtered down to one. It is re-derived by code each time it runs, so it is labelled as such and can never, by itself, promote anything.

*Committed sentinels* are written at decision time: when a candidate qualifies a window the production policy does not, or refuses one it takes, an immutable record captures the contract, side, ask, fee, predicted edge and timestamp, and is followed to settlement. This is the existing regime-gate sentinel pattern generalized from one implicit candidate to many. It cannot be re-derived favourably later, and it accrues only from the moment it starts.

**Promotion requires committed sentinel evidence**, a minimum number of independent settlement windows, a clustered return clearing a stated threshold, and a written reason — mirroring the model promotion ledger already in `lib/model-promotion.ts`. Nothing reaches production on a number that was only ever computed after the fact. That failure mode is not hypothetical: the DOWN suspension of 2026-08-13 was adopted on retroactive figures that later failed to reproduce, and was withdrawn a day later.

**First committed candidate implemented 2026-08-14.** `persistence-two-consecutive-v1` changes only entry maturity: two consecutive qualifying observations spanning 15 seconds against production's three spanning 30. Every current probability, edge, quality, price, asset, side, warm-up, late cutoff, Kalshi-specific quote/spread, classified-path, and adaptive-regime rule remains fixed. It records every signal-level candidate intent, whether production was already eligible, when production later catches up, exact ask/bid/fees, a prospectively captured empirical fill-weighted maker benchmark, and exact Kalshi settlement. **Observed fills added 2026-08-18.** The fill-weighted benchmark multiplies an unconditional settlement return by a modelled fill probability, which prices the fill as a random draw the desk's own adverse-selection measurements refute, and which — being a positive scaling — can never disagree with the ask benchmark beside it. Each intent now also carries a simulated resting post scored against observed trade prints: one order-book snapshot at post time because depth is not historical, the reprice ladder reconstructed from the 2-second contract path, and one print fetch after the 12-second managed-maker horizon. A post fills only when volume traded at or through its price exceeds the size displayed ahead of it, never on a touch. The review figure is the return **conditional on an observed fill**. The modelled benchmark is retained unchanged because the store is committed evidence, and is no longer reported as the maker benchmark. Observation sources are never pooled. See docs/maker-post-observation-design.md. Capital, current positions, and reconciliation are deliberately excluded because they are operational state rather than evidence about persistence. Evidence is scoped to the active production buy-policy version and resets on a production policy change. The first review remains manual and locked until 100 resolved **incremental** settlement windows; reaching that count is not promotion eligibility. **Retired 2026-08-19:** v21 adopted the candidate's two-snapshot/15-second rule, and all 80 active-policy intents in the final store were already production-eligible, leaving zero incremental intents. Runtime collection and its detached maker observer are removed; historical intents, observations, resolution, and reporting remain read-only. The invalid 60-second depth instrument and its backfill fail closed and have no package commands. A future candidate requires a new versioned prospective design.

**Calendar-effects collection implemented 2026-08-14.** `calendar-effects-v1` fixes the selection-bias and retention problems in the original time-of-day replay. For every exact Kalshi asset/window it commits the first collector update at or below five minutes remaining within a 30-second tolerance, regardless of qualification, with probability, confidence, both side books/fees, selected side/edge, compact factor values, cycle regime, model version, buy-policy version, and exact outcome. It separately records one first actionable highest-edge current-policy candidate per correlated settlement window, or finalizes an explicit no-candidate marker. Candidate outcomes report bounded fee-aware ask return and a decision-time empirical fill-weighted maker benchmark. Superseded policy cohorts remain durable but are never blended. Six four-hour `America/Los_Angeles` bands are predeclared to preserve the existing review definition; UTC timestamps remain authoritative and local labels are derived. Time review is locked until every band has 30 dates and 100 resolved candidate windows. Individual-weekday review additionally requires 12 occurrences and 100 candidate windows per weekday. Those counts only open manual held-out review and cannot change production.

### 12.6 Storage and modules

| Path | Role |
|---|---|
| `lib/buy-policy.ts` | `BuyPolicy` type, `PRODUCTION_BUY_POLICY`, pure rule evaluation |
| `lib/policy-candidate.ts` | Candidate definition, retroactive scoring, promotion criteria (pure) |
| `lib/policy-candidate-store.ts` | Server-only durable candidate and sentinel records |
| `data/policy-candidates.json` | Candidate definitions and statuses; append-only history |
| `data/policy-sentinels.json` | Immutable per-window sentinel records keyed by candidate |
| `lib/live-skip.ts` | `LiveSkipClass`, episode folding, per-class attribution and the window join (pure) |
| `lib/live-skip-store.ts` | Server-only durable skip journal and compactor; no execution authority |
| `data/live-skips.json` / `.journal.jsonl` | Worker-local live skip episodes; journal compacts at 50 MB |
| `lib/ioc-fill-model.ts` | Immediate-or-cancel fills against displayed depth, shared by the simulated exit and taker entry (pure) |
| `lib/persistence-candidate-store.ts` | Implemented narrow first candidate, durable scoring, exact settlement, and read-only report |
| `data/persistence-candidate.json` | Worker-local prospective intents for the two-snapshot candidate; no execution authority |
| `lib/calendar-evaluation-store.ts` | Append-journaled, non-pruned fixed-snapshot/calendar collection and pure policy-scoped report |
| `data/calendar-evaluation.json` / `.journal.jsonl` | Worker-local calendar evidence; no execution authority; journal compacts at 50 MB |

The regime gate is a special case of this mechanism — one implicit candidate, the production policy, scored forward on its own sentinels. Unifying them is a follow-up, not a prerequisite; the gate works and retrofitting it earns nothing immediately.

### 12.7 Surfaces

The Policy dialog gains a candidates section beside the production policy: each candidate's status, its parameter delta against production, its screening evidence marked as re-derived, its committed evidence, and its promotion eligibility.

The signed Performance dialog includes a read-only Calendar tab with current-policy four-hour and weekday cohorts, date/window counts, forecast Brier, no-candidate coverage, fee-aware candidate return, and explicit review locks. It is omitted from the public/stateless payload with the other worker-local evaluation evidence.

A side-by-side comparison surface reports the mirror against live per settlement window — the decision each lane made, the outcome, and the aggregate drag decomposed into fill, limit and stop. This is the surface that answers "predicted versus actual" directly, which the current dialogs only approximate.

### 12.8 Delivery order

1. **Unify the rules.** *(Done, buy policy v17.)* Removed the mode parameter from the rule layer, collapsed the per-track environment variables to `MONEY_NOODLE_ALLOW_DOWN_ENTRY` and `MONEY_NOODLE_EXCLUDED_ASSETS`, applied the regime gate to both tracks, and added `lib/mirror-invariant.test.ts`, which asserts the absence of a mode parameter by arity so the divergence cannot return unnoticed.
2. **Record live skips durably** per window. *(Done 2026-08-20, `live-skip-v1`: typed per-gate classes, episode folding, and `windowsWithheldBy` as the join to the paper book.)* The side-by-side comparison surface remains.
3. **Introduce `BuyPolicy`** as a value, with production as its first instance.
4. **Candidate store and retroactive screening**, ultimately published in the Policy dialog. *(Partially implemented: the first persistence candidate is collecting and appears in the signed Performance view; generalized `BuyPolicy` candidates and the Policy surface remain.)*
5. **Committed sentinels and promotion criteria**, reusing the model-promotion shape. *(First committed sentinel implemented with a sample-count review lock and no promotion path; generalized comparative criteria remain.)*

Step 1 had an immediate, intended consequence: **paper stopped trading XRP and began obeying the regime gate.** XRP execution evidence therefore paused until a non-production candidate lane can restore it. That was accepted rather than worked around because the then-current executed evidence cleared −2se on both tracks independently (live −45.7% ±21.5 over 41 windows, paper −35.1% ±13.0 over 81), and a trustworthy mirror was worth more than additional rows from the same policy mixture.

**XRP review updated 2026-08-20.** The historical result reproduced exactly, but its fills end under legacy through v13/v14 and do not measure v21/v5. A current-v21, first-to-fire, ask-priced reconstruction was +1.0% ±12.5 over 59 XRP decisions/windows, with XRP −12.1pp ±12.8 against the same-window non-XRP mean over 58 paired windows. The prospective portfolio journal had only three unique resolved XRP candidates; one completed persistence, lost, and was independently portfolio-blocked, so asset admission alone would have changed zero recorded selections. This less-than-one-day replay contains no current-policy XRP execution and establishes neither harm nor value. The exclusion remains production policy; removing it would be a manual, versioned bounded experiment rather than an evidence promotion. See `reports/xrp-exclusion-review-2026-08-20.md`.

### 12.9 Out of scope

This design does not change any live entry rule, does not let a candidate place an order or hold a budget, does not alter sizing or the fill model, and does not bump the buy policy version when a candidate changes. Only promotion changes the production policy version, and only through the recorded, manual act described in §12.5.

### 12.10 Retired policy identity: long-shot round trip

The long-shot round trip ran prospectively as a paper-only second policy on `crypto-15m`; its live lane was
never armed. It bought a side whose executable Kalshi ask fell to a low mark early in the cycle and attempted
a target exit before settlement without consuming `P(UP)`. Its complete historical design and parameter
record remain in [`docs/long-shot-policy-design.md`](../docs/long-shot-policy-design.md).

**Retired 2026-08-26.** The frozen 12¢→97¢/600s v2 cohort completed 150 resolved attempts across 76 independent
settlement windows. Exact paper P&L was −1,410.93¢ on 4,979¢ staked. The prospective hold arm measured
−14.71% ±27.56pp clustered SE; the paired target-exit-minus-hold comparison was −2.47pp ±0.85pp and −98.93¢,
with all 11 target-exited positions subsequently settling in the owned side. The broad hold interval does not
refute every cheap-contract hypothesis, but neither this cohort nor the earlier wide screens supplied positive
evidence worth a separate runtime lane. See
[`reports/long-shot-v2-final-review-2026-08-26.md`](../reports/long-shot-v2-final-review-2026-08-26.md).

Execution, high-frequency polling, evidence writes, Postgres projection, dashboard/API, strategy-specific
estimators, and strategy-level budget splitting are removed. Provider → market remains the active allocation
chain. No former strategy share is transferred into a higher edge-policy ceiling, and no edge forecast,
entry, execution, exit, sizing, or capital rule changes.

`long-shot-round-trip` remains a recognized **retired historical `strategyId`**. Existing ledger rows,
compaction groups, P&L, corrections, and reconciliation history must retain that identity and must never be
normalized into `edge-binary-buy`. Worker-local evidence and the applied database migration remain historical
records; retirement grants no authority to delete or rewrite them.
