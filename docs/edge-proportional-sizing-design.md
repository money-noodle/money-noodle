# Edge-proportional entry sizing — design note

> Status: **proposal, no code.** Written 2026-08-19 against the measurement in
> [reports/edge-buy-opportunities-2026-08-19.md](../reports/edge-buy-opportunities-2026-08-19.md) §1.
> Nothing here is authorized by existing. It ends at §7, a decision for the maintainer.

## 1. What is being proposed

Replace the flat per-trade stake with a bounded multiple of it, set from the decision's own net edge:

```
multiplier = clamp(netEdge / PIVOT_EDGE, MIN_MULTIPLE, MAX_MULTIPLE)
stakeLimitCents = quantize(baseStakeCents × multiplier)
```

with `PIVOT_EDGE = 0.08`, `MIN_MULTIPLE = 0.3`, `MAX_MULTIPLE = 3`. A decision at the current 8pp
median edge keeps today's ticket exactly; a −5pp-to-2pp admission gets roughly a third of it; a 24pp
decision gets three times it and no more.

**Admission does not change.** The entry rule layer takes no sizing input and is untouched, so the
mirror invariant (SPEC §12.3) holds by construction: this is capital, which §12.3 already lists as a
permitted difference between tracks, applied identically to both.

## 2. Why

Measured on the 3,078 admitted decisions of the 9-day cohort, at the ask and held to settlement — the
same rows, the same admission rule, only the weight changed:

| weighting | return per $1 committed |
| --- | --- |
| flat stake (production) | +18.6% |
| stake ∝ net edge | +38.3% |
| full Kelly | +30.1% |
| **capped 0.3×–3×, pivot 8pp** | **+28.9%** |

Better than flat on **9 of 9 days**. The ten highest-edge rows contribute **4.0%** of the capped
arm's profit, so it is not a tail artefact. Restricted to `netEdge < 35pp` — the cohort a re-armed
`MAX_NET_EDGE` would leave — it is +19.9% against +14.8%.

The underlying fact is `reports/edge-magnitude-2026-08-18.md`: return per $1 rises from +11.6% at
5–10pp edge to +44.0% at 25–35pp while the win rate falls. The desk already prices this. Its portfolio
rank is `expectedProfitCents` = `potentialPayoutCents × p − stakeCents`, which at a fixed stake is
`edge / cost` — return on capital. **It ranks by return on capital and then commits the same capital to
every winner.** This proposal makes the two agree.

## 3. Why the caps are the blocker, not the evidence

AGENTS §4: *exposure and correlation caps are global, counted across the whole account. Local caps
summing above the global one are not a cap.*

Today `DEFAULT_MAX_OPEN_POSITIONS = 9`, `maximumSameWindow = 6`, `maximumSameGroupPerWindow = 3` are
**position counts**. At a flat ticket a position count is a dollar cap: nine positions is nine tickets,
and `STATUS.md` reasons about it exactly that way when it records exposure rising "from roughly 21% to
64% of the edge policy's allocation when fully committed — 9 positions at $1 per trade against $14."

At 0.3×–3× that identity breaks. Nine positions is anywhere from 2.7 to 27 tickets, and the worst case
is not hypothetical: the multiplier is highest exactly where correlated candidates cluster, because a
market-wide move admits several assets at a high edge in the same window. **Nine maximum-multiple
positions in one correlation group is the failure this must not permit**, and the current constraints
would not refuse it — `selectPortfolio` counts rows.

So the caps have to become dollar-denominated **before** the sizing rule exists, not alongside it:

- `PortfolioCandidate` gains the stake it would consume, and `PortfolioExposure` the stake it already
  holds. `lib/global-exposure-caps.test.ts` currently asserts that `PortfolioExposure` exposes exactly
  `{ closesAt, symbol }` so no cap can be keyed per provider — that assertion has to be widened
  deliberately, with the reason recorded, rather than quietly relaxed (AGENTS §8).
- Each of the three limits gains a cents ceiling alongside its count, and the **binding one is
  whichever refuses first**. A count limit that no longer binds is not deleted; it stays as the
  backstop for the case where the stake estimate is wrong.
- The account-wide ceiling is set so that the fully-committed dollar exposure is no higher than
  today's `9 × baseStake`. **This proposal must not raise total exposure.** It reallocates it.

## 4. Money arithmetic

- The multiplier is a float applied to a whole-cent base, so it quantizes **once** at the whole-cent
  control boundary before anything reserves against it, per AGENTS §1: `Math.ceil(cost − 1e-9)` for the
  stake limit, so rounding is against us. Budget counters still see only integers.
- The per-trade cap stays **all-in**, fees included. `buildOrder` already sizes quantity down until
  `price × count + fees` fits `stakeLimitCents`; it receives a different limit, not a different rule.
- `maxLiveStakeCents()` (default 25¢, hard ceiling 500¢) and `proposedStakeCents` remain **absolute**
  ceilings above the multiplier, and the multiplier is applied before them: `min(base × multiplier,
  proposedStakeCents, maxLiveStakeCents(), funding.spendableCents)`. A multiplier can never lift a
  stake above an operator-set cap, only below it.
- `reservedStakeCents` is still captured at issuance and every safety ceiling still reads that captured
  value, never a recomputed one (AGENTS §4).
- Exact-arithmetic tests: the multiplier at each clamp boundary, a value landing on a float-representation
  edge, and one asserting that `multiplier × base` never exceeds the operator cap by a single cent.

## 5. What this does not claim

- **It amplifies the sign of the book, and the book is negative.** Live is −4.6% and paper −11.3% on
  the settled v17+ cohort. Sizing by edge does not make a losing policy profitable; it makes it lose
  faster if the edge gradient is a selection artefact of the admitted population.
- The measurement is at the ask, held to settlement, over nine days on one venue. It says nothing about
  what these entries would **fill** at, and the desk fills about half its resting orders and fills the
  worse half (`analyze:loss-decomposition`: fill selection −8.4pp under v19).
- Bigger tickets are not neutral to execution. A 3× order rests more size at one price, which changes
  its queue position and how much of the displayed depth must trade through it. Whether the maker fill
  rate is size-invariant at these sizes is **not measured** and the 2026-08-19 review of the depth
  experiment says the persisted sample cannot answer it.
- Nothing about the `MAX_NET_EDGE` ceiling. It is currently disarmed, and this proposal concentrates
  capital in exactly the band the ceiling used to refuse. Those two decisions interact and should be
  taken together, not separately.

## 6. How it would be refereed

Retroactive screening promotes nothing (AGENTS §5.5), and this was selected by comparing five
weightings on data that had already been examined. The route to a decision:

1. **Walk-forward gains a sizing arm.** `selectedTrade` currently scores buy-at-the-ask-and-hold per
   dollar committed; the candidate dimension needed is the multiplier, held against a flat baseline,
   with the production gate bounds fixed as `WalkForwardParameters` now holds them. Sweeping the
   multiplier while the gate is fixed is the correct shape — sweeping both would let the search
   rediscover a policy by fitting it.
2. **A minimum count of independent settlement windows** with the clustered return of the capped arm
   above the flat arm, and the same drawdown discipline `lib/stake-expansion-policy.ts` already
   applies. Drawdown is the statistic that moves most here, and mean return is not sufficient.
3. **A written promotion reason in the immutable ledger.** This is a manual act.

Note the interaction with the guardrail *"Do not increase stake size from live P&L alone."* This
proposal does not increase the stake ceiling, but it does increase the stake on some trades, so the
same evidence bar applies to it.

## 7. The decision

Three options, and the recommendation is the second:

- **Do nothing.** Costs the measured ~10pp per $1 on the admitted population. Defensible while the
  book is negative: a flat ticket is the smallest thing that can be wrong.
- **Build the dollar-denominated caps first, and only then revisit sizing** — recommended. The caps are
  a strict safety improvement on their own terms and are worth having whether or not sizing ever
  changes; they close a gap that also exists today whenever `perTradeCents` is edited. Sizing then
  becomes a small change on top of a correct foundation rather than a change that quietly removes a
  ceiling.
- **Ship both together.** Fastest to the measured gain, and it couples a safety change to a P&L change
  so that a bad outcome cannot be attributed to one or the other.
