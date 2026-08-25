# Paper fill calibration design

Status: approved in prose by the maintainer on 2026-08-21 and implemented. This design preceded
implementation. Scope: ship the machinery (`queueClearFraction: 0` = exact current model, fresh v6
cohort), provide the held-out re-evaluation, no funded-execution or rule change. The evaluator denominator was
corrected on 2026-08-25 to require an accepted live order plus the same maker route and quantity; post-only create
races and route/quantity differences occur before queue placement and are not queue-calibration evidence. Phase F1
of [`paper-execution-fidelity-v2-design.md`](paper-execution-fidelity-v2-design.md) also repaired the implementation
to apply the fraction at every newly joined queue, including a price-changing amendment, while proving the active
neutral value exactly preserves v6 behavior.

## 0. Decision

Make the paper maker fill model an **accurate, independently simulated** model of the live venue queue,
and add a **reproducible, held-out re-evaluation** that keeps it accurate as evidence grows — without
ever reading a live order's authoritative fill to set the paper result at runtime.

The change does **not** adopt a calibration from retrospective data. It adds:

1. a versioned, bounded paper fill model parameter (`queueClearFraction`), defaulting to zero
   (= today's full-conservative model, so no behavior change until a parameter is adopted);
2. a durable, atomic store and history so any future adoption changes the cohort (version-bumped)
   and is recorded, never invented;
3. a read-only held-out evaluator (`npm run analyze:paper-fill-calibration`) that a maintainer runs
   periodically ("every so often") and that reports when a candidate clears its band; **promotion is
   manual**.

No funded execution path changes. Paper remains an independent simulation; the calibration is a fixed
prior set from historical paired evidence, never a per-row live-fill callback.

## 1. Confirmed failure and channel

A fresh read of `data/paper-orders.json` at `2026-08-21T16:26Z`:

- current (v5) prospectively paired terminal intents: **130** (`entry-execution-mirror-pair-v1`);
- cells: **both 16, paper-only 10, live-only 10, neither 94**;
- agreement 84.6%, paper capture of live fills 61.5%, paper-positive precision 61.5%.

Window-level P&L over the current v5 cohort (intents since `2026-08-21T02:17Z`):

| Lane | Realized P&L |
| --- | ---: |
| paper | −419¢ over 26 filled |
| live | +343¢ over 25 filled |

When both lanes fill the same `(symbol, side, closesAt)`, realized P&L agrees to the cent (14 slots,
net −19¢). The gap is **both**-digging:

1. **Paper misses live-filled winners.** 12 live-filled slots paper did not fill; **11 were attempted
   by paper** and its own simulation returned no fill. The largest live-only rows (SOL 06:45 +383¢,
   HYPE 09:00 +231¢) are paper attempts whose queue simulation refused the fill.
2. **Paper-only losers**: paper filled 12 slots live did not fill, net −152¢.

Channel (1) is the known **cancellation-blind** queue: `applyTradePrintsToPaperQueue` depletes
`displayedAhead` only with aggressive opposite-taker prints. Real venue order can move forward when
*earlier orders cancel* or *shared FIFO priority* advances, without a full displayed-book write. That
is the documented mechanism (SPEC §12.3, `reports/paper-live-mirror-fidelity-2026-08-21.md` §2). No
retroactive re-fit is valid here: this change ships the machinery, a fresh v6 cohort, and asks the
held-out analysis to say when a calibration is justified.

## 3. Calibration model (pure, versioned)

### 3.1 The one tunable

`queueClearFraction` — the fraction of each newly joined displayed-ahead queue cleared by the
cancellation/FIFO-advance proxy before aggressive prints are applied. Bounded `[0, 0.5)` so a paper order can
never be assumed to skip more than half its shown depth. Default **`0` = today's exact model**. At initial
acceptance, later recovery from unavailable depth, and every price-changing amendment, the displayed quantity is
transformed by the same fraction:

```
effectiveInitialAhead = floor(displayedAhead * (1 - queueClearFraction) + 1e-9)   // toward zero
```

The rest of `applyTradePrintsToQueue` unchanged: aggressive taker prints still consume the remaining
`effective  ahead`; ask-touch never fills; missing terminal trade evidence still excludes the attempt.

### 3.2 Determinism and independence

The calibration is a **fixed parameter read from a durable versioned store**, evaluated at paper-ready
entry, never conditioned on a live order fill. Paper P&L is produced only by the simulation + the
calibration constant.

### 3.3 Why this does not add pseudo-fills

The parameter only *shortens the initial exaggerated queue*, so a fair first-pin print can fill it
earlier with the *same printed volume that was actually observed*. It never invents a fill when no
aggressive-side prints were observed (queue would be empty regardless). It is not the inverted
quote-touch model, and it estimates no random fills.

## 4. Versioning and cohorts

Advance `PAPER_MANAGED_MAKER_EXECUTION_VERSION` from
`paper-managed-execution-route-ioc-requalify3-v5` to
`paper-managed-execution-route-ioc-requalify3-calibrated-v6`.

- v6 is a **fresh, neutral cohort**. Existing v5 rows are immutable; no fill or P&L changes retroactively.
- `queueClearFraction: 0` with no adoption is always stamped as v6.
- **Every manual adoption starts another paper execution cohort.** The store owns a monotonic generation:
  the first adoption stamps v7, the next v8, and so on, including a later rollback to zero. A changed fill
  assumption can therefore never share an execution-policy identity with an earlier assumption.
- The calibration is read before paper intent creation and its complete immutable record is copied onto the
  order. Management consumes that issuance-time copy rather than rereading mutable active state.

`PAPER_FILL_CALIBRATION_VERSION = 'paper-fill-calibration-v1'` marks the calibration-record schema; the
paper execution suffix (`v6`, `v7`, …) identifies the economic cohort. Adoption writes the generated paper
execution identity and held-out evidence to `data/paper-fill-calibration.json`.

## 5. Store

`lib/paper-fill-calibration-store.ts` (atomic `${target}.${pid}.rand.tmp` → rename):

```ts
interface PaperFillCalibrationStore {
  version: 1;
  active: PaperFillCalibration;      // neutral v6 or the latest adopted generation
  history: PaperFillCalibration[];   // complete, append-only adoption records
}
```

- the worker loads `getActivePaperFillCalibration()` before creating a paper intent, stamps its complete
  calibration and generated execution cohort, and uses that same stamp during management;
- promotion (if any) is a **manual**, explicit `adoptPaperFillCalibration` call that generates the next
  cohort, enforces `0 <= qcf < 0.5`, requires positive held-out windows and a reason, and appends the full
  provenance without truncation. No auto-adoption;
- malformed or discontinuous store history fails closed rather than silently reverting to neutral.

## 6. Re-evaluation (`npm run analyze:paper-fill-calibration`)

A **read-only** script (writes `reports/` only, places no order).

### Honest limitation

The ledger records `paper_trade_evidence` as a per-read *summary* (consuming count/quantity, queue
before/after, fill added), not a per-print stream. A candidate `queueClearFraction` therefore cannot be
faithfully re-simulated from the durable ledger after the fact, and this review must not pretend it can.
It reports instead:

- the current model's held-out cells (both / paper-only / live-only / neither) and agreement, capture
  and precision on the **second half of settlement windows**, conditional on an accepted live maker with the same
  paper/live route and requested quantity;
- the **structural upper bound** of any queue-shortening recovery: the live-only filled rows paper's
  model refused, summed realized P&L;
- the evaluator selects exactly the active paper execution cohort before creating its held-out split and
  reports the selected identity; it never pools v5, neutral v6, or an adopted v7+ generation;
- no candidate is promoted — SPEC §12.5 requires the adopting cohort to have retained per-read/print
  evidence for an honest validation split, and adoption is a manual act into a new cohort (v7 first).

No grid is fit here, because a candidate `queueClearFraction` cannot be faithfully re-simulated from
these per-read summaries; the two bullets above are the honest measurement available from the durable
ledger.

### What authorizes promotion

Per SPEC §12.5 / AGENTS.md §5.5, no retrospective promotion: a candidate **will not auto-adopt**.
The evaluator prints a candidate only when it clears the held-out band. **Adoption is a recorded
manual act** that starts a new cohort (v6 → v7) and is written into `data/paper-fill-calibration.json`
and the paper execution version history.

## 7. Deliverables and files

| Path | Change |
| --- | --- |
| `lib/paper-fill-calibration.ts` | pure model: bounded parameter, `applyQueueClearFraction`, versioning contract |
| `lib/paper-fill-calibration-store.ts` | durable atomic store; read active calibration, manual adopt |
| `lib/paper-maker-simulation.ts` | accept calibration input in the maker queue model; apply whenever a new queue is joined; no neutral behavior change |
| `lib/paper-execution.ts` | load active calibration and pass through `managePaperMakerOrder`; bump paper version + record calibration on orders |
| `lib/types.ts` | calibration field on orders; history store types |
| `scripts/analyze-paper-fill-calibration.mjs` | held-out re-evaluation (read-only) |
| `lib/paper-maker-fill.test.ts` | grid of queueClearFraction inputs on the pure model + a manager-level smoker; bounds honored; neutral reproduces today |
| `docs/paper-fill-calibration-design.md` | this document |
| `STATUS.md` | record the model, cohort reset to v6, and the re-evaluation cadence |

Required tests:

- `queueClearFraction: 0` produces an exactly equal complete simulation with or without an explicit calibration;
- positive values reduce initial, recovered, and amended queue-ahead proxies with exact arithmetic (floor + 1e-9)
  and never go negative;
- bounds reject `>= 0.5` and `NaN`; exactly-arithmetic edge (float-representation landing) is pinned;
- store atomic write + manual adoption appends immutable history and never auto-promotes;
- calibration never reads a live fill field (independent simulation);
- mirror-invariant + strategy-isolation unchanged (the rule layer takes no execution mode).

## 8. Approved scope

**Accept only after maintainer agreement.** No performance, no funded execution, no live risk change.
Always consumed by paper-only. Ask the maintainer to confirm:

1. Ship the machinery with `queueClearFraction: 0` and a fresh v6 cohort;
2. run the held-out evaluator; if no candidate clears the band, the report is a null result,
   and the v6 cohort keeps collecting;
3. no auto-promotion; every future adoption receives the next paper execution generation (v7, v8, …)
   plus a complete recorded manual `adopt` entry.

## D. Explicit non-goals (unchanged)

- Paper keeps ignoring live operator pause, risk stops, hourly caps, reconciliation blocks, live
  capital — that is **SPEC §12.3 measurement of limit/stop drag**, not an execution twin.
- No exact `queue_position_fp` request is added (signed-read budget contention; see §4 of
  `docs/paper-live-mirror-fidelity-repair-design.md`).
- The paper P&L remains **independent**; matched-live overlay remains a separate, non-accounting
  projection (unchanged `attachMatchedLiveFillShadow`) and never sets paper status or bankroll.