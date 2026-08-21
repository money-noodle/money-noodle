# Paper/live mirror fidelity review — 2026-08-21

> **Finding: the first-attempt simulator is materially better and deliberately conservative, but the paper
> track is not yet a complete best estimate of live.** A generation-check defect prevents every current-v4
> paper maker miss from opening episode 2 or 3. No live rule, funded order, or reconciliation path reads
> paper outcomes, so this does not make live unsafe; it does make current paper results incomplete.
>
> No policy or execution change is made by this review. Reproduce the paired measurements with
> `npm run analyze:paper-live-mirror`.

## Question and method

The review asks two separate questions:

1. Does paper make the same decision, route, and size as live when both lanes act on the same signal?
2. Does its public-data execution model reproduce the venue's authoritative fill/no-fill result?

I reloaded `data/paper-orders.json` at **2026-08-21T02:56:54Z** (3,110 rows). The closed paper execution
cohort is `paper-managed-execution-route-ioc-v4`: **103 attempts in 55 settlement windows**, from
2026-08-20T06:09:04Z through 2026-08-21T02:16:39Z. It contains 100 makers and three taker decisions.

The primary comparison pairs one paper row one-to-one with a live row only when symbol, side, exact close,
and episode agree and creation times differ by at most one second. This yields **69 attempts in 41
settlement windows**. A 60-second sensitivity includes serially delayed live drain work and is reported
separately. Fill-rate differences are averaged inside the settlement window before calculating the standard
error over windows.

The caveat that most threatens the result is selection: pairing requires both lanes to issue, so it excludes
paper operation while live was paused, risk-stopped, capital-blocked, or otherwise withheld. It tests the
execution simulator conditional on a shared intent, not the full paper-minus-live track record. Exact FIFO
rank and cancellations ahead are not public, and 41 settlement windows leave a broad interval.

## 1. Decision, route, and sizing parity are strong on first attempts

All **69/69 paired attempts** chose the same maker/taker route and requested the same quantity. Median
creation-time separation was 367 ms. This verifies the intended shared decision and relative-sizing path on
this observed cohort; it does not prove every possible input, which remains the role of the pure-grid and
mirror-invariant tests.

The current paper edge bankroll also ties exactly at this read:

- starting: 10,000¢;
- realized: −2,284¢;
- open edge-policy stake: 0¢;
- available: 7,716¢;
- residual: **0¢**.

An initial dry run while four separately funded long-shot positions held 128¢ produced a false 128¢ residual
because the diagnostic counted their open stake against the edge bankroll. This review narrows that check to
edge-policy open stake; the final dry run reported a 0¢ residual and changed no data.

## 2. First-attempt fill approximation is useful but not individually exact

### Same-start paired results

| Outcome | Attempts |
| --- | ---: |
| Both filled | 15 |
| Paper filled, live did not | 5 |
| Live filled, paper did not | 9 |
| Neither filled | 40 |
| **Total** | **69** |

Fill/no-fill agreement was **79.7%**. Paper filled 29.0% and live filled 34.8%. Averaged by settlement
window, paper minus live fill rate was **−2.8pp ±9.4pp over 41 windows** (95% normal interval). The data do
not establish aggregate over- or under-filling.

The disagreement mechanism is more informative than the aggregate:

- Conditional on **61 venue-accepted live makers**, agreement was **85.2%**: 15 both filled, nine
  live-only, 37 neither, and **zero paper-only fills**. The simulator captured 62.5% of authoritative live
  fills and every simulated fill in this accepted subset was also a live fill. That is conservative, not
  live-equivalent.
- The five paper-only rows all occurred before a live order became authoritative: four were post-only
  create races rejected on all bounded attempts; one durable live intent reconciled to no accepted venue
  order. Paper explicitly does not model venue acknowledgement races or ambiguous signed submission.
- Both-filled rows acquired the same quantity in 15/15 cases. Paper paid 0.400¢ more per contract on
  average than live over those 15 attempts. The sample is too small to calibrate a price adjustment.

Expanding pairing to 60 seconds gives 73 pairs and 78.1% agreement (15 both, five paper-only, 11 live-only,
42 neither). The lower agreement is expected: paper manages selected candidates concurrently while live
serializes funded orders, so later live orders can begin 15–17 seconds after their paper counterpart and are
no longer observing the same book.

### Why the simulator is conservative

`simulateManagedPaperMaker` shares live's pure initial and progressive price functions, uses the same
six-check/two-second nominal management path, preserves issuance-sized quantity, and requires public
opposite-taker trade volume at or through the bid to consume all displayed queue ahead. Ask touch alone is
not a fill. Missing final trade evidence is excluded rather than scored as a miss.

That physical rule has a known blind spot: it subtracts trades but not orders canceled ahead. A real order
can move forward when earlier orders cancel and fill without enough public aggressive volume to deplete the
initial displayed proxy. The accepted-order result—no paper-only fills but eight missed live fills—is
consistent with that mechanism, though this sample cannot prove it is the only cause.

Kalshi exposes exact `queue_position_fp` for the account's real resting orders, as documented and verified in
`reports/kalshi-order-size-and-fill-mechanics-2026-08-20.md`; the repo does not collect it. Public displayed
size is therefore not “as close as possible” yet.

Manager wall time also needs better evidence. Paper's median/p90 were 12.645/13.099 seconds, close to live's
13.756/14.378 seconds, but three paper rows exceeded 30 seconds and one completed after 196.930 seconds.
The durable record does not retain the consuming print timestamps or volume, so it cannot show whether the
late response discovered a trade inside the intended 12-second horizon or admitted a later trade. This is
an observability gap, not enough evidence to rewrite the row.

## 3. Current paper requalification is broken

This is a deterministic implementation defect, not a statistical concern.

During the paper-v4 period:

| Lane | Episode 1 | Episode 2 | Episode 3 |
| --- | ---: | ---: | ---: |
| Paper | 103 attempts / 30 fills | **0 / 0** | **0 / 0** |
| Live | 81 / 28 | **14 / 2** | **5 / 2** |

`runPaper` asks `adaptiveEntryEpisodeDecision` to validate the paper simulator identity
`paper-managed-execution-route-ioc-v4`. But `adaptiveEntryEpisodeDecision` first reads
`entryExecutionDecision.policyVersion`; production-shaped v4 paper rows carry the shared live route identity
there (`maker-high30-requalify3-fresh1c-v5`, and v6 for new rows). The values can never equal, so every
completed paper maker zero-fill is classified as a prior generation and can never rearm.

The paper unit test misses this because it deletes `entryExecutionDecision` from its fixture, unlike every
production v4 row. This violates `docs/requalifying-entry-episodes-design.md` §§5–6 and SPEC §12.2's promise
of the same versioned episode boundary.

The 19 later live episodes and their four fills are not a direct estimate of what corrected paper would
have done: paper's independent first episode can disagree with live and therefore open a different retry
population. They do establish that the missing path is reachable and material, not inert.

## 4. IOC entry and exit evidence

The route call itself is wired correctly on the paired sample, but IOC entry validation is not mature:
current paper v4 has only **three taker decisions**, with two paired live taker decisions; neither paired
attempt filled. This cannot validate taker depth, partial fills, or fees.

The new paper exit model is directionally encouraging but also small:

- paper depth-model exits completed **7/13 (53.8%)**;
- contemporaneous live exits completed **10/17 (58.8%)**;
- same-position, same-second decisions agreed **7/8 (87.5%)**.

These are different selected populations except for the eight pairs. No conclusion beyond “the model is
binding and no longer completes every paper exit” is supported.

## 5. Reporting currently overstates what is measured

`MakerFillReport.matchedLivePaper.matchedIntents` is conditioned on an authoritative live fill because the
overlay is attached only from `attachMatchedLiveFillShadow`. It can count both-filled and live-only rows,
but not paper-only or neither-filled rows. Its current 240 “matched intents” therefore cannot report overall
paper/live agreement and should not be read as a validation denominator.

The existing matched-live overlay remains useful as an authoritative, non-accounting counterfactual. It
should not replace the independent paper outcome, but a separate complete pair record is needed to evaluate
the simulator honestly.

## 6. Recommended improvements, in order

### A. Restore the intended episode boundary first

1. Make execution-generation validation lane-aware on production-shaped orders rather than preferring the
   shared route identity for paper.
2. Add an integration test retaining both `entryDecision.executionPolicyVersion` and
   `entryExecutionDecision.policyVersion`.
3. Bump the paper execution identity and leave v4 history untouched; the corrected cohort must start fresh.

This changes paper execution, not the buy rule or funded lane, but it requires an agreed design/version record
before code under the repository's process.

### B. Build a complete prospective pair evaluator

Stamp a stable observation-only pair identity when both intents arise, then report all four fill/no-fill
cells, route, quantity, timing, partial completion, and price/fee differences by paper execution generation.
Do not infer pairs retrospectively by nearest timestamp and do not condition the denominator on a live fill.
Paper P&L must remain independent of this evaluator.

### C. Collect exact live FIFO evidence

For each accepted live maker and every price-changing amendment, collect the authenticated
`queue_position_fp`, venue order creation timestamp, fill timestamps/IDs, and remaining quantity. This is
observation-only and cannot gate or size an order. It would reveal how much the displayed-ahead proxy misses
because of cancellations, latency, and actual priority.

For paper, durably record the bounded consuming print evidence—time range, count, quantity through each
price, and queue-ahead changes—so every simulated fill can be replayed. Then fit or validate a cancellation
adjustment on held-out live pairs; do not introduce random pseudo-fills or reuse the inverted quote-touch
model.

### D. Remove live self-interference in evaluation

When both lanes run, later public books can include the desk's real resting order. An offline ex-self replay
should subtract the known live remainder at its exact price and separately show the authoritative matched-live
overlay. Do not feed authenticated live state into the paper money path merely to improve a report.

### E. Keep two questions separate

Current paper deliberately ignores live risk stops, hourly limits, reconciliation blocks, and live capital.
That is necessary for measuring stop/limit drag under SPEC §12.3, but it means paper is not a literal forecast
of everything the funded account will do “in any situation.” If the desired product is an exact operational
live twin, add a separate non-money lane that clones those controls. Replacing the existing paper mirror with
it would delete the stop-drag measurement and should be a separate SPEC decision.

## Decision

Do not use the v4 paper track as a complete estimate of live execution across requalifying episodes. Its
first-attempt maker model is useful, conservative, and substantially closer than the retired ask-touch model,
but it misses about one third of accepted live fills in this small paired cohort and cannot model submission
races. Nothing here is financial advice.

## Resolution, 2026-08-21

The approved repair advances paper execution to
`paper-managed-execution-route-ioc-requalify3-v5`. Paper generation validation now reads the paper simulator
identity even when the production row also carries the shared v6 route identity; v4 misses cannot authorize
v5, and production-shaped tests pin the distinction.

New edge intents carry prospective exact `entry-execution-mirror-pair-v1` IDs derived from the complete
decision calculation and episode. The authenticated maker report now exposes all four terminal outcome cells,
one-sided intents, ambiguous IDs, route/quantity agreement, live-fill capture, and both-fill price/quantity
differences. No historical nearest-time pair is backfilled and the public projection receives neither pair
IDs nor the live report.

Each successful paper maker trade read now retains bounded queue-consumption evidence: read timing,
consuming print count/quantity and venue-time bounds, queue ahead before/after, and fill added. Fill arithmetic
is unchanged. Exact authenticated `queue_position_fp` reads remain deferred because they would contend with
the signed-read budget used for authoritative fills and reconciliation; adding an observation that can delay
a money-state read would violate the isolation requirement. See
`docs/paper-live-mirror-fidelity-repair-design.md`.

Typecheck, lint (0 errors / 37 inherited warnings), 121 test files / 1,007 tests, and the production build
passed. The active funded worker was pause/drained with zero positions and reservations before restart.
Startup reconciliation completed READY at `2026-08-21T02:55:42.322Z`; control remained operator-paused and
restart-safe. The signed performance route exposed a clean zero-row prospective pair cohort, as expected
before the first v5 intent. No funded execution was resumed automatically.
