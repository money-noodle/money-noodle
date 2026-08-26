# Providers and market data

> **Status:** Normative · **Parent:** [`SPEC.md`](../SPEC.md) · **Structurally verified:** 2026-08-26
> **Canonical for:** data sources, trading-provider variants, venue-specific findings, adapter boundaries, and contract normalization.  
> **Read with:** [`trading-risk-and-budget.md`](trading-risk-and-budget.md) for funded capability and account controls.
>
> This module contains requirements extracted from the former monolithic `SPEC.md`. Product behavior was not
> changed by the extraction. If this module appears to conflict with `SPEC.md` or another canonical module, stop
> and resolve the specification conflict rather than choosing one silently.

<a id="req-provider-integrations"></a>

## 5. Data sources and integrations

<a id="req-provider-source-set"></a>

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

<a id="req-provider-registry-variants"></a>

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

<a id="req-provider-polymarket"></a>

#### Polymarket

Read path: Gamma API plus CLOB market/order-book APIs.  
Private path: CLOB authentication/signing, allowance/funding checks, orders, fills, and positions. Network/chain IDs and collateral semantics must be validated before enabling trade controls.

<a id="req-provider-kalshi"></a>

#### Kalshi

Read path: market/event and order-book APIs.  
Private path: signed API requests for balance, positions, orders, fills, placement, and cancellation. Environment (demo vs production) must be visually unmistakable.

<a id="req-provider-crypto-com"></a>

#### Crypto.com

Crypto.com remains research-only for `crypto-15m`; market-data, paper, and live event-contract capabilities fail
closed. Its documented Strike Options product lacks a matching 15-minute target, programmatic event-contract
placement, a central limit order book, managed post-only execution, and comparable cycle-open settlement.

Spot, perpetual, futures, and margin APIs belong to a separately specified future market, not an adapter variant of
`crypto-15m`. Reconsideration requires official evidence of programmatic event-contract market data and placement,
operator eligibility, exact settlement semantics, and a separately designed dealer-quoted IOC execution model.
Consumer scraping or browser automation cannot supply capability. The dated investigation is preserved in the
ordinary decision history; absence of public documentation alone is not proof that no institutional interface
exists.

<a id="req-provider-forecastex"></a>

#### ForecastEx

Planned read/paper-first adapter using official ForecastEx/authorized broker interfaces. Normalize exchange contracts separately from any introducing-broker account layer; verify participant eligibility, market-data access, settlement authority, fees, quantity/tick rules, order lifecycle, and authoritative fills/positions before live work.

<a id="req-provider-robinhood"></a>

#### Robinhood

Robinhood remains unsupported for `crypto-15m`; market-data, paper, and live event-contract capabilities fail closed.
Its documented official API covers crypto trading rather than event contracts and supplies no verified
programmatic event-contract path or full order book. Reported routing of prediction markets to another supported
venue is unverified and cannot grant capability.

A future authenticated `crypto-spot` integration is a separate market with its own forecast, spread, depth,
eligibility, credential, and execution requirements. Before reconsidering event contracts, verify an official API,
exact contract ownership/routing, settlement target, order lifecycle, fees, and operator eligibility. Consumer
scraping or browser automation cannot supply capability. Dated connectivity and spread measurements remain in the
decision history rather than this requirement module.

<a id="req-provider-contract-normalization"></a>

### Contract normalization

Never assume venue contracts resolve identically. A normalized market must retain:
- Venue ID, title, exact rules, resolution source, open/close time, timezone.
- YES/NO or UP/DOWN mapping.
- Tick size, minimum order, fee model, restrictions, and settlement terms.
- A `comparability` state: exact, approximate, or not comparable.
- Provider and provider-variant IDs plus immutable contract-target and rules fingerprints.
- Whether the capability is `research`, `paper`, or independently promoted `live`; unsupported capability must fail closed.
