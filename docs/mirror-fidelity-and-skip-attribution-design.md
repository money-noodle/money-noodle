# Mirror fidelity and skip attribution

> **Document type:** Execution design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-20
> **Canonical requirements:** [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md), [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260820-08`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

**Status:** implemented 2026-08-20. Supersedes nothing; completes `spec/policy-and-track-separation.md` §12.8 step 2 and closes two
modelled asymmetries in the paper mirror.

**Departure from process, recorded rather than buried.** AGENTS.md asks for the design doc before the
code. Here the design was agreed in prose with the maintainer in-thread, item by item, and the code
followed immediately; this document was written alongside the implementation rather than before it. The
one design decision that changed during implementation is called out in §2.1 and was reported before the
code was written.

## 0. What this is for

The 2026-08-20 divergence review found four channels separating live from paper, and a fifth problem
underneath them: none of the four could be attributed from durable data. `spec/policy-and-track-separation.md` §12.3 promises that
`paper − live` "decomposes into fill drag, limit drag, and stop drag". It did not. Reconstructing the
largest channel — live spending 12 of 24 hours risk-stopped on 2026-08-19 while paper kept trading —
required joining the trading control audit against the order ledger by hand.

This change does three things and deliberately does not do a fourth.

| # | Change | Channel |
| --- | --- | --- |
| 1 | Durable per-window live skip journal with a typed class | Makes all channels countable |
| 2 | Paper standalone exit simulates its own IOC | Closes the largest modelled asymmetry |
| 3 | Paper entry takes the route the execution policy chooses | Closes a `spec/policy-and-track-separation.md` §12.2 conformance gap |
| 4 | **Not done on purpose:** paper does not obey live's risk stops | Must stay open — see §3 |

## 1. Live skip attribution

`src/lib/live-skip.ts` (pure), `src/lib/live-skip-store.ts` (durable), wired through `runLive`.

### 1.1 Why a class per call site rather than a classifier

The obvious implementation reads the existing free-text reason and pattern-matches a class out of it.
That was rejected. The reasons are prose written for a dashboard, they change when someone improves the
wording, and a new gate added later would silently inherit whichever pattern happened to match. Instead
`skip()` takes the class as its first argument, so every gate names what it is and a new gate cannot
compile without deciding. This is AGENTS.md §5.7 applied at the source: a class with zero records is
visible as an inert gate rather than assumed to be a control.

### 1.2 Episodes, not cycles

The live cycle runs roughly every 15 seconds. One row per skip per cycle would be about 5,760 rows a day,
nearly all identical, and would bury the signal it exists to surface. A record is therefore an **episode**
— a maximal run of consecutive cycles reporting the same class, reason, symbol and side. The 2026-08-19
risk stop is one record with `cycles: 1,440` and the settlement windows it spanned, not 1,440 records.

Episodes fold on replay, so the fold is idempotent across a reload and across a crash between snapshot
and journal truncation. Compaction writes the snapshot first and truncates second: a crash in between
leaves duplicate evidence rather than missing evidence, and duplicate evidence simply extends an episode.

### 1.3 Operator intent decides `stop` versus `operator`

The control state alone cannot tell a risk stop from a deliberate pause — both read `paused`. AGENTS.md
§4 already keeps operator intent separate from operational state, so the classifier uses it: intent still
`active` while state is `paused` means the system suspended the desk (`stop`); intent `paused` means a
person did (`operator`). This distinction is the single most load-bearing one in the journal, because it
is the difference between "the desk chose not to trade" and "the desk was stopped out".

### 1.4 The join

Records carry the settlement windows open while the episode ran. `windowsWithheldBy(records, 'stop')`
joined against paper orders on `closesAt` turns "paper traded while live was stopped" from a manual
reconstruction into a first-class number. `none` — nothing qualified — is deliberately excluded from
`WITHHELD_CLASSES`: it is the desk working as intended, and pooling it with stop drag would overstate
every channel.

### 1.5 Coverage

Every `skip()` gate in `runLive` journals, and so do the three withholds inside the switch path — a
reduce-only switch exit that did not fill, one that filled partially so the replacement was withheld, and
an uncertain switch retained pending reconciliation. Those three write through `recordSwitchSkip` with
the incumbent's own settlement window; they were missed on the first pass and are called out here because
leaving them would have left the switch path with exactly the single-slot problem this removes.

The first two carry class `fill`. §12.3 decomposes `paper − live` into fill, limit and stop drag, so an
exit that did not fill is fill drag in its own right; folding it into `portfolio` would attribute an
execution failure to a ranking decision.

The one `lastLiveSkip` assignment deliberately left alone reports a *completed* switch. It is a status
line, not a withhold, and journalling it would inflate every drag figure it touched.

### 1.6 What it cannot do

It closes no divergence channel. It has no execution authority, nothing on a money path reads it, and a
failed write is logged and dropped rather than allowed to stall a trading cycle — a gap in evidence is
recoverable, a stalled cycle is a gap in risk control.

## 2. Paper exit fill model

`src/lib/ioc-fill-model.ts` (pure), applied in `executePaperStandaloneExit`.

Before this, `executePaperStandaloneExit` set `status = 'sold'` at the modelled net liquidation value
unconditionally. Every exit paper decided on completed. Live's reduce-only IOC completed 50 of 87
attempts — 57.5% — over the same period. Paper was reporting an outcome live could not have achieved, in
the one place that makes `paper − live` uninterpretable.

### 2.1 The design changed during implementation

The agreed shape was "reuse the entry simulation's own machinery — filled only against observed
aggressive prints at or through that price beyond displayed depth ahead". Reading `placeKalshiSell`
before writing it showed that is the wrong model:

```
time_in_force: 'immediate_or_cancel'
post_only: false
reduce_only: true
→ returns liquidityRole: 'taker'
```

The exit is an **IOC taker**. It never rests, never holds queue position, and never sees a print — it
crosses whatever is displayed at the instant it arrives and cancels the remainder. Modelling it with the
maker machinery would have invented a resting sell order the venue never held, replacing one wrong model
with a differently wrong one. The correct model is a single sweep of the displayed ladder, best price
first, stopping at the limit. This was raised with the maintainer before any code was written.

### 2.2 Deliberate conservatism

- **Displayed size only.** No hidden or iceberg liquidity is inferred, so fills are understated on a
  venue that has it. Kalshi publishes full depth, so the understatement should be small.
- **One instant, one attempt.** Live gets one IOC and so does this.
- **No price improvement**, and each level pays its own price rather than the touch.
- **No market impact.** A sweep that walks several levels would in reality move the book. Nothing models
  that; it matters only if sizing grows enough to walk the ladder.

### 2.3 Missing evidence is not a no-fill

Both new taker paths distinguish "the book says there is no depth" from "there is no book". This was
missed on the first implementation and caught in review before deploy; it mattered more than it looks.

`fetchKalshiManagedMakerQuote` wraps its order-book fetch in `.catch(() => undefined)`, and
`observeKalshiOrderBook` can miss its cache. Sweeping an absent book returns zero, so a data outage would
have been recorded as a genuine `ioc_no_fill` — biasing downward the exact fill rate this change exists to
measure honestly. On the exit it was worse than a bias: `standaloneExitAttemptedAt` permanently disables
retry for both tracks, so one cache miss would have stranded a position with its exit switched off for the
rest of the window.

The entry path now returns the reservation and marks the attempt `rejected`; the exit defers without
stamping anything and is re-evaluated on the next observation. This is the same distinction the managed
maker simulation already draws with `evidenceComplete`, and it should be the default posture for any
future simulated venue interaction: an attempt that could not be observed is excluded, never classified.

### 2.4 What it still cannot mirror

Live can also fail on a venue error, an ambiguous response, or a reconciliation contradiction. Paper has
no analogue for any of those and does not invent one. What is now modelled is the depth question, which
is what decides most real no-fills.

### 2.5 Expected effect on the published paper track record

**It will drop.** Over the reviewed period live's 37 exit no-fills retained positions that went on to
return +55.5% (25 won, 12 lost), so live's failures to exit were profitable and paper was clipping those
same winners at a lower price. Paper's own exits will now sometimes fail in the same way, which removes
an optimism the old number carried. The direction is correct; the magnitude is not predicted here.

The 106 already-recorded costless exits stay in the ledger. They are evidence of what the v3 simulator
did and are not rewritten — AGENTS.md §3. `paperExitFillVersion` distinguishes them so the two cohorts
are never pooled.

## 3. Paper entry route

`spec/policy-and-track-separation.md` §12.2 specifies the paper mirror as an "independent maker simulation with the same versioned episode
boundary **and route decision**". The code did not do the route part: `entryExecutionDecision` was called
only inside `runLive`, and `applyPaperMakerSimulation` hardcoded `liquidityRole = 'maker'`. Every one of
556 paper edge orders was a maker; live had 15 takers. The high-edge IOC route that the whole v4/v5
execution change was about had no mirror at all.

`runPaper` now calls the same function `runLive` calls, on the same inputs, and branches on the result.
The taker branch refreshes the exact contract and re-checks the same two conditions live re-checks — the
one-cent quote cap, and whether the refreshed quote still authorizes taking — before sweeping displayed
depth with the shared IOC model. `post_only_race` remains unmirrorable: it has no meaning for an order
that never rests.

**The mirror invariant is untouched.** This is execution, not the rule layer.
`evaluateEntryExecutionPolicy` is not an entry rule and takes no execution mode; `qualifiesAsBuyEdge`,
`bestEntry` and the rest are unchanged, and `src/lib/mirror-invariant.test.ts` still asserts their arity.

## 4. Channel 1 stays open, on purpose

Paper does not obey live's risk stops, hourly ceilings, or reconciliation gate, and must not. `spec/policy-and-track-separation.md` §12.3
lists these as deliberately per-track: paper's entire value in this channel is measuring **what the stop
cost**. Making the tracks symmetric here would delete the measurement. What was missing was never
symmetry — it was the label, and §1 supplies it.

## 5. Versioning

| Identity | Change |
| --- | --- |
| `PAPER_MANAGED_MAKER_EXECUTION_VERSION` | `paper-managed-maker-requalify3-v3` → `paper-managed-execution-route-ioc-v4` |
| `PAPER_EXIT_FILL_VERSION` | new, `paper-ioc-exit-depth-v1` |
| `LIVE_SKIP_JOURNAL_VERSION` | new, `live-skip-v1` |
| Buy policy | **unchanged.** No entry rule, threshold, size, or gate moved. |

The paper execution bump resets the paper execution cohort. v3 rows remain valid evidence of what the v3
simulator did and must not be pooled with v4 rows.

## 6. What would falsify this

If paper's exit completion rate does not fall toward live's 57.5%, the depth model is not binding and the
no-fills live experiences are caused by something else — latency, reduce-only rejection, or a venue state
this cannot see. The first review should compare completion rates directly, per settlement window, on v4
rows only, and should not be run until there are enough v4 exits to separate from noise.
