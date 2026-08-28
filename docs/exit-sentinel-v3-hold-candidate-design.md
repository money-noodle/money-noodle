# Exit sentinel v3: a frozen hold arm and an honest no-bid state

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Not started
> **Created:** 2026-08-28
> **Canonical requirements:** [`spec/policy-and-track-separation.md`](../spec/policy-and-track-separation.md)
> **Decision record:** [`DEC-20260828-01`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> Agreed in prose with the maintainer and accepted on 2026-08-28. This adds an observation-only
> evaluation generation. It grants no execution authority, changes no entry rule, exit rule, threshold,
> sizing, capital, or operator control, and must not alter a single production order. Production continues
> to run `strict-value-v1` exactly as it does today while v3 observes.

## 1. Why a new generation rather than a fifth arm on v2

Two independent reviews converge on the same blocker.
[`strict-value-hold-review-2026-08-27`](../reports/strict-value-hold-review-2026-08-27.md) found that under buy
v22 production strict value sold 87 profitable live positions, 83 of which later settled on the owned side, and
that holding those actual sales would have added 284.0806¢ exact — while four reversals saved 172.5881¢ and rare
reversals made the exit better by 604.5342¢ over lifetime. It concluded that the question needs "a new
prospective, reasoned exit-sentinel generation with an explicit frozen `hold-no-strict-value` candidate," and
recorded that the proposed cycle was not implemented.

[`exit-sentinel-preclose-availability-diagnosis-2026-08-26`](../reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md)
explains why v2 cannot answer it even with such an arm added. `exitObservationTerms` refuses a quote whose
owned-side bid is at or below zero — correct for execution, because a zero bid is not a sale price — so no
lifecycle observation is appended and `maintainExitPolicySentinels` records the cycle as generic `unavailable`.
A losing owned side routinely reaches a fresh one-sided book with a zero executable bid in the final ninety
seconds, so that state is concentrated on losers: **every position v2 made incomplete by cycle coverage was a
loss**, six live and nine paper. Candidate cash and significance computed over complete paths are therefore
biased upward, and the review states v2 "remains diagnostic even if its numerical counts later cross a
threshold."

v2's own events are immutable and its generic `unavailable` rows do not retain the rejected quote or a reason,
so they cannot be safely relabelled. A new generation is the only way to collect the missing state prospectively.

## 2. The no-bid state

`ExitEvaluationCycle.classification` gains a third value. v3 distinguishes:

| Classification | Meaning | Counts as evidence |
| --- | --- | --- |
| `observed` | A fresh quote with an executable owned-side bid; a full observation was recorded. | Yes |
| `no-executable-bid` | A fresh quote was read and the owned-side bid was zero, or the opposite side's ask reached 1. The market state is known: nothing could be sold. | **Yes** |
| `unavailable` | No fresh quote: read failure, staleness, rate limiting, or a missing contract. | No |

`no-executable-bid` is an observation, not a gap. The system saw the market and the market offered nothing. Every
non-`observed` cycle retains the rejected bid and ask, the observation source, and a reason string, which is the
retention v2 lacked and the diagnosis named as its largest caveat.

**Production is not touched.** `exitObservationTerms` keeps refusing a zero bid and keeps returning `null`; the
sell path stays reduce-only and still never invents liquidation value. Only the sentinel's classification of that
refusal changes, and only in the new store.

## 3. Candidate arms

The frozen family is the existing four plus one:

| Candidate | Behaviour |
| --- | --- |
| `strict-value-margin3c-v1`, `strict-value-margin5c-v1`, `strict-value-confirm2-v1`, `trailing-50-35-v1` | Unchanged from v2. |
| **`hold-no-strict-value-v1`** | Never sells. Holds every position to exact settlement. |

Five arms is a deliberate choice with a stated cost. Holm gives the best-looking arm the bar `0.05 / arms`,
so the family size sets the threshold: two arms need `t >= 1.96`, five need `t >= 2.33`. Hold currently reads
`+0.0981 +/- 0.0554` over 82 windows (`t = 1.77`) on the retrospective active-buy cohort, so at that effect size
reaching the bar needs about 101 windows in a two-arm family and about 142 in a five-arm family. The desk settles
roughly 32 eligible windows a day, which prices the difference at **about 3.1 days against 4.4 days**. Spending
one extra day to keep four live questions open is the accepted trade.

The four incumbent arms restart at zero here. They cannot instead be left to finish in v2: the outcome-selection
defect keeps `reviewUnlocked` false there permanently, so v2 accumulation can never conclude for any arm.

At a `no-executable-bid` cycle a selling arm cannot fire and simply retains its state; the hold arm is unaffected
by construction. Both arms therefore remain scoreable through exactly the cycles that v2 dropped, which is the
whole point of the change.

The hold arm's terminal value is the exact settlement outcome of the position it inherits. Rather than assume a
blanket redeployment penalty, v3 **records slot occupancy** on every held position: the extra seconds the arm keeps
the position open past production's exit, and whether an exposure or correlation group limit was reached in that
window while it was held. The measured constraint is slots, not cash. Across 16,367 live-skip rows since
2026-08-25 there were **no cash-shortage refusals and 109 exposure/correlation group-limit refusals**, and strict
value exits at a mean 169 seconds remaining, so a held position occupies a slot for roughly the last three minutes
of a fifteen-minute cycle. Recording the occupancy lets a review price the displacement from evidence instead of
choosing a penalty in advance.

## 4. What it must record and what unlocks a review

Sizing, fees, and rounding come from the production functions, and both money views are reported separately:
whole-cent `pnlCents` for budget comparison and exact `actualPnlCents` for reporting, never summed together.

Thresholds carry over from v2 unchanged: 60 complete independent settlement windows, at least 20 divergent
windows, at least 90% cycle coverage per path, returns clustered on the settlement window, and Holm correction
across the frozen family. Two consequences must be stated rather than discovered later:

1. **The family grows from four arms to five**, so Holm raises the bar for every arm including the incumbents.
   That is the honest cost of asking a fifth question of the same data.
2. **v2 evidence does not transfer.** v3 starts at zero windows. `reviewUnlocked` stays false on both
   generations until v3 accumulates its own, and a v2 count crossing a threshold still authorizes nothing.

Live and paper are reported separately and a sign disagreement between tracks blocks the lock, as it does today.

## 5. Storage and lifecycle

A new append-only journal and compacted store, `exit-policy-sentinels-v3`, sits beside v2 under the existing
atomic-write and journal-ownership rules. **v2 stops collecting when v3 starts** and is retired in place: its
journal and store are never rewritten, truncated, or reclassified, and remain readable as history. Nothing
numeric transfers, because v2's counts are biased by the defect v3 exists to fix. What transfers is the reasoning:
the no-bid mechanism, the lifetime counterweight that holding was worse by 647.8770¢ across 168 windows, and the
active-policy reading that it was better by 240.7378¢ across 82. Each is recorded in v3's opening note as a prior
to be tested, never as accumulated evidence.

## 6. Sentinels as a first-class concept

Sentinels are currently five unrelated stores that only a maintainer reading source can enumerate. This design
makes the concept explicit, because a prospective-evidence discipline nobody can see is a discipline that quietly
lapses.

A new `sentinel-registry` module beside the other registries becomes the single enumeration, in the same spirit as the provider, market, and
strategy registries: a new sentinel is a registry entry, never new UI. Each entry declares a stable id, the
question it answers in one sentence, its frozen arm family, when collection opened, its promotion thresholds, its
current lifecycle state (`collecting`, `locked-for-review`, `concluded`, `retired`), and a projection function
returning progress against each threshold. The registry is read-only and grants no execution authority; it
describes instruments, it does not authorize what they measure.

A new authenticated `GET /api/sentinels` route returns that projection, bounded and sanitized like the other
authenticated reads, and never on a stateless host.

A new sentinels dialog component adds a **Sentinels** trigger beside `AllocationDialog` in the dashboard
badge row and in the trading-control dialog, matching the existing badge pattern. The modal shows, for each
running sentinel: the question, a per-arm table in the shape used in this repo's reviews (arm, windows, divergent
windows, coverage, clustered mean with standard error, Holm threshold, and whether it clears), a timeline from
collection start through the present with the projected date each threshold is met at the observed accumulation
rate, and a progress indicator per threshold. Concluded and retired sentinels sit in a collapsed region below,
each showing its final reading and the reason it closed, so a retired instrument stays visible rather than
disappearing. The UI displays projections only; it exposes no control that could arm, disarm, promote, or reset a
sentinel.

## 7. What this cannot conclude

Even a fully unlocked v3 would not authorize disabling the exit. As
[`strict-value-hold-review-2026-08-27`](../reports/strict-value-hold-review-2026-08-27.md) states, removing strict
value deliberately exchanges rare large loss saves for frequent small winner gains and retains capital and
exposure until settlement. That displacement must be bounded in a separate accepted design before any manual
versioned promotion. v3 measures the exchange rate; it does not decide whether to make the trade.

## 8. Tests

Pin the three-way classification over a grid of quote states including a zero bid, an opposite-side ask at exactly
1, a stale quote, and a missing contract; that a selling arm never triggers at `no-executable-bid` while the hold
arm survives; that coverage counts `no-executable-bid` in the numerator and `unavailable` outside it; that the
hold arm's terminal value equals exact settlement; Holm across five arms; that production order flow and
`exitObservationTerms` are byte-identical before and after; strategy isolation; and that no v3 code path can reach
an order function. Registry tests pin that every sentinel store is enumerated, that a registry entry cannot claim
execution authority, and that the API projection is read-only and unavailable on a stateless host.
