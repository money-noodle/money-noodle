# The entry gate charges a fee the desk does not pay

> Planning document, 2026-08-17. **No code changes with this document, and none should follow until §7
> is decided.** Measured with `data/forecast-history-shards` over 11,479 admitted rows in 2,154
> settlement windows.

## 1. What is wrong

`venueFeeRate` (`lib/prediction-policy.ts`) charges every candidate a Kalshi taker fee:

```
venueFeeRate(kalshi, price) = 0.07 · price · (1 − price)
netEdge = probability − price − feeRate
```

Production executes as a maker, and **Kalshi charges nothing on a resting fill** — 497 live maker fills
at a mean of 0.000c against 0.682c for the 5 taker fills. The gate is deducting a cost the desk does not
incur. At mid price that is **1.75pp, or 35% of the 5pp `MIN_NET_EDGE` threshold.**

This is also the second fee model in a repo whose §1 says fee models live only in `venueFeeCents`.

**The execution layer already disagrees with the gate.** `evaluateEntryExecutionPolicy` receives
`makerNetEdge = probability − bidPrice` — no fee term at all. The maker-is-free assumption is already in
the codebase; only `venueFeeRate` still contradicts it.

## 2. What correcting it actually does — and it is not what I first said

I described this as admitting "materially more candidates". **Measured, it moves 1.0% of volume**, and it
moves in both directions:

| | rows | windows | win | return |
| --- | --- | --- | --- | --- |
| admitted today (fee charged) | 11,479 | 2,154 | 55.7% | +14.7% ±4.0 |
| admitted with the fee corrected | 11,589 | 2,178 | 56.2% | +14.2% ±3.9 |
| **added** by the correction | 201 | 161 | 58.2% | **+2.6% ±13.1** |
| **dropped** by the correction | 125 | 80 | 32.0% | **+23.0% ±36.2** |

Net **+110 rows, +1.0%**. The two marginal cohorts are individually weak and noisy — the added rows
return well under the population mean, and the dropped rows' interval spans nearly fifty points.

**This is a correctness fix, not an opportunity.** Nothing here argues the desk is leaving money on the
table; the honest claim is only that the number it computes should mean what it says.

## 3. The non-obvious part: the correction is not a loosening

Raising every `netEdge` by up to 1.75pp pushes rows *up* through **both** bounds. 201 rows cross
`MIN_NET_EDGE` and are admitted; **125 rows cross `MAX_NET_EDGE` and are refused.**

Those 125 are the cheap, high-claimed-edge cohort the v15 ceiling exists to reject — 32% win rate, the
region §3 of the 2026-08-16 review showed the model is most overconfident in. Correcting the fee makes
the ceiling bite harder, which is the direction that review would want, and it happens as a side effect
rather than by decision.

## 4. No single threshold reproduces today's set

The fee is price-dependent, so removing it shifts each row by a different amount. There is no scalar
`MIN_NET_EDGE` that makes the corrected gate admit exactly what today's admits:

| corrected floor | rows | shared with today | newly admitted | of today's, lost |
| --- | --- | --- | --- | --- |
| 5.00pp | 11,589 | 11,388 | 201 | 91 |
| 6.00pp | 11,379 | 11,331 | 48 | 148 |
| 6.75pp | 11,090 | 11,090 | 0 | 389 |

So "correct the accounting without changing behaviour" — the move that worked for the paper bankroll —
**is not available here.** Any correction changes the admitted set. That is the central constraint on
sequencing (§6).

## 5. Blast radius

`netEdge` is not confined to the gate. Everything below reads it and shifts if its definition changes:

| reader | effect |
| --- | --- |
| `admissibleEntry` (`MIN_NET_EDGE`, `MAX_NET_EDGE`) | the admitted set, §2 |
| `edgeStrength = netEdge × confidence` | **portfolio ranking**, so which candidate wins a cycle |
| `signalEligibility.medianNetEdge` | the persistence median, and its own `MIN_NET_EDGE` floor |
| **v18's freshness gate** (`netEdge − medianNetEdge`) | the spike measure, mid-evaluation |
| `evaluateEntryExecutionPolicy` | `currentNetEdge` is the **taker** edge and must keep its fee |
| `entryDecision.netEdge` on every order | stored; historical rows keep the old definition |
| `analyze-edge-gates.mjs`, `analyze-entry-realization.mjs` | each recomputes the fee independently |

Two of these matter more than the rest. **The execution policy compares a taker path against a maker
path**, so `currentNetEdge` must keep charging the taker fee while the gate stops — one number can no
longer serve both, and the split has to be explicit rather than incidental.

**And v18's spike gate is mid-evaluation.** Its sentinel needs ~60 declined windows and has roughly four
days to run. Changing the quantity it measures resets that evidence.

## 6. Consolidating the two models is not a rename

§1 wants one fee model. But the two express different things:

- `venueFeeCents(venue, priceCents, quantity, role)` — the **charged amount**: whole cents, rounded up,
  with a 1c floor on the taker schedule.
- `venueFeeRate(venue, price)` — a **marginal rate** per $1 of payout, continuous, used inside an
  expected-value comparison.

Deriving the rate from the cents function at quantity 1 would import the 1c floor and the rounding into
a continuous EV calculation, which would distort the gate at small sizes far more than the bug being
fixed. The consolidation that is actually correct is a **shared schedule** — one place holding
`0.07 · p · (1 − p)` and the maker-is-free fact — with two thin accessors over it. That is worth doing
and is not the same change as fixing the gate.

## 7. Options, and what I would recommend

1. **Correct the fee to the maker schedule, keep `MIN_NET_EDGE` at 5pp.** Honest EV, +1.0% volume, the
   ceiling bites harder. Needs a policy version bump and a manifest entry, because the admitted set moves.
2. **Correct the fee and re-derive both thresholds from evidence.** Larger, and the 2026-08-16 sweep
   already says thresholds are flat — so it would be tuning on a surface measured as noise.
3. **Correct the fee only in reporting, leave the gate alone.** Cheapest, and dishonest: it would leave
   the production gate knowingly computing the wrong number while a report showed the right one.
4. **Do the shared-schedule consolidation first, gate unchanged, then decide.** Removes the §1 violation,
   makes the maker fact live in one place, and changes no admitted row.

**Recommendation: 4, then 1, and not before v18's sentinel reports.** Option 4 is behaviour-neutral and
independently correct, so it can land immediately. Option 1 changes what the desk trades for a measured
1.0% of volume whose two halves are individually noise — there is no urgency that justifies disturbing a
running evaluation for it, and the ranking and spike-measure shifts in §5 would confound the sentinel's
read.

## 8. What must not change

- **The taker path keeps its fee.** A taker fill genuinely pays it; `evaluateEntryExecutionPolicy` must
  keep comparing a fee-bearing taker edge against a fee-free maker edge, which is what it already does.
- **The long-shot policy is untouched.** Its entry is an explicit price-capped taker IOC.
- **No stored order is reinterpreted.** `entryDecision.netEdge` on existing rows was computed under the
  old definition and stays that way; any cohort analysis spanning the change must split on policy version.
- **The analysis scripts must be corrected in the same change**, or a report will silently score the new
  policy with the old fee. Each currently carries its own copy of the rate.

## 9. Verification

1. Both accessors derive from one schedule, and a maker rate of zero on Kalshi is asserted directly
   against the 497-fill observation recorded in `venueFeeCents`.
2. A grid over price and role shows the rate and the charged amount agree except for rounding and the
   taker floor, which are the documented differences.
3. The admitted set changes by exactly the 201 added and 125 dropped rows measured here, reproduced by a
   script rather than asserted from this document.
4. `evaluateEntryExecutionPolicy` still receives a fee-bearing taker edge, pinned by a test, since that
   is the one place the two schedules must stay apart.
5. If §7 option 1 proceeds: a policy version bump, a manifest `history` entry with this document as its
   evidence link, and an explicit statement that the change is a correctness fix with a measured 1.0%
   volume effect — not an expected improvement in return.

## 10. Adaptive resolution, 2026-08-19

The premise behind option 1 no longer holds: live execution is adaptive and may legitimately choose either
maker or taker after the shared rule admits a candidate. One global role cannot describe admission,
execution, and counterfactual reporting without making at least two of them wrong.

The maintainer chose a behaviour-neutral semantic split:

- Shared `netEdge` remains taker-priced and is renamed conceptually to **immediate-execution admission
  edge**. `ENTRY_FEE_ROLE` becomes `ENTRY_ADMISSION_FEE_ROLE`; this is conservative for a later maker and
  correct for a later taker. It remains execution-mode independent and preserves the mirror invariant.
- Adaptive selection never reads the admission-role constant. Its taker edge passes `'taker'` explicitly;
  its maker edge passes `'maker'` explicitly.
- Ask counterfactuals use `'taker'`; maker counterfactuals use `'maker'`. The dynamic maker-shadow report
  is corrected accordingly.
- Durable calendar and retired persistence rows are not reinterpreted. Their maker-fee fields were stamped
  under the old taker-role convention; correcting future collection requires a new collection version
  during the collector audit.
- Admission is not flipped to maker. The 1% impact in this document was measured under obsolete thresholds,
  and changing admission now would require a fresh replay, buy-policy version, manifest history, and manual
  decision.

This split changes no admitted candidate, persistence result, ranking, order size, or funded execution.
