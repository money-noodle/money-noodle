# Paper is charged a taker fee on maker fills

> Design written before the code, 2026-08-17. Defect found while asking why the paper track lost more
> than live under one shared entry policy. **No code changes with this document.**

## 1. What is wrong

`estimatePaperFill` reserves a conservative **taker** fee, and the comment on `venueFeeCents` (`lib/venue-fill.ts`) states the intended
contract in as many words:

> Conservative taker-fee reserve; actual maker fees come from Kalshi fill records and unused cash is released.

Live honours it. On a fill it takes `fill.feeCents` — sourced from Kalshi's `average_fee_paid`
(`placeKalshiBuy`/`placeKalshiSell`, `lib/live-orders.ts`) — recomputes the all-in cost, and returns the difference with
`releaseTradingBudget` (`executePreparedLiveBuy`, `lib/paper-execution.ts`).

Paper never releases. At the equivalent point it *recomputes the taker fee*:

```
const feeCents = venueFeeCents(order.venue, result.averagePrice * 100, result.filledCount);
```

That is the defect, and it is one line, in `applyPaperMakerSimulation` (`lib/paper-execution.ts`).

## 2. The venue's own answer, across every live fill

Grouped by the liquidity role Kalshi itself reported:

| role | fills | non-zero fees | mean | max |
| --- | --- | --- | --- | --- |
| maker | 497 | 22 | **0.000c** | 0.02c |
| taker | 5 | 5 | 0.682c | 0.85c |

Kalshi charges a real fee on aggressive fills and effectively nothing on resting ones. The 22 non-zero
maker fees are all at or below 0.02c — rounding dust, not a schedule.

This is an authoritative live API response over 497 fills, which is the evidence standard §6 of the agent
rules requires for venue mechanics. It is not an inference from a published fee table.

## 3. Size of it

Under v17, settled entries only, read at 2026-08-17T07:17:38Z:

| | as recorded | entry fee removed |
| --- | --- | --- |
| live | −427c on 13,259c = **−3.22%** | unchanged (it pays none) |
| paper | −1,299c on 15,729c = **−8.26%** | −664c = **−4.22%** |
| **gap** | **5.04pp** | **1.00pp** |

Paper paid **635c of entry fees across 119 entries — 4.04% of stake.** Live paid 0c.

On the 76 decisions where both tracks bought the identical contract, so selection cannot differ:

| | as recorded | fee removed |
| --- | --- | --- |
| live | −2.98% | −2.98% |
| paper | −5.56% | **−1.39%** |

On identical decisions paper is *better* than live once the phantom fee comes out. Roughly four fifths of
the apparent paper underperformance is an accounting artefact.

## 4. Why this is not merely a reporting bug

The reserved fee is charged against a hard all-in cap, so it propagates into behaviour:

1. **Sizing.** `estimatePaperFill` shrinks quantity until `price × count + fees` fits the cap, so paper
   buys less exposure per cent. On the shared subset paper's payout-to-stake is 2.391 against live's
   2.550 for the same decision.
2. **Budget.** Paper's bankroll draws down faster, so it reaches its caps sooner and declines entries
   live would take.
3. **Exits — the one that matters.** `applyExitObservation` feeds `evaluateExitPolicy` both an
   `exactCostCents` inflated by the phantom entry fee and an `exitFeeCents` from the same taker model.
   Cost basis and exit fee both move, so `netProfitPercent`, the +75% profit-lock arming point, and the
   strict-value `netLiquidationCents >= optimisticHoldValueCents + minimumGain` test all shift. **Paper
   is making different sell decisions**, not just recording the same ones differently.
4. **The published record.** Paper is the public track record and the Postgres projection, so the
   published figures understate the paper desk.

Fixing only the reported number would leave 1, 2 and 3 in place. That is the reason this is a design
document rather than a one-line change.

## 5. Why nothing caught it

The mirror invariant governs the entry **rule** layer — it asserts that layer takes no execution mode
(`lib/mirror-invariant.test.ts`). Tracks are *permitted* to differ in fill model, budget and sizing; SPEC
§12.3 says so deliberately. This divergence hid inside that permission.

It arrived with the 2026-08-14 mirror alignment (`6c58054`, "Execute paper as a maker so the mirror
matches live"). Paper's *execution* became maker; its *fee model* stayed taker. The lesson worth writing
down is that "paper mirrors live" is narrower than it sounds, and the execution-side gap it leaves open
has no invariant watching it.

## 6. The fix

**Extend `venueFeeCents`, never fork it**, per §1 of the agent rules — fee models live in one function.

```
venueFeeCents(venue, limitPriceCents, quantity, role: 'maker' | 'taker')
```

`role` is **required, not defaulted**. A default would silently keep every existing call site on the taker
schedule, which is precisely the present bug. Making it required forces each of the seven call sites to
declare what it is, and breaks the compiler until they do.

Call sites and their correct role:

| site | role | why |
| --- | --- | --- |
| `estimatePaperFill` reserve | taker | conservative; the desk cannot know at issuance how it will fill, and reserving low would breach the all-in cap |
| `applyPaperMakerSimulation` | **maker** | the simulated fill is a managed maker fill |
| `applyExitObservation` | taker | live's reduce-only exit reports `liquidityRole: 'taker'` (`placeKalshiSell`, `lib/live-orders.ts`) |
| `bestSwitch` | taker | same |
| `buildOrder` minimum-size probe | taker | sizing headroom, matches the reserve |
| `longShotCycle` entry | taker | its entry is an explicit price-capped taker IOC |
| `longShotExitFeeCents` | taker | reduce-only IOC |

Then paper mirrors live's release: settle the fill at the maker rate and return
`reservedCents − accountedStakeCents` to the paper bankroll, which is the line paper already has and
currently computes from the wrong fee.

**The Kalshi maker rate is 0**, documented with the 497-fill observation and its date. Not because zero is
elegant, but because it is what the venue reports. This is a modelled constant on the paper side, so it
can go stale silently — §8 covers that.

## 7. What must not change

- **The reserve stays taker.** Paper and live must size identically at issuance or the tracks diverge in
  quantity, which is a far worse problem than the one being fixed.
- **Exits stay taker on both tracks.** The desk's exits genuinely cross the spread.
- **The long-shot policy is untouched.** Its entry really is a taker IOC; its fees are correct today, and
  a careless "maker everywhere" change would silently under-charge a second live strategy.
- **No ledger is rewritten.** §3 of the agent rules forbids hand-editing durable state, and the 119
  affected v17 paper orders are evidence of what the desk did. They stay.
- **`BUY_POLICY_VERSION` does not move.** The entry rule is unchanged; this is execution. Bump the paper
  execution identifier (`paper-managed-maker-trade-queue-v2`, set in `buildOrder`, `lib/paper-execution.ts`) instead, so
  pre-fix and post-fix paper cohorts are separable in every report that groups by it.

## 8. Guarding against a stale constant

Live reads the real fee from the venue on every fill, so live is self-correcting and only paper carries a
model. If Kalshi introduces a maker fee, paper silently becomes optimistic — the same failure as today
with the sign flipped.

The check should use the evidence the desk already collects: compare the assumed maker rate against the
observed distribution of live maker fees and report drift on the maker report surface. Observed, not
auto-applied — a fee model that refits itself from the ledger would make a money path depend on data
whose own correctness it is supposed to test.

A unit test cannot cover this, since it would have to read live data to be meaningful. The unit tests
should instead pin the two schedules and the rounding direction, per §1's requirement that every money
path gets an exact-arithmetic test.

## 9. Consequence that is deliberately out of scope

**The entry gate charges the same phantom fee**, through a second fee model:

```
venueFeeRate(venue, price) = 0.07 * price * (1 - price)   // lib/prediction-policy.ts
netEdge = probability - price - feeRate
```

At a mid price that deducts ~1.75pp from every candidate's net edge for a fee maker entries do not pay.
`MIN_NET_EDGE` is 0.05, so the gate is under-crediting edge by roughly **35% of its own threshold**, and
correcting it would admit materially more candidates.

That is an entry-policy change. It needs its own evidence, its own version bump and its own manifest
entry, and it must not be smuggled in on the back of an execution fix — particularly not while v18 is
still accruing its first sentinel windows. Recorded here so it is not lost, and explicitly not done.

It also means the repo has two fee models despite §1 saying fee models live only in `venueFeeCents`.
Consolidating them is worth doing and is its own change, because one is a per-contract cost in cents and
the other a rate per $1 of payout, and merging them carelessly would move the entry gate.

## 10. What the fix invalidates

- **`reports/edge-policy-review-2026-08-17.md` paper P&L figures need a correction note.** Paper's
  −9.4% is roughly −4.2% on a like-for-like basis with live. The **win-rate findings are unaffected** —
  §2's fill selection and §3's edge spike never touch fees, so both stand as written.
- The v18 sentinel's `realizedEdge` prices entries at `askPrice + estimatedFeeRate` using the taker rate.
  Both arms use it identically, so the comparison is unbiased; only the level is pessimistic. Worth
  correcting when §9 is addressed, not before.
- Any paper-versus-live comparison made since 2026-08-14 is affected. The maker report's matched-fill
  counts are not, since those are counts rather than money.

## 11. Verification

1. `venueFeeCents` unit tests pin both schedules, the 1c floor on taker, the rounding direction, and a
   value on a float-representation edge.
2. A paper fill settling at the maker rate releases exactly `reserved − accounted` to the bankroll, and
   the budget ledger balances — the property `lib/budget-ledger.test.ts` already guards.
3. `estimatePaperFill` still sizes against the taker reserve, so paper and live quantities agree for the
   same stake cap and ask. This is the regression most worth pinning: it is the thing §7 says must not
   change.
4. `npm run typecheck` must fail before the call sites are updated. If it passes, `role` was given a
   default and the fix is incomplete.
