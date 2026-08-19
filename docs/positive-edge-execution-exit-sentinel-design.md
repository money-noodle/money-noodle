# Positive-edge maker restriction and exit-policy sentinels

> Design approved and implemented in the working tree, 2026-08-19, following
> [`reports/maker-adverse-selection-and-exit-depth-2026-08-19.md`](../reports/maker-adverse-selection-and-exit-depth-2026-08-19.md).
> The maintainer chose to keep live trading running. This changes no entry, execution, sizing, or exit
> behavior. Collection starts prospectively when the built runtime first initializes each store; no existing
> order or lifecycle path is backfilled.

## 1. Decision and boundary

The current evidence authorizes prospective measurement and a reporting correction, not a trading-policy
change:

- maker fills are outcome-selected, but no issuance-time feature identifies a robust profitable remainder;
- active adaptive execution has too little actual taker evidence to replace maker;
- current strict-value exits sold winners, but threshold replays disagree across current/lifetime and
  live/paper cohorts.

Live and paper therefore continue unchanged. The new code, if approved, is an **evaluation lane** under
SPEC §12. It may append evidence and resolve outcomes. It may not place, amend, cancel, size, reserve, gate,
or prioritize an order. No result may automatically change production.

Maker and exit evidence remain separate. A maker restriction answers whether declining a production maker
attempt improves the book. An exit candidate answers whether a different first-to-fire sale rule improves
an already filled position. Combining them would make it impossible to identify which mechanism moved.

## 2. Maker question: test restrictions, not hypothetical fills

A counterfactual taker fill is not observable. An executable ask can price an optimistic taker benchmark,
but cannot prove that a signed IOC would have filled. The current adaptive policy must accumulate actual,
separately stamped taker attempts and fills; the sentinel must not relabel ask settlement as live taker
execution.

A restrictive maker candidate is observable exactly. On every production attempt whose stamped
`executedStyle` is `maker`:

- production earns authoritative maker P&L when filled and zero when no money is spent;
- a candidate that admits the attempt earns the same result;
- a candidate that refuses it earns zero.

This scores every attempted position, including no-fills, and therefore preserves the fill/outcome joint
distribution that the adverse-selection finding depends on. It tests the marginal decision to decline that
maker attempt: it assigns no replacement trade, freed slot, or later budget reuse. Reallocation is a
separate portfolio candidate and cannot be credited to an execution restriction for free.

### 2.1 Fixed maker candidates

The first generation contains two candidates, selected before prospective evidence starts:

| candidate | single difference from production | reason for including it |
| --- | --- | --- |
| `maker-spread-max2c-v1` | refuse a maker attempt when issuance spread is above 2¢ | 2¢ is already the active strict-taker spread ceiling; it is not selected from a new optimum search |
| `maker-spike-max2pp-v1` | refuse when firing edge minus persistence median is at least 2pp | this is the existing, currently disarmed edge-spike threshold, retained rather than re-fit |

They are scored independently, not combined into a third screened candidate. Unknown/non-finite input
refuses in the candidate arm but cannot affect production. The pure candidate evaluator takes no execution
mode; the same classification is stamped on matched live and paper intents, preserving SPEC §12.3.

The comparison population is all issued positive-edge strategy maker attempts stamped by the active
execution policy after the sentinel start time, including pre-acceptance post-only races and accepted
no-fills. Portfolio and budget refusals remain production facts and are reported separately; a candidate is
not credited for an intent production never attempted.

### 2.2 Maker record

One immutable decision-time record per `(strategyId, symbol, side, closesAt, logicalSequence)`:

| field | meaning |
| --- | --- |
| `version` | `maker-restriction-sentinel-v1` |
| `recordedAt`, `calculationAt` | UTC timestamps; never local keys |
| `strategyId`, `symbol`, `side`, `closesAt` | intent identity and settlement cluster |
| `buyPolicyVersion`, `executionPolicyVersion` | cohort boundaries |
| `issuanceAsk`, `issuanceBid`, `spread` | exact decision quote |
| `netEdge`, `medianNetEdge`, `edgeSpike` | recomputable signal terms |
| `cycleRegime` | numeric issuance regime when available; missing v1 rows remain missing |
| `candidates` | fixed candidate id and `admit`/`refuse`; written before outcome or fill |
| `orderId` | link to authoritative production execution, when an order row is issued |
| `outcome`, `resolvedAt` | appended settlement resolution |

Fill, stake, fees, and P&L are read from the authoritative order ledger rather than copied into a second
money ledger. A missing or contradictory order link is reported as unscorable, never inferred.

Actual taker reporting remains alongside this sentinel, grouped by execution-policy version with submission,
acceptance, IOC fill, outcome, and clustered return. It is observational evidence about the current adaptive
policy, not an arm in the maker-restriction comparison.

## 3. Exit question: compare complete first-to-fire paths

Every candidate runs on every filled positive-edge position from its first valid lifecycle observation.
Candidate scoring never starts from only positions production held; that would manufacture value for early
sales. Within a candidate, the first trigger wins and later triggers are ignored.

### 3.1 Fixed exit candidates

| candidate | rule |
| --- | --- |
| `strict-value-margin3c-v1` | production optimistic-hold calculation with a 3¢ minimum cash advantage |
| `strict-value-margin5c-v1` | same, with a 5¢ minimum cash advantage |
| `strict-value-confirm2-v1` | current 1¢ condition must hold on two consecutive valid observations at least 2 seconds apart; any intervening valid failure resets confirmation |
| `trailing-50-35-v1` | arm at +50% net executable profit on exact cost, then sell after net liquidation gives back at least 35% of its recorded peak |

The two margins bracket the smallest current alternatives without selecting the retrospective 10¢ peak.
The confirmation arm tests transient model under-valuation. The trailing arm is the center of the previously
screened trailing grid, not its best retrospective cell. These explanations and identifiers are frozen
before collection starts; adding another arm starts a new version and a new multiple-comparison family.

All arithmetic uses exact float cents in observations. A candidate paper sale quantizes only at the existing
paper budget boundary. Live counterfactual liquidation remains explicitly **optimistic** because an observed
bid does not prove a reduce-only IOC fill.

### 3.2 Continue observation after production exits

A production exit currently ends the position path. That makes any candidate which would wait longer
unobservable and biases comparisons toward holding at settlement. The exit sentinel therefore requires a
detached, public-data-only shadow lifecycle after production sells:

- the production exit record is committed first and is never delayed;
- the detached observer follows the exact contract through settlement at the existing lifecycle cadence;
- it records executable bid, ask, taker fee, net liquidation, model probability, confidence, and seconds
  remaining under a separate sentinel id;
- it uses no signed endpoint, cannot call an order function, and cannot mutate the settled production order;
- request failure records an observation gap; stale data never triggers a candidate;
- stateless hosts never run it.

Without this continuation, margin and confirmation candidates are screening-only and cannot become
promotable. The implementation must fail closed by reporting incomplete coverage rather than substituting
hold or carrying forward a stale bid.

### 3.3 Exit record

One append-only stream per filled position:

| record | required content |
| --- | --- |
| `position` | sentinel version, order id, strategy id, track, quantity, exact cost, side, contract, close, policy versions |
| `observation` | UTC time, fresh executable bid/ask, fee, net liquidation, owned-side probability, confidence, candidate state and first-trigger result |
| `production-exit` | actual policy, attempted time, accepted/fill status, exact proceeds; copied by reference to authoritative order evidence |
| `resolution` | authoritative outcome, hold P&L, candidate first-trigger P&L, coverage status |

Candidate states are deterministic reducers over ordered observations. Duplicate timestamps are idempotent.
Late records after resolution are rejected. A venue/outcome contradiction marks the position unscorable and
requests ordinary reconciliation; an evaluation store never repairs production evidence.

## 4. Storage and execution boundary

Implemented stores:

- `data/maker-restriction-sentinels.json` + `data/maker-restriction-sentinels.journal.jsonl`
- `data/exit-policy-sentinels.json` + `data/exit-policy-sentinels.journal.jsonl`

Each has one server-only owner and an explicit version. Normal writes append; only its owner may compact.
Compaction uses the existing atomic temp-file/rename convention. Corrupt files are moved aside, never
rewritten by hand. Stores and reports are scoped by `strategyId`, buy-policy version, execution-policy
version, candidate version, and track.

The evaluator modules are pure. Store modules import `server-only`. Detached observation is called only
after authoritative production persistence and its result is never awaited by execution. A dependency test
must fail if policy, portfolio, budget, or order modules import a sentinel store or candidate result.

## 5. Reporting

### Maker

For production and each restriction candidate, report:

- intents, fills, and independent settlement windows;
- cash deployed and zero-deployment decisions;
- exact cash P&L and return per deployed stake;
- return across every eligible intent, assigning refused/no-fill intents zero;
- winner- and loser-conditional production fill rates;
- candidate-minus-production return clustered by settlement window;
- live and paper separately, plus actual taker submission/acceptance/fill cohorts separately.

A candidate must beat production including production's no-fills. Reporting only conditional filled ROI is
insufficient.

### Exit

For production and every candidate, report:

- every filled position and independent window, not only survivors;
- first triggers and trigger margins/times;
- exact cash P&L and incremental cash versus production;
- clustered incremental return versus production;
- hold outcome as a benchmark, never as the production baseline;
- paper-exact and live-optimistic results separately;
- complete-path coverage and observation gaps.

Raw cash and equal-window normalized results remain side by side when they disagree.

## 6. Review lock and multiplicity

Collection begins only after implementation records a UTC start time and both store versions. Existing
orders and lifecycle paths remain retrospective screening and are excluded from prospective claims.

A first diagnostic report may be viewed at 30 independent settlement windows. Promotion review remains
locked until all of the following hold for the candidate being reviewed:

1. at least 60 resolved independent windows in its scoped cohort;
2. at least 20 windows where its decision differs from production;
3. complete scoreable paths for at least 90% of otherwise eligible positions;
4. positive exact aggregate cash difference and positive clustered mean difference versus production;
5. the 95% clustered lower bound on candidate-minus-production return exceeds zero after Holm correction
   across the two maker candidates or four exit candidates in that generation;
6. live and paper are reported separately and any sign disagreement blocks promotion rather than being
   averaged away.

For an exit candidate, live observed-bid replay alone cannot satisfy an executable-live-fill claim. A
manual review must identify what evidence supports transfer from paper execution to reduce-only live IOC;
otherwise the candidate remains evaluation-only even if its return criteria clear.

Reaching the bar changes status only to reviewable. Promotion remains manual, requires a written reason and
policy/version history, and must satisfy the existing paused/quiescent real-money mutation controls. No
sentinel can auto-promote, auto-withdraw, or auto-resume anything.

## 7. Tests required before collection

- Pure maker candidate grids at, within epsilon of, and beyond 2¢/2pp boundaries.
- Mirror invariant: identical candidate labels for the same snapshot regardless of track.
- First-to-fire exit grids, confirmation reset, trailing peak updates, stale/invalid observation refusal.
- Exact-arithmetic tests for fees, net liquidation, adverse rounding, and float edges.
- Append idempotence, crash recovery, compaction, corruption isolation, and policy-version scoping.
- Complete-cohort tests proving sold and held production positions both enter every exit arm.
- Dependency test proving sentinel modules have no import path into prediction, policy, budget, portfolio,
  live order, or reconciliation decisions.
- Strategy-isolation coverage for every store aggregation.

## 8. Implementation map

| path | role |
| --- | --- |
| `lib/maker-restriction-sentinel.ts` | pure candidate classification and track-separated reporting |
| `lib/maker-restriction-sentinel-store.ts` | prospective decision records, settlement, append journal, compaction |
| `lib/exit-policy-sentinel.ts` | pure first-to-fire reducers, path coverage, track-separated reporting |
| `lib/exit-policy-sentinel-store.ts` | position/observation/production/resolution events and compaction |
| `lib/paper-execution.ts` | detached hooks after durable maker intent and after lifecycle observation; public-data continuation after production exits |
| `app/api/performance/route.ts` | authenticated, stateful, read-only reports; public/stateless payload unchanged |

The runtime imports sentinel stores only from shared orchestration. Rule, sizing, budget, portfolio, signed
order, and reconciliation modules import no sentinel result. Tests pin candidate boundaries, mirror labels,
first-to-fire behavior, confirmation reset, trailing state, full-cohort scoring, event idempotence, immutable
decision fields, append-only ownership, and dependency isolation.

## 9. Explicitly unchanged

- Live remains running and armed under existing operator intent.
- Entry rules and the paper/live mirror do not change.
- Adaptive maker/taker selection, caps, slippage, and fee roles do not change.
- `STRICT_EXIT_MIN_GAIN_CENTS` remains 1¢.
- Profit reversal remains in its current configured state.
- No buy-policy, execution-policy, or policy-manifest version changes.
- No historical sentinel or journal is backfilled or reinterpreted.
