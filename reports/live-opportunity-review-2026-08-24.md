# Live opportunity review — 24 hours through 2026-08-24T17:30Z

## Question and decision

Could the funded desk have won more positions or earned more by changing the forecast model, tightening entry
policy, changing execution, or changing exits?

**Decision:** no production change is authorized. The model/admission surface remained profitable and close to
calibrated, and none of twelve related entry-tightening screens beat production when scored on every production
position. The largest measured loss of opportunity was between order selection and maker fill. Crossing every
first ask looks positive retrospectively, but it assumes every IOC fills, ignores the funded portfolio/budget
sequence, and has almost no actual taker evidence. Strict exits again destroyed value, but the approved v2
prospective evaluation has only just started.

The next useful experiment is execution evidence: preserve the current entry rule and compare a bounded,
prospectively committed taker treatment with production maker execution. Do not lower a taker threshold or switch
all entries from this replay alone.

## Inputs and method

Recalculated at **2026-08-24T17:37:52Z** with:

```bash
npm run analyze:live-opportunities
node scripts/analyze-unfilled-entries.mjs 24
npm run analyze:positive-edge-current
```

The reload contained **75,362 durable forecast rows, 4,402 execution orders, and 8,837 active-v22 Kalshi
candidate observations**. The primary interval is the 24 hours of resolved settlement windows ending
**2026-08-24T17:30:00Z**. Comparators are the immediately prior 24 hours, the trailing 72 hours, the full active
v22 model/admission cohort since `2026-08-20T04:50:15Z`, and current execution generation v6.

For model/admission comparisons, each rule independently takes the first qualifying observation per
`(symbol, closesAt, side)`. Positions inside one settlement timestamp are averaged before the mean and standard
error. A tightening is scored on **every production position**; a position it omits earns zero, and no freed
capital or replacement trade is invented. Twelve related tightening candidates were inspected, so isolated good
rows would be screening rather than evidence.

Live and paper are not pooled. Actual cash and fills come from the execution ledger. Ask and posted-maker
counterfactuals include the existing fee model but optimistically assume execution. The most threatening caveat
is therefore fill causality: a missed maker winner does not prove a taker order would have filled at the observed
ask, and taking many more orders would change capital/rate-limit availability.

## Last 24 hours

### Actual funded result

There were **163 resolved live attempts**, 148 venue acceptances, 46 fills over 31 independent windows, and 116
unfilled attempts. Six positions settled as wins, 30 as losses, and 10 were sold; **16/46 positions had positive
realized P&L**.

- exact stake: **1,144.95¢**;
- exact realized P&L: **−226.1777¢**, or −19.8% aggregate ROI;
- clustered realized return: **−28.4% ±16.7pp** over 31 windows.

All 46 fills came from the maker route. Five taker decisions produced one venue acceptance and zero fills, so the
last day contains no actual taker outcome evidence.

### Model and entry admission were not the failure

The production v22 first-to-fire surface contained **402 positions across 86 windows**, winning 240/402 (59.7%)
against a mean selected-side probability of 62.0%. The calibration gap was −2.34pp and ask-priced hold return was
**+33.1% ±7.8pp**.

Restricting to the 63 settlement windows in which the funded desk attempted at least one order:

| stage | positions / windows | ask-priced hold return |
| --- | ---: | ---: |
| every production candidate in active windows | 337 / 63 | **+18.1% ±6.9pp** |
| candidates selected for a live order | 131 / 63 | +20.7% ±11.0pp |
| candidates that eventually filled | 46 / 31 | **−32.8% ±15.5pp** |

The ordered subset did not underperform the available active-window surface. The sign reversal occurred only
when the cohort narrowed to fills.

The preceding day looked similar before fills: all production candidates returned +32.2% ±6.8pp and ordered
candidates +32.4% ±17.0pp, while filled candidates returned −12.7% ±20.0pp. Over 72 hours, the sequence was
+29.0% ±4.6pp for active-window candidates, +25.2% ±8.1pp ordered, and **−22.7% ±10.1pp filled**. This repeated
shape argues against explaining the latest loss by forecast decay or portfolio ranking.

### Tightening the entry policy would have removed more value

No tested tightening had positive incremental return against production across every last-day production
position. Representative results:

| candidate | retained decisions | dropped winners / losers | incremental return vs production |
| --- | ---: | ---: | ---: |
| edge floor 8pp | 297 | 64 / 41 | −4.4% ±2.8pp |
| edge floor 10pp | 257 | 91 / 54 | −3.8% ±4.3pp |
| edge floor 15pp | 169 | 147 / 86 | −9.9% ±5.8pp |
| minimum price 30¢ | 387 | 9 / 6 | −10.7% ±4.3pp |
| maximum price 65¢ | 381 | 19 / 2 | −2.1% ±0.9pp |
| probability floor 60% | 283 | 56 / 63 | −6.2% ±5.3pp |
| confidence floor 70% | 108 | 175 / 119 | −18.3% ±6.9pp |

A 60% confidence floor changed no decision and is inert in this cohort. The only positive tightening in the prior
24-hour comparison was a 30¢ minimum at +0.3% ±1.7pp, indistinguishable from zero and reversed sharply in the
latest day. Across 72 hours and the complete active-v22 cohort, **all non-inert tightening arms were negative** on
the every-position measure. Raising an edge threshold increased conditional return among survivors but lost more
production value by omitting positions; reporting only survivor ROI would give the wrong answer.

The model did not show a stable asset exclusion either. Ask-priced active-v22 return was positive for all seven
assets. BNB was weakest (+9.3% ±7.9pp lifetime-v22; +3.9% ±10.2pp over 72 hours; +2.2% ±17.5pp in the last day),
but it was not persistently negative. BTC and ETH were strong on the model surface; ETH returned +41.3% ±13.4pp
in the last day, +36.6% ±8.9pp over 72 hours, and +46.8% ±7.1pp over active v22. Negative realized ETH/DOGE
fills therefore do not by themselves establish an asset-model defect.

## Execution was the main opportunity gap

Among accepted maker orders in the last day:

- filled positions would have won at settlement **16/46** and returned −23.7% ±17.5pp if held;
- accepted maker misses would have won **73/101** and returned **+45.4% ±12.2pp** at their posted prices;
- in the 19 windows containing both, fill-minus-miss return was −46.3% ±27.1pp.

The paired estimate is noisy for one day, but it persists. Current v6 has 73 paired windows with fill-minus-miss
return **−25.1% ±12.8pp**. The production maker report independently finds a paired fill win-rate gap of
−14.4pp ±5.5pp across those windows. Winner-conditional fill rate was 18.5%, versus 46.7% for losers. This is the
classic adverse-selection shape: the passive order fills more often when price moves against the selected side.

An optimistic alternative that crosses every first live attempt's issuance ask produced:

| horizon | positions / windows | wins | counterfactual cash | clustered return |
| --- | ---: | ---: | ---: | ---: |
| last 24h | 131 / 63 | 74 | +878.15¢ on 4,363.85¢ | +15.4% ±10.0pp |
| trailing 72h | 350 / 172 | 203 | +3,526.04¢ on 12,019.96¢ | +17.6% ±7.4pp |
| current v6 | 447 / 219 | 262 | +4,054.98¢ on 15,568.02¢ | +19.0% ±6.5pp |

This is the clearest candidate mechanism for winning more bets, but not a deployable P&L estimate. It assumes
full taker execution, ignores depth/slippage and the sequence of occupied capital/rate slots, and was inspected
after observing the maker-fill gap. Actual current-v6 taker evidence is only **five fills across five windows**;
one was profitable and aggregate P&L was +260.7144¢ because that single cheap winner dominated five losses.
The clustered mean is +259% ±359pp and carries essentially no precision. The 24 current taker recommendations'
ask counterfactual was +69.5% ±40.4pp, but taker-minus-maker was only +13.1% ±73.4pp.

The two already committed maker restrictions do not solve the problem. In the latest day, refusing spreads above
2¢ changed ten windows and moved return −0.6% ±1.2pp while worsening raw cash by 34.37¢; the edge-spike restriction
moved −2.1% ±2.0pp. Across current v6, the 2¢ spread arm moved +2.0% ±1.5pp normalized but changed live raw cash
from +107.2141¢ to −175.0632¢; paper raw cash moved in the opposite direction. The spike arm remained negative.
Neither is promotion evidence.

## Exits were a real but smaller loss

Ten authoritative strict-value sales across nine last-day windows beat hold **0/10**:

- exit-minus-hold cash: **−58.2277¢**;
- clustered incremental return: **−24.0% ±7.6pp**.

Holding those exits would have reduced the day's exact loss from −226.1777¢ to approximately −167.95¢, but it
would not have made the filled cohort profitable. The result persists: 0/27 over 22 trailing-72-hour windows,
−142.7997¢ and −18.5% ±4.4pp; current v6 is 0/33 over 28 windows, −151.7415¢ and −15.7% ±3.7pp. This confirms the
priority of exit-sentinel v2, not a retrospective replacement. V2 began only at 2026-08-24T17:08Z and had one
resolved paper position and no live position at this read.

## Additional reporting defect found and repaired

The authenticated maker sentinel marked both candidate rows `reviewUnlocked: true` after only checking
window/divergence counts. That flag did **not** enforce the approved positive exact-cash, Holm-corrected,
track-consistency requirements. The displayed evidence itself fails those requirements. The report gate now also
requires at least 90% scoreable coverage, positive exact cash and clustered mean, one-sided Holm family-wise
significance across both arms, and simultaneous positive live/paper eligibility. Recalculation leaves all four
track/candidate flags false. This reporting correction has no path to order placement and does not change the
economic finding.

## Findings, unknowns, and authorized next steps

### Findings

1. **Do not tighten the model or buy policy from this day.** Production candidates were profitable and nearly
   calibrated; all twelve non-inert tightening formulations lost value on the complete production cohort.
2. **Do not blame portfolio ranking.** Ordered positions tracked the active-window opportunity surface; fills did
   not.
3. **Maker adverse selection is the main measurable opportunity gap.** It is present in the latest day, 72-hour
   look, and current-v6 paired cohorts.
4. **Strict exits cost 58.23¢ in the day but explain only about one quarter of the 226.18¢ loss.** Continue v2
   prospective collection rather than selecting a replacement retrospectively.
5. **Simple spread/spike maker refusal is not the answer.** Existing prospective arms are weak or contradictory.

### Unknowns

- How often a signed taker IOC at the observed ask would actually fill after request latency and depth limits.
- How much extra taker execution would crowd out later opportunities under the global capital and hourly order
  ceilings.
- Whether a narrower decision-time feature can identify maker fills that are not adversely selected without
  screening dozens of correlated candidates.
- Whether the last-day fill gap is a stable mechanism or partly a short regime; the current-v6 paired interval is
  still broad.

### What the evidence authorizes

- Retain the corrected maker-sentinel `reviewUnlocked` reporting gate and do not reinterpret prior `true` flags.
- Design, before coding, a **bounded prospective execution experiment** that leaves entry selection unchanged and
  obtains actual taker IOC evidence on a precommitted subset. It must preserve the shared entry rule, all-in cap,
  global exposure/rate limits, reconciliation, and separate live/paper execution accounting.
- Continue exit-policy-sentinel v2 untouched.
- Make no model, buy-threshold, asset-exclusion, maker restriction, or exit-policy production change from this
  retrospective review.

## Subsequent operator decision

Later on 2026-08-24, the maintainer approved only the bounded operational measurement authorized above. The
prospective `bounded-taker-pilot-v1` design fixes 25/75 assignment before outcomes and caps funded treatment at
30¢ each / 300¢ total; it is documented in `docs/bounded-taker-experiment-design.md`. This is an execution and
capital experiment, not a retrospective promotion, and v1 has no route-promotion state.
