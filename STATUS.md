# Money Noodle — Current Implementation Status

> **Projection date:** 2026-08-27 · **Status:** Current implementation projection
> **Projection-critical source fingerprint:** `sha256:ac3edd0544f06af727050a205b5b896767a2ca9385f0d1704b41663eff0358cf`
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

The 2026-08-26 documentation migrations changed no product, policy, capital, execution, reconciliation, or funded
behavior. Canonical modules now separate durable requirements from dated progress/evidence, stable requirement and
decision IDs are verified, designs route by workstream as well as lifecycle, and selected authority/status identities
are checked against source. The former 34,588-word root status remains byte-preserved in bounded immutable fragments
indexed by [`status/README.md`](status/README.md).

## Implementation by area

| Area | Current implementation |
| --- | --- |
| Product surfaces | Local dashboard, signed Automation/Budget/Performance controls, public sanitized paper summary, factor and policy drill-downs, selected-side order-book ladder, stable signal transitions, explicit stale/degraded states, and read-only track/provider/variant/market/forecast/buy/execution attribution scopes are implemented. Current-card scope is presentation-only; signed open orders, history, and trading performance share one pure order-identity vocabulary and keep live/paper totals separate. A separate stateless-safe Kalshi one-hour threshold section shows exact-duration ABOVE/YES and BELOW/YES research contracts without policy, paper, or live authority. |
| Forecasting | Venue-independent Blend 0.4 production probability, immutable forecast history, exact provenance, outcome resolution, calibration/performance reports, pure forecast boundary, and prospective candidate-family collection are implemented. Evaluator v2 is offline monitoring only and cannot promote. |
| Entry and portfolio | Shared buy policy v22, mode-free initial admission, one-maker/two-taker bounded continuation, persistence, sizing, global position/window/correlation ceilings, and prospective choice-set evidence are implemented. |
| Paper execution | Independent managed-maker/IOC simulation, displayed-depth queue proxy, public trade evidence, reduce-only depth exits, exact mirror-pair IDs, separate paper bankroll, and neutral versioned calibration are implemented. Paper is diagnostic rather than live-equivalent. |
| Live execution | The currently implemented live adapter supports signed buy/sell order lifecycle, managed post-only makers, bounded IOC entry evaluation, collision-resistant IDs, exact exchange identity, cancellation confirmation, fill/fee reconciliation, and side-aware reduce-only exits and switches. Additional providers fail closed. |
| Funded safety | Explicit arming, typed environment confirmation, kill switch, quiescent Pause/drain, per-trade and rate caps, loss/drawdown stops, durable reservations, operator-intent separation, startup/manual/full and periodic incremental reconciliation, and guarded system-only auto-resume are implemented. |
| Storage | Forecast storage v3 uses one owning writer, immutable content-addressed shards/rollups, checksums, journal replay, and publish-last generations. Execution ledger v9 keeps money/control rows hot and hydrates immutable terminal evidence from verified batches. Hourly H2 adds a detached persistent-worker-only asset/minute and exact-outcome JSONL writer. Atomic stores and append-only journals retain owner boundaries. |
| Archive and restore | Local-only object archival, full read-back checksum verification, manifests, independent restore, disk-capacity checks, and rebuildable Next-cache cleanup are implemented. Remote-primary deletion is not authorized. |
| Hosted runtime | Hosted deployment is stateless, reads bounded sanitized paper projections, and may fetch bounded public research feeds such as the H1 hourly threshold surface. It has no credentials, durable collection, reconciliation, ledger-write, control, paper, or funded order authority. |
| Governance | Versioned registries, policy manifest, immutable model-promotion ledger, canonical modular specification, controlled design/status lifecycles, stable requirement/decision IDs, deterministic task preflight, critical requirement-to-source/test navigation, workstream design routing, and CI documentation/application gates are implemented. `AGENTS.md` remains one bounded always-loaded guide; the verifiers check its citations, routed context, current-design source pointers, canonical authority restatement, and the projection-critical source fingerprint above. |

## Active identities

| Concern | Current identity or state |
| --- | --- |
| Production forecast | Blend 0.4; prospective candidates cannot affect it |
| Shared entry policy | `buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22`: +5pp minimum net edge and 10–75¢ entry band |
| Live execution | `maker-then-positive-edge-taker2-fresh2tick-v8`; one managed maker, then after authoritative zero-fill at most two freshly rechecked IOC intents bounded by two ticks, 125% of final maker limit, 75¢, and positive charged-fee edge; bounded pilot remains closed |
| Paper execution | `paper-managed-execution-route-ioc-requalify3-calibrated-v7`, neutral `queueClearFraction = 0`, exact inclusive maker event-time horizon |
| Entry sizing | `entry-sizing-reduce30-below-edge30-v1`; no multiplier above one |
| Ordinary exit | `strict-value-v1`; side-aware reduce-only IOC behavior |
| Profit reversal | `profit-reversal-75-v1` remains withheld from execution by default while prospective observations continue |
| Long-shot strategy | Retired registry identity only; no execution, collection, allocation, API, or UI authority |
| Hourly threshold research | `kalshi-hourly-threshold-read-v1` with `strike-threshold-zero-drift-v1`; detached `hourly-threshold-observation-v1` implemented but not activated; paper/live false |

Read the exact constants and capability intersections from their owning source and registries; this table is a dated
projection, not a substitute for code.

## Latest bounded evidence

| Question | Dated result | Material caveat and consequence |
| --- | --- | --- |
| Exact paper/live mirror | The 2026-08-26 review contained 170 terminal exact pairs across 93 close windows. Among 122 accepted same-route/same-quantity makers across 77 windows, paper captured 24/66 live fills (36.4%); paper-minus-live fill rate was −35.93pp ±5.72pp clustered SE. | FIFO position and cancellations ahead are private, and different fill cells deploy different capital. Paper remains materially conservative; no calibration or funded route changed. See [`reports/paper-live-exact-v7-mirror-review-2026-08-26.md`](reports/paper-live-exact-v7-mirror-review-2026-08-26.md). |
| Paper timing F2 | The fixed 2026-08-27T02:16:57.962Z review had 308 records. The approved invariant filter excluded five post-horizon rows and retained 303 records, 159 exact maker pairs across 115 windows, 98.38% row coverage, and 14 live create races. | The corrected 100-window count/coverage milestone passed. Neutral paper v7 enforces the horizon prospectively; retained v6 timing evidence carries only under exact-equivalence and generation-stratification rules. The 300-window/30-race gates remain closed and F3 stays off. See [`reports/paper-execution-timing-100-window-review-2026-08-27.md`](reports/paper-execution-timing-100-window-review-2026-08-27.md). |
| Forecast candidate Phase 2 | At the fixed 2026-08-26T05:27:33Z review, 11,303 closed rows across 104 closed windows had 95.34% funded-provider outcome coverage, complete six-arm families, 100% candidate availability, and zero replay error. The 100-window coverage gate passed. | All 527 unscoreable rows lacked funded-provider contract provenance at issuance; no row with provenance lacked its eventual outcome. This was coverage-only: production remained Blend 0.4, no arm was ranked, and Phase 3 was not authorized. See [`reports/forecast-candidate-phase2-100-window-coverage-review-2026-08-26.md`](reports/forecast-candidate-phase2-100-window-coverage-review-2026-08-26.md). |
| Maker restrictions | The fixed 2026-08-26T07:13:14Z review covered 181 live attempts across 102 windows and 707 paper attempts across 288 windows, all scoreable. The spread arm reached 20 live divergent windows and improved exact cash by 157.7076¢ live and 252.0520¢ paper, but its clustered differences were only +3.95pp ±2.58pp and +1.71pp ±1.20pp. | Neither track survived the two-arm Holm correction; the spike arm also had only 14 live divergent windows and lost 337.9820¢ incremental paper cash. Both joint review locks remained false, so maker execution and every policy/capital generation stayed unchanged. See [`reports/maker-restriction-v1-fixed-review-2026-08-26.md`](reports/maker-restriction-v1-fixed-review-2026-08-26.md). |
| Exit sentinel v2 | The 2026-08-26 diagnosis covered 9,240 events across 150 sentinels; close-bounded coverage was 71/78 live and 62/72 paper. Every position made incomplete by cycle coverage was a loss. | V2 conflates a fresh zero bid with missing evidence, creating outcome selection. Its candidate economics are not promotion-grade; v3 remains deferred. See [`reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md`](reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md). |
| Long-shot final review | On 2026-08-26, 150 resolved attempts across 76 windows lost 1,410.93¢ exact on 4,979¢ staked. The paired 97¢ exit was −98.93¢ versus hold. | Hold uncertainty remained broad and the strategy came from retrospective screening. The result supported retirement, not a claim against every cheap-contract strategy. See [`reports/long-shot-v2-final-review-2026-08-26.md`](reports/long-shot-v2-final-review-2026-08-26.md). |
| Fixed live/paper economic monitor | The 24 hours through 2026-08-26T07:15Z had 54 live fills across 42 windows and −221.4543¢ exact P&L, versus 49 paper fills across 41 windows and −388.2450¢. Every qualifying v22 decision remained +24.33% ±7.21pp ask-and-hold, while live fills were −23.81% ±15.82pp and paper fills −36.22% ±16.43pp. | One live taker fill gained 242.79¢ while 53 maker fills lost 464.2443¢; paper captured only 24.49% of accepted live maker fills in the fixed-day exact cohort. Execution selection and exits remain competing explanations, not a unique correction. No forecast, policy, route, exit, calibration, sizing, or capital change was authorized. See [`reports/live-paper-economic-monitor-2026-08-26.md`](reports/live-paper-economic-monitor-2026-08-26.md). |
| Hourly threshold mechanics | The 2026-08-26 public revalidation covered ten planned series, 1,335 open rows, 36 threshold rows, twelve exact one-hour rows, and ten rows with the structured strike fields required by H1. | This was one listing snapshot; availability changes, and DOGE's two exact-hour rows omitted structured strikes. H1 leaves incomplete contracts unavailable and grants no policy, paper, or live authority. See [`reports/kalshi-hourly-threshold-contract-revalidation-2026-08-26.md`](reports/kalshi-hourly-threshold-contract-revalidation-2026-08-26.md). |
| Archive/restore | The 2026-08-24 manifest covered 138 stable files and 1,436,922,799 source bytes; an independent restore reproduced every file and passed forecast-v3 and execution-v9 semantic verifiers. | The bucket lacked Object Lock and an independent replica. No durable local source deletion or remote-primary eviction was authorized. See [`reports/object-storage-restore-and-disk-reclamation-2026-08-24.md`](reports/object-storage-restore-and-disk-reclamation-2026-08-24.md). |

These measurements are not live counters. Recalculate from durable inputs before making a current quantitative
claim or decision.

## Work in progress and held boundaries

- Forecast candidate Phase 2 continues under its frozen prospective generation. Paper timing F2 passed its
  corrected 100-window milestone after a pre-outcome invariant filter excluded five rows. Neutral v7 enforces the
  exact horizon; reviews retain v6 evidence only when it is exactly equivalent and show generation strata. F3
  remains blocked by the 300-window, 30-race, and non-interference gates.
- Maker-restriction sentinels continue without tuning. Exit v3 remains explicitly deferred.
- The strict serial evaluation sequence remains base forecast → confirmed signal → venue candidacy → portfolio
  selection → live authorization → attempt/outcome. Downstream collection does not start early.
- Remote-primary storage eviction remains blocked pending enforceable retention or an independent replica plus the
  owner-aware tier catalog and verified hydration.
- Stake expansion, another live venue, queue-aware live gates, unconditional taker execution, and automatic entry
  relaxation remain unsupported or blocked.
- Provider/policy attribution visibility is implemented without a ledger rewrite or public-payload expansion.
  Durable unified policy lineage and parameter diffs remain a separate structural design.
- Hourly threshold H1 public market data and H2 detached durable observation are implemented; H2's prospective
  clock has not started pending worker activation. H3 isolated paper remains
  unactivated. Proposed engine separation and multitenancy have no implementation authority. Noodle Land remains
  exploratory and outside application/runtime authority.

See [`status/roadmap.md`](status/roadmap.md) for sequencing and [`spec/open-decisions.md`](spec/open-decisions.md)
for unresolved normative questions.

## Latest recorded operational snapshot

At the published snapshot on 2026-08-27, the local production worker activated the paper-only v7 horizon repair
after existing funded positions became terminal and reservations reached zero. Startup full reconciliation
completed READY at `2026-08-27T02:44:52.760Z` with zero local/venue managed positions, resting orders,
reservations, or blockers. Revision 7,797 retained explicit active operator intent in `live` mode with 1,666¢
available and zero reserved; funded execution was not paused or implicitly re-armed by the restart.

That state may have changed immediately after publication. Do not infer present permission, exposure, cash,
readiness, or restart safety from it.

## Persistent guardrails

- Preserve Paper/Live separation and exact-versus-whole-cent reporting labels.
- Do not infer funded authority from configuration, documentation, hosted output, or a prior READY snapshot.
- Do not loosen stake, exposure, execution, reconciliation, or promotion gates from one favorable metric.
- Never force a live switch or order for verification.
- Never delete, rewrite, or hand-edit durable journals or ledgers to repair a status discrepancy.
- Nothing in Money Noodle is financial advice.
