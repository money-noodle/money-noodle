# How order size affects fills on Kalshi — 2026-08-20

> **No size or fill policy change. Execution-identity repair completed 2026-08-21 (§6.1).** This
> investigation answers whether displayed offer size and the desk's own order size matter, whether splitting
> an order helps, and how partial fills work. It also found a live reconciliation collision in repeated maker
> episodes; the repair and auditable correction are recorded below.

## Inputs, method, and caveats

Reloaded `data/paper-orders.json` at **2026-08-20T15:47Z**: 3,014 rows, including 1,411 live rows spanning
2026-08-08T21:12Z–2026-08-20T15:47Z. A read-only signed account read at **2026-08-20T16:09Z** returned
1,655 venue order records and 1,696 fill records. Kalshi's current OpenAPI document and order documentation
were re-fetched in this session. Public BTC, ETH, and DOGE books were read at 16:10Z and swept with
`immediateBuyFill` (`lib/ioc-fill-model.ts`). No order was submitted, amended, or canceled.

The signed order response currently exposes 885 records whose client ID starts `live:`, fewer than the
1,252 locally accepted entry rows. It is therefore authoritative for the orders it returned—and decisive
that partial fills occurred—but not a complete denominator for lifetime fill-rate estimation. Public depth
is a point-in-time display, not guaranteed executable liquidity by the time an order arrives.

For the queue comparison, I used the displayed-ahead proxy on the initial accepted maker post, excluded the
one venue order ID collision described in §6, and clustered deep-minus-shallow differences by settlement
window. The largest caveat is that `displayedAhead` is not exact queue position and the managed order later
reprices, forfeiting that initial queue.

## 1. Kalshi's matching rule: price first, then time

Kalshi defines queue position as the number of contracts that must match before an order receives a partial
or full match, determined by **price-time priority**
([queue-position API](https://docs.kalshi.com/api-reference/orders/get-queue-positions-for-orders)). Its
OpenAPI document also states that reducing a resting order's size preserves queue position, while increasing
size or changing price sends it to the back of the queue.

That separates two meanings of “size”:

- **Displayed size ahead of our maker order is important.** It must trade or cancel before our order starts
  filling. Better price outranks it; at equal price, earlier time outranks it.
- **Our own order size does not buy priority.** Kalshi is FIFO, not pro-rata. A larger resting order has the
  same threshold for its first 0.01 contract, but a higher threshold for its last contract: approximately
  `queue ahead + our requested quantity` must trade through.
- **Displayed offer size matters to a taker.** It is how much can fill at that price. A request larger than
  the touch must either walk to worse prices allowed by its limit or end partially filled.

Kalshi publishes YES and NO bid ladders. A NO bid at `1−p` is economically the YES ask at `p`; the production
mapping is `selectedSideDepth` (`lib/order-book-depth.ts`).

## 2. Maker evidence: queue ahead matters materially

Accepted live maker orders with an initial displayed-ahead observation, excluding the collided order group
(**n = 493**):

| Displayed contracts at our price or better | Orders | Any fill |
| --- | ---: | ---: |
| 0 | 80 | 81.3% |
| 1–10 | 26 | 84.6% |
| 11–50 | 55 | 72.7% |
| 51–200 | 61 | 49.2% |
| 201–1,000 | 111 | 40.5% |
| 1,000+ | 160 | 28.8% |

Comparing `>200` with `≤200` only inside settlement windows that contain both, deep queues filled
**27.7pp less often ±6.7pp** over **84 windows** (`t = −4.11`). This supports the FIFO mechanism.

It is not an exact causal estimate:

- `displayedAhead` includes displayed quantity at better prices and our price, not Kalshi's private rank;
- a cached public book can disagree with the signed quote;
- production changes price during six checks over 12 seconds, and every price change forfeits the prior
  queue;
- asset, price, and market activity still differ inside a shared settlement window.

Kalshi exposes exact `queue_position_fp` for the account's own resting orders. Nothing in this repo calls
that endpoint; current telemetry remains a proxy.

The desk's accepted maker requests are small but not infinitesimal: **0.04–15.66 contracts**, median
**0.60**, p90 **3.16** (n = 1,228 with reliable requested quantity). The data do not justify saying own size
is irrelevant: the authoritative venue history contains 19 partially filled maker orders. What is supported
is narrower—queue ahead dominates the probability of getting any fill at these ticket sizes; own size
controls whether that fill completes.

## 3. Taker orders: larger size buys depth, not priority

An IOC buy consumes displayed offers from best to worst until it reaches either its quantity or its limit.
For the same static book and limit, increasing requested size cannot reduce the quantity already available
to the smaller order. It can, however:

1. reduce the fraction filled;
2. increase the average price if the limit permits worse levels; and
3. increase market impact for anything submitted after it.

A 16:10Z illustration from one rapidly changing public-book snapshot:

- BTC's displayed book filled a simulated 2,000-contract YES buy entirely at its 46¢ touch;
- ETH filled 2,000 at 50.79¢ average versus a 50¢ book touch, across three levels;
- DOGE exposed only 870.05 contracts across the 20 returned levels for the same request, averaging 40.36¢
  versus a 24¢ touch.

These are mechanics examples, not stable liquidity estimates. The market-summary quote moved materially
around the book reads, which is exactly why production refreshes the exact contract immediately before a
submission.

`placeKalshiTakerBuy` (`lib/live-orders.ts`) is more restrictive than the unconstrained illustration: its
limit is the refreshed selected-side ask. It therefore takes only liquidity at that approved price; a
larger request than the touch fills partially and cancels the rest rather than walking beyond the cap. The
signed history contains one such taker entry: **1.00 of 10.56 contracts** filled, with the remainder canceled.

## 4. Partial fills are real and ordinary

The signed 16:09Z history returned 885 `live:` entry order records:

| Venue result | Orders |
| --- | ---: |
| Full fill | 638 |
| Partial fill | **20** |
| Zero fill | 227 |

Nineteen partials were maker fills and one was a taker fill. The same signed read returned 131 managed exit
order records: 113 filled at least partly and **two were partial**. The local ledger independently contains
the corresponding two partial-exit child rows. These counts correct the earlier draft conclusion that the
desk had never ended an order partially.

Time-in-force determines the remainder:

- **Managed maker entry:** `good_till_canceled` and `post_only: true`. A partial remains resting until the
  12-second manager cancels and confirms the remainder. The acquired slice becomes the position; any fill,
  including 0.01 contract, ends requalification.
- **Taker entry:** `immediate_or_cancel`. Available quantity inside the cap fills immediately and all
  remainder cancels.
- **Reduce-only exit:** also IOC. A partial sold slice is booked separately, the unsold position remains,
  and a switch replacement is withheld. This prevents a partial exit from opening reverse exposure.
- **Fill-or-kill:** Kalshi supports it generally, but the repo records that Kalshi rejects the desk's
  reduce-only FOK shape, so exits use IOC and explicitly reconcile partials.

Counts and fills use 0.01-contract fixed point. Multiple maker fill records may occur at different prices as
the order is amended; the desk sums `count_fp`, computes a quantity-weighted price, cancels the remainder,
and returns `status: 'partial'` when filled quantity is between zero and requested quantity
(`placeKalshiBuy`).

## 5. Should one order be split into smaller attempts?

### Simultaneous child orders

No matching advantage. Submitted at one price without another trader interleaving, the children occupy the
same consecutive FIFO span as one parent. If another order interleaves, later children are worse. Child
orders add API writes, rate-limit use, more cancellation states, and more local fee reservations; each
filled child also consumes the desk's filled-order ceiling.

### Sequential children at the same price

Usually worse for completion: each new child goes to the back of the then-current queue. It can encounter a
better future book, but that is a new time/market opportunity—not a benefit created by making the quantity
smaller. Keeping one resting order preserves time priority; decreasing its quantity even preserves Kalshi's
reported queue position.

### Repricing one existing order

This can increase fill probability because better **price** outranks the old queue, not because the order
was split. Production already does this over six checks. The cost is explicit: every price change forfeits
the previous queue and can deepen adverse selection.

### Fresh post-miss episodes

Production permits up to three separately requalified episodes, each after fresh persistence. Excluding the
collision in §6, accepted maker fill rates were:

| Episode/attempt number | Accepted makers | Any fill |
| ---: | ---: | ---: |
| 1 | 1,183 | 52.4% |
| 2 | 39 | 51.3% |
| 3 | 6 | 16.7% |

The later samples are tiny and mix historical execution generations, so they do not establish a retry
benefit. More fill is not itself desirable: the active-v3 review found eventual losers filled 71.4% versus
27.8% for eventual winners (25 accepted outcomes; 9 windows), in
[`maker-adverse-selection-and-exit-depth-2026-08-19.md`](maker-adverse-selection-and-exit-depth-2026-08-19.md).
A retry proposal must beat the live rule after counting no-deployment as zero, not merely raise fill rate.

## 6. Safety defect found: repeated episodes can collide during create retries

This is load-bearing and separate from the economic result.

`placeKalshiBuy` gives a post-only acknowledgement-race retry the client ID
`` `${input.clientOrderId.slice(0, 30)}-${createAttempt}` ``. All episodes for one
asset/side/window share those first 30 characters. `clientMatches` in `lib/execution-reconciliation.ts`
recognizes the same truncated `-1`/`-2` form for every episode. Therefore a later episode's create-retry
order can match every earlier local episode in the same window.

That happened for `live:HYPE:UP:2026-08-20T14:30:00Z`:

- three local episode rows now carry the same venue order ID;
- the signed venue order was created during episode 3 with client ID
  `live:HYPE:UP:2026-08-20T14:30:-2` and filled 0.47 contracts;
- episodes 1 and 2 had terminal execution observations of zero fill, yet reconciliation later attributed
  the episode-3 fill, cost, and position to them as well.

The queue/fill analysis above excludes all three collided rows. This is not evidence that Kalshi duplicated
the fill; it is a local identity/matching defect. It can overstate local exposure and P&L and can charge one
venue fill to multiple ledger rows. The existing venue-position comparison should fail closed while the
position is open, but it does not prevent duplicate durable attribution after settlement. The safe repair
needs two parts agreed before code:

1. a collision-resistant, length-bounded client-order ID for each `(logical order, episode, create attempt)`
   and exact reconciliation matching; and
2. an auditable correction for the already-settled three-row ledger/budget attribution—never a hand edit.

Until that lands, repeated maker episodes are not mechanically safe merely because their base IDs differ.

### 6.1 Resolution, 2026-08-21

The approved repair in `docs/live-order-identity-correction-design.md` landed as live execution generation
`maker-high30-requalify3-fresh1c-idv2-v6`:

- new episode client IDs are deterministic 40-character `live:v2:<128-bit SHA-256 prefix>` values and create
  retries append exact `-1`/`-2` suffixes without truncation;
- reconciliation removed legacy fuzzy fill matching, permits exact v2 lost-response candidates only, and
  blocks one venue order from owning multiple local entries before applying fills;
- canceled zero-fill historical create-race records are recognized only as non-authoritative legacy noise;
  any filled, working, or unmatched managed record still blocks; and
- ledger v8 correction `live-order-identity-correction:hype-up:2026-08-20T14:30:00Z` preserved before/after
  snapshots, restored episodes 1 and 2 to their observed zero-fills, retained episode 3 as the sole 0.47 fill,
  and appended the matching trading-control audit event.

The correction improved exact order-record P&L by **53.58¢** and whole-cent live budget control by **54¢**,
from 1,755¢ available / −245¢ realized to 1,809¢ / −191¢. The difference is the required exact-versus-control
view, not unexplained drift. A second correction run made no change. Startup reconciliation then completed
READY with zero local or venue-managed positions. Funded automation remained operator-paused.

## 7. Direct answers

1. **Is offer size important?** Yes. For a taker, displayed offer size is the quantity available at that
   price. For a maker, displayed quantity ahead is a strong fill predictor; exact FIFO rank is better.
2. **Are larger purchases more or less likely to fill?** They are no less likely to fill *something* in a
   static book, but less likely to fill *completely* at one price. A permissive taker limit pays worse levels;
   a tight IOC cancels the excess; a maker needs more future sell volume to fill its tail.
3. **Do several smaller attempts help?** Not because they are smaller. Same-price children do not improve
   FIFO priority, and sequential children lose it. A later attempt may see a different market, but current
   evidence does not show a fill advantage and adverse selection makes “more fills” an unsafe objective.
4. **How do partials work?** Each matching slice executes immediately. GTC rests the remainder; IOC cancels
   it; FOK requires all-or-none. The desk has 20 authoritative partial entries in the returned signed
   history and two partial managed exits—not zero.

## Decision status

No size, retry, price, or fill policy changes are authorized. The client-ID collision is mechanically
repaired and its known ledger damage is corrected; exact `queue_position_fp` collection would now be the
cleanest prospective instrument for separating queue-ahead effects from own-size completion. Nothing here is
financial advice.
