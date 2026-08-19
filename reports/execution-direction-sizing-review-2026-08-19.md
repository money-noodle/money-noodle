# Direction-aware execution and 30pp sizing review — 2026-08-19

> **Subsequent operator decision, 2026-08-19:** the maintainer approved live restrictive deployment,
> explicitly accepting that the 30pp threshold was retrospective and not promotion-grade. Production is
> now `maker-high30-one-attempt-fresh1c-v4` with `entry-sizing-reduce30-below-edge30-v1`; direction remains
> observation-only. See
> [`docs/high-edge-execution-reduced-sizing-design.md`](../docs/high-edge-execution-reduced-sizing-design.md).
>
> **Measurement and proposed design boundary at the time of this read.** The 30pp+ realized band is the
> only positive band on both tracks, but it has 17 live windows and its three largest wins exceed the
> band’s total profit. The prior 0.3×–3× proportional-sizing proposal does not reproduce on realized money.
> Exact-quote direction explains failed makers, but the obvious adverse-move refusal disagrees between live
> and paper and drops winners. The original measurement made no funded change; the subsequent deployment is
> the explicit operator departure recorded above.

## Inputs, method, and caveat

Recalculated at **2026-08-19T22:43:38Z** from **2,711 order rows and 64,952 resolved forecasts** with
`npm run analyze:execution-direction-sizing`.

Realized returns use exact `actualPnlCents / actualStakeCents` when available and are averaged within the
settlement window before uncertainty. Sizing candidates score every settled position, not a surviving
cohort. Direction is selected-side price direction: an ask one cent lower between the issuance snapshot and
fresh exact-contract submission quote is adverse to the side being bought; one cent higher is favorable.
No-fill and candidate refusal earn zero.

The most threatening caveat is selection. The 30pp threshold is being examined because its cell looked
best, and every sizing result below is therefore retrospective. The “take” arm assumes the refreshed ask
fills; it is an optimistic bound, not evidence that an IOC would fill. Live and paper share signals and are
reported separately rather than treated as independent confirmation.

## 1. Current net-edge bands

| net edge | live return/$1 | rows / windows | live exact P&L / stake | paper return/$1 | rows / windows | paper exact P&L / stake |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5–10pp | +1.9% ±9.4 | 102 / 96 | −14.12¢ / 10,201.76¢ | −6.6% ±7.0 | 145 / 133 | −849.88¢ / 15,723¢ |
| 10–18pp | −8.7% ±11.5 | 91 / 79 | −583.99¢ / 9,128.83¢ | −3.3% ±9.2 | 122 / 112 | −470.89¢ / 13,422¢ |
| 18–30pp | −8.2% ±18.3 | 76 / 73 | −1,600.81¢ / 7,340.41¢ | −18.2% ±12.2 | 96 / 93 | −2,962.97¢ / 10,157¢ |
| **30pp+** | **+46.2% ±46.9** | **18 / 17** | **+1,187.09¢ / 1,802.71¢** | **+56.3% ±45.4** | **29 / 25** | **+1,165.66¢ / 3,676¢** |

The user-supplied shape reproduces on the newer ledger. It does not establish a 30pp sizing threshold:

- live has only 17 independent windows across eight days; paper has 25 across seven days;
- the **three largest positive rows contribute 1,311.84¢ live and 1,439.64¢ paper**, respectively 110%
  and 123% of each band’s net profit;
- the clustered standard error is as large as the point estimate;
- the table is realized fills, so edge is entangled with which orders the venue selected and with exits.

The cell is worth preserving and testing. It is not yet safe to lever.

## 2. Sizing on realized money

Each position is normalized to one base ticket before applying a multiplier. `capital units` therefore show
how much relative capital the arm would deploy; this is not a reconstruction of historical budget reuse.

| track / arm | capital units | normalized return/capital | clustered return ±SE |
| --- | ---: | ---: | ---: |
| live flat | 287.0 | −2.37% | −4.3% ±7.6 |
| live prior proportional 0.3×–3× | **506.4** | −2.36% | −3.3% ±7.8 |
| live 0.3× below 30pp; 1× at 30pp+ | **98.7** | +2.79% | −3.2% ±7.7 |
| paper flat | 392.0 | −3.40% | −7.1% ±5.7 |
| paper prior proportional 0.3×–3× | **692.3** | −2.86% | −6.8% ±5.9 |
| paper 0.3× below 30pp; 1× at 30pp+ | **137.9** | +5.81% | −5.6% ±6.1 |

The earlier proportional result was on the admitted population. On executed money it adds roughly 76% more
modeled capital while leaving return essentially unchanged and negative. **Do not implement 0.3×–3× sizing
now.** Execution must be repaired before edge can safely increase stake.

The reduce-only arm is the safer candidate: it never raises a ticket, keeps every admission, leaves 30pp+
at today’s base, and cuts lower-edge tickets to the already-proposed 0.3× floor. Its raw normalized cash
turns positive only because the selected 30pp tail receives most of the weight; the equal-window clustered
mean remains negative. It needs a committed sizing sentinel, not immediate activation.

Because this candidate never exceeds 1×, today’s count caps still bound worst-case dollars. Dollar-denominated
account/window/group caps remain the correct foundation, but they are no longer a prerequisite for testing a
**reduce-only** multiplier; they are mandatory before any multiplier above 1×.

## 3. Failed fills are directional—and mostly should remain failed

V21 maker attempts with a resolved exact outcome and a fresh pre-submit quote:

| track / pre-submit move | attempts / windows | fills | fill rate | filled eventual wins | production return across attempts |
| --- | ---: | ---: | ---: | ---: | ---: |
| live adverse ≥1¢ | 32 / 22 | 20 | 62.5% | 5 | −27.3% ±15.1 |
| live stable | 3 / 3 | 3 | 100% | 1 | −37.1% ±62.9 |
| live favorable ≥1¢ | 37 / 24 | 11 | 29.7% | 7 | +3.4% ±8.6 |
| paper adverse ≥1¢ | 72 / 44 | 50 | 69.4% | 21 | **+7.8% ±15.4** |
| paper stable | 14 / 12 | 10 | 71.4% | 4 | −14.1% ±25.4 |
| paper favorable ≥1¢ | 114 / 49 | 22 | 19.3% | 12 | +2.2% ±5.9 |

The mechanism is visible: favorable movement creates the low fill rate. Those failed maker orders are not an
execution defect by themselves; the side became more expensive before the order arrived.

The obvious restriction—do not post after a one-cent adverse move—would have improved live by **+15.4pp
±8.3pp**, refusing 15 losing fills but also five winning fills. Paper does not confirm it: the corresponding
30pp-fresh-edge arm improves only **+0.5pp ±7.3pp** and refuses 29 losing fills plus 21 winners. It is not a
winner-preserving production rule.

Waiting until the first two-second management check is too late and too weak. Only one live and six paper
attempts were cancellable on that definition; it removed no later live fill and removed two paper winners
against one loser.

## 4. “Adjust price according to direction” does not mean chase

A favorable selected-side move raises the ask and consumes the edge. Applying the current absolute taker
requirements to the fresh exact quote produced:

- **zero live taker conversions** at either a 15pp or 30pp fresh-edge floor;
- two optimistic paper conversions at 15pp;
- zero paper conversions at 30pp.

So raising the limit to rescue these misses would mostly buy contracts after the measured advantage had
vanished. The current issuance cap is doing useful work. A favorable miss should become a taker only if the
**refreshed** quote—not the stale issuance quote—still clears the chosen edge, persistent-edge, quality,
spread, all-in cap, and slippage gates. Otherwise it should fail.

An adverse move is different: raising the maker bid writes more optionality into the move that is already
running against the selected side. But the track disagreement means production cannot yet refuse it from
this retrospective screen.

## 5. Proposed design for maintainer agreement

A coherent conservative adjustment would be a new, separately versioned execution-and-sizing generation:

1. **No upsizing.** Stamp a reduce-only sizing candidate: 0.3× base below 30pp, 1× at or above 30pp. Apply
   the same multiplier relative to each track’s own base ticket; quantize once at the all-in cent boundary.
2. **High-edge route.** At 30pp+ issuance edge, refresh the exact quote immediately. Take only if fresh
   taker edge remains at least 30pp and the existing median-edge, quality, 2¢ spread, 1¢ movement, funding,
   rate, exposure, and reconciliation gates all clear. Otherwise do not chase.
3. **Ordinary route.** Below 30pp, keep one bounded maker attempt. An authoritative zero-fill is an allowed
   result; disable the taker fallback for this band rather than converting a failed low-edge maker.
4. **Direction remains observation-only initially.** Add candidates that refuse a maker after an adverse
   exact-quote move and that stop repricing after the first unfilled adverse management check. Do not let
   either candidate affect production until the track-separated sentinel clears its locked window and
   differing-decision bars.
5. **No price ladder invented from edge.** A maker stays passive and under the original approved cap. A
   taker uses the refreshed ask as a capped IOC. There is no midpoint extrapolation or uncapped chase.
6. **Dollar ceilings before >1×.** Account-, settlement-window-, and correlation-group cents caps must land
   before any later proposal increases a ticket above today’s base.

This design reduces lower-band dollars, preserves every entry observation, lets low-value misses fail, and
reserves price concession for a fresh 30pp opportunity. It is intentionally restrictive. Because the 30pp
threshold and 0.3× multiplier were chosen after looking at these data, activating them would be an explicit
operator decision against the normal prospective-promotion bar; the evidence itself authorizes only a
committed evaluation lane.

## Decision status

No production adjustment was made by this review itself. Before the subsequent operator decision, the options were:

- **evaluation only (recommended):** implement the reduce-only sizing and direction/high-edge routes as
  non-executing sentinels;
- **operator-directed restricted deployment:** activate 0.3× below 30pp, 1× at 30pp+, fresh-30pp taker,
  and no sub-30pp fallback, recording the retrospective departure in the sizing/execution manifest;
- **no change:** continue the existing adaptive policy and current sentinels.

Nothing here is financial advice.
