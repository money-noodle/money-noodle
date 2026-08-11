# Kalshi probability-weight analysis — 2026-08-11

## Question

Should issuance-time Kalshi probability enter tradeable `P(UP)`? If so, at what weight, after accounting for the Kalshi orders the modified probability would create?

## Current architecture

Kalshi is already used for:

- Side-specific actionable bid/ask, spread, fees, quantity, and execution.
- Contract reference/provenance and authoritative outcome.
- Implied-volatility and calibration benchmarks.
- A separately labeled venue-informed comparison probability.

Kalshi has **zero weight in tradeable probability**. The stored venue comparison currently combines 75% Polymarket and 25% Kalshi into a venue prior, then applies 0.30 venue log-odds weight. It cannot authorize trades.

## Method

- One fixed snapshot nearest five minutes remaining per asset/window.
- Exact matching Kalshi contract identity, actionable UP and DOWN asks, and authoritative Kalshi outcome required.
- 308 asset-windows across 44 settlement windows, from 2026-08-11 06:45 through 17:30 UTC.
- Binary policy v11 replay: selected-side probability at least 55%, net edge after estimated Kalshi fee at least 5pp, quality at least 50%, and ask from 5–97¢.
- Primary result selected at most the largest apparent edge per correlated settlement window.
- Candidate probability was used to regenerate the side and order decision; the original production side was not reused.
- Tested additive Kalshi log-odds weights 0.10–1.00, linear independent/Kalshi pools of 90/10 through 0/100, and the stored cross-venue comparison blend.
- Chronological halves, one-shot held-out selection, and five expanding walk-forward folds were evaluated.

Exact same-Kalshi-contract history is still short. The results are useful for rejection but insufficient for promotion.

## Probability accuracy

Kalshi improved probability scoring:

| Candidate | Brier score |
|---|---:|
| Independent production | 0.1602 |
| +0.10× Kalshi log-odds | 0.1521 |
| +0.20× Kalshi log-odds | 0.1476 |
| +0.30× Kalshi log-odds | 0.1453 |
| +0.50× Kalshi log-odds | 0.1445 |
| Kalshi-dominant linear pools | approximately 0.138 |

This confirms that Kalshi is an informative benchmark. It does **not** establish profitable tradable disagreement.

## Order and net-return impact

Primary top-one-per-window results:

| Candidate | Trades | Wins | Total normalized P&L | Mean per trade |
|---|---:|---:|---:|---:|
| Independent production | 10 | 3 | −1.55 | −15.53% |
| +0.10× Kalshi log-odds | 10 | 5 | −0.37 | −3.65% |
| +0.20× Kalshi log-odds | 10 | 5 | −0.37 | −3.65% |
| +0.30× Kalshi log-odds | 11 | 6 | −0.15 | −1.34% |
| +0.50× Kalshi log-odds | 14 | 8 | −0.26 | −1.86% |
| +0.75× Kalshi log-odds | 22 | 13 | −2.12 | −9.66% |
| +1.00× Kalshi log-odds | 36 | 26 | −0.98 | −2.71% |
| Stored Poly/Kalshi comparison blend | 15 | 7 | −1.51 | −10.03% |

Every direct positive-weight candidate lost after ask and fee. Higher additive weights produced more correct predictions and more orders, but paid too much for those outcomes. High linear Kalshi weights correctly eliminated all apparent edge and created no trades.

The 1.00× additive candidate is the clearest accuracy-versus-profit warning: 26/36 wins but negative P&L.

## Held-out results

The first half selected 1.00× Kalshi log-odds. On the untouched second half:

- Candidate: 16 trades, 12 wins, −0.53 normalized P&L, −2.41% per window.
- Independent baseline: 1 trade, 1 win, +0.33 normalized P&L, +1.52% per window.

Five expanding walk-forward folds:

- Selected Kalshi candidates: −1.13 total, −5.12% mean window return.
- Independent baseline: +0.33 total, +1.52% mean window return.
- Candidate positive in 0/5 folds.
- Candidate beat baseline in 0/5 folds.

Direct Kalshi weighting fails held-out profitability and stability gates.

## Kalshi as a veto rather than forecast input

A separate replay retained independent probability and used Kalshi only to reject excessive disagreement:

| Gate | Trades | Wins | Total normalized P&L |
|---|---:|---:|---:|
| No veto | 10 | 3 | −1.55 |
| Kalshi selected-side probability ≥45% | 7 | 4 | −0.32 |
| Same majority direction | 5 | 3 | −0.25 |
| Independent/Kalshi divergence ≤15pp | 4 | 3 | **+0.55** |

The 15pp divergence veto was positive in both chronological halves, but only four trades exist. It is a useful observation-only candidate, not promotion evidence.

## Decision

1. Keep Kalshi weight at **zero in tradeable probability**.
2. Keep Kalshi as a strong benchmark and execution price.
3. Do not use the existing venue-informed comparison blend to authorize orders.
4. Prospectively evaluate a separately versioned 15pp Kalshi-disagreement veto while preserving independent probability.
5. Reconsider only after materially more exact same-contract windows and positive chronological, fee-aware held-out results.

The reason is empirical rather than ideological: direct Kalshi weighting improves Brier score and win count, but every tested weighting lost money after the same Kalshi ask and fee used to create the order.

## Reproduction

```bash
pnpm analyze:kalshi-weight
```
