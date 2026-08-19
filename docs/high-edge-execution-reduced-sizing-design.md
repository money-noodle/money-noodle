# High-edge taker routing and reduce-only sizing

> Approved for live deployment by the maintainer on 2026-08-19 after
> [`reports/execution-direction-sizing-review-2026-08-19.md`](../reports/execution-direction-sizing-review-2026-08-19.md).
> This is an explicit operator decision on retrospective evidence. It changes execution and capital, not
> the shared buy rule. The buy-policy version and mirror invariant remain unchanged.

## 1. Decision

The edge strategy receives one entry attempt per asset/side/window/generation. Issuance net edge determines
both its maximum all-in ticket and its live execution route:

| issuance net edge | all-in ticket ceiling | live route |
| --- | --- | --- |
| below 30 percentage points | 30% of the track's current base ticket, rounded up to whole cents | one managed maker attempt |
| at least 30 percentage points | 100% of the track's current base ticket | immediate fresh-quote taker evaluation |

There is no additional absolute minimum ticket. If the reduced all-in cap cannot fund the venue's minimum
quantity plus conservative fee reserve, the order is refused. A partial authoritative fill may spend less
than the intended cap and is never chased to manufacture a minimum spend.

No multiplier exceeds 1. The operator's configured per-trade amount, live stake ceiling, provider/strategy
funding, available cash, position counts, rate limit, and reconciliation state continue to cap every order.
The current configured base is 100¢; therefore the initial deployed ceilings are 30¢ below 30pp and 100¢ at
30pp+. The 250¢ environment ceiling does not enlarge either ticket.

## 2. Evidence and departure

At the deciding 2026-08-19T22:43:38Z read, realized 30pp+ entries returned +46.2% ±46.9pp live over 18 rows
and 17 settlement windows and +56.3% ±45.4pp paper over 29 rows and 25 windows. Every lower band was flat or
negative on one or both tracks. The three largest positive rows exceeded each track's total high-edge
profit, so the band was not established and the normal prospective promotion bar was not met.

The earlier 0.3×–3× edge-proportional proposal also failed on executed money: it increased modeled capital
about 76% while clustered return remained negative and nearly unchanged. This design therefore uses no
upsizing. It reduces lower-band dollars and preserves today's base only for the nominated high-edge band.

The maintainer approved live deployment because paper cannot establish signed IOC fills or actual maker
queue selection. The retrospective threshold choice and concentration are recorded rather than converted
into an evidence claim.

## 3. High-edge live route

A 30pp+ issuance decision does not authorize buying a stale price. The order reserves quantity and taker fees
against the existing worst permitted price, then the signed path performs one exact-contract quote refresh.
Historical accepted entry refreshes took about 0.6–0.7 seconds at the median and about one second at p90.
No extra confirmation delay is introduced.

The refreshed quote must clear all of:

1. fresh taker net edge at least 30pp after the shared venue fee schedule;
2. persistence-median net edge at least 10pp;
3. estimate quality at least 65%;
4. selected-side spread no wider than 2¢;
5. ask movement no more than the existing 1.0¢ issuance cap;
6. the 97¢ entry ceiling, all-in sized reservation, funding, rate, exposure, live-risk, and reconciliation
   gates already required by production.

The old maker sample-count and `makerNetEdge × fillRate` comparative gates do not apply to this route. That
estimate treats maker fills as random, contrary to the measured outcome selection. A qualifying route sends
one marketable IOC **limit** at the refreshed ask. Movement after refresh may still produce an accepted
zero-fill IOC; it never permits an uncapped market order.

If any fresh condition fails, no maker substitute is posted and no later retry opens. The failed high-edge
attempt is durable and terminal for that logical sequence.

## 4. Ordinary live route

Below 30pp, production submits one managed post-only maker attempt under the existing issuance price cap and
12-second management/cancellation path. An authoritative zero-fill is an allowed result. It does not open a
taker fallback, a second maker, or fresh post-miss persistence.

Paper receives the same relative sizing but retains its independent managed-maker simulation. It also receives
one attempt. This is permitted track separation: entry admission is identical; execution and capital are not.

Protected switches retain their existing reduce-only sequencing and execution mechanics. Their replacement
order receives the new sizing ceiling, but this decision does not alter the switch's sell-first safety path.

## 5. Direction observation

Direction-based cancellation is not activated. New maker orders stamp a prospective
`entry-direction-observation-v1` record from their exact execution path:

- issuance selected-side ask;
- first fresh pre-submit selected-side ask and movement in cents;
- classification at the precommitted ±1¢ boundary: adverse, stable, or favorable;
- the fixed counterfactual “refuse adverse pre-submit maker” decision;
- the first management quote observed with zero fill, its movement from the fresh submission quote, and the
  fixed counterfactual “cancel on first unfilled adverse move” decision.

The observation is reporting-only. Pricing, sizing, execution-style selection, maker amendments, cancellation,
budget, and reconciliation may not import or read its candidate decisions. Paper and live remain separate in
reports; only live can establish actual signed fill behavior.

## 6. Money arithmetic and durable identity

`entry-sizing-reduce30-below-edge30-v1` is stamped on every new edge order with base cap, issuance edge,
multiplier, and resulting all-in cap. Below 30pp the cap is:

```text
ceil(baseStakeLimitCents × 0.30 − 1e-9)
```

It is quantized once before `estimatePaperFill`; quantity then rounds down until principal plus conservative
taker-fee reserve fits. High-edge remains exactly the integer base cap. Actual maker fees and fill terms
replace the reserve without changing the issuance ceiling.

Live execution advances to `maker-high30-one-attempt-fresh1c-v4`. Historical v3 orders and their retry
semantics remain immutable. A pre-deployment v3 miss cannot become a v4 retry because v4 permits one attempt
and requires its own current policy stamp.

## 7. Tests and deployment

Tests must pin:

- 30% sizing below, within epsilon of, and at/above 30pp;
- adverse rounding and no multiplier above 1;
- 30pp+ adaptive routing without maker comparative gates;
- every fresh absolute gate and the one-cent cap;
- sub-30pp maker-only routing and terminal zero-fill behavior;
- one attempt on live and paper;
- direction classifications and fixed candidate decisions without a production import path;
- order stamping, paper/live relative sizing, and unchanged mirror-invariant arity;
- exact fee/fill sizing at float edges.

Deployment requires the ordinary funded procedure: typecheck and full tests; build; quiescent pause/drain;
restart the built server; authoritative startup reconciliation; then explicit resume only if every existing
readiness and live-risk gate passes. No code change may silently preserve active operator intent across a
manual deployment pause.
