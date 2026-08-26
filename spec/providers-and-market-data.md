# Providers and market data

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-25  
> **Canonical for:** data sources, trading-provider variants, venue-specific findings, adapter boundaries, and contract normalization.  
> **Read with:** [`trading-risk-and-budget.md`](trading-risk-and-budget.md) for funded capability and account controls.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

## 5. Data sources and integrations

### Current initial sources

| Source | Use | Auth | Cache target |
|---|---|---|---|
| Polymarket Gamma API | Active 15m market metadata/probability | Public | 12 seconds |
| Kraken 1m OHLC + ticker | Single-series cycle-open reference, live price, and realized volatility | Public | 10 seconds |
| Polymarket CLOB books | Batched UP/DOWN bid/ask liquidity for actionable gating | Public | Every live market refresh |
| CoinGecko | Spot, returns, 7d sparkline | Public | 60 seconds |
| CoinDesk RSS | Recent headlines | Public | 10 minutes |
| Kraken OHLC | Multi-year weekly seasonal baseline | Public | 24 hours |
| Local price history | Supplemental long-term baseline | Local | Hourly snapshots |

### Trading-provider registry and variants

“Provider” in trading surfaces means a prediction-market venue or broker, distinct from an LLM research provider. The registry initially contains Polymarket and Kalshi and will add **Crypto.com**, **ForecastEx**, and **Robinhood** through official, permitted APIs only. Consumer web scraping or browser automation cannot authorize live trading.

Each provider exposes one or more immutable, versioned **provider/model variants**. A variant is the provider-specific interpretation and execution layer around Money Noodle's common venue-independent forecast, including:

- contract discovery and normalized asset/window mapping;
- exact rules, oracle/reference source, averaging window, timezone, and UP/YES mapping;
- quote/book normalization, tick size, quantity granularity, fee schedule, and settlement handling;
- execution style, fill assumptions, slippage/depth treatment, and reconciliation version;
- comparability classification and contract-target fingerprint.

Provider variants **must not blend provider prices into tradeable probability or confidence**. Prices remain benchmark and execution-cost inputs. A genuinely different forecast formula is a separate forecast-model variant and follows immutable evaluation/manual-promotion rules.

All provider variants run in isolated paper tracks from the same issuance stream. At most one explicitly promoted variant per provider may be live-enabled initially. Every current order and evaluation row retains `providerId`, `providerVariantId`, `forecastModelVersion`, `buyPolicyVersion`, and `executionPolicyVersion`, so variants never share outcomes or P&L accidentally. Historical rows written before a field existed are not rewritten: provider may normalize from its then-equivalent venue and market from the sole then-existing market, while every non-inferable missing variant or policy identity remains explicitly `unattributed` in read models.

Define a common `PredictionVenue` interface while preserving provider-specific contract semantics:
- `listMarkets(filter)`
- `getMarket(id)` / `getOrderBook(id)`
- `getAccount()` / `listPositions()` / `listOrders()` / `listFills()`
- `previewOrder(order)`
- `placeOrder(order, idempotencyKey)`
- `cancelOrder(id)`
- `subscribe(listener)` for quotes, orders, fills, and account events

#### Polymarket

Read path: Gamma API plus CLOB market/order-book APIs.  
Private path: CLOB authentication/signing, allowance/funding checks, orders, fills, and positions. Network/chain IDs and collateral semantics must be validated before enabling trade controls.

#### Kalshi

Read path: market/event and order-book APIs.  
Private path: signed API requests for balance, positions, orders, fills, placement, and cancellation. Environment (demo vs production) must be visually unmistakable.

#### Crypto.com

**Verified 2026-08-13: not viable for `crypto-15m`. Retains research-only status; capabilities stay false.**

The binary product is **Strike Options**, offered by Crypto.com | Derivatives North America (CDNA) under CFTC oversight, US only. Durations are 5 minutes, 20 minutes, 2 hours, daily, and weekly — there is no 15-minute contract. Three findings independently block integration:

1. **No programmatic access.** The Exchange API v1 covers spot, margin, perpetual swaps, and standard futures. Strike Options and Up/Down are not tradeable through it, and the Predictions API exposes data only with execution restricted on event-based elements. CDNA is a separate entity from Crypto.com Exchange. Scraping or browser automation cannot authorize live trading, so there is no path.
2. **No order book, and the venue is the counterparty.** Orders are market orders with protection on an immediate-or-cancel basis against a platform-quoted price; the trader sees an indicative amount and may fill anywhere within a slippage tolerance. Money Noodle's live edge is managed post-only maker placement, which cannot exist here, and no two-sided book means no observable spread from which to derive implied volatility. The counterparty sets the price knowing its own index.
3. **Not comparable.** Settlement uses CDNA's own indicative index price, taken from BID/ASK midpoints once per second, against a predetermined strike rather than a cycle-open reference, with a fixed US$10 payout. Under contract normalization this is `not comparable` to the 15-minute target, so it could not serve even as a benchmark price.

Even treated as its own market, the gap is structural rather than a recalibration: a dealer-quoted IOC binary needs a different execution model entirely — slippage tolerance, indicative-versus-fill reconciliation, no maker path, and no cancellation lifecycle.

**Connectivity verified 2026-08-13.** Public Exchange v1 reads require no credentials at all and are broad: 930 instruments comprising 577 spot pairs and 343 perpetual swaps, with real order-book depth and a $0.01 spread on BTC around $63.7k. Signed private reads also work: HMAC-SHA256 over the sorted key-value concatenation `method + id + apiKey + params + nonce` authenticated on first attempt, validating the construction against the live API. This is the strongest research surface of any candidate provider, and it needs no account to use.

What the API *does* support — spot, margin, perpetual swaps, futures — maps onto a **future** market rather than this one. Perpetual funding rates are an observable drift signal, unlike the current zero-drift model, so that work is gated behind directional-alpha research and not adapter plumbing. Before reversing this finding, confirm with CDNA or Crypto.com institutional support whether Strike Options market data and order placement are available programmatically; absence of public documentation is not proof that no interface exists.

#### ForecastEx

Planned read/paper-first adapter using official ForecastEx/authorized broker interfaces. Normalize exchange contracts separately from any introducing-broker account layer; verify participant eligibility, market-data access, settlement authority, fees, quantity/tick rules, order lifecycle, and authoritative fills/positions before live work.

#### Robinhood

**Verified 2026-08-13: no event-contract API. Not viable for `crypto-15m`.**

The only documented official interface is the **Crypto Trading API** at `trading.robinhood.com`: crypto only, US only, authenticated per request with an API key plus an Ed25519 signature carried in `x-api-key`, `x-timestamp`, and `x-signature`. Read-only actions cover accounts, holdings, orders, products, and quotes; order types are market, limit, stop-loss, and stop-limit. The official crypto-API article makes no mention of event contracts, prediction markets, equities, or options.

Two consequences for event contracts. There is no programmatic path, so live and paper are both unreachable. And Robinhood's prediction markets are widely reported to route to the Kalshi-regulated exchange with data sourced through Kalshi's API — if that holds, a Robinhood event-contract adapter would duplicate contracts Money Noodle already trades directly on Kalshi, adding a broker hop without adding a market. Treat the routing claim as reported rather than officially confirmed; it is a reason to deprioritize, not a verified fact.

**Connectivity verified 2026-08-13.** Signed reads of accounts and holdings work — Ed25519 over `apiKey + timestamp + path + method + body`, authenticated on first attempt. Market data, however, is spread-inclusive and has **no order book**: `best_bid_ask` returns `bid_inclusive_of_sell_spread` and `ask_inclusive_of_buy_spread` with an explicit spread of ~0.945% each way, roughly 1.9% round trip, against $0.01 on Crypto.com for the same asset. Robinhood is therefore usable as an account data source and unusable as a price reference or execution venue; no edge measured against a 1.9% round trip survives.

The crypto API is a genuine interface for a **future** `crypto-spot` market. Note that even quotes are account-authenticated, so unlike Crypto.com there is no unauthenticated market-data path: an adapter cannot be exercised at all without operator credentials. Market data appears limited to best bid/ask, estimated fill prices, and supported pairs, with no documented full-depth book or historical candles, so it is thinner than the Kalshi and Polymarket books the current policy assumes.

### Contract normalization

Never assume venue contracts resolve identically. A normalized market must retain:
- Venue ID, title, exact rules, resolution source, open/close time, timezone.
- YES/NO or UP/DOWN mapping.
- Tick size, minimum order, fee model, restrictions, and settlement terms.
- A `comparability` state: exact, approximate, or not comparable.
- Provider and provider-variant IDs plus immutable contract-target and rules fingerprints.
- Whether the capability is `research`, `paper`, or independently promoted `live`; unsupported capability must fail closed.
