# Second Market: Kalshi Hourly Crypto (Strike Contracts) — Design

> **Approved 2026-08-21** · Decisions locked: T-only, 8pp edge floor, 3/2/1 caps, 60s cadence,
> cross-market exposure ignored, strike-grid helper, all ten assets. · Status: design, implementation
> pending. Product/architecture truth lives in `SPEC.md §3.6` (markets & keying), `market-registry.ts`,
> `strategy-registry.ts`, `policy-manifest.ts`, and `basis-model.ts`. This document is the pre-code
> agreement for adding a second market: what the market is, how the contracts differ, and every
> registry/policy/store seam that must grow a case.

## 1. Situation

### 1.1 What was assumed

The plan opened as "hourly crypto as the 15m up/down with a 60-minute horizon." That framing is
**wrong and was corrected before anything was written.** There is no hourly up/down-vs-open contract
on Kalshi.

### 1.2 Verified against the live API (2026-08-21)

- Kalshi crypto series frequencies are only `fifteen_min`, `hourly`, `daily`, `weekly`, `monthly`,
  `annual`, `custom`, `one_off`. Probes for `KXBTC45`, `KXBTC45M`, `KXETH45M`, `KXBTC30M` all return
  HTTP 404. **There is no 45-minute crypto contract either.**
- `KXBTC15M` (the current market's series) resolves **up/down vs the prior cycle's open**: the 60s
  BRTI average at close ≥ the 60s BRTI average at the prior window's open. No absolute number. Its
  series title is "Bitcoin price up down".
- The **hourly** crypto series — `KXBTC`, `KXETH`, `KXSOL`, `KXXRP`, `KXDOGE`, `KXHYPE`, `KXBNB`
  (plus `KXTON`/`KXNEAR`/`KXZEC` and `D`-suffixed hourly spin-offs) — resolve against **absolute
  strikes**. Sampled `KXBTC` markets were **100 of 100** either `T` (above/below strike) or `B` (band
  between strikes). **Zero** resolve higher/lower than the prior hour. The hourly series title is
  "Bitcoin range".
- The daily series (`BTC` titled "Bitcoin range", `BTCD` titled "Bitcoin price Above/below", `ETH`
  "Ethereum range", `ETHD` "Ethereum price Above/below", …) are **also strike products, not up/down**,
  and currently have **zero listed markets** (dormant). Only the 15m is a literal up/down contract
  family on Kalshi.
- The `H`-suffixed hourly series (`KXNEARH`, `KXTONH`, `KXZECH`) have **zero listed markets**; they
  are dormant/legacy, not tradeable.

### 1.3 The decision

Proceed with **hourly crypto, strike-based**, treating each strike contract's directional side as the
hourly analog of a 15m up/down bet. The operator confirmed **T (threshold) contracts only** for the
first market; band (`B`) contracts are explicitly out of scope for Phase 1 (they are a separate
two-sided model + width-policy surface).

Kalshi's site displays the two contract families as separate price tiles on the same series: the
single-strike "$62,100 or above / or below" tile (the `T` family) and the "price range" tile (e.g.
`$78,400–78,499.99`, ~11% probability, ~9× payout, the `B` family). Both belong to `KXBTC`; they are
contract types, not different assets. Only the 15m series is a literal up/down.

## 2. The contract and what it changes

### 2.1 Contract resolution

Kalshi hourly crypto settles on a **CF Benchmarks index 60-second average** (BRTI for BTC, ERTI for
ETH, HYPEUSD_RTI for HYPE) before the hourly close, compared to the contract's **absolute strike**:

- `KXBTC-26AUG2116-T80799.99`: Yes if the 60s BRTI average is **above $80,799.99** at close.
- `KXBTC-26AUG2116-T62200`: Yes if below $62,200.
- `KXBTC-26AUG2116-B80750`: Yes if between 80,700 and 80,799.99 (band, deferred).

A window (e.g., 19:00→20:00Z) lists **one strike per ticker** and **many tickers per window**. The
query surface is therefore a **grid**: asset × window × strike × side.

### 2.2 The model consequence (the load-bearing difference)

The 15m model (`basisProbability`, `lib/basis-model.ts`) prices **exactly one thing**:
`P(settlement ≥ cycle-open reference)` — a two-sided event anchored to the open, solved as the CDF of a
driftless log-normal. That does **not** answer an absolute-strike contract, which needs
`P(close > K)`, `P(close < K)`, and (for bands) `P(A < close < B)` from a **price**: a whole log-price
distribution, then CDF evaluation at the strike.

**Good news:** the driftless log-normal generalizes. `basisProbability` already produces the CDF shape
`z = ln(current/reference) / (σ√T)`. Re-deriving against an absolute strike replaces the reference with
the strike: `P(close > K) = Φ(ln(current/K) / (σ√T))` and `P(close < K) = Φ(ln(K/current) / (σ√T))`.
Band probability = `Φ(z_high) − Φ(z_low)`.

The model surface is therefore not a parameter change — it is a **new probability target family**
(strike-threshold) sharing the same diffusion machinery. That is real, new forward code, not a tuning.

## 3. Registry and keying (SPEC §3.6 compliance)

The four keying axes must stay intact. A second market is **additive**, keyed by `marketId`.

| Concern | Keyed by | This market |
| --- | --- | --- |
| Budget | provider, % per enabled market | New `crypto-1h` allocation = % of current Kalshi equity |
| Forecast model and calibration | **market** | Shared diffusion, **horizon/strike-specific fitted parameters, drift, settlement correction**; every provider in the market reports the identical probability |
| Policy | provider × market | New policy row with an 8pp edge floor, not the 15m v22 tune duplicated |
| Position and correlation caps | market, global within the market | New `crypto-1h` caps (3/2/1), binding within this market only |

Concretely:

- **`lib/market-registry.ts`**: add `CRYPTO_1H: MarketId = 'crypto-1h'`, a descriptor
  (`horizonSeconds: 3600`, `settlementBasis: '60-second CF index average versus an absolute strike'`),
  and a **(kalshi, crypto-1h)** capability triple.
- **Fail closed:** capability is declared per (provider, market). Adding hourly to the registry does
  **not** grant Kalshi live authority on it. The new triple grants `marketData + paper`; `live` stays
  `false` until a separate promotion.
- **Provider registry** (`trading-provider-registry.ts`): add an hourly variant identity (e.g.
  `kalshi-1h-maker-v1`) so paper P&L is not pooled with the 15m maker.
- **Everything keeps `marketId`.** Orders, budget rows, policy rows, and summaries already carry an
  explicit `marketId`; the default still points at `crypto-15m`, so nothing existing migrates.

### 3.1 Strategy identity

A strike-defined hourly book is still semantically an edge binary buy (model probability minus ask
after fees), but **isolation requires the P&L not pool with the 15m edge book**, and `strategyId` must
distinguish it. Recommend a **new strategy id**, e.g. `edge-binary-buy-1h-strike`, with
`signalSource: 'model-probability'` unchanged.

This gates every money aggregation (`lib/strategy-isolation.test.ts` re-narrows by `strategyId`), so
the new strategy is added there and to every money path.

### 3.2 Candidate model: strike-grid selection

The 15m unit is one asset/window/contract. The hourly unit is one asset/window/**strike**. This
inverts the search:

- **Compute the probability curve once per asset/window** from the shared distribution, then evaluate
  it at each strike in the admissible band — not re-fit per strike.
- **Admissible strikes** sit inside the entry price band (provisionally the 15m 10–75¢ band) **and**
  clear the side floor **and** clear the 8pp net-edge floor after fees.
- A **strike-grid helper** emits the candidate strikes: strikes within a provisional ±N σ of current
  spot, where N is measured from the first hourly book sample, not assumed.
- **At most ONE strike per (asset, window)** may be selected. All strikes in a window settle on the
  same final price — buying two strikes on the same side is the same economic bet at doubled size, and
  buying opposite sides at two strikes is the double-buy the fail-closed default rejects. One per
  asset/window preserves the mirror and the 15m portfolio invariant.

### 3.3 Position and persistence identity must gain strike

The single most important code seam:

- Paper/live order identity keys on `symbol:side:closesAt` (`baseOrderId`, `persistenceKey` in
  `paper-execution.ts`). Unique for 15m because one contract exists per asset/window.
- Hourly **collides**: multiple strikes share a window. An order on `KXBTC:UP:20:00:80000` and another
  on `...:82000` are different tickers but the persistence key and portfolio slot judge them the same
  asset/window.

Design: **order/portfolio/persistence identity gains strike**:
`(marketId, strategyId, symbol, closesAt, strike, side)`. Local presentation groups by (asset, window)
while durable order identity and reserve/settlement attribution key by the specific strike ticker.

- `MarketQuote`/`VenueQuote` gains a `strike?: number`.
- `PortfolioCandidate` gains `strike` (distinguish) while the same-asset/window rule still forbids two
  strikes of the same asset+window — the economic double-buy guard.
- `baseOrderId`, `persistenceKey`, and the spike-sentinel id all include the strike ticker.

## 4. Cross-market position rule

**Cross-market exposure is deliberately ignored (operator decision, 2026-08-21).** The 15m and 1h
markets are separate instruments with different settlement semantics and different horizons, and each
market's caps bind **within that market only** — exactly as SPEC §3.6 already keys them. Concretely:

- No new same-underlying aggregation rule across `crypto-15m` and `crypto-1h`. A 15m BTC position and
  a 1h BTC position are two separate positions in two separate markets, each counting against its own
  market's caps, uncapped against each other.
- A 15m BTC-UP plus a 1h BTC-DOWN is **permitted** and is not "opposite exposure" in the SPEC sense:
  they are different contracts, not the same economic contract bought twice.
- The correlation-group map applies per market — the group cap constrains similar assets *within the
  hourly book*, never across books.

This is a recorded operator choice, not a default from SPEC: the risk of correlated windows across
both books is accepted as a monitoring question rather than a hard cap, and may be revisited by a later
design if measurement shows the correlation is material.

## 5. Model generalization and new edge floor

- Driftless log-normal generalizes to `P(settlement > K)` / `P(<K)`. **Drift stays zero** — hourly
  drift is not estimable from sparse short-horizon samples, and assuming it fabricates edge.
- **New edge floor — locked at 8pp for the hourly collection cohort** (operator decision 2026-08-21).
  The 15m sits at 5pp (v22) on ~58k observations of `P(settlement ≥ cycle-open reference)`; the hourly
  target `P(settlement ≥/≤ absolute strike)` has **zero calibration history**, so 8pp = 1.6× the
  proven 15m floor applied to an untuned surface. It excludes everything below 5pp where Kalshi's
  quadratic fee (~1.3¢ at a 75¢ ask) and tick error alone can flip an edge's sign, but admits a
  5–9pp band where venue-implied-vol misestimation is most plausibly tradeable. The cost of an 8pp
  floor is slower cohort accumulation on a 24-window/day book (a 10pp floor can drop below one
  qualifying paper trade/day); that cost is bounded because the track is paper-only. The floor is a
  collection-cohort number the 60-window cohort exists to re-examine, not a promotion.
- New **buy policy version** (`provider × market`) with its own `BUY_POLICY_VERSION`, added to
  `policy-manifest.ts` with matching `history` (the manifest test enforces this).
- **New execution-policy, sizing, and exit rows** — not shared with the 15m, because fees, tick sizes,
  and position cadence differ.
- **Position / same-window / same-group caps — locked at 3 / 2 / 1 within the hourly market only**
  (operator decision 2026-08-21). At most 3 concurrent hourly positions total, at most 2 in one
  settlement window, and at most 1 per correlation group per window. Deliberately not the 15m's
  measured 9/6/3 raise (justified by stacking evidence +2.3% live vs −5.7% single-position and +19.3%
  group stacking); the hourly book has no such evidence, its exposure per position is 4× longer, and
  strike multiplicity makes stacking easy. Caps rise only on measured stacking evidence after the
  hourly 60-window cohort.

### 5.1 Paper/market-data first; live withheld

- The new capability triple for (kalshi, crypto-1h) grants **marketData + paper**; `live` stays
  `false`. Fail closed.
- **Paper shadow trading** on the 1h strike book keeps the mirror invariant: the entry rule takes no
  execution mode — identical rule for paper/live.
- Live promotion is a separate manual act on committed sentinel evidence (`SPEC §12.5`), out of scope
  for this design.

## 6. Index and oracle handling

- **Settlement index:** hourly crypto settles on the CF Benchmarks index (BRTI/ERTI/…) 60-second
  average. The Kraken basis reference used for the 15m is only a *detection* series; the **contract
  truth for resolution keys on the CF index**.
- New target-integrity work: read/compare the CF index series for each asset, resolve strikes against
  the hourly close, and reconcile settlement outcome to the exact strike contract. This is new code:
  the contract-provenance and target-integrity frames assume one period-open reference and a
  settlement average; hourly strikes are absolute-price single-close events.
- A possible cross-source drift detection: compare the CF settlement value/close to the Kraken
  reference, same posture as the 15m, but now against a single absolute strike rather than the
  period-open reference.

## 7. Cadence

- **Cadence locked at 60s** for the 1h evaluation loop (operator decision 2026-08-21), 4× slower than
  the 15m's 15s cycle on a book with 4× fewer and 4× longer windows.
- **No 90s warm-up / 2-of-15s persistence copy**; the hourly qualifier wants a longer persistence span
  (different autocorrelation in the few-decision-per-hour world). Exact persistence/warm-up values
  remain implementation detail pending the first hourly cohort, but the boundary points — no warm-up
  copy, longer persistence, 60s cadence, no entry in the final minutes of an hour — are locked.
- 15-second polling would waste the shared Kalshi read-limit budget on a book that cannot act that
  fast.

## 8. Asset set — all ten, all fully participating

Add TON/NEAR/ZEC to the participating set (hourly strikes exist for them), not read-only:

- Widen `ASSETS` and the `KRAKEN_PAIRS` / CoinGecko mappings in `feeds.ts`.
- Ten symbols map to hourly series 1:1: BTC/ETH/SOL/XRP/DOGE/HYPE/BNB + TON/NEAR/ZEC.
- `cryptoExposureGroup` (`portfolio-policy.ts`) needs a mapping for the three new symbols
  (provisionally: `layer1-beta` for TON, `alt-beta` for NEAR/ZEC, with a correlation check before
  finalizing).

## 9. Decisions (locked 2026-08-21)

All six open decisions are resolved; nothing remains un-decided.

1. **New 1h entry edge floor — 8pp.** Collection cohort; re-examined at the 60-window boundary; not a
   promotion.
2. **1h position / window / group caps — 3 / 2 / 1**, within the hourly market only.
3. **Evaluation cadence — 60s**; no 15m warm-up/persistence copy.
4. **Cross-market exposure — ignored.** Each market's caps bind within itself; 15m-UP + 1h-DOWN is
   permitted (different contracts, not "the same economic contract").
5. **Strike admissible band — a "strike grid" helper** admitting strikes within a provisional ±N σ of
   spot, N measured from the first hourly book sample, not assumed; at most one strike per
   (asset, window).
6. **T (threshold) only; band (`B`) deferred** — the band family needs two-sided pricing
   `P(A < close < B)` plus a width policy and is a separate Phase 2.

## 10. Not in scope for this design

- Live promotion + funding on `crypto-1h`.
- The `B`/band and daily range/Above-below contract families (two-sided pricing + width policy; the
  daily series `BTC`/`BTCD`/`ETH`/`ETHD` are dormant today and belong to a future separate `crypto-1d`
  market if they ever list).
- A literal hourly or daily up/down-vs-open contract — none exists on Kalshi (only `KXBTC15M` is
  titled and resolved up/down).
- Expanding to other venues (Polymarket has 15m only; Crypto.com direction is a separate market).
- Migration of 15m data: none — additive keyed by marketId.

## Change log

- 2026-08-21 · Draft for review. Decided hourly-with-strikes; no 45m exists; all ten assets; CF
  index work; paper-first; slower cadence; new edge floor.
- 2026-08-21 · Decisions locked after operator review: T-only (band deferred); 8pp edge floor;
  3/2/1 caps per market; 60s cadence; cross-market exposure explicitly ignored; strike-grid helper.
  The threshold-vs-band site-tile distinction and the daily-range scope note were added.