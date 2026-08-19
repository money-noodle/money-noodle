# Positive-edge buys, maker/taker execution, and early exits — 2026-08-19

Detailed follow-up: [`maker-adverse-selection-and-exit-depth-2026-08-19.md`](maker-adverse-selection-and-exit-depth-2026-08-19.md).

> **Finding, not a promotion:** the active buy gate still looks positive before execution, but the positions
> that actually fill do not. Current maker fills are strongly adversely selected against same-window
> accepted no-fills. The active bounded taker policy has no fills, so there is no current maker-versus-taker
> outcome comparison. Strict-value exits helped over lifetime paper history, but in the young v21 live
> cohort every one of its nine exits lost value versus holding. No production policy changes.

## Scope and deciding corrections

Recalculated at **2026-08-19T07:00:52Z** from 2,548 durable order rows and 61,630 forecasts with:

- `npm run analyze:positive-edge-current`
- `npm run analyze:take-the-ask`
- `npm run analyze:loss-decomposition`
- `npm run analyze:execution-gap -- 24`
- `npm run analyze:exit-counterfactuals`
- `npm run analyze:exit-alternatives`

The custom current-policy report uses the production `buildMakerFillReport` and `buildTradeRecord` builders.
Candidate rows are deduplicated to one `(symbol, closesAt, side)` position. Means and standard errors are
clustered by settlement timestamp; assets in one timestamp are not independent trials. Live and paper remain
separate and are not independent corroboration because they start from the same signal.

The caveat that most threatens every current-policy conclusion is sample age: v21 has only 25 resolved
candidate windows, and the active execution policy v3 has nine live settlement windows. Maker and taker
styles are deliberately assigned to different signals, so their realized returns are descriptive and not a
randomized causal comparison. Unfilled returns are counterfactual settlement returns at issuance terms;
filled returns use authoritative terms.

## 1. Is the active buy gate still buying the wrong positions?

Not before execution, on the evidence currently available.

| v21 chain, ask-priced and held | Decisions | Windows | Clustered return | ±SE |
| --- | ---: | ---: | ---: | ---: |
| Every first qualified position | 197 | 25 | **+17.5%** | 7.3pp |
| Positions selected for a live order | 60 | 24 | +13.9% | 16.2pp |
| Positions that obtained a live fill | 23 | 16 | **−23.6%** | 20.9pp |

The candidate gate clears two standard errors, although 25 windows is still a young policy cohort. The
ordered subset is noisy rather than demonstrably worse than the gate. The large sign change arrives only
after fill selection. **Later same-day correction:** the older contract-selection leak is withdrawn.
The initial correction still compared issued orders with alternatives that had not passed the same
decision-time state. The final replay applies persistence, regime, cooldown/retry, active exposure,
production sizing, and historical caps: 331 of 339 positive-control snapshots choose the same contract;
chosen minus replay-preferred is **−0.9pp ±2.7pp (95%) over 232 v17-v19 windows**. The remaining gap is
between the admitted and ordered cohorts, not a measured ranking defect. See
`reports/edge-buy-opportunities-2026-08-19.md` §8.

Actual v21 money also disagrees by track:

| Track | Settled | Windows | Raw P&L / stake | Raw ROI | Clustered return |
| --- | ---: | ---: | ---: | ---: | ---: |
| Live | 23 | 16 | −118.50¢ / 1,901.35¢ | −6.2% | −29.0% ±21.4pp |
| Paper | 34 | 20 | +111.76¢ / 2,869¢ | +3.9% | +1.8% ±16.6pp |

That disagreement is execution, not independent evidence that selection works on one track. No asset has
more than 11 paper or seven live v21 settlements. Both live directions are negative point estimates (UP
−19.6% ±36.3pp; DOWN −34.9% ±19.6pp), while paper UP is +7.2% ±27.2pp and DOWN −3.6% ±27.3pp. Price,
asset, and timing slices likewise fail to move together across tracks. Screening one of those small slices
out now would be retroactive selection, not evidence.

The 24-hour funnel found 477 admitted positions, 294 reconstructably persistent, 133 ordered, and 60 filled.
The desk still chooses among many candidates, but budget, correlation, rate, and existing-position constraints
are mixed into the 168 persistent positions not ordered. The conversion count alone cannot call those misses.

## 2. Maker versus taker

### What actually happened under v21

| Executed style | Attempts | Venue accepted | Fills/settled | Raw P&L / stake | Raw ROI | Clustered return |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Maker | 43 | 38 | 16 | +0.24¢ / 1,443.61¢ | +0.0% | −9.7% ±20.0pp |
| Taker | 28 | 12 | 7 | −118.74¢ / 457.74¢ | −25.9% | −36.7% ±63.3pp |

Maker looks better in realized cash, but the taker interval is enormous and these were not equivalent
signals. Most taker fills predate active execution policy v3. Under **v3 itself**, maker has 28 attempts,
25 venue acceptances, 10 fills, and −272.36¢ on 888.26¢ (−30.7%; clustered −42.3% ±23.4pp over nine
windows). Four v3 decisions selected taker; all four were refused before venue acceptance by the bounded
fresh-quote/slippage checks, so **v3 has zero actual taker fills**. It is not possible to say whether current
v3 takers are more successful.

The taker counterfactual is suggestive but not decisive. Across v21, 27 resolved recommendations in 13
windows returned +26.9% ±29.5pp and beat same-intent maker execution by +42.6% ±26.0pp. The advantage does
not clear two standard errors. V3 itself has only three resolved recommendations (+71.3% ±86.0pp) and no
actual fills.

### The current maker problem is fill selection

| Cohort | Paired windows | Filled minus accepted-no-fill win rate | ±SE | Filled minus no-fill return | ±SE |
| --- | ---: | ---: | ---: | ---: | ---: |
| v21 | 6 | **−50.0pp** | 22.4pp | **−110.1pp** | 28.3pp |
| execution v3 | 5 | **−60.0pp** | 24.5pp | **−112.9pp** | 34.5pp |

The samples are small, but they reproduce the prior-era mechanism and clear roughly two standard errors:
resting orders fill after price moves against the selected side and miss positions that continue away. This
is not evidence for taking everything. The rerun take-the-ask control still shows that repricing the same
fills at the ask loses the maker discount, while taking every decision mostly doubles capital deployment
without establishing a better rate of return. Selective taking remains a hypothesis, not a result.

A reporting defect is now visible: `buildMakerFillReport` excludes `liquidityRole === 'taker'`, but a taker
refused before submission has no liquidity role. It therefore counts the four current refused takers inside
`submittedAttempts` for the maker funnel. Accepted-maker, fill, and paired-return figures above are unaffected;
the submitted/acceptance headline and maker segments are overstated. Fix reporting before treating that
headline as operational evidence.

## 3. Is the early exit still protecting the book?

### How production exits work

The enabled rule is `strict-value-v1`, not a stop-loss and not a fixed take-profit. On a fresh executable
bid, `evaluateExitPolicy` computes:

1. cash available from a reduce-only sale, net of exit fee;
2. model hold value = quantity × owned-side probability;
3. optimistic hold value = quantity × (owned-side probability + uncertainty), capped at payout.

It sells only when executable cash exceeds optimistic hold value by at least 1¢. A 60-second same-side
cooldown plus fresh persistence prevents immediate re-entry. The separate `profit-reversal-75-v1` arm tracks
a +75% high-water reversal but is disabled; its measured result remains negative.

### Lifetime result

| Strict-value EXIT vs HOLD | Exits | Windows | Incremental return | ±SE | Raw incremental cash |
| --- | ---: | ---: | ---: | ---: | ---: |
| Live | 86 | 79 | +10.5% | 10.2pp | +892.29¢ |
| Paper | 219 | 165 | **+21.7%** | 8.6pp | +3,391.03¢ |

The memory that early exits kept the strategy afloat is grounded in the lifetime chain, especially paper.
The live point estimate remains positive but no longer clears two standard errors. Strict value often sells
positions that later win—82.6% of lifetime live strict exits would settle in the money—but historically a
smaller number of avoided losses offset the upside surrendered. That asymmetric insurance shape is why its
17.4% lifetime live hit rate does not by itself make the rule wrong.

### Active v21 result

| Strict-value EXIT vs HOLD | Exits | Windows | Incremental return | ±SE | Hit rate | Raw incremental cash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Live v21 | 9 | 7 | **−35.3%** | 6.5pp | 0/9 | −266.15¢ |
| Paper v21 | 18 | 11 | +25.6% | 40.3pp | 3/18 | −368.24¢ |
| Live execution v3 | 3 | 2 | −38.9% | 7.6pp | 0/3 | −105.10¢ |

The current live exit cohort has failed cleanly so far: every strict-value exit earned less than holding.
In raw exact cents, replacing those nine live exits with their authoritative hold outcomes would move the
v21 book from −118.50¢ to approximately +147.65¢, all else fixed. Paper exposes an important disagreement:
its equal-window normalized mean is positive while its raw cash total is negative, because stake and the
number of exits per window differ. Neither view should be hidden.

This is a material warning, not authorization to disable the exit after seven windows. It is one short
regime selected after looking at the outcome, and the paper track does not confirm the normalized loss.
The broader 26-rule replay also promotes nothing: take-profit rules were positive as a group (5/8, mean
+4.5% versus the live rule) and trailing rules 5/5 (+1.7%), but the best individual t was about 2 after 26
comparisons—expected under a null. Stop-loss, time-based, and profit-reversal groups did not help.

## 4. Conclusions and what the evidence authorizes

1. **Are maker orders more successful?** Historically and across all v21 actual cash, maker is better than
   taker. Under active v3 there is no comparison because no taker has filled. Maker itself is currently
   losing and strongly adversely selected.
2. **Are we buying the wrong ones?** The v21 gate and ordered-at-ask cohort are positive; the filled cohort
   is negative. The current evidence points first to *which orders fill*, not to a demonstrated bad gate or
   a stable asset/direction cohort. The later decision-state replay withdrew the older
   contract-selection claim; ranking is not a measured secondary mechanism.
3. **Is early exit still helping?** Lifetime paper says yes; lifetime live is now uncertain. Current v21
   live says no, strongly but over only seven windows. The former claim cannot be carried forward as though
   it were established for v21.
4. **Authorized now:** fix the maker-funnel reporting classification and keep collecting separately stamped
   v3 maker/taker and v21 strict-exit evidence. No buy gate, execution style, exit policy, stake, side, asset,
   or live-authority change is authorized by these samples.
