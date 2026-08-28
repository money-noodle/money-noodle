# Second Market: Kalshi Hourly Crypto (Strike Contracts) — Design

> **Document type:** Product design
> **Design status:** Accepted
> **Implementation:** Partial
> **Created:** 2026-08-21
> **Canonical requirements:** [`spec/forecasting-and-evidence.md`](../spec/forecasting-and-evidence.md), [`spec/providers-and-market-data.md`](../spec/providers-and-market-data.md), [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md)
> **Decision record:** [`DEC-20260821-01`](../spec/decisions/decision-id-map.json)
> **Design index:** [`docs/README.md`](README.md)

> **Approved 2026-08-21** · Decisions locked: T-only, 8pp edge floor, 3/2/1 caps, 60s cadence,
> cross-market exposure ignored, threshold-pair selection, all ten assets. · Status: H1 public market-data
> capability and Vercel UI implemented; H2 detached durable observation activated prospectively at
> 2026-08-27T07:04:37.842Z. Its fixed ten-close wiring review found identity/outcome/archive/isolation healthy but
> cadence incomplete at 524/596 expected minute buckets; H3 paper remains pending. Product/architecture truth lives
> in `spec/trading-risk-and-budget.md` §3.6 (markets & keying), `market-registry.ts`,
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
venue listing is therefore a grid, but the Phase 1 candidate surface is not: discovery filters to the exact `T`
above/below threshold pair for each asset/window and does not evaluate the deferred `B`-family strike grid.

A fresh public-API check on 2026-08-26 found that one series can simultaneously expose `T` pairs whose
`open_time`→`close_time` durations are one hour, 25 hours, and seven days. `crypto-1h` therefore requires an exact
3,600-second duration; series identity or nearest future close alone is insufficient. Six of the ten planned
series exposed current exact-hour rule pairs in that single snapshot, but only five supplied the structured
floor/cap fields H1 requires; DOGE omitted both fields and remains unavailable alongside SOL, TON, NEAR, and ZEC.
Absence or structural incompleteness remains explicit and does not prove permanent unsupported status. See
[`reports/kalshi-hourly-threshold-contract-revalidation-2026-08-26.md`](../reports/kalshi-hourly-threshold-contract-revalidation-2026-08-26.md).

### 2.2 The model consequence (the load-bearing difference)

The 15m model (`basisProbability`, `src/lib/basis-model.ts`) prices **exactly one thing**:
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

## 3. Registry and keying (`spec/trading-risk-and-budget.md` §3.6 compliance)

The four keying axes must stay intact. A second market is **additive**, keyed by `marketId`.

| Concern | Keyed by | This market |
| --- | --- | --- |
| Budget | provider, % per enabled market | New `crypto-1h` allocation = % of current Kalshi equity |
| Forecast model and calibration | **market** | Shared diffusion, **horizon/strike-specific fitted parameters, drift, settlement correction**; every provider in the market reports the identical probability |
| Policy | provider × market | New policy row with an 8pp edge floor, not the 15m v22 tune duplicated |
| Position and correlation caps | market, global within the market | New `crypto-1h` caps (3/2/1), binding within this market only |

Concretely:

- **`src/lib/market-registry.ts`**: add `CRYPTO_1H: MarketId = 'crypto-1h'`, a descriptor
  (`horizonSeconds: 3600`, `settlementBasis: '60-second CF index average versus an absolute strike'`),
  and a **(kalshi, crypto-1h)** capability triple.
- **Fail closed:** capability is declared per (provider, market). Adding hourly to the registry does
  **not** grant Kalshi live authority on it. Activation is staged: H1 grants `marketData` only while `paper` and
  `live` remain false; the completed initial target grants `marketData + paper`, with `live` still false until a
  separate promotion.
- **Provider registry:** H1 uses a read-model identity such as `kalshi-hourly-threshold-read-v1`, not the
  provider's selected execution variant. The current provider configuration selects one variant per provider, so
  adding an active hourly execution variant early could stamp a 15m order with the wrong identity. Add the eventual
  `kalshi-1h-maker-v1` only with H3's provider × market execution-variant ownership and isolated paper P&L.
- **Everything keeps `marketId`.** Orders, budget rows, policy rows, and summaries already carry an
  explicit `marketId`; the default still points at `crypto-15m`, so nothing existing migrates.

### 3.1 Strategy identity

A strike-defined hourly book is still semantically an edge binary buy (model probability minus ask
after fees), but **isolation requires the P&L not pool with the 15m edge book**, and `strategyId` must
distinguish it. Recommend a **new strategy id**, e.g. `edge-binary-buy-1h-strike`, with
`signalSource: 'model-probability'` unchanged.

This gates every money aggregation (`src/lib/strategy-isolation.test.ts` re-narrows by `strategyId`), so
the new strategy is added there and to every money path.

### 3.2 Candidate model: the threshold surface is an up/down pair, not a strike grid

The plan originally treated the hourly book as a dense strike grid and built a whole "strike-grid
helper / evaluate every strike / at most one strike per asset/window" apparatus. **That assumed a book
shape the threshold product does not have.** Measured 2026-08-21 against the live API in the nearest
future window:

| Hourly series (nearest future window) | Total contracts | T (threshold) | B (band) |
| --- | --- | --- | --- |
| `KXBTC` | 188 | **2** | 186 |
| `KXETH` | 300 | **2** | 298 |
| `KXHYPE` | 75 | **2** | 73 |

The **188-strike grid is the band (`B`) family**, which we deferred. The threshold (`T`) product
we are initially implementing is **one above-strike contract and one below-strike contract per asset/window**
— a presentation pair. Candidate selection therefore aligns with the 15m one-position grouping, not with a grid,
while retaining the non-complementary contract identity below:

- **One T contract per side per asset/window** (above-strike = up, below-strike = down), the hourly
  analog of the single 15m contract per asset/window.
- Price the pair once per asset/window from the shared driftless log-normal:
  `P(close > K_high)` and `P(close < K_low)`.
- Admissible asks sit inside the entry band (provisionally 10–75¢), clear the side floor and the 8pp
  net-edge floor after fees — same qualifications as the 15m, applied to the up/down pair.
- The portfolio holds **at most one T position per (asset, window)** (one side of the pair), matching
  the 15m one-position-per-window rule and avoiding a doubled economic bet.

#### Independent candidate contract

“Pair” is presentation grouping, not binary complement identity. The first generation contains exactly these two
candidate classes when their exact contracts are available:

- `ABOVE`: buy YES on the floor-strike `T` contract; model `P(settlement > K_high)`; display direction `UP`;
- `BELOW`: buy YES on the cap-strike `T` contract; model `P(settlement < K_low)`; display direction `DOWN`.

Each candidate owns its ticker, strike relation/value, YES book, rules fingerprint, open/close timestamps, model
probability, and outcome. The BELOW probability is never `1 − P(ABOVE)`, and its quote is never inferred from the
ABOVE contract's NO book. The two events leave a middle region where both settle NO. Their NO books remain venue
mechanics for those exact contracts and are not additional entry candidates in the initial T-only family.

Discovery groups rows only when provider, series, asset, exact `open_time`, and exact `close_time` agree and
`close_time − open_time = 3,600` seconds. It identifies ABOVE from a finite floor strike with no cap strike and
BELOW from a finite cap strike with no floor strike, then confirms the exact rules. A missing or ambiguous side is
explicitly unavailable. It may remain visible as incomplete research evidence, but an incomplete group cannot
become paper-eligible. No ticker pattern, row order, subtitle, complementary price, or nearby longer-duration pair
may fill the gap.

**Open verification item (not a lock):** the two T strikes per window are not centered near spot in the
sample — BTC showed above-$87,799 and below-$69,200 around an ~$80k spot, roughly $8k above and $11k
below. If that asymmetry-to-spot persists, the threshold "up/down" is a **deep-wing pair** rather than
a near-the-money one — cheap contracts in the documented longshot region — and must be measured from
the first hourly book before any sizing or policy relies on it.

### 3.3 Position and persistence identity keys by strike ticker (not a grid)

Paper/live order identity keys on `symbol:side:closesAt` (`baseOrderId`, `persistenceKey` in
`paper-execution.ts`) plus the strike in the ticker. With the common threshold shape of **two contracts
per window, one per side**, `side + window` alone usually distinguishes the pair — but durable identity
must still key by the **exact strike ticker**, because a window can list more than one strike on a side,
and because reserve/settlement attribution is per ticker.

Design: **order/portfolio/persistence identity = `(marketId, strategyId, symbol, closesAt, ticker,
side)`** where `ticker` already encodes the strike (`MarketQuote.n` / `VenueQuote.ticker`). Local
presentation groups by (asset, window) while durable identity and reserve/settlement key by the exact
ticker.

- `MarketQuote`/`VenueQuote` already carries the ticker; expose the parsed strike for labelling.
- The same-asset/window portfolio rule forbids a *second* position in the same (asset, window) on any
  side — the double-buy guard. One T position per asset/window.
- `baseOrderId`, `persistenceKey`, and the spike-sentinel id include the ticker.

## 4. Cross-market position rule

**Cross-market exposure is deliberately ignored (operator decision, 2026-08-21).** The 15m and 1h
markets are separate instruments with different settlement semantics and different horizons, and each
market's caps bind **within that market only** — exactly as `spec/trading-risk-and-budget.md` §3.6 already keys them. Concretely:

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
- **New edge floor — locked at 8pp for the eventual hourly paper cohort** (operator decision 2026-08-21).
  The 15m sits at 5pp (v22) on ~58k observations of `P(settlement ≥ cycle-open reference)`; the hourly
  target `P(settlement ≥/≤ absolute strike)` has **zero calibration history**, so 8pp = 1.6× the
  proven 15m floor applied to an untuned surface. It excludes everything below 5pp where Kalshi's
  quadratic fee (~1.3¢ at a 75¢ ask) and tick error alone can flip an edge's sign, but admits a
  5–9pp band where venue-implied-vol misestimation is most plausibly tradeable. The cost of an 8pp
  floor is slower cohort accumulation on a nominal one-hour book (a 10pp floor can drop below one
  qualifying paper trade/day); actual listing availability controls the calendar. That cost is bounded because the
  track is paper-only. The floor is a paper-cohort number the 60-window cohort exists to re-examine, not a promotion.
  It has no authority during the read-only H1 market-data stage.
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

### 5.1 Market-data first, then paper; live withheld

- **H1 — read-only market data:** register `crypto-1h`, implement the exact-duration independent-candidate
  normalizer and strike model, and expose a stateless-safe Vercel surface. Capability is
  `marketData: true, paper: false, live: false`. H1 has no buy-policy, persistence, sizing, portfolio, budget,
  ledger, order, settlement-write, or reconciliation authority. It may display model probability, exact YES ask,
  and their labeled difference, but cannot call the row qualified, paper-eligible, or trade-ready.
- **H2 — durable observation:** the persistent worker may add a detached 60-second observation/outcome lane only
  after its schema, writer ownership, archive inclusion, exact-provider resolution, and non-interference tests are
  accepted. Stateless hosts remain writer-free. This stage supplies the prospective availability needed to freeze
  the still-unspecified persistence, warm-up, and final-cutoff values before paper starts.
- **H3 — paper activation:** only after the complete provider × market buy, persistence, sizing, execution, exit,
  portfolio, bankroll, settlement, and reporting identities are frozen and tested may the capability become
  `marketData: true, paper: true, live: false`. Paper shadow trading then keeps the mirror invariant: its entry rule
  takes no execution mode and would be identical to a future live rule.
- Live promotion is a separate manual act on committed sentinel evidence
  (`spec/policy-and-track-separation.md` §12.5), out of scope for this design.

### 5.2 H2 observation contract

H2 is `hourly-threshold-observation-v1`. The persistent worker owns one detached 60-second timer and one serialized
append-only writer for `data/hourly-threshold-observations.journal.jsonl`. Each asset/minute observation retains the
provider, market/data/model versions, UTC bucket, scheduled UTC research-window close, asset, availability reason,
exact venue open/close when present, spot/volatility
inputs, and each independent candidate's direction, ticker, strike/relation, four public quotes, model probability,
model-minus-ask diagnostic, rules fingerprint, and market URL. Duplicate asset/minute IDs are idempotent.

Exact public outcomes append separately by ticker and rules fingerprint after close. `YES`, `NO`, and explicit
venue invalidation are distinct; missing or delayed venue results stay unresolved. A contradictory result or rules
fingerprint fails the observer rather than relabeling history. Resolution uses only the exact Kalshi contract API;
Kraken never substitutes for the CF Benchmarks outcome.

The worker fetches one fresh H1 response per minute and at most ten due exact outcomes. Its timer is not awaited by
the 15-second collector, paper/live orchestration, settlement, or reconciliation. Errors drop/degrade observation
health and never delay or change another lane. Stateless hosts cannot start the writer. The journal is included by
the existing JSONL archive allowlist; compaction, retention, and deletion remain separate unapproved work.

`npm run analyze:hourly-thresholds` is read-only. It reports availability, exact identities, outcome coverage, and
model diagnostics clustered by scheduled UTC research close. That research-window key counts explicit listing
absence but is never substituted for an exact venue contract close or outcome identity. The first gates are:

- 10 independent closes: wiring, writer, identity, availability, outcome, archive, and non-interference smoke only;
- 60 independent closes: first availability/model review, with the CF-vs-Kraken target-integrity caveat explicit.

No backfill counts as prospective H2 evidence. Neither gate specifies persistence, warm-up, cutoff, qualification,
paper execution, sizing, bankroll, or live promotion; those remain a pre-outcome H3 design decision.

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

### 7.1 Request budget (see the canonical traffic reference)

The per-venue request inventory, worst-case single-cycle numbers, Kalshi token budget, and throttle
recovery matrix live once in `docs/venue-traffic-and-rate-limits.md`. This section only states the
hourly plan's delta and points there.

- At the locked 60s cadence the hourly market adds **one Kalshi public read per asset per 60s** = 10
  requests/min ≈ 0.17/s, negligible against Kalshi's 20/s sustained (10 tokens/request).
- The real hourly cost is **payload, not request count**: the hourly series needs the full strike grid
  (hundreds of contracts, dominated by the deferred `B` family) to locate the two threshold contracts,
  where the 15m read is `limit=10`. Bound this with a series/status/type filter that returns the
  threshold pair rather than the whole grid before the hourly market ships.
- Do **not** widen the 15m venue loop to implement the hourly asset set. Split the current global asset list into
  shared asset metadata plus explicit per-market membership: the existing seven stay on `crypto-15m`, while the ten
  planned symbols belong to `crypto-1h`. Shared spot/reference requests may fetch the union at the slowest adequate
  market cadence, but 15m Kalshi and Polymarket discovery must not acquire three unrelated subjects. This keeps the
  hourly delta near 10 Kalshi series reads/min plus bounded reference-data deltas rather than changing every 15m
  venue tick. The binding constraints remain (a) signed-read bursts during reconciliation/manager and (b) hourly
  grid payload.

See `docs/venue-traffic-and-rate-limits.md` §4 for the worked deltas.
- 15-second polling would waste the shared Kalshi read-limit budget on a book that cannot act that
  fast.

## 8. Asset set — all ten planned, availability explicit

Support the ten planned symbols in the read model, but never imply that a planned series has a current exact
one-hour listing. The 2026-08-26 snapshot found current pairs for six and none for four; a missing series/card is
shown as unavailable. Paper participation begins per exact available contract only after H3 rather than being
inferred from planned asset membership.

Add TON/NEAR/ZEC to the planned set and required spot/reference mappings:

- Replace the one global `ASSETS` ownership assumption with shared asset metadata and explicit market membership;
  keep the current seven-member `crypto-15m` set unchanged and define the ten-member `crypto-1h` planned set.
- Extend Kraken and CoinGecko mappings for the three new reference assets without adding their Polymarket/Kalshi
  15m discovery calls.
- Ten symbols map to planned hourly series 1:1: BTC/ETH/SOL/XRP/DOGE/HYPE/BNB + TON/NEAR/ZEC; current listing
  absence remains visible and does not remove the planned identity.
- `cryptoExposureGroup` (`portfolio-policy.ts`) needs a mapping for the three new symbols
  (provisionally: `layer1-beta` for TON, `alt-beta` for NEAR/ZEC, with a correlation check before
  finalizing).

## 9. Decisions (locked 2026-08-21)

All six original product questions are resolved. H1 deliberately has no entry policy. The exact persistence,
warm-up, and final-cutoff values required for H3 paper activation remain withheld pending the H2 prospective
availability cohort; they require a pre-outcome design amendment and cannot be selected from paper results.

1. **New 1h entry edge floor — 8pp.** Collection cohort; re-examined at the 60-window boundary; not a
   promotion.
2. **1h position / window / group caps — 3 / 2 / 1**, within the hourly market only.
3. **Evaluation cadence — 60s**; no 15m warm-up/persistence copy.
4. **Cross-market exposure — ignored.** Each market's caps bind within itself; 15m-UP + 1h-DOWN is
   permitted (different contracts, not "the same economic contract").
5. **Threshold-pair selection.** Discover the exact `T` above-strike and below-strike contracts for each
   asset/window, retain each exact strike ticker in durable identity, and permit at most one position per
   (asset, window). The `B`-family strike grid and a sigma-based strike-admissibility helper are out of scope.
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
  3/2/1 caps per market; 60s cadence; cross-market exposure explicitly ignored; the initial plan still included a
  strike-grid helper, which the contract-shape correction below superseded before implementation.
  The threshold-vs-band site-tile distinction and the daily-range scope note were added.
- 2026-08-21 · **Corrected the candidate model**: the threshold surface is an up/down pair, not a
  strike grid (measured 188/300/75 contracts per window, only 2 T each for BTC/ETH/HYPE). Removed the
  over-built strike-grid helper; the portfolio rule is now one T position per (asset, window). Added
  an open verification item on the deep-wing pair. Also added §7.1 request-budget delta pointing at
  the new canonical `docs/venue-traffic-and-rate-limits.md`.
- 2026-08-26 · Removed the remaining stale current-decision references to the superseded strike-grid helper and
  clarified that the full venue listing is a grid while the Phase 1 candidate surface is the exact `T` threshold
  pair. No market capability, policy, registry, or runtime behavior changed.
- 2026-08-26 · Revalidated all ten planned public series across 1,335 open rows. Defined exact 3,600-second
  selection, two independent YES candidate identities, explicit unavailable handling, and staged H1 market-data →
  H2 observation → H3 paper capability. This is pre-code prose and changes no current registry or runtime behavior.
- 2026-08-27 · Maintainer approved H2 detached durable collection: one asset/minute append-only observation,
  exact ticker/rules outcome ownership, persistent-worker-only writer, archive inclusion, 10-window smoke, and
  60-window first review. H2 grants no qualification, paper, live, budget, or reconciliation authority.
- 2026-08-26 · Maintainer approved the H0 contract and H1 implementation boundary under
  [`DEC-20260826-08`](../spec/decisions/decision-id-map.json). H1 added exact-duration public normalization, a
  zero-drift strike model, process-memory-only reads, market-specific asset membership, and a stateless-safe Vercel
  UI. Paper/live capability and execution-variant selection remain unchanged until H3 can key them by provider ×
  market.
