# Kalshi hourly threshold-contract revalidation — 2026-08-26

## Question

What contract shape did the ten planned Kalshi hourly crypto series expose immediately before implementation, and
what must the first read-only selector preserve?

This was a public, read-only venue-mechanics check. It did not inspect an account, place an order, score a policy,
or authorize market-data, paper, or live capability.

## Method and cohort

At approximately `2026-08-26T15:36:50Z`, request the public Kalshi markets endpoint once for each planned series:
BTC, ETH, SOL, XRP, DOGE, HYPE, BNB, TON, NEAR, and ZEC. Each request used `status=open`, `limit=1000`, and the
corresponding `KX<asset>` `series_ticker`.

Classify a returned ticker containing `-T` as a threshold contract for this bounded inventory. Separately classify
an exact one-hour contract only when parsed `close_time − open_time = 3,600` seconds. Retain the returned ticker,
open/close timestamps, floor/cap strikes, subtitle, and YES/NO quotes. No missing contract was reconstructed and no
series was inferred from another asset.

The ten responses contained 1,335 open market rows. Six series returned six open threshold contracts each, for 36
threshold rows total; twelve of those rows formed six exact one-hour two-contract groups. Five groups also carried
the structured floor/cap strike fields required by the approved H0 normalizer. DOGE's two exact-hour rules named
their relations and strikes in prose while both structured strike fields were null, so H1 must leave that group
unavailable rather than add an unapproved prose/ticker parser.

## Result

| Planned series | Open rows | Open threshold rows | Exact one-hour rows | H0 structured rows |
| --- | ---: | ---: | ---: | ---: |
| BTC | 318 | 6 | 2 | 2 |
| ETH | 390 | 6 | 2 | 2 |
| SOL | 0 | 0 | 0 | 0 |
| XRP | 165 | 6 | 2 | 2 |
| DOGE | 132 | 6 | 2 | 0 |
| HYPE | 165 | 6 | 2 | 2 |
| BNB | 165 | 6 | 2 | 2 |
| TON | 0 | 0 | 0 | 0 |
| NEAR | 0 | 0 | 0 | 0 |
| ZEC | 0 | 0 | 0 | 0 |

Every exact one-hour group described two distinct YES events in its rules: one “above” contract and one “below”
contract. They were not YES/NO sides of one contract and were not complements. Five groups also supplied the
structured floor/cap identity H1 requires. For example, the current BTC group was:
current BTC group was:

- `KXBTC-26AUG2612-T88799.99`, open `15:00Z`, close `16:00Z`, YES if `$88,800 or above`, YES ask 1¢; and
- `KXBTC-26AUG2612-T70200`, open `15:00Z`, close `16:00Z`, YES if `$70,199.99 or below`, YES ask 1¢.

The same `KXBTC` response also contained threshold pairs open for 25 hours and seven days. Selecting merely the
nearest future threshold close, or treating every `KXBTC` threshold ticker as a one-hour market, would therefore
mix different horizons. Exact `open_time`/`close_time` duration is load-bearing identity.

All twelve exact one-hour YES asks in this snapshot were 1¢, including the two DOGE rows H1 must leave unavailable
for missing structured strike identity. That is outside the proposed 10–75¢ paper-entry band;
it indicates that a read-only hourly surface may be useful while producing no eligible paper decision. It does not
authorize lowering a price, probability, quality, persistence, or edge gate to manufacture activity.

## Implementation consequence

The first implementation should be a read-only, stateless-safe market-data surface that:

1. represents above-strike YES and below-strike YES as independent candidates with exact tickers and strikes;
2. never derives one candidate's probability or quote as the complement of the other;
3. requires exact one-hour duration before assigning `crypto-1h` identity;
4. makes a missing, ambiguous, or structurally incomplete directional candidate explicitly unavailable;
5. displays unavailable planned assets rather than inventing or parsing a contract beyond the approved fields; and
6. leaves paper and live capability false until durable observation, outcome, policy, accounting, and isolation
   gates are separately implemented.

## Caveat and authority

This was one public API snapshot, not a listing-frequency distribution. Open listings can change by asset and time,
and zero open rows do not prove a series is permanently unsupported. The `-T` classifier and public summary fields
must be confirmed against exact contract rules during implementation. A longer prospective inventory is required
before claiming availability, candidate frequency, or paper-policy viability.

The result changes no production forecast, policy, route, allocation, capability, or runtime behavior. It supports
only the pre-code contract boundary in
[`docs/second-market-hourly-crypto-design.md`](../docs/second-market-hourly-crypto-design.md).
