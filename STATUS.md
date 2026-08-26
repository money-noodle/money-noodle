# Money Noodle — Current Implementation Status

> **Projection date:** 2026-08-26 · **Status:** Current implementation projection
> **Requirements:** [`SPEC.md`](SPEC.md) · **Design lifecycle:** [`docs/README.md`](docs/README.md)
> **Status index and archives:** [`status/README.md`](status/README.md) · **Roadmap:** [`status/roadmap.md`](status/roadmap.md)
>
> This document is dated and non-operational. It does not determine whether funded execution is running and cannot
> authorize a policy, order, budget, reconciliation action, or deployment. Before any operational action, read the
> authenticated Automation surface and `data/trading-control.json`. Code and versioned registries remain
> authoritative for current behavior.

## Current system

Money Noodle is implemented as a local research dashboard, continuous paper shadow trader, bounded public paper
publisher, and environment-gated, explicitly armable live trading desk. The current production path supports both
binary sides, managed maker entry, bounded IOC evaluation, independent paper fills, reduce-only exits, protected
switching, global exposure controls, durable budget epochs, and account-wide reconciliation.

The repeated-episode identity defect was repaired under collision-resistant live IDs and its known ledger damage was
corrected on 2026-08-21. Exact dynamic exchange identity and external-position ownership were repaired on
2026-08-25. The former long-shot strategy was retired and removed from runtime/product authority on 2026-08-26;
its historical identity and evidence remain durable.

The 2026-08-26 documentation migration changed no product, policy, capital, execution, reconciliation, or funded
behavior. The former 34,588-word root status is preserved byte-for-byte in bounded immutable fragments indexed by
[`status/README.md`](status/README.md).

## Implementation by area

| Area | Current implementation |
| --- | --- |
| Product surfaces | Local dashboard, signed Automation/Budget/Performance controls, public sanitized paper summary, factor and policy drill-downs, selected-side order-book ladder, stable signal transitions, explicit stale/degraded states, and read-only track/provider/variant/market/forecast/buy/execution attribution scopes are implemented. Current-card scope is presentation-only; signed open orders, history, and trading performance share one pure order-identity vocabulary and keep live/paper totals separate. |
| Forecasting | Venue-independent Blend 0.4 production probability, immutable forecast history, exact provenance, outcome resolution, calibration/performance reports, pure forecast boundary, and prospective candidate-family collection are implemented. Evaluator v2 is offline monitoring only and cannot promote. |
| Entry and portfolio | Shared buy policy v22, mode-free rule evaluation, post-qualification execution style, persistence, up to three requalified episodes, sizing, global position/window/correlation ceilings, and prospective choice-set evidence are implemented. |
| Paper execution | Independent managed-maker/IOC simulation, displayed-depth queue proxy, public trade evidence, reduce-only depth exits, exact mirror-pair IDs, separate paper bankroll, and neutral versioned calibration are implemented. Paper is diagnostic rather than live-equivalent. |
| Live execution | The currently implemented live adapter supports signed buy/sell order lifecycle, managed post-only makers, bounded IOC entry evaluation, collision-resistant IDs, exact exchange identity, cancellation confirmation, fill/fee reconciliation, and side-aware reduce-only exits and switches. Additional providers fail closed. |
| Funded safety | Explicit arming, typed environment confirmation, kill switch, quiescent Pause/drain, per-trade and rate caps, loss/drawdown stops, durable reservations, operator-intent separation, startup/manual/full and periodic incremental reconciliation, and guarded system-only auto-resume are implemented. |
| Storage | Forecast storage v3 uses one owning writer, immutable content-addressed shards/rollups, checksums, journal replay, and publish-last generations. Execution ledger v9 keeps money/control rows hot and hydrates immutable terminal evidence from verified batches. Atomic stores and append-only journals retain owner boundaries. |
| Archive and restore | Local-only object archival, full read-back checksum verification, manifests, independent restore, disk-capacity checks, and rebuildable Next-cache cleanup are implemented. Remote-primary deletion is not authorized. |
| Hosted runtime | Hosted deployment is stateless and reads only bounded sanitized paper projections. It has no credentials, collection, reconciliation, ledger-write, control, or funded order authority. |
| Governance | Versioned registries, policy manifest, immutable model-promotion ledger, canonical modular specification, controlled design/status lifecycles, and CI documentation/application gates are implemented. `AGENTS.md` remains one bounded always-loaded guide with stable historical citations and explicit change routing, and is now verified against the code it cites by `verify:agents`. |

## Active identities

| Concern | Current identity or state |
| --- | --- |
| Production forecast | Blend 0.4; prospective candidates cannot affect it |
| Shared entry policy | Buy policy v22: +5pp minimum net edge and 10–75¢ entry band, with the remaining current gates unchanged |
| Live execution | `maker-high30-requalify3-fresh1c-bounded-taker-pilot-v7`; the bounded pilot is closed and subsequent eligible intents retain incumbent maker execution |
| Paper execution | `paper-managed-execution-route-ioc-requalify3-calibrated-v6`, neutral `queueClearFraction = 0` |
| Entry sizing | `entry-sizing-reduce30-below-edge30-v1`; no multiplier above one |
| Ordinary exit | `strict-value-v1`; side-aware reduce-only IOC behavior |
| Profit reversal | `profit-reversal-75-v1` remains withheld from execution by default while prospective observations continue |
| Long-shot strategy | Retired registry identity only; no execution, collection, allocation, API, or UI authority |

Read the exact constants and capability intersections from their owning source and registries; this table is a dated
projection, not a substitute for code.

## Latest bounded evidence

| Question | Dated result | Material caveat and consequence |
| --- | --- | --- |
| Exact paper/live mirror | The 2026-08-26 review contained 170 terminal exact pairs across 93 close windows. Among 122 accepted same-route/same-quantity makers across 77 windows, paper captured 24/66 live fills (36.4%); paper-minus-live fill rate was −35.93pp ±5.72pp clustered SE. | FIFO position and cancellations ahead are private, and different fill cells deploy different capital. Paper remains materially conservative; no calibration or funded route changed. See [`reports/paper-live-exact-v7-mirror-review-2026-08-26.md`](reports/paper-live-exact-v7-mirror-review-2026-08-26.md). |
| Paper timing F2 | At the 2026-08-26 status read, 121/121 records were complete across 53 windows, with 69 known live pairs and one observed create race. | The 100-window and 300-window/30-race gates remained closed. F3 was not activated and no timing candidate changed paper fills. |
| Forecast candidate Phase 2 | At the fixed 2026-08-26T05:27:33Z review, 11,303 closed rows across 104 closed windows had 95.34% funded-provider outcome coverage, complete six-arm families, 100% candidate availability, and zero replay error. The 100-window coverage gate passed. | All 527 unscoreable rows lacked funded-provider contract provenance at issuance; no row with provenance lacked its eventual outcome. This was coverage-only: production remained Blend 0.4, no arm was ranked, and Phase 3 was not authorized. See [`reports/forecast-candidate-phase2-100-window-coverage-review-2026-08-26.md`](reports/forecast-candidate-phase2-100-window-coverage-review-2026-08-26.md). |
| Maker restrictions | At the 2026-08-26 projection, live spread had 18/20 divergent windows, paper spread 65, and live spike 14; every joint `reviewUnlocked` remained false. | Arms have unequal and still-gated track evidence. Counts or an isolated statistic cannot promote a restriction. |
| Exit sentinel v2 | The 2026-08-26 diagnosis covered 9,240 events across 150 sentinels; close-bounded coverage was 71/78 live and 62/72 paper. Every position made incomplete by cycle coverage was a loss. | V2 conflates a fresh zero bid with missing evidence, creating outcome selection. Its candidate economics are not promotion-grade; v3 remains deferred. See [`reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md`](reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md). |
| Long-shot final review | On 2026-08-26, 150 resolved attempts across 76 windows lost 1,410.93¢ exact on 4,979¢ staked. The paired 97¢ exit was −98.93¢ versus hold. | Hold uncertainty remained broad and the strategy came from retrospective screening. The result supported retirement, not a claim against every cheap-contract strategy. See [`reports/long-shot-v2-final-review-2026-08-26.md`](reports/long-shot-v2-final-review-2026-08-26.md). |
| Fixed live/paper economic monitor | The fixed day reviewed on 2026-08-25 had 47 live fills across 34 windows and −259.466¢ exact P&L on one attribution route, versus 52 paper fills across 42 windows and −258.308¢. | Signal selection remained positive while fills were negative; route attribution, fill selection, and exits remain competing explanations. The slice did not authorize a retrospective entry filter. See [`reports/live-paper-economic-monitor-2026-08-25.md`](reports/live-paper-economic-monitor-2026-08-25.md). |
| Archive/restore | The 2026-08-24 manifest covered 138 stable files and 1,436,922,799 source bytes; an independent restore reproduced every file and passed forecast-v3 and execution-v9 semantic verifiers. | The bucket lacked Object Lock and an independent replica. No durable local source deletion or remote-primary eviction was authorized. See [`reports/object-storage-restore-and-disk-reclamation-2026-08-24.md`](reports/object-storage-restore-and-disk-reclamation-2026-08-24.md). |

These measurements are not live counters. Recalculate from durable inputs before making a current quantitative
claim or decision.

## Work in progress and held boundaries

- Forecast candidate Phase 2 and paper timing F2 continue under their frozen prospective generations.
- Maker-restriction sentinels continue without tuning. Exit v3 remains explicitly deferred.
- The strict serial evaluation sequence remains base forecast → confirmed signal → venue candidacy → portfolio
  selection → live authorization → attempt/outcome. Downstream collection does not start early.
- Remote-primary storage eviction remains blocked pending enforceable retention or an independent replica plus the
  owner-aware tier catalog and verified hydration.
- Stake expansion, another live venue, queue-aware live gates, unconditional taker execution, and automatic entry
  relaxation remain unsupported or blocked.
- Provider/policy attribution visibility is implemented without a ledger rewrite or public-payload expansion.
  Durable unified policy lineage and parameter diffs remain a separate structural design.
- The accepted hourly threshold-market design is not implemented. Proposed engine separation and multitenancy have
  no implementation authority. Noodle Land remains exploratory and outside application/runtime authority.

See [`status/roadmap.md`](status/roadmap.md) for sequencing and [`spec/open-decisions.md`](spec/open-decisions.md)
for unresolved normative questions.

## Latest recorded operational snapshot

At the published snapshot on 2026-08-26, the requested documentation rollout used the authenticated Pause path:
revision 7,097 became operator-paused / `live`, quiescent, and restart-safe after manual full reconciliation passed
with zero local/venue managed positions, resting orders, or reservations. After the provider/policy attribution
build loaded, startup full reconciliation completed READY at `2026-08-26T04:49:07.312Z`; revision 7,099 retained
operator-paused intent, 1,861¢ available, zero reserved, no blockers, and zero open positions. Paper collection
continues, but funded execution was not implicitly resumed.

That state may have changed immediately after publication. Do not infer present permission, exposure, cash,
readiness, or restart safety from it.

## Persistent guardrails

- Preserve Paper/Live separation and exact-versus-whole-cent reporting labels.
- Do not infer funded authority from configuration, documentation, hosted output, or a prior READY snapshot.
- Do not loosen stake, exposure, execution, reconciliation, or promotion gates from one favorable metric.
- Never force a live switch or order for verification.
- Never delete, rewrite, or hand-edit durable journals or ledgers to repair a status discrepancy.
- Nothing in Money Noodle is financial advice.
