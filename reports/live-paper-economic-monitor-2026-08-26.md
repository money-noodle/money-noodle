# Live and paper economic monitor — 24 hours through 2026-08-26T07:15Z

> **Finding:** the fixed v22 opportunity surface remained positive, while both funded and paper fills lost money.
> Live exact P&L was −221.4543¢ over 54 fills in 42 windows; paper exact P&L was −388.2450¢ over 49 fills in
> 41 windows. One funded taker winner contributed +242.79¢, while 53 maker fills lost 464.2443¢. This strengthens
> the execution-selection and exit diagnosis but does not identify a safe replacement route or entry rule. No
> forecast, entry, maker/taker, exit, paper calibration, asset, size, capital, or live-authority change is authorized.

## Method and fixed boundary

The review reran between **2026-08-26T07:23Z and 07:26Z**:

```bash
npm run analyze:live-opportunities
npm run analyze:paper-settlement -- 2026-08-26T07:15:00.000Z
npm run analyze:positive-edge-current
npm run analyze:paper-live-mirror
npm run analyze:forecast-candidates
npm run analyze:paper-execution-timing
```

The primary interval is the fixed 24 hours ending at the latest resolved quarter-hour close available to the
live-opportunity analyzer, **2026-08-26T07:15:00Z**. The interval begins **2026-08-25T07:15:00Z**. Returns are
averaged within UTC `closesAt` before standard error. No-fill is zero spend and zero return, not a losing
investment. Exact reporting P&L and whole-cent bankroll control remain separate.

Auditable analyzer SHA-256 values were:

- live opportunities: `bca5f425a7d734dd18ef0a7815daa22c0deee3dbf4e787a34f211ad5085b4206`;
- paper settlement: `4e5334223db5c7ac985849e66f613916ec293c84614c4e921424a62e92113ac4e`;
- signed performance: `fd4f54fcc630e6099d4b4da91beb6804bcd5fb9682342166bd192831811c4acf`;
- authenticated control: `bb3813346fe06e50fe9ee781217bd7f9776ab657a1b89f55e58dfa458da5bc73`;
- exact mirror: `51640835247e6c3ac50ca93614ec55087f8be1b018c825a0d22edfb8275ceffd`.

The caveat that most threatens interpretation is execution attribution. Paper materially undercaptures live maker
fills, accepted misses are counterfactual rather than deployed capital, and the funded daily total is materially
improved by one taker fill. None of those observations alone identifies what a different executable route would
have earned under the same latency, depth, rate, and capital state.

## 1. Signal, selection, and funded execution

The fixed signal surface remained positive:

| Stage | Rows / windows | Clustered ask-and-hold return |
| --- | ---: | ---: |
| Every qualifying v22 decision | 361 / 85 | **+24.33% ±7.21pp** |
| Candidates in live-active windows | 302 / 60 | +22.83% ±7.58pp |
| Positions ordered live | 86 / 60 | +5.61% ±12.75pp |
| Positions that filled live | 53 / 42 | **−25.79% ±15.82pp** |

The complete signal cohort had 217/361 winning decisions, mean predicted probability 61.36%, observed win rate
60.11%, calibration gap −1.25pp, and Brier score 0.2350. Signal quality therefore did not share the sign of funded
fill economics, although the ordered cohort was already much less certain than the complete opportunity surface.

Funded execution contained 90 resolved attempts: 72 venue acceptances, 54 fills, 29 confirmed no-fills, and seven
rejected/other terminal outcomes. Eighteen fills were profitable.

| Funded result | Value |
| --- | ---: |
| Exact stake | 1,506.21¢ |
| Exact P&L | **−221.4543¢** |
| Aggregate ROI | −14.70% |
| Clustered return | **−23.81% ±15.82pp** over 42 windows |

The prior non-overlapping fixed day had 33 fills across 24 windows and +9.5782¢ exact P&L. One positive day followed
by one negative day is not a stable regime estimate and creates no retrospective tuning authority.

### Route disagreement

| Route | Attempts / accepted / fills | Exact P&L | Clustered return |
| --- | ---: | ---: | ---: |
| Maker | 86 / 69 / 53 | **−464.2443¢** | −30.54% ±14.67pp over 41 windows |
| Taker | 4 / 3 / 1 | **+242.7900¢** | +252.35% over one window; no SE |

The one taker fill nearly halved the day's funded loss. A single fill cannot establish a taker distribution, and
the completed bounded pilot remains closed. It supplies no authority for an unconditional route switch.

Sixteen accepted maker misses across 16 windows would have returned +454.12¢ on 436.88¢ at their posted terms;
15/16 later settled in the selected side, for +103.28% ±16.84pp clustered return. That reinforces adverse
selection, but no capital was deployed and no replacement or queue-priority path is observed. The fixed maker-
restriction review still failed its Holm gates; this monitor does not reopen it.

## 2. Exit contribution

Nine funded strict-value exits occurred in the fixed day. Only one beat settlement hold. They cost 29.2443¢ exact
versus hold, with −13.67% ±24.00pp clustered incremental return. Eight paper exits cost 151.2450¢ exact versus hold.
Unlike the prior fixed day, both tracks pointed against the actual exits in this interval.

Across active v22, 18 funded strict-value exits in 18 windows beat hold once and cost 88.1061¢, with
−20.16% ±12.57pp clustered incremental return. This is a continuing diagnostic warning, not promotion-grade exit
evidence. Exit-sentinel v2 still has the known outcome-selection defect around generic unavailability; reasoned v3
remains deferred and historical gaps cannot be relabeled after outcomes.

## 3. Paper operations and accounting

Paper remained mechanically complete at the fixed boundary:

| Measure | Fixed-day result |
| --- | ---: |
| Attempts / attempt windows | 155 / 66 |
| Fills / economic windows | 49 / 41 |
| Confirmed no-fills | 106 |
| Rejected / nonterminal | 0 / 0 |
| Exact stake / P&L | 1,307¢ / **−388.2450¢** |
| Whole-cent P&L | **−391¢** |
| Aggregate ROI | −29.71% |
| Clustered return | **−36.22% ±16.43pp** |
| Settlement latency | 16.602s median / 33.671s p95 |
| Over 60 seconds / overdue at boundary | 0 / 0 |

The immediately prior fixed day lost 364.5050¢ exact on 51 fills across 40 windows. The two adjacent paper days
were both negative; they still do not identify a unique forecast, queue, or exit correction.

The fixed-boundary paper bankroll tied independently: 10,000¢ starting, −3,616¢ whole-cent realized P&L, zero open
stake, 6,384¢ available, and zero residual. Lifetime exact paper reporting P&L was −4,154.8210¢. Exact and
whole-cent views differ because budget control quantizes each order and includes its durable corrections; neither
view substitutes for the other.

## 4. Paper/live fidelity

Within the fixed day, 65 accepted same-route/same-quantity maker pairs across 51 windows produced:

| Cell | Pairs |
| --- | ---: |
| Both filled | 12 |
| Paper only | 2 |
| Live only | 37 |
| Neither | 14 |

Agreement was 40.00%; paper captured 12/49 or 24.49% of accepted live maker fills. Across the complete prospective
exact generation at **2026-08-26T07:26:24Z**, 130 accepted-maker pairs across 83 windows had 25 both-filled, three
paper-only, 48 live-only, and 54 neither. Paper capture was 34.25%, and clustered paper-minus-live fill rate was
**−38.76pp ±5.54pp**.

Private FIFO position and cancellations ahead remain unavailable. This evidence rejects paper/live equivalence but
cannot select a queue correction. Paper calibration and F3 remain unchanged.

## 5. Capital and accounting controls

The signed performance read reported current-epoch exact live P&L of −2.9256¢ and whole-cent budget P&L of −150¢
across 299 settlements. At the authenticated **2026-08-26T07:25:38.821Z** snapshot, the 2,000¢ current budget had
1,822¢ available and 28¢ reserved. Lifetime exact live P&L was −1,001.9044¢.

The exact and whole-cent current-epoch figures are different accounting views rather than an arithmetic tie. The
whole-cent control identity tied at the snapshot: 2,000¢ start − 150¢ realized − 28¢ reserved = 1,822¢ available.
Periodic reconciliation was READY with one matching local/venue managed position and no blocker.

Stake expansion remained closed despite 220 settlement windows:

- clustered current-epoch return was −9.14% ±7.92pp;
- drawdown from peak equity was 26.32%, above the 10% expansion limit;
- lifetime exact P&L remained negative.

These are capital/risk ceilings. They block expansion but do not choose an economic policy.

## Decision and next gates

1. Keep Blend 0.4, buy policy v22, incumbent maker execution, strict-value exits, sizing, assets, paper calibration,
   and every capital/safety ceiling unchanged.
2. Continue forecast Phase 2 toward 300 windows and paper timing F2 toward 100 and 300 windows/30 races.
3. Keep both maker restrictions locked after their fixed review; do not combine or retune them from this daily slice.
4. Keep exit v3 deferred and do not treat v2's outcome-selected complete cohort as efficacy evidence.
5. Repeat the same fixed-UTC decomposition later. Negative returns alone do not tune production; a correctness,
   accounting, reconciliation, or safety contradiction would require immediate investigation.

This report is a dated monitor, not an endorsement of profitability and not financial advice.
