# Paper/live mirror fidelity repair

**Status:** implemented and activated locally on 2026-08-21 after approval in prose by the maintainer and
review of `reports/paper-live-mirror-fidelity-2026-08-21.md`. This design preceded execution-code changes.

**Current diagnostic review, 2026-08-26:** the prospective exact live-v7/paper-v6 cohort is recorded in
`reports/paper-live-exact-v7-mirror-review-2026-08-26.md`. It found material paper undercapture but authorized
no calibration or production change; F2/F3 gates remain controlling.

## 0. Decision

Repair the current paper execution mirror without changing funded execution:

1. restore the intended three-episode paper requalification boundary;
2. advance the paper execution generation so defective v4 rows are never pooled with repaired rows;
3. stamp a prospective exact pair identity on paper and live intents from the same decision calculation;
4. report all four paired fill outcomes without conditioning the denominator on a live fill; and
5. retain bounded public trade/queue-consumption evidence for each paper maker poll.

Exact authenticated Kalshi queue-position collection is **not** added in this change. The endpoint exists,
but every call consumes the same signed-read capacity used by authoritative fill and reconciliation reads.
An observation request that can rate-limit or delay those reads is not observation-only under AGENTS.md §4.
It requires a separately agreed request budget/cadence or a venue stream that cannot contend with execution.
The schema below leaves room for it; no speculative value is invented now.

No buy rule, live route, live sizing, live episode count, live order ID, live order call, exit rule, risk gate,
budget, reconciliation rule, or promotion state changes.

## 1. Paper episode repair

### 1.1 Defect

A production v4 paper row carries two different identities for different purposes:

- `entryDecision.executionPolicyVersion` identifies the paper simulator generation;
- `entryExecutionDecision.policyVersion` identifies the shared maker/taker route generation.

`adaptiveEntryEpisodeDecision` currently prefers the shared route identity for every lane. `runPaper` asks
it to compare that value with the paper simulator generation. Those values are intentionally different, so
every completed paper maker zero-fill looks stale and no paper episode 2 or 3 can open.

### 1.2 Repair

Generation ownership is lane-aware:

- paper validates `entryDecision.executionPolicyVersion`;
- live validates `entryExecutionDecision.policyVersion`, with the entry-decision field only as a legacy
  fallback.

The terminal-state, post-completion persistence, taker-terminal, fill, uncertainty, and three-episode rules
remain unchanged.

Advance `PAPER_MANAGED_MAKER_EXECUTION_VERSION` from
`paper-managed-execution-route-ioc-v4` to
`paper-managed-execution-route-ioc-requalify3-v5`. Existing v4 rows remain immutable. A v4 miss cannot
authorize a v5 episode; a new settlement window begins the repaired cohort normally.

Tests use the real production shape with both identity fields present. They must fail if paper reads the
shared route identity again.

## 2. Prospective exact pair identity

### 2.1 Why the existing overlay is insufficient

`matched-live-fill-shadow-v1` is attached only after an authoritative live fill. It cannot count paper-only
or neither-filled pairs and therefore cannot measure agreement. Retrospective nearest-time pairing also
confuses live's serialized drain latency with a common decision.

### 2.2 Identity

Every new edge-policy entry order receives an observation-only `executionMirrorPair`:

- version `entry-execution-mirror-pair-v1`;
- stable ID derived from strategy, provider, exact contract, side, close, decision calculation timestamp,
  and final episode number.

Paper and live receive the same ID only when they were built from the same dashboard calculation and exact
episode. A row may have no counterpart because capital, pauses, stops, exposure, or independent prior fills
legitimately separate the lanes. The field is never read by selection, execution, sizing, budget, or
reconciliation.

No historical pair IDs are backfilled.

### 2.3 Report

`buildMakerFillReport` groups only prospectively stamped rows and reports:

- paired, paper-only, live-only, and ambiguous IDs;
- both-filled, paper-only-fill, live-only-fill, and neither-filled cells;
- route and requested-quantity agreement;
- both-filled quantity agreement and mean paper-minus-live price;
- fill/no-fill agreement and paper capture of live fills.

An ID with more than one row in either lane is reported as ambiguous and excluded from outcome cells. It is
never resolved by ordering or nearest timestamp.

The authenticated performance surface shows this separately from the legacy live-fill-conditioned overlay.
For prospectively stamped rows, that overlay also joins by the exact pair ID instead of its legacy nearest-
time fallback; unstamped history retains the old readable behavior. The public/stateless projection remains
paper-only and receives no pair report or live identifiers.

## 3. Bounded paper queue-consumption evidence

`applyTradePrintsToPaperQueue` continues to own fill arithmetic. For each successful trade read it also
returns a bounded summary:

- read start and completion times;
- number and quantity of previously unseen consuming prints at or through the current paper limit;
- first and last consuming venue timestamps;
- queue ahead before and after applying them;
- fill quantity added by the read.

The manager appends one `paper_trade_evidence` execution observation per successful read. It does not retain
an unbounded list of trade IDs or full API payloads. Existing in-memory ID deduplication remains authoritative
within the attempt. Failed reads produce no complete-evidence event, and final-read failure continues to
exclude the attempt rather than manufacture a miss.

This is evidence only: the mutation already performed by `applyTradePrintsToPaperQueue` is unchanged. The
summary is derived from that same pass and cannot alter which prints qualify or how much fills.

The change does not reinterpret the three historical paper rows whose wall time exceeded 30 seconds. Future
rows carry enough timestamps to determine whether a delayed response found volume during the intended
management interval. Any later horizon change requires a new paper execution generation and a separate
decision.

## 4. Exact queue position: deferred safety requirement

Kalshi's 2026-08-21 OpenAPI defines:

- `GET /portfolio/orders/{order_id}/queue_position`;
- response `queue_position_fp`, “the number of preceding shares before the order in the queue.”

The managed entry currently spends signed reads on authoritative fills every two seconds and cancellation
confirmation; reconciliation uses the same signed-read bucket. Adding six queue reads per order, or even an
unbudgeted initial read, can consume capacity needed by money-state reads. Detached promises do not remove
that venue-side contention.

Before collection is permitted, agree one of:

1. a dedicated venue/API read budget proven independent of authoritative reads;
2. a single bounded read with reserved headroom and a fail-drop path demonstrated not to affect management;
   or
3. an authenticated stream isolated from REST execution limits.

Until then `displayedAhead` remains explicitly a proxy and the report says so. No queue estimate may become
a gate, size input, or fill override.

## 5. Accounting and track meaning

The edge paper bankroll was historically separate from the now-retired long-shot paper funding. The drift
check remains narrowed to edge-policy open stake so retired foreign-strategy history cannot manufacture a
false residual. It writes nothing unless explicitly run with `--write`; this repair requires no correction.

Paper continues to ignore live operator pause, risk stops, hourly limits, reconciliation blocks, and live
capital. That is the SPEC §12.3 mirror used to measure stop/limit drag. A literal operational live twin would
be an additional non-money lane and is out of scope here; replacing paper with it would delete the existing
measurement.

## 6. Files and tests

| Path | Change |
| --- | --- |
| `lib/maker-retry-policy.ts` | lane-aware execution-generation ownership |
| `lib/paper-maker-simulation.ts` | paper execution v5 identity and bounded trade evidence |
| `lib/execution-mirror-pair.ts` | pure pair identity and complete-pair aggregation |
| `lib/paper-execution.ts` | stamp pair identity after final episode assignment |
| `lib/execution-report.ts` | expose prospective four-cell report |
| `components/performance-dialog.tsx` | signed-only complete-pair panel |
| `lib/types.ts` | durable observation/pair and report types |
| `scripts/analyze-paper-live-mirror.mjs` | reproducible historical/current review |
| `scripts/correct-paper-bankroll-drift.ts` | strategy-scoped open-stake diagnostic |

Required tests:

- production-shaped paper miss requalifies under v5;
- v4 miss cannot authorize v5;
- live still validates its route generation;
- pair IDs agree only on exact decision identity and episode;
- duplicate lane ownership is ambiguous and excluded;
- all four outcome cells and agreement fields are correct;
- queue evidence records only new consuming prints and does not change fill arithmetic;
- no pair field enters the public projection;
- mirror invariant and strategy isolation remain unchanged.

Run typecheck, lint, all tests, production build, and `git diff --check`. Deployment, if requested, follows a
pause/drain and authoritative reconciliation because the running worker must load the corrected paper
generation; funded execution is not automatically resumed.
