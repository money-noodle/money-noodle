# Venue Traffic, Rate Limits, and Throttle Recovery — Canonical Reference

> **Document type:** Reference
> **Design status:** Reference
> **Implementation:** Not applicable
> **Created:** 2026-08-21
> **Canonical requirements:** [`spec/providers-and-market-data.md`](../spec/providers-and-market-data.md), [`spec/trading-risk-and-budget.md`](../spec/trading-risk-and-budget.md)
> **Decision record:** None — no accepted product decision
> **Design index:** [`docs/README.md`](README.md)

> Living reference · 2026-08-26. This is the single place that states, per venue, what traffic the
> system produces, the worst case, and how a throttle is recovered. Every design that adds a subject
> (a market, an asset, a cadence, a reader) must reconcile its numbers here before landing. It cites
> code constants (`src/lib/freshness.ts`, `src/lib/task-cadence.ts`, `src/lib/kalshi-rate-limit.ts`,
> `src/lib/kalshi-api.ts`, `src/lib/kalshi-quote-cache.ts`, `src/lib/cache.ts`) rather than restating behaviour
> from memory.

## 1. The load-bearing facts

- **Kalshi is the only venue with purpose-built throttle machinery, but observed public bursts still exceed the
  effective limit.** It has (a) a public-read backoff/pause (`src/lib/kalshi-rate-limit.ts`), (b) separate signed read and signed write buckets each
  with 3-attempt 429-only retry (`src/lib/kalshi-api.ts`), and (c) a per-ticker single-flight quote cache
  (`src/lib/kalshi-quote-cache.ts`) so the entry path, manager, and reports deduplicate.
- **Polymarket, Kraken, and CoinGecko have no 429 awareness at all.** Their failures are absorbed by
  the generic `cached` wrapper (`src/lib/cache.ts`), which serves the previous value with a stale flag or,
  on a cold cache, throws. A rate limit on these venues therefore presents as "stale data", not as a
  controlled backoff. That is a capability gap, not just a different flavour.
- **Kalshi's token budget** (from the venue's basic tier, as encoded): 200 tokens/s refill, 600-token
  bucket, **10 tokens per request** ⇒ **20 requests/s sustained, 60 in a burst**. Public reads,
  signed reads, and signed writes draw from the same token pool but the app tracks them as separate
  backoff buckets.

## 2. Per-venue request inventory (current, 15m-only, 7 assets)

All counts are *upstream requests* (what the venue sees); the `cached`/`cachedKalshiRead` layers may
suppress them between TTLs.

| Venue | Endpoint | Cadence (TTL) | Requests / tick | Bound |
| --- | --- | --- | --- | --- |
| **Kalshi** public | `/markets?series_ticker=<series>&limit=10` | 12s (`kalshiCacheMs`) | **1 per asset** = 7 | N assets |
| Kalshi public (on-demand) | order-book monitor ladder | 2s while one operator panel expanded | 1 | at most 1 expanded card |
| Kalshi public (prospective F2 shadow) | exact maker-price quote twice + one final trade-history read | only a newly durable paper maker; 400ms/250ms timing + 3s post-horizon evidence grace | 3 per observed intent | at most 6 intents/calculation; no retry; overflow unavailable |
| Kalshi signed (exact pre-submit / manager) | exact-contract quote/depth/trade | on-demand / bounded | per-ticker, single-flight | depends on entries |
| Kalshi signed (reconciliation) | cutoff, cash, nonzero positions, order/fill delta, resting twice, exact active order/fills | 5 min + event | 7 base reads + bounded active IDs | live-enabled only |
| Kalshi signed (full reconciliation) | cash, nonzero positions, current-tier orders/fills, resting twice | startup/manual/drain | 6 base reads + current-tier pages/cancellation refresh | explicit barrier only |
| **Polymarket** | Gamma events (`?slug=`) | 12s (`polymarketCacheMs`) | **1 per asset** = 7 | N assets |
| Polymarket | CLOB `/books` POST | same 12s pass | **1** (all tokenIds batched) | 1 |
| **Kraken** | `/public/Ticker` | contractReference 10s | **1** (all pairs) | 1 |
| Kraken | `/public/OHLC?interval=1` | contractReference 10s | **1 per asset** = 7 | N assets |
| Kraken | `/public/OHLC?interval=10080` (weekly) | 24h (`seasonalCacheMs`) | **1 per asset** = 7 | N assets, 24h |
| **CoinGecko** | `/coins/markets` (all ids) | 60s (`coinGeckoCacheMs`) | **1** | 1 |
| CoinDesk RSS (news) | `/arc/outboundfeeds/rss` | 10 min (`newsCacheMs`) | **1** | 1 |

## 3. Steady-state vs worst-case single cycle

**Steady nominal** (the 15s collector tick, `dashboardPollMs`, with the sub-15s-TTL feeds refetching
each tick):

| Venue | Steady public reads / 15s | / min |
| --- | --- | --- |
| Kalshi | 7 | ~28 |
| Polymarket | 8 (7 events + 1 CLOB) | ~32 |
| Kraken | 8 (1 ticker + 7 OHLC) | ~32 |
| CoinGecko | ~0.25 (1 per 60s) | 1 |
| News | ~0.025 (1 per 10min) | ~0.15 |
| **Total** | **~23.3** | **~93** |

**Worst-case single cycle** — every TTL cold at once (process start, or every long feed firing in the
same tick): Kalshi 7 + Poly 8 + Kraken 15 (8 fast + 7 weekly) + CoinGecko 1 + news 1 ≈ **32 requests
in one 15s cycle ≈ 2.1/s average over that tick**. That is 3.5% of Kalshi's 20/s sustained and 3.5% of
its 60/s burst for the Kalshi share (7); from the public-read capacity standpoint the quote loop is far
from the binding constraint.

The F2 paper timing shadow adds at most 18 public reads in one calculation: six create quotes, six acknowledgement
quotes, and six final history reads separated across its approximately 15-second lifecycle. That is at most 1.2
requests/s if every calculation is continuously saturated and each six-request sub-burst consumes 10% of the
60-request venue bucket. The inspected last-day 160 paper makers imply 480 reads/day, approximately 0.006/s on
average. No retry is permitted; cap overflow or public backoff records unavailable evidence. This accounting is an
upper bound, not permission for later candidates to reuse the capacity.

**The real pressure points are signed Kalshi reads**, not the public quote loop. Full startup/manual/drain
reconciliation reads cash, nonzero positions, current-live-tier orders/fills, and resting orders, paginated at
1,000 rows; this remains a barrier but no longer runs every five minutes. Periodic/event reconciliation has
seven base reads (historical cutoff, cash, nonzero positions, fixed-window orders, fixed-window fills, and
resting before/after) plus exact order/fill reads bounded by locally active or uncertain IDs. Those venue reads
run outside the execution-ledger serializer while reconciliation state fences new live exposure. Notifications
of "read-limit backoff at startup" in STATUS trace to signed reads sharing the same 10-token pool as public
quotes while the signed buckets also carry exact pre-submit and manager reads. **This is where the 600-token
burst matters.** A busy live desk adds per managed maker 6 checks × (quote+depth+trade+fill) reads over 12s.
The former long-shot one-second entry/trailing/target reads were removed with that strategy on 2026-08-26.

## 4. What the hourly plan adds

The `crypto-1h` plan (docs/second-market-hourly-crypto-design.md) changes the table in three ways:

1. **New public-read traffic (additive, distinct series).** The hourly market reads the same
   endpoint shape but a **different series name** (`KXBTC` not `KXBTC15M`) and needs the **whole
   grid** to locate the 2 threshold contracts — the current 15m read is `limit=10`, so the hourly
   read pulls hundreds of contracts per series (the `B` family we defer) to find the `T` pair. That is a
   **payload** increase far more than a requests/sec one: still 1 request per asset per cadence, but a
   ~200–300-contract body instead of a 10-contract one.
2. **60s cadence (locked).** At one read per asset per 60s: Kalshi hourly adds **10 assets × 1 = 10
   requests/min ≈ 0.17/s**. Negligible against 20/s sustained. Request count stays near-flat against the
   token budget; the load that matters is bandwidth on the grid fetch, which a min-60s cadence bounds.
3. **Market-specific membership keeps the 15m venue loop at seven assets.**
   - The hourly design no longer widens the one global `ASSETS` list and accidentally adds TON/NEAR/ZEC to 15m
     Kalshi and Polymarket discovery. Shared asset metadata gains those symbols, while explicit market membership
     keeps the current 15m subjects unchanged and gives the hourly market its planned ten.
   - Hourly reference data may add up to ten 1m-OHLC reads/min plus one batched ticker read/min at its 60-second
     cadence; CoinGecko remains one batched request with a larger ID set. That is approximately another 0.18
     requests/s before cache reuse, rather than adding requests to every 15-second venue cycle.
   - Together with ten hourly Kalshi reads/min, the planned request-count delta is approximately 0.35 requests/s.
     Exact cache sharing and cold-start arithmetic must be remeasured in the implementation review; this estimate
     does not authorize a broader caller or faster cadence.

**Net against Kalshi token budget:** the hourly public quote count remains a small fraction of the 20/s sustained,
and the existing 15m venue count does not change. The binding constraints remain (a) the signed-read burst during
reconciliation/manager, and (b) the **grid-payload** cost of hourly reads, which must be bounded (prefer a
`status`/type/time filter or series query that returns the exact one-hour threshold pair rather than the full band
grid) before the hourly market ships.

## 5. Throttle recovery matrix

How each venue recovers when it says "slow down":

| Venue | Mechanism in code | Recovery behaviour | Notes / gaps |
| --- | --- | --- | --- |
| Kalshi public | `kalshi-rate-limit.ts` backoff | exponential 250ms→8s, jittered, `pausedUntilMs`; any success clears the pause; a cached value may be served stale | mechanism works, but a 190-response exact-market 429 burst in one 2026-08-25 window proves caller/time attribution and effective-burst accounting are incomplete |
| Kalshi signed read/write | `kalshi-api.ts`, 3 attempts, `backoffMs` | 429-only retry; **write retries only on explicit 429** (a timeout/drop keeps the uncertain+reconcile path, because the order may exist) | correct and important |
| Kalshi quote cache | `cachedKalshiRead` single-flight | failed load resolves `undefined`, dropped not cached, next caller retries; `allowStale` optional | solid |
| Polymarket | none | `cached` serves previous value (stale) or throws on cold | **no 429 awareness/backoff** |
| Kraken | none | `cached` stale fallback | no 429 awareness; Kraken is permissive but has no explicit backoff coded |
| CoinGecko | none | `cached` stale fallback | no backoff; free-tier limits are the risk |
| News (CoinDesk) | none | `cached` stale fallback | low volume; no backoff |

**Gap to close (prospective, not this plan):** the non-Kalshi venues should grow the same "named
throttle" treatment the Kalshi read already has — detect 429/too-many and back off inside `cached`
rather than silently serving stale, so a throttle is visible as a controlled backoff instead of
indistinguishable from a flaky upstream. That is separate work, out of scope for the hourly market.

## 6. Worst-case arithmetic for future edits

To keep this reference honest, state any new subject (asset, market, cadence, reader) as a delta here.
Template: **Δ requests/s** = `N_subjects × requests_per_subject_per_tick / tick_seconds`. Check the
result against Kalshi's 20/s sustained and the burst budget; report **request count** and **payload**
separately, because the hourly case shows they diverge.

## Change log

- 2026-08-26 · Replaced the planned global 7→10 asset widening with shared asset metadata plus per-market
  membership. The 15m venue loop stays at seven subjects; the hourly ten-series and reference-data delta is
  separately bounded. No runtime caller or capability changed.
- 2026-08-26 · Removed the long-shot ordinary/trailing/target quote load after the strategy's final review;
  no replacement reader was added.
- 2026-08-26 · Recorded the 190-response public exact-market 429 burst across seven 20:15Z contracts. The existing
  log does not retain caller/time attribution, so dense long-shot watching is a source-based hypothesis rather than
  a settled cause. F2 remained 100% available and no incomplete exit-v2 position belonged to that window; see
  [`reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md`](../reports/exit-sentinel-preclose-availability-diagnosis-2026-08-26.md).
- 2026-08-25 · Added the prospective F2 paper timing shadow: three public reads per observed paper maker, capped
  at six intents/calculation, no retries; at most 18 reads/calculation or 1.2/s continuously saturated, with the
  inspected 160-maker day implying about 0.006/s average.
- 2026-08-23 · Replaced five-minute full-live-tier pagination with seven-base-read incremental reconciliation
  plus bounded exact active IDs; retained full current-tier pagination at startup/manual/drain barriers.
- 2026-08-21 · Created as the canonical per-venue traffic/rate-limit/recovery reference to support the
  `crypto-1h` plan. Quantified current 15m (7-asset) steady and worst-case, the hourly plan's added
  public-read/grid-payload cost, and the readiness gap on the non-Kalshi venues.
