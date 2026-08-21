# Window-consensus direction gate: data collection and evaluation plan

> Status: **design draft, not approved, not implemented.** Nothing here authorizes a change to the forecast,
> entry rule, execution lane, or budget. This prescribes what to collect and how to evaluate a possible
> future "buy only when the selected side has been rising over a window consensus" gate. It follows the
> decision made on 2026-08-20 to (a) dig deeper into the 120/60/30/2 second windows plus 4/6/8/10 minutes,
> (b) collect the right data from now, and (c) revisit the decision periodically on longer timelines.
>
> Numbering continues the candidate progression in `docs/quote-trajectory-spread-signal-design.md`: that
> design collects trailing-60s + cycle-to-date; this design extends the same boundary to a full eight-window
> grid and adds the precommitted evaluation.

## 1. Decision and question

The desk currently qualifies a buy on the entry policy (`MIN_NET_EDGE` + gates) and places a maker limit.
The 2026-08-20 exploration (`reports/window-consensus-exploration-2026-08-20.md`) asked: **does the
selected-side venue move over multiple lookback windows before the buy separate winners from losers well
enough to gate on?** The exploration found:

- a **window-length gradient**: the 8–10-min move separates winners ~2× as well as the 30s move
  (480s up-move 27% win vs down-move 11%, over 104 orders / 12 days);
- an **all-windows-positive consensus** reaches 50% win rate but fires ~0.7 trades/day — it starves the desk;
- the **2s reading is noise** (0 uses in the consensus today);
- the **direction of the effect flips by regime**: the last-18h day showed adverse-before-winner; the
  pooled book showed up-before-winner. No pooled number is trustworthy across regimes.

None of that promotes anything. The right response is to (a) collect the full grid of window moves at
decision time, durably, for every qualified decision including unfilled ones, and (b) run a precommitted
forward evaluation with a fixed candidate set and a revisit cadence.

## 2. What to collect (the data contract)

Extend the existing quote-trajectory observation boundary (not a new store) with a **decision-time window
stamp** recorded on every qualified decision — filled **and** unfilled — at the moment the entry decision is
made. Per decision:

| Field | Meaning | Source |
| --- | --- | --- |
| `selectedSide` | the side the decision chose (`UP`/`DOWN`) | entry decision |
| `venueMoves` | signed selected-side ask move, cents, over **2s, 30s, 60s, 120s, 240s, 360s, 480s, 600s** | exact pre-submit quote series |
| `underlyingMoves` | signed Kraken-basis move over the same 8 windows | Kraken series / basis model |
| `quoteAges` | per-window age of the oldest quote used in that move | quote cache timestamps |
| `windowCoverage` | how many of the 8 windows had a fresh quote (`0..8`) | — |
| `issuedAt` | decision time | — |

Why the underlying is separate: a venue dip is the maker fill mechanism (adverse-move fills arrive when the
price comes to us); an underlying dip is asset momentum. The exploration's regime flip (08-20 vs pooled) is
the evidence that these two cannot be pooled into one "direction" number.

The 2s reading already exists (`entryDirectionObservation.preSubmit`); retain it, unweighted, until it has
≥300 windows.

## 3. What we do NOT collect

- No new venue request, poll, or scheduler: the 8 window reads all come from quotes the managed-maker /
  ledger path already fetches at decision time.
- No store additions beyond the stamp field on the decision record (single JSON write, same atomic path).
- No change to the gate, sizing, fill model, or budget.

## 4. Precommitted candidate set (fixed before any result)

Written down now, unchanged until the first forward review completes:

1. **All-positive gates**: each non-empty subset of the 8 windows as "buy only if every window shows a
   positive move". (2⁸−1 = 255 — cap to the 127 non-empty subsets of the 7 non-2s windows + the
   with-2s variants separately, since 2s has no coverage yet.)
2. **≥k-of-4** family over {30,60,120,240}, k ∈ {1,2,3,4}.
3. **Magnitude thresholds** on the top 5 single windows (30s, 60s, 120s, 480s, 600s): skip-buy iff
   move < −5/−10/−15/−20¢, and buy-only-if move ≥ +2/+5/+10/+15¢.
4. The **with-2s** consensus subset, evaluated only once 2s has ≥300 windows.

The multiple-comparison denominator is the size of this set (~250+ candidates). Every forward report must
state: "evaluated N candidates over W windows; the top cell is best-of-N, not a discovery."

## 5. Decision statistic and bar

- **Cluster** on settlement window (SPEC §5.1) — never rows.
- Candidate must beat BOTH:
  - the live rule's win rate / net within the **same regime** (a window/period tagged by cycle-regime, not
    pooled across the 0–56% daily spread), and
  - the whole-book rate after fees.
- On **≥30 independent settlement windows** (the count that distinguishes "real" from "hopeless" in this
  book, consistent with the long-shot review bar).
- **Frequency gate**: candidate must fire ≥ ~3 decisions/day at deployed stake, else rejected regardless of
  win rate. Rate-without-capital is not an edge under the 2,000¢ budget.
- Promotion is manual, versioned, SPEC §12.5. The sentinel itself is observation-only and can never make
  itself promotable (same rule as quote-trajectory).

## 6. Revisit cadence (longer-term review)

- **Every 500 resolved decision-windows** (~5 days), rerun this exact screen on the full ledger since the
  last review, append to a dated report. Same script, same denominators. Growth, not re-tuning.
- **Weekly**: with-2s subset once ≥300 windows (~08-27).
- **Monthly**: walk-forward-style review of the full decision history clustered by regime, with the
  multiple-comparison count stated each time.
- Every review: candidates, window sets, n, win rate, net, trades/day, MC count. Null results written up.
- Nothing auto-promotes; promotion is a manual SPEC §12.5 act.

## 7. Decisions recorded 2026-08-20 (maintainer)

These three close the open items; each is now fixed and cannot float at review time without a new design
revision.

1. **8-window grid is kept whole.** The exploration is saved, the venue+underlying stamp covers all eight
   windows (2s, 30s, 60s, 120s, 240s, 360s, 480s, 600s), and the with-2s consensus subset is evaluated
   only once the 2s reading has ≥300 windows. A schema break on `quote-trajectory-spread-v1` is
   acceptable if required; the observation boundary is extended, not replaced.
2. **Store it all**: the decision-time window stamp records every qualified decision — filled, unfilled, and
   requalified — so the adverse-selection and fill-miss story (which lives predominantly in unfilled
   orders) is never again reconstructed after the fact. The stamp is written at decision time, not at fill.
3. **Top-5 window set is fixed**: {30s, 60s, 120s, 480s, 600s} — precommitted now, used at every review.
   None of these may be swapped for another window at a later review; only the whole fixed set can change
   via a new design revision.

## 8. Explicitly out of scope

- Changing entry qualification, the maker gate, fees, or budget now.
- Making this a live rule before the forward bar is met.
- Pooling regimes without labeling.

**Relationship to existing docs**: this extends
`docs/quote-trajectory-spread-signal-design.md` (which already separates the three meanings of direction and
the collection-only boundary); it does not modify that design's collection behavior.