# Policy and track separation

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-26
> **Canonical for:** live/paper/evaluation lanes, the mirror invariant, policy candidates, evidence, promotion, and
> retired strategy identity.
> **Read with:** [`trading-risk-and-budget.md`](trading-risk-and-budget.md) for execution/capital differences and
> [`forecasting-and-evidence.md`](forecasting-and-evidence.md) for model evidence.
>
> This module states durable lane and promotion requirements. Dated candidate progress and measured results belong
> in `STATUS.md`, reports, designs, and identified decisions rather than this canonical rule set.

## 12. Track separation and policy evaluation

<a id="req-policy-lane-purpose"></a>

### 12.1 Why this exists

Live, paper mirror, and candidate evaluation answer different questions. Paper is useful only when it applies the
same decision policy as live and changes execution/capital. A speculative rule in paper destroys that comparison,
while an always-fills benchmark is a separate evaluation rather than a paper order.

The historical pre-v17 divergence and its correction remain in the decision archives and
[`docs/mirror-fidelity-and-skip-attribution-design.md`](../docs/mirror-fidelity-and-skip-attribution-design.md).
They explain the rule but do not add a fourth authority lane.

<a id="req-policy-three-lanes"></a>

### 12.2 The three lanes

| Lane | Policy | Money | Execution | Answers |
|---|---|---|---|---|
| **Live** | active production policy | real | current promoted execution policy; authoritative venue fills | What did the desk earn? |
| **Paper mirror** | active production policy, identical entry decision | simulated | independent simulation of the same route/episode decision | What did comparable simulated execution earn, and what did real execution/capital cost? |
| **Evaluation** | immutable candidate | none | observation/scoring only; never an order | Should a separately reviewed change be considered? |

An ask-fill or other always-fills benchmark belongs to evaluation. It cannot replace the paper mirror or be reported
as though it used deployable execution.

<a id="req-policy-mirror-invariant"></a>

### 12.3 The mirror invariant

**For any prediction snapshot, the entry decision is identical for live and paper. Tracks may differ only in
execution and capital.**

The rule layer takes no execution-mode parameter. In particular, `qualifiesAsBuyEdge`, `hasTradableEdge`,
`bestEntry`, `bestEntryForSide`, `bestVenueEntry`, `qualifiesVenueBuyEdge`, `downEntryEnabled`, and `assetAdmitted`
cannot branch on paper/live mode. Environment configuration for entry direction and admitted assets is shared.
Any adaptive regime gate that is part of production entry policy applies to both tracks.

Track differences are limited to:

- authoritative venue fills versus independent simulated fills;
- budget, bankroll, stake sizing, and funding feasibility;
- live rate/loss stops and reconciliation readiness; and
- separately counted position/correlation capacity because the books hold different positions.

Portfolio constraints and selection logic remain shared. Separate books may produce different selected sets because
their actual exposures and available capital differ; that is a capital state difference, not permission for a
different entry rule.

Paper-minus-live is total execution and capital drag only if every missing live decision is attributable. Live skips
therefore use durable episodes keyed to the settlement window and a typed class named by the actual blocking gate.
`none`—nothing qualified—is not a withheld-live class. Fill, limit, and stop drag remain separately reportable.

The independent paper fill contract, exact pair identity, and known non-mirrorable venue states are specified by the
accepted mirror and paper-fidelity designs indexed in [`docs/README.md`](../docs/README.md). No calibration may read
a live fill from the row it is simulating.

<a id="req-policy-as-data"></a>

### 12.4 The policy as data

A production buy policy and every candidate are immutable named values evaluated by the same pure rule code. The
minimum contract is:

```ts
export interface BuyPolicy {
  version: string;
  minNetEdge: number;
  maxNetEdge: number;
  minEstimateQuality: number;
  minSelectedSideProbability: number;
  minEntryPrice: number;
  maxEntryPrice: number;
  downEnabled: boolean;
  excludedAssets: string[];
  requiredSnapshots: number;
  observationSpanMs: number;
  warmupMs: number;
  lateCutoffMs: number;
}
```

Production constants may project fields of the production value for existing readers. Candidate scoring must call
the same evaluator; duplicated ad hoc rule implementations cannot supply promotion evidence.

<a id="req-policy-candidate-evidence"></a>

### 12.5 Candidates and their evidence

A candidate is immutable, named, versioned, non-funded, and unable to affect either trading lane.

| Status | Meaning |
|---|---|
| `screening` | Retroactive scoring only; never promotion evidence by itself |
| `collecting` | Committed prospective sentinels are accumulating |
| `promotable` | Precommitted evidence gates pass; promotion remains manual |
| `production` | The one active policy |
| `retired` | Superseded or refuted; identity and evidence remain durable |

**Retroactive screening** replays the shared evaluator over immutable recorded snapshots. It must score the complete
eligible population, identify reconstruction/unavailable rows, preserve production as the comparator, and report
multiple-comparison cost. It filters ideas but cannot promote one.

**Committed sentinels** are written at decision time and followed to exact settlement. They capture the candidate,
production comparison, contract/side, actionable cost and fee, probability/quality, timestamp, policy/model identity,
and every input needed to explain the divergence. Tightening candidates must record production trades they refuse;
loosening candidates must record incremental trades they admit.

Promotion requires all of the following:

1. predeclared criteria and a frozen candidate generation;
2. a minimum number of independent settlement windows;
3. exact-provider outcomes and deployable cost treatment appropriate to the claim;
4. clustered return clearing the recorded margin against production, with multiplicity addressed;
5. a written reason and linked evidence; and
6. an explicit authenticated manual promotion that creates a new production policy version and immutable ledger row.

Counts only unlock review. No candidate, evaluator, report, LLM, or walk-forward process can promote automatically,
place an order, reserve money, mutate a budget, or alter reconciliation.

<a id="req-policy-storage-modules"></a>

### 12.6 Storage and modules

Policy definitions and scoring are pure. Candidate/sentinel stores are server-only, append-only in normal operation,
and have no execution imports or authority. Production policy identity comes from `lib/policy-manifest.ts`; current
implementation paths come from code rather than this specification.

Every durable candidate row retains candidate version, production comparator version, forecast/model identity,
provider/variant/market/contract provenance, side, issue/close times, inputs, availability, and eventual exact
outcome. Historical rows are never relabeled into a newer policy generation.

<a id="req-policy-surfaces"></a>

### 12.7 Surfaces

The signed Policy surface distinguishes production from screening, collecting, promotable, and retired candidates.
It shows parameter deltas, evidence type, sample/independent-window counts, correction, caveats, and manual review
state. Retroactive results are labeled re-derived; committed results are labeled prospective.

The signed Performance surface may compare live and paper by settlement window and decompose fill, limit, and stop
drag. Public/stateless payloads omit worker-local candidate and funded-control evidence unless a separately bounded,
sanitary paper projection explicitly includes it.

No read surface can promote, roll back, arm, resume, configure capital, reconcile, or trade.

<a id="req-policy-delivery-order"></a>

### 12.8 Delivery order

Lane work follows this dependency order:

1. preserve the mode-free shared entry evaluator and mirror invariant tests;
2. preserve durable typed live-skip attribution;
3. represent production and candidates through the shared policy value;
4. score retroactive screening through that evaluator;
5. collect committed prospective sentinels; and
6. add authenticated manual promotion only after criteria and immutable audit are defined.

`STATUS.md` states which steps are implemented. `status/roadmap.md` may order pending work but cannot skip a
prerequisite or authorize behavior.

<a id="req-policy-out-of-scope"></a>

### 12.9 Out of scope

Candidate definition or observation does not change live entry, paper entry, fill simulation, sizing, budget,
portfolio limits, reconciliation, exits, or production policy version. Only a separately accepted and recorded
manual promotion changes production.

<a id="req-policy-retired-long-shot"></a>

### 12.10 Retired policy identity: long-shot round trip

`long-shot-round-trip` is retired and has no execution, collection, allocation, API, UI, estimator, or projection
authority. Its prospective paper evidence and retirement result are preserved in
[`docs/long-shot-policy-design.md`](../docs/long-shot-policy-design.md) and
[`reports/long-shot-v2-final-review-2026-08-26.md`](../reports/long-shot-v2-final-review-2026-08-26.md).

It remains a recognized historical `strategyId`. Existing ledger rows, compaction groups, P&L, corrections, and
reconciliation history retain that identity and must never be normalized into `edge-binary-buy`, deleted, or
rewritten. Retirement transfers no strategy share into another policy and changes no edge forecast, entry,
execution, exit, sizing, capital, or reconciliation rule.
