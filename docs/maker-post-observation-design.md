# Observing whether the sentinel's entries would have filled

> Design document, 2026-08-18. Agreed in prose with the maintainer before any code. It adds durable
> per-intent fill observation to `persistence-two-consecutive-v1` (SPEC §12.5, §706) and retires a
> reported number that cannot be wrong.
>
> **No policy change follows from this.** It is instrumentation on an observation-only evidence store. It
> places no order, reserves no budget, gates nothing, and has no return path into production policy.

## 1. What is wrong

The sentinel's maker benchmark is computed in `resolveIntent` (`lib/persistence-candidate-store.ts`) as

```
makerExpectedProfitPerContract = ((won ? 1 : 0) − bidPrice − estimatedMakerFeeRate) × makerFillProbability
                                  └──── settlement return at the bid ────┘          └──── 0…1 ────┘
```

and surfaced on the performance dialog as **"Maker-touch benchmark · empirical fill-weighted"**
(`components/performance-dialog.tsx`). Three things are wrong with it, in order of force.

**It assumes filling is independent of the outcome.** The desk's own measurements say the opposite: filled
entries win about 19pp less than unfilled ones ([loss-decomposition-2026-08-18.md](../reports/loss-decomposition-2026-08-18.md),
[edge-policy-review-2026-08-17.md](../reports/edge-policy-review-2026-08-17.md)). Multiplying an
unconditional return by a fill rate prices the fill as a random draw, which is exactly the assumption the
adverse-selection finding refutes.

**It cannot disagree with the ask benchmark.** `makerFillProbability` is a positive scalar, so the product
never changes sign or ranking relative to the ask number. For the current v19 cohort the fill probability
ranges 43–70% with a mean of 50.8% — shrunk hard toward a 0.55 base rate by a 20-attempt prior — so the
tile is approximately the bid-priced return times a constant one-half:

| tile | v19 cohort, 96 resolved incremental intents |
| --- | --- |
| ask benchmark | +13.08¢ per $1 |
| bid-priced return (price effect, not displayed) | +14.96¢ per $1 |
| "maker-touch benchmark" | +7.63¢ per $1 = 14.96 × 0.51 |

A number that cannot contradict the one beside it is not a benchmark. It is a unit conversion.

**It is not touch, and touch would be worse.** The label is wrong: touch is `touchProbability`, kept as a
diagnostic, and `lib/maker-fill-model.ts` documents it as *inverted* against reality — bucketed by its own
prediction, observed fill rates ran 66/61/57/52% against predictions of 12/41/64/86%, because the mechanism
is queue position and touch cannot see it.

## 2. What production actually does, which the simulation must match

A resting entry is **not a static post**.

- `initialManagedMakerPrice` (`lib/managed-maker.ts`) joins or improves the selected side's bid, stays one
  tick below the ask, and never exceeds the issuance cap.
- `nextManagedMakerPrice` then runs `MAKER_MANAGEMENT_CHECKS` = 6 checks across the 12-second
  `MANAGED_MAKER_HORIZON_SECONDS`, one every 2 seconds, ratcheting the limit up a linear ramp from the bid
  toward the passive ceiling on checks 0–4. The price is monotonically non-decreasing. The 6th check is
  terminal-only.
- Live retries once by default (`maximumLiveMakerAttempts`), paper twice, with a 30s cooldown and no retry
  inside the final 120 seconds (`lib/maker-retry-policy.ts`).

Simulating a static post at the bid would understate fills, because production climbs toward the ask as its
horizon expires. **The ladder is the primary arm.** The static post is recorded alongside it as a
conservative floor, and both come free from the same prints.

Retries are **out of scope for v1** and are recorded as unmodelled. The first attempt is what
`persistence-two-consecutive-v1` is about; adding attempts multiplies the observation window without
changing the question.

## 3. What must be observed, and when

The three inputs split by whether they can be recovered after the fact. This is what makes the instrument
cheap.

| input | recoverable later? | source | cost per intent |
| --- | --- | --- | --- |
| queue ahead at each rung | **no** — depth is not historical | `fetchKalshiOrderBookNow` + `selectedSideDepth` | 1 request, at intent creation |
| the reprice ladder (bid/ask at each 2s check) | **already durable** | `contract-paths.journal.jsonl`, 2-second cadence | free |
| volume traded at or through each price | **yes** | `fetchKalshiTradePrintsSince(ticker, sinceMs)` | 1 request, after the horizon |

**Two new venue requests per intent**, against twelve for the naive poll-every-check design. Both endpoints
are public and unauthenticated.

One book snapshot serves every rung: Kalshi returns all levels, so `selectedSideDepth(book, side, bid, ask,
rung)` yields `displayedAhead` at each price on the ladder from a single fetch. That snapshot is taken at
post time and is therefore up to 12 seconds stale by the last rung — recorded as a limit, not corrected.

**The 2-second contract path is the substrate for the ladder**, and this design depends on it continuing.
At the previous 15-second cadence the ladder could not be reconstructed at all; each rung is a 2-second
check, so a 15-second sample sees one rung in six.

## 4. The fill rule

The rule is the one already written and tested in `lib/maker-depth-experiment.ts`: a post fills once
cumulative volume **at or through its price** exceeds the size displayed ahead of it at posting.
`openPost`/`applySample` are reused rather than reimplemented. Size ahead is fixed at posting — a level
that grows behind us does not delay a fill and a cancellation does not advance it; only executions do.

**One refinement over the existing experiment.** `scripts/experiment-maker-depth.ts` attributes every print
at or below the post price to that side, without reading `takerSide`. Both directions print at the same
price, so that counts trades that lifted an ask as if they had hit our bid, which is permissive. A resting
YES (UP) bid is consumed only by a taker buying NO, and a resting NO (DOWN) bid only by a taker buying YES,
so v1 filters on `takerSide`. The permissive rule is retained only where the data has already discarded
`takerSide` — see §7.

Both arms are evaluated against the same prints:

```
ladder  post walks bid → passive ceiling over 6 checks; at each rung, queue ahead is read from the
        posting snapshot at that rung's price, and consumed volume carries across rungs
static  post held at the initial bid for the whole horizon
```

## 5. Where it runs, and the boundary it moves

`scripts/experiment-maker-depth.ts` states its boundary plainly: it is deliberately not wired into
`processCycle`, because "a standalone process cannot delay, gate, size, price, or trade, because it is not
on that path at all". That boundary is being moved and the move should be recorded rather than glossed.

What makes it acceptable: **the sentinel is already detached.** `lib/paper-execution.ts` calls
`void persistenceCandidateCycle(...)` — the result is never awaited by the execution path and cannot delay
it. The observer hangs off that same detached call, so nothing new lands on the critical path.

Constraints that keep it that way, all of which fail toward recording less:

- A hard per-cycle request cap. Over it, intents record `unobserved`.
- No retries. A failed or timed-out request records `unobserved`.
- Observation never blocks intent creation: the decision-time record is written first and independently, as
  it is today.
- Public unauthenticated endpoints only — the same two the experiment script already uses — so signed
  trading calls do not share the path.
- Coverage is reported, never assumed. `unobserved` is a first-class outcome and appears in the report.

## 6. Schema, append-only

New optional fields on `PersistenceCandidateIntent`, written once when the observation completes. **No
existing field is mutated or removed**, because the store is committed evidence and rewriting the meaning
of a recorded field mid-cohort silently blends two definitions across the 609 intents already there.

| field | meaning |
| --- | --- |
| `makerObservationModel` | version string, `maker-post-observed-v1`; absent means never attempted |
| `makerPostCents` | the initial post price the ladder starts from |
| `makerQueueAheadCents` | displayed size ahead at the initial post, from the posting snapshot |
| `makerLadderFill` | `filled` \| `unfilled` \| `unobserved` |
| `makerLadderFillCents` | the rung it filled at |
| `makerLadderFillAt` | when, within the horizon |
| `makerStaticFill` | same three states, post held at the initial bid |
| `makerStaticFillCents` | the static post price, for symmetry |
| `makerObservationSource` | `live-2s` \| `depth-experiment-60s` — see §7 |
| `makerRealizedProfitPerContract` | settlement return at the observed ladder fill price, written at resolution and only when `makerLadderFill === 'filled'` |

`makerExpectedProfitPerContract` and `makerFillProbability` **stay exactly as recorded.** Nothing is lost
by leaving them: both are re-derivable from `bidPrice`, `estimatedMakerFeeRate`, `outcome`, and
`makerFillProbability`, all of which are already durable.

## 7. The backfill, labelled separately

`data/maker-depth-experiment.jsonl` covers 2026-08-18 03:11–19:47 at 60-second cadence, and **108 of the
114 sentinel intents created during that run have coverage, 104 with at least two samples after the
intent.** Those intents are the v19 cohort, which is the one §706's scoping rule counts.

They are backfilled, and they are **not pooled with live observations**. `makerObservationSource`
distinguishes them, the report groups by it, and no figure blends the two. Three differences make them a
weaker method, all in the same direction of being coarser rather than wrong:

- **60-second samples against a 12-second horizon.** Volume through a price is exact whatever the cadence
  because prints are cumulative between samples, but the ladder's rungs cannot be resolved. The backfill
  therefore scores the **static arm only**; its ladder result is `unobserved`.
- **`takerSide` is already discarded** in `tradedVolumeByPrice`, so the backfill necessarily uses the
  permissive rule of §4 and will fill slightly too often.
- Queue ahead comes from the sample preceding the intent, up to 60 seconds stale, rather than from a
  snapshot at post time.

The backfill is a bridge for one day, worth having because the live cohort starts at zero. It is not the
measurement.

## 8. What the report changes to

`buildPersistenceCandidateReport` stops presenting `meanIncrementalMakerExpectedProfitPerContract` as the
maker benchmark. It reports instead, over resolved incremental intents:

- **observed fill rate**, ladder and static, with coverage and an explicit `unobserved` count
- **return conditional on an observed fill** — clustered on the settlement window, the number a promotion
  decision needs and the only one here that can contradict the ask benchmark
- **the price effect alone**: the bid-priced settlement return, never multiplied by a fill rate

The dialog tile is relabelled off "Maker-touch benchmark", which was wrong in both halves.

The same `return × p_fill` product exists in `lib/calendar-evaluation-store.ts` and `lib/maker-shadow.ts`.
Those are **out of scope here** and left as they are; this document does not silently redefine a number two
other surfaces still compute.

## 9. Limits, worst first

- **A simulated post is not a filled order.** It cannot see hidden or iceberg size, and it cannot know that
  our own resting size would have changed the book or that we would have been queue-jumped by a later
  improvement. Sitting behind all displayed size is conservative; ignoring queue-jumping is optimistic. The
  errors do not cancel and their net direction is unknown.
- **None of the 609 existing intents can be retro-fitted** beyond the one-day backfill, because depth is
  not historical. The live cohort starts at zero and accrues at roughly 100 intents a day.
- The posting snapshot is up to 12 seconds stale by the last rung of the ladder.
- Retries are unmodelled; only the first attempt is observed.
- Kalshi only, one strategy, one candidate.
- Fill and settlement remain jointly distributed: this measures whether a fill happened, and reports the
  return conditional on it, which is the point — but the conditional cohort is still small and its interval
  will be wide for some time.

## 10. What this does not authorize

Nothing. It produces the missing input to `persistence-two-consecutive-v1`'s first review; it does not
conduct that review, and it does not promote anything. Promotion remains a manual act recorded in an
immutable ledger, requiring committed sentinel evidence, the stated minimum of independent settlement
windows, a clustered return clearing a stated threshold, and a written reason (AGENTS §7, SPEC §12.5).

Review timing is the maintainer's call, taken daily against the accruing cohort.
