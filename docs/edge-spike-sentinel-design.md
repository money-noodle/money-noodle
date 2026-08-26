# Edge-spike gate and its sentinel

> **Document type:** Policy design
> **Design status:** Superseded
> **Implementation:** Removed
> **Created:** 2026-08-17
> **Canonical requirements:** [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> Design written before the code, 2026-08-17. Evidence: [reports/edge-policy-review-2026-08-17.md](../reports/edge-policy-review-2026-08-17.md) §3.
> Ships as buy policy v18 with `edge-spike-sentinel-v1` recording every decision the gate declines.

## 1. What is being changed and why

`signalEligibility` already computes `medianNetEdge` over the qualifying persistence snapshots and stamps
it on every entry decision. Nothing has ever read it as a gate. The 2026-08-17 review found that decisions
where the firing edge sat **2pp or more above that median** won 34.0% against 58.7% for the rest, over 228
deduplicated `(symbol, window, side)` decisions, window-clustered at t = 2.30 on return and t = 3.18 on win
rate — repeating inside every net-edge band and on 6 of 6 assets.

The mechanism came before the cut, which is the only reason this is worth acting on: an edge that has just
jumped above its own recent level is a price that has just moved, and the direction it moved is against the
side the jump makes look cheap. The desk was buying dips in contracts that were dipping because they were
losing, and then resting a passive limit below that, which fills only if the move continues.

## 2. This is not a promotion, and the record must not claim it is

The threshold was chosen after looking at the bins, on three days of data, with paper's own clustered
interval spanning zero. Under §5.5 of the agent rules that is retroactive screening and it promotes
nothing.

**The change is made on an asymmetry, not on the evidence clearing a bar**, and the manifest entry says so:

- If the effect is not real, the desk declines ~25% of decisions and ~30% of stake that are as good as the
  rest. The book is realizing −4.3% live, so the marginal realized return on that volume is negative and
  declining it costs approximately nothing today. The opportunity cost only appears once execution is
  fixed and the book turns positive.
- If the effect is real, waiting costs roughly 680c/day of live book against 1,705c available in the epoch.

That asymmetry is what authorizes the change. It is also what makes the rollback criterion obvious: if the
sentinel's declined arm comes back at or above the admitted arm over enough independent windows, the gate
goes, because the reason for it was never that the evidence was strong.

The precedent that governs the tone here is the v14 DOWN suspension, withdrawn seven days later when its
figures could not be reproduced from the authoritative order ledger under four P&L conventions and eight
time cutoffs. The failure mode was not "a restrictive gate shipped"; it was **a number computed in an
analysis script that did not survive recomputation**. The sentinel exists so that this one is recomputed
prospectively, from data written at decision time, rather than re-argued from the same script.

## 3. Where the gate goes

In `evaluateSignalPersistenceWithRequirements` (`lib/signal-persistence.ts`), as a declared member of
`SignalPersistenceRequirements` rather than a hidden constant.

That layer is correct for three reasons. It is the only place that holds both the firing edge and its
persistence median. It takes no execution mode, so live and paper cannot diverge and the mirror invariant
holds by construction. And `executionEligibility` is the single chokepoint both `runLive` and `runPaper`
already call.

Making it a *requirement* rather than an inline constant matters for the two-snapshot persistence
candidate lane, which calls the same evaluator directly. That candidate exists to measure snapshot count
and span; it passes the production spike threshold explicitly so it keeps differing from production in one
variable only.

The rule itself lives in `lib/edge-spike-policy.ts` — pure, I/O free, no persistence types — so the gate,
the sentinel, and the policy manifest all read one constant, and the rule can be tested over a grid of
inputs rather than through a fixture.

**Tolerance.** A decision is admitted only when `spike + 1e-12 < maximum`: strictly below, with the epsilon
on the refusing side, matching the 1e-12 used for probability and edge gates elsewhere. A spike of exactly
2pp is refused, which is the cohort boundary the review measured (`spike >= 0.02` was the losing arm). A
tolerance that eased this gate would be a bug.

## 4. What the sentinel records

`edge-spike-sentinel-v1`, in `data/edge-spike-sentinels.json`.

**Committed at decision time, not fill time.** Derived from fills it would inherit every selection bias of
the executing lane — budget exhaustion, cap blocks, maker no-fills — and would answer "conditional on
having successfully bought", which is a different and flatteringly selected question. This is the same
reason `lib/hold-sentinel.ts` commits at trigger time, and it matters more here than there, because the
review's §2 showed maker fills are themselves adversely selected in exactly this cohort.

One record per `(symbol, side, closesAt)`, written when a decision passes **every other** persistence gate
and reaches the spike check. Both arms are recorded from the same evaluation:

| field | meaning |
| --- | --- |
| `admitted` | whether the spike gate let it through — this is the arm label |
| `edgeSpike` | the continuous value, so the threshold can be described but not re-chosen |
| `netEdge`, `medianNetEdge` | the two inputs, so the value is recomputable rather than trusted |
| `askPrice`, `estimatedFeeRate` | priced from the executable ask at decision time |
| `outcome`, `resolvedAt`, `realizedEdge` | patched in once at settlement; nothing else is ever rewritten |

Recording both arms from one evaluation is what makes the comparison fair: they are scored by the same
code path, at the same moment in the window, on the same population, and neither depends on whether an
order was placed. The admitted arm is deliberately *not* taken from the order ledger — that would compare
a real-fills cohort against a simulated one, which is the error §2 of the review is about.

`realizedEdge` is per $1 of payout — `(outcome === side ? 1 : 0) − ask − fee` — not capital ROI, so a
cheap contract's enormous percentage return cannot dominate the mean. The review found the clustered mean
return on cheap contracts is skew-dominated; this bounds it. Intervals are clustered on the settlement
window.

## 5. Review bar

60 resolved windows in the declined arm before the first review, matching `hold-sentinel`. At the observed
~17 declined decisions a day that is roughly four days. It is a *review* bar, not a promotion criterion:
promotion or withdrawal is a manual act with a written reason, per §7 of the agent rules.

Deliberately unreachable-by-accident: the sentinel accrues whether or not the gate is later relaxed,
because it records the evaluation rather than the execution.

## 6. Known cost, accepted

Bumping `BUY_POLICY_VERSION` resets the adaptive regime gate. `evaluateRegimeGate` filters evidence by
`item.policyVersion === policyVersion` and returns `allowsEntries: true` while warming, so the 156
accumulated v17 sentinel windows are discarded and the gate permits everything for 12 settlement windows.
For that stretch the adaptive gate cannot close on a bad patch. This is accepted rather than mitigated:
scoping the regime gate's evidence to the policy version is correct — evidence from a different gate is
evidence about a different desk — and special-casing a "compatible" version bump would be the beginning of
exactly the drift that scoping prevents.

## 7. What this design deliberately does not do

- **It does not size differently.** A reduced ticket on spiked entries would keep the sample unbiased but
  make the realized-P&L arms non-comparable, and it complicates sizing on a money path for a three-day result.
- **It does not touch the exit.** `strict-value-v1` is carrying the entire realized result and nothing here
  goes near it.
- **It does not change the ranking.** §4 of the review found a selection cost among simultaneous candidates
  that is not established on live, and §7 offers the spike as a hypothesis that would explain it. If the
  gate works, that cost should shrink on its own; if it does not, ranking is the next thing to look at.
- **It does not remove the `MAX_NET_EDGE` ceiling**, despite the review finding its stated calibration
  justification is the wrong argument. That is a separate decision with its own observability defect —
  `bestEntry` records the best *admissible* option, so no row above the ceiling has been recorded since it
  shipped, and the ceiling cannot currently be falsified from recorded data at all.
