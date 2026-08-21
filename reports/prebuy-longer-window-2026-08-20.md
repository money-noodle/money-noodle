# Longer pre-buy direction windows (30s–8min): would a trend gate have helped? — 2026-08-20

> **Observation-only read.** Extends the 2-second pre-submit question to longer lookbacks. Reconstructs each
> filled order's selected-side ask at buy time and at buy−W for W ∈ {30, 60, 120, 240, 480, 900} s, from the
> 15-second forecast-history quote series (08-20 shard + journal) and the 15-second `contract-paths` store.
> 28–30 of 30 filled live orders have usable windows. No policy change is authorized.

## The question

"2 seconds is too short — what if we read the short-term direction over 1 minute before the buy, and only
bought if trending up?"

## Answer: no, 1 minute does not fix it

The full window sweep:

| Lookback | Winners mean move | Losers mean move | skip-adverse NET | kept winners | winners foregone | losers avoided |
| --- | --- | --- | --- | --- | --- | --- |
| 30s | −0.2c | −5.9c | +10c | 6 | 8 (−273c) | 9 (+283c) |
| **60s** | **−2.1c** | **−5.7c** | **+46c** | 6 | 7 (−237c) | 9 (+284c) |
| 120s | −3.5c | −5.6c | +26c | 6 | 7 (−231c) | 8 (+257c) |
| 240s | −4.0c | −12.8c | +28c | 6 | 5 (−187c) | 7 (+216c) |
| 480s* | +1.5c | −18.2c | +149c | 1 | 1 (−43c) | 6 (+192c) |

\* 480s covers only the 9 orders bought 8+ minutes into the cycle — a late-cycle sub-cohort already biased to
losers (incl. the −93¢ BNB loss); the +149c is a sub-population artifact, not a signal.

### Why 1 minute fails — the median tells the story

**Winners' median 60s move: −4.0c. Losers' median 60s move: −4.0c. Identical.**

Winners mean −2.1c, losers mean −5.7c — a *slightly* larger adverse move for losers, but the distributions
overlap almost completely and no magnitude threshold separates them:

| 60s threshold (skip if move <) | skipped | winners foregone | losers avoided | NET |
| --- | --- | --- | --- | --- |
| −2c | 15 | 7 | 8 | +25c |
| −5c | 12 | 6 | 6 | −4c |
| −10c | 8 | 4 | 4 | +10c |
| −15c | 6 | 3 | 3 | +12c |
| −20c | 4 | 2 | 2 | +20c |

Every threshold is ≈ 0 — the same coin as the 2-second reading, just with the same face showing.

### The 7 winners a 60s gate would have dropped

These are **the day's best trades** — every one won *because* the market dipped to the resting bid, which is
the only way a maker order fills:

```
HYPE UP  sold  move −4c   +21 (+22 hold)      SOL UP sold  move −8c  +30 (+35 hold)
SOL UP   sold  move −10c  +30 (+30 hold)      DOGE UP sold move −20c +36 (+36 hold)
BNB UP   won   move −34c  +43                 BTC UP sold  move −5c  +26 (+30 hold)
BNB DOWN sold  move −30c  +27 (+41 hold) ← day's best hold-winner
```

The −30c and −34c "adverse" moves are not crashes — they are the **entry discount**, the price coming down to
us, exactly the fills the strategy exists to capture.

## The structural finding, across all windows

The ambiguity is **not** a 2-second artifact. It survives at 30s, 60s, 120s, and 240s because it is
structural for a maker strategy:

- **A resting bid fills only when the market moves against your side** (price dips to your bid).
- Therefore **winners and losers both arrive with adverse-looking pre-buy movement** — the winners had the
  dip-and-recover, the losers had the dip-and-crash.
- A direction gate that skips adverse movement skips **both** — and since the strategy is a maker, the
  adverse-move winners it drops are systematically the *discount captures*, which carry most of the value.

Longer windows don't separate them either, because the discriminating feature is not *which way* the price
moved in the preceding minute — it's whether the move reverses, which is not knowable before the buy.

## What would actually work (and is already collecting)

The trailing-60s and cycle-to-date **underlying** (Kraken basis) direction — the `quote-trajectory-spread-v1`
collection deployed 2026-08-20 — is a different quantity than the selected-side venue ask. It measures the
asset, not the book, and the adverse-selection mechanism (venue dip = fill) does not apply to it. That is the
feature worth a forward sentinel with a predeclared threshold.

The same collector answers the "momentum at buy" question with the exact horizon (trailing-60s) the desk
would actually consult — but it has ~1 window of data so far and can promote nothing.

## Caveats

- 28–30 orders, one day, one regime (UP drift). Not a basis for any change.
- Lookback windows reconstructed from 15s forecast-history + contract-paths; 2 orders unreadable (bought
  within 60s of cycle start, before watch data begins).
- Multiple comparisons: 6 windows × 5 thresholds = 30 looks at 28 orders. The result is not a discovery; it
  is "no window beats ≈0," which is the honest null.

Full inputs: `data/paper-orders.json`, `data/forecast-history-shards/2026-08-20.json`,
`data/forecast-history.journal.jsonl`, `data/contract-paths.journal.jsonl`.