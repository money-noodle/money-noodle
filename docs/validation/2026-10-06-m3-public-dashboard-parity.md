# Validation report: M3 public dashboard parity against the v1 baseline

> **Status:** Dated validation evidence, not policy or acceptance authority
> **Collected:** 2026-10-06T00:43:53Z to 2026-10-06T00:44:36Z
> **Source revision on `main` during collection:** `234aba14c12c2c176ac82c50ab9cf6af05dba49f`
> **Deployed revisions observed:** platform-api and web both `git-234aba14c12c2c176ac82c50ab9cf6af05dba49f`, deployed and health-verified by [run 37390554442](https://github.com/money-noodle/money-noodle/actions/runs/37390554442); the API reported `ready`
> **Result:** parity verified, **zero discrepancies**; two open observations
> **Owning ticket:** #213. Acceptance of M3 is #79's decision.

## How the measurements were collected

Read-only observation of two public sites, with `curl` and `jq`, by the supervisor from a host with outbound network access, inside the window in the header. Every request was stored to a file before anything was compared, and each comparison table below was produced by a script over those stored files, applying the classification this document's procedure defines. No credential was used, no `refresh` parameter was sent, and no failure was induced in either system. The raw captures, about 1.5 MB, are retained by the supervisor in the private operations workspace and are available to the maintainer on request.

An earlier attempt on 2026-10-06 at 00:01Z collected nothing: that session's egress proxy refused the `CONNECT` for both systems and for a control host, so it contributed the procedure below and no measurements.

## The procedure

This is the procedure the collection followed and the one a reviewer repeats; its results are under [Results](#results). Public URLs only, no credentials, no query parameters beyond those written here. Four rules it holds to:

1. **Be a polite client.** A handful of requests per endpoint, spaced by seconds, never in a loop. Both sides are small deployments and one of them is the production baseline.
2. **Never send v1's `refresh` parameter.** It forces up to twenty-three upstream provider calls per request on the baseline, and the new system has no equivalent, so a forced v1 refresh is both impolite and not a comparison.
3. **Capture market data on both sides inside the same few seconds**, and record both responses' own generation times. Market data moves; a comparison across a minute measures the market, not the two systems.
4. **Record raw responses to files first, compare afterwards.** Every table below is produced from a stored file, so a reviewer can re-derive it.

Set the three origins once. The baseline is `noodle.money`, which this repository already names. The two new origins are the interim `*.run.app` URLs of the `platform-api` and `web` Cloud Run services in `us-west1` — non-secret typed configuration under the accepted hosting decision, held in host configuration and by the maintainer, and withheld here as the M1 validation report withholds service hostnames. No credential is needed for any request below; both services are publicly invokable.

```bash
V1=https://noodle.money
API=<the platform-api service origin>
WEB=<the web service origin>
OUT="$(mktemp -d)"; echo "$OUT"
```

### P1. Identity and the collection window

```bash
date -u +%Y-%m-%dT%H:%M:%SZ | tee "$OUT/window-open.txt"
curl -sS --max-time 20 "$API/health/live"  | tee "$OUT/api-live.json"   | jq -S .
curl -sS --max-time 20 "$API/health/ready" | tee "$OUT/api-ready.json"  | jq -S .
curl -sS --max-time 20 "$WEB/health/live"  | tee "$OUT/web-live.json"   | jq -S .
curl -sS --max-time 20 "$API/v1/platform/status" | tee "$OUT/api-status.json" | jq -S .
```

Record both services' `version`. The parity claim is about *these* revisions; a later deploy makes the figures below historical.

### P2. Paper data — the frozen projection

The v1 writer is stopped, so the projection these three reads serve is frozen. That is what makes paper parity a stable, repeatable comparison rather than a race: the same stored rows answer both sides indefinitely, and the source times on both sides must be *identical*, not merely close. Begin by proving that, because every value comparison below depends on it.

```bash
for pair in "paper-budget:v1/paper/budget" \
            "paper-performance/summary:v1/paper/performance/summary" \
            "paper-performance:v1/paper/performance"; do
  v1_path="${pair%%:*}"; gcp_path="${pair##*:}"
  name="$(printf '%s' "$v1_path" | tr '/' '-')"
  curl -sS --max-time 30 "$V1/api/$v1_path"  -o "$OUT/v1-$name.json"
  sleep 2
  curl -sS --max-time 30 "$API/$gcp_path"    -o "$OUT/gcp-$name.json"
  sleep 2
done
```

**Source times must match exactly.** The new system publishes the source's own clock and never substitutes its own:

```bash
jq -r '[.sourceUpdatedAt, .generatedAt] | @tsv' "$OUT/gcp-paper-budget.json"
jq -r '[.sourceUpdatedAt, .generatedAt] | @tsv' "$OUT/gcp-paper-performance-summary.json"
jq -r '[.sourceUpdatedAt, .generatedAt] | @tsv' "$OUT/gcp-paper-performance.json"
```

Compare each against the v1 response's own timestamp fields. A legacy timestamp that is not ISO-8601 UTC is **identical after a documented transformation** — record the before and after, not just the verdict.

**Field inventory, both sides.** Produce the leaf paths of each response and diff them; every line of the diff is one row of the result table:

```bash
leaves() { jq -r '[paths(scalars) | join(".")] | unique[]' "$1"; }
diff <(leaves "$OUT/v1-paper-budget.json") <(leaves "$OUT/gcp-paper-budget.json")
```

Classify every path into exactly one of:

- **identical** — same path, same value.
- **identical after a documented transformation** — name the transformation (ISO normalization of a legacy timestamp; a `bigint` serialized as a string on one side and a JSON number on the other; a renamed path carrying the same value).
- **present only on one side** — expected on the new side for additive disclosure (`sourceUpdatedAt`, `executionKey`, the `schemaVersion`/`requestId` envelope) and on the v1 side for the forecast, signal, fill-estimate and policy members that M3 deliberately does not carry (see *Intentional non-parity*).
- **discrepancy** — anything else. File it.

**Money and counts are compared with exact equality**, never a tolerance. The new system republishes the stored figures in the source's own units (US cents, whole counts) and performs no rounding:

```bash
jq -S '{startingCents, availableCents, equityCents, reservedCents,
        proposedStakeCents, realizedPnlCents, openOrders, settledOrders,
        bankrollResets, executions: (.recentExecutions | length)}' \
  "$OUT/gcp-paper-budget.json"
```

Read the matching v1 members from `$OUT/v1-paper-budget.json` and assert equality field by field. Do the same for the summary's counters and the full record's `paperRecord`, `paperProviderRecords`, `paperEpochs` and forecast history lengths.

Two figures are expected to disagree with each other **within** the new system, and the contract says so: the budget record's `realizedPnlCents` is whole-cent and scoped to the current funding, while the full record's is exact and lifetime. Compare each against its own v1 counterpart, never against the other.

The reconciliation residual the web shows is computed by the client from three published figures — `equityCents - (startingCents + realizedPnlCents)` — and is not an API field. Recompute it on both sides from their own figures.

### P3. Market data — live feeds, captured together

```bash
date -u +%Y-%m-%dT%H:%M:%S.%3NZ > "$OUT/market-window.txt"
curl -sS --max-time 30 "$API/v1/market/overview" -o "$OUT/gcp-overview.json"
curl -sS --max-time 30 "$V1/api/dashboard"       -o "$OUT/v1-dashboard.json"
date -u +%Y-%m-%dT%H:%M:%S.%3NZ >> "$OUT/market-window.txt"
jq -r '.generatedAt' "$OUT/gcp-overview.json"
```

Record the skew: the elapsed seconds between the two captures, and each response's own generation time.

**Per asset, compare:**

```bash
jq -r '.assets[] | [.symbol, (.spot.price//"-"), (.spot.change24hPercent//"-"),
                    (.polymarket.probabilityUp//"-"), (.kalshi.probabilityUp//"-"),
                    (.polymarket.closesAt//"-"), (.kalshi.closesAt//"-"),
                    (.venueProbabilityUp//"-"), (.basis.referencePrice//"-"),
                    (.basis.currentPrice//"-"), (.basis.volatilityPerSecond//"-"),
                    (.basis.volatilitySamples//"-")] | @tsv' "$OUT/gcp-overview.json"
```

- **Spot price.** Expect a difference; both sides read the same provider at different instants. The test is whether the difference is explained by the skew. The new response publishes `basis.volatilityPerSecond`, the standard deviation of log return per root second, so the expected move over a skew of `Δt` seconds is `price × volatilityPerSecond × sqrt(Δt)`. A difference inside four of those is skew; beyond that, record it as a discrepancy with both figures and the skew. Where the two sides read *different* sources for a price, say which and stop comparing them numerically.
- **Venue quotes and alignment.** The new system publishes a second venue's quote only when its settlement is within five seconds of the first venue's and is still ahead. Compare `closesAt` on both sides and the set of venues present per asset. An asset carrying one venue on the new side and two on v1 is explained by that rule, not a gap — check the two `closesAt` values before calling it either.
- **Basis inputs.** `referencePrice`, `referenceSource`, `currentPrice`, `secondsRemaining`, `volatilityPerSecond`, `volatilitySamples`, `standardDeviationPercent`, `zScore`, `probabilityUp`. The same arithmetic on both sides, so differences must follow from the price and volatility inputs; verify that by recomputing `zScore = ln(currentPrice / referencePrice) / (volatilityPerSecond × sqrt(max(2, secondsRemaining − 30)))` from the published inputs on each side.
- **Headlines.** Compare as **sets**, by title, and report the overlap; both sides read one publisher's feed at different instants, so the newest item may differ. Zero overlap is a discrepancy; a one- or two-item difference at the head of the list is not.
- **Assets present on one side only.** The new overview covers the assets both fifteen-minute venues list. v1's list is driven by what its own spot feed returned. Name the asset and which rule explains it.

**Freshness.** The new response states a state, an age and a reason per feed:

```bash
jq -S '.feeds' "$OUT/gcp-overview.json"
```

v1 publishes no such states. That is deliberately new behaviour, not a parity gap — see the table below. Record what the states actually said at collection time, because a `stale` or `unavailable` feed changes how its figures should be read.

### P4. Hourly thresholds

```bash
curl -sS --max-time 30 "$API/v1/market/hourly-thresholds" -o "$OUT/gcp-hourly.json"
sleep 2
curl -sS --max-time 30 "$V1/api/markets/hourly"           -o "$OUT/v1-hourly.json"

jq -r '.markets[] | [.symbol, .marketDataAvailable, (.openAt//"-"), (.closesAt//"-"),
                     (.currentPrice//"-"), (.volatilityPerSecond//"-"),
                     (.volatilitySamples//"-"), (.unavailableReasons|join(","))] | @tsv' \
  "$OUT/gcp-hourly.json"
jq -r '.markets[] | .symbol as $s | .candidates[] |
       [$s, .direction, .ticker, .strike, (.askYes//"-"), (.modelProbabilityYes//"-"),
        (.modelMinusAsk//"-")] | @tsv' "$OUT/gcp-hourly.json"
```

- **Listing and candidate sets should be identical.** Both sides read the same venue listing for the same hour, so per asset the `(openAt, closesAt)` group and the set of `(direction, ticker, strike)` candidates must match. A difference here is a real discrepancy, not skew.
- **Current price and volatility are expected to differ.** The new system uses finished one-minute candles only; v1 uses the candle still forming. Quantify it and show the difference is consistent with that one rule:
  - the new `currentPrice` must equal the close of the **last completed** minute of the exchange's public one-minute series, which a reviewer can fetch directly from the venue and check;
  - the difference from v1's price should sit inside roughly one minute of movement, `price × volatilityPerSecond × sqrt(60)`;
  - the new `volatilitySamples` counts returns between completed minutes, so a sample taken over the same window would be expected one lower than v1's. The 2026-10-06 collection did **not** observe that — both sides reported 120 — which is recorded under [Open observations](#open-observations).
- **Model probabilities.** The same zero-drift log-normal formula on both sides, unclamped. Recompute from each side's own published price, volatility and time remaining; a difference that the recomputation reproduces is an input difference (above), not a formula difference.

### P5. The web views

For each page, confirm which operation feeds it and that the rendered figures are the API's own. Sample three fields per page, read from the HTML, against the operation captured in P3/P4 within the same minute.

```bash
for path in "" "market/hourly" "paper/budget" "paper/performance"; do
  curl -sS --max-time 30 -o "$OUT/web-${path//\//-}.html" \
       -w '%{http_code} %{time_total}s /'"$path"$'\n' "$WEB/$path"
  sleep 2
done
```

| Page | Operations behind it | Sample three |
| --- | --- | --- |
| `/` | `getPlatformStatus`, `getMarketOverview`, `getPaperBudget`, `getPaperPerformanceSummary` | an asset's spot price, its basis reference source, the bankroll equity |
| `/market/hourly` | `getHourlyThresholdMarkets` | a candidate's strike, its model probability, the available/total count |
| `/paper/budget` | `getPaperBudget` | equity, available, the newest execution's stake |
| `/paper/performance` | `getPaperPerformanceSummary`, `getPaperPerformance` | accuracy, settled count, lifetime realized profit and loss |

Also confirm, per page: the source time is present and is the API's own value; the market and hourly pages carry their feed states; the hourly page carries the completed-minutes note; every page carries the research-only notice. Figures are formatted for display — cents rendered as dollars, ratios as percentages, contract prices as cents — so compare the underlying value, not the string.

## Results

One collection, in the window in the header. Each subsection below mirrors the procedure step that produced it. Figures are reproduced as the collection recorded them.

### R1. Identity and the collection window

Both services reported `git-234aba14c12c2c176ac82c50ab9cf6af05dba49f` — the #233 merge — and the API's `/health/ready` answered `ready`, so the projection it reads was reachable throughout. Market captures and their generation times:

| Capture | Wall clock | Response `generatedAt` |
| --- | --- | --- |
| New overview | 2026-10-06T00:44:18.987873572Z | 2026-10-06T00:44:20.195Z |
| v1 dashboard | 2026-10-06T00:44:21.353125025Z | 2026-10-06T00:44:21.158Z |
| New hourly | — | 2026-10-06T00:44:23.706Z |
| v1 hourly | — | 2026-10-06T00:44:25.935Z |

Generation skew between the two overviews: 1.0 s. Wall-clock window across the pair: 2.4 s.

### R2. Paper data — exact parity, zero discrepancies

The frozen projection held: the source and generation times are identical on both sides, so the two systems answered from the same stored rows.

| Read | Identical leaves | Identical after transformation | Only on v1 | Only on the new system | Discrepancies |
| --- | --- | --- | --- | --- | --- |
| Budget | 376 | 0 | 0 | 33 | **0** |
| Performance summary | 60 | 0 | 0 | 3 | **0** |
| Full performance | 8484 | 7 | 0 | 3 | **0** |

Times, compared directly:

| Record | v1 | New system |
| --- | --- | --- |
| Budget `sourceUpdatedAt` | not published | `2026-09-03T15:03:13.716Z` |
| Summary `generatedAt` | `2026-09-03T15:03:14.615Z` | `2026-09-03T15:03:14.615Z` |
| Summary `sourceUpdatedAt` | not published | `2026-09-03T15:03:14.615Z` |
| Full record `generatedAt` | `2026-09-03T14:54:30.421Z` | `2026-09-03T14:54:30.421Z` |
| Full record `sourceUpdatedAt` | not published | `2026-09-03T15:03:14.615Z` |

Every member present only on the new system is one the procedure predicted as additive disclosure, and nothing else:

| Read | Only on the new system |
| --- | --- |
| Budget | `recentExecutions[N].executionKey` × 30, `requestId`, `schemaVersion`, `sourceUpdatedAt` |
| Performance summary | `requestId`, `schemaVersion`, `sourceUpdatedAt` |
| Full performance | `requestId`, `schemaVersion`, `sourceUpdatedAt` |

The seven "identical after transformation" leaves are all the same transformation — a second-precision timestamp republished with milliseconds:

| Path | Transformation | v1 | New system |
| --- | --- | --- | --- |
| `cyclePaths.latestByAsset[0].closesAt` | timestamp format | `2026-09-03T15:00:00Z` | `2026-09-03T15:00:00.000Z` |
| `cyclePaths.latestByAsset[1].closesAt` | timestamp format | `2026-09-03T15:00:00Z` | `2026-09-03T15:00:00.000Z` |
| `cyclePaths.latestByAsset[2].closesAt` | timestamp format | `2026-09-03T15:00:00Z` | `2026-09-03T15:00:00.000Z` |
| `cyclePaths.latestByAsset[3].closesAt` | timestamp format | `2026-09-03T15:00:00Z` | `2026-09-03T15:00:00.000Z` |
| `cyclePaths.latestByAsset[4].closesAt` | timestamp format | `2026-09-03T15:00:00Z` | `2026-09-03T15:00:00.000Z` |
| `cyclePaths.latestByAsset[5].closesAt` | timestamp format | `2026-09-03T15:00:00Z` | `2026-09-03T15:00:00.000Z` |
| `cyclePaths.latestByAsset[6].closesAt` | timestamp format | `2026-09-03T15:00:00Z` | `2026-09-03T15:00:00.000Z` |

Collection lengths on the full record are equal: `forecasts` 500 and 500, `paperEpochs` 1 and 1, `paperProviderRecords` 1 and 1.

The reconciliation residual, recomputed on each side from its own three published figures, is `0` cents on both.

Money and counts were compared with exact equality throughout, as the procedure requires; the zero in the discrepancy column is that comparison passing, not a tolerance absorbing a difference.

### R3. Market data — identical figures, one input difference

Every feed on the new system was `fresh` at capture: `spot`, `referencePrices`, `polymarketQuotes`, `kalshiQuotes`, `longHistory`, `news`.

Asset sets are identical: both sides published `BNB`, `BTC`, `DOGE`, `ETH`, `HYPE`, `SOL`, `XRP`; neither side carried an asset the other did not.

| Asset | v1 price | New price | Diff | 4σ skew band | Within | Polymarket `pUp` v1 / new | Kalshi `pUp` v1 / new | Combined v1 / new | Reference v1 / new |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BNB | 786.5 | 786.5 | 0 | ±0.1021 | yes | 0.88 / 0.88 | 0.35 / 0.35 | 0.7475 / 0.7475 | 786.4 / 786.4 |
| BTC | 8.578e+04 | 8.578e+04 | 0 | ±13.05 | yes | 0.125 / 0.125 | 0.245 / 0.245 | 0.155 / 0.155 | 8.582e+04 / 8.582e+04 |
| DOGE | 0.09522 | 0.09522 | 0 | ±1.95e-05 | yes | 0.205 / 0.205 | 0.0455 / 0.0455 | 0.1651 / 0.1651 | 0.09527 / 0.09527 |
| ETH | 2713 | 2713 | 0 | ±0.3665 | yes | 0.235 / 0.235 | 0.435 / 0.435 | 0.285 / 0.285 | 2713 / 2713 |
| HYPE | 94.58 | 94.58 | 0 | ±0.02986 | yes | 0.9 / 0.9 | 0.9995 / 0.9995 | 0.9249 / 0.9249 | 94.46 / 94.46 |
| SOL | 120.9 | 120.9 | 0 | ±0.028 | yes | 0.345 / 0.345 | 0.28 / 0.28 | 0.3287 / 0.3287 | 120.8 / 120.8 |
| XRP | 1.51 | 1.51 | 0 | ±0.000318 | yes | 0.08 / 0.08 | 0.003 / 0.003 | 0.06075 / 0.06075 | 1.508 / 1.508 |

Spot prices are identical on all seven assets — the same provider read a second apart — so the skew band was never approached. Both venue probabilities, the combined venue probability and the settlement reference are identical on every asset.

Venue alignment matched on every asset: both sides published the same Polymarket and Kalshi settlement times, `2026-10-06T00:45:00Z` on v1 and `2026-10-06T00:45:00.000Z` on the new system — the same instant in the two systems' timestamp formats, which is the millisecond transformation of R2 again.

The one figure that differs is the realized volatility, in its fourth significant figure, on every asset:

| Asset | Volatility per root second, v1 / new | Samples v1 / new | `zScore` v1 / new |
| --- | --- | --- | --- |
| BNB | 3.249e-05 / 3.245e-05 | 120 / 120 | 0.1317 / 0.1251 |
| BTC | 3.802e-05 / 3.803e-05 | 120 / 120 | -2.4333 / -2.3096 |
| DOGE | 5.124e-05 / 5.119e-05 | 120 / 120 | -5.8002 / -5.5093 |
| ETH | 3.381e-05 / 3.378e-05 | 120 / 120 | -3.1542 / -2.9970 |
| HYPE | 7.795e-05 / 7.893e-05 | 120 / 120 | 7.7628 / 7.2748 |
| SOL | 5.79e-05 / 5.792e-05 | 120 / 120 | 0.9617 / 0.9125 |
| XRP | 5.271e-05 / 5.265e-05 | 120 / 120 | -6.2676 / -5.9558 |

`zScore` therefore differs too, and the recomputation localises why. Taking each side's own published inputs and applying `ln(current / reference) / (volatility × sqrt(max(2, secondsRemaining − 30)))`:

| Asset | Side | Published `zScore` | Recomputed | Match |
| --- | --- | --- | --- | --- |
| BNB | v1 | 0.1317 | 0.1317 | yes |
| BNB | new | 0.1251 | 0.1251 | yes |
| BTC | v1 | -2.4333 | -2.4333 | yes |
| BTC | new | -2.3096 | -2.3096 | yes |
| DOGE | v1 | -5.8002 | -5.8002 | yes |
| DOGE | new | -5.5093 | -5.5093 | yes |
| ETH | v1 | -3.1542 | -3.1542 | yes |
| ETH | new | -2.9970 | -2.9970 | yes |
| HYPE | v1 | 7.7628 | 7.7628 | yes |
| HYPE | new | 7.2748 | 7.2748 | yes |
| SOL | v1 | 0.9617 | 0.9617 | yes |
| SOL | new | 0.9125 | 0.9125 | yes |
| XRP | v1 | -6.2676 | -6.2676 | yes |
| XRP | new | -5.9558 | -5.9558 | yes |

Both sides' published `zScore` reproduce exactly from their own inputs, on all seven assets. So this is an **input** difference and not a formula difference: the same arithmetic over a slightly different volatility estimate. The expected cause is the completed-minutes rule applied to the one-minute series the basis estimate reads — the new system drops the forming candle, v1 includes it — which is intentional non-parity. One part of that expectation did not hold and is recorded as an open observation below: both sides report `volatilitySamples` 120, so the one-lower sample count this document predicted as the rule's signature was not observed.

Headlines: 12 on each side, overlap 12, nothing on one side only.

Per-asset member inventory, taking BTC as the representative asset. Present only on v1, grouped by family, every member named as the capture recorded it:

- Forecast and model: `modelProbabilityUp`, `blendedProbabilityUp`, `edge`, `confidence`, `confidenceBreakdown.base`, `confidenceBreakdown.dataQuality`, `confidenceBreakdown.sampleQuality`, `confidenceBreakdown.uncertaintyPenalty`.
- Entry policy: `signal`, `enabledTradingVenues[N]`.
- Explanatory factors: `factors[N].id`, `.label`, `.eyebrow`, `.direction`, `.score`, `.weight`, `.confidence`, `.contribution`, `.summary`, `.detail`, `.source`, `.available`.
- Calibration replay: `calibrationReplay.version`, `.source`, `.productionProbabilityUp`, `.productionConfidence`, `.probabilityFloor`, `.probabilityCeiling`, `.baselineBasisProbability`, `.baselineReplayError`, `.basisLogOddsWeight`, `.confidenceReplayError`, `.confidenceSource`, `.slowTiltLogOdds`, `.slowTerms[N].id`, `.slowTerms[N].logOdds`, `.basisInput.currentPrice`, `.basisInput.referencePrice`, `.basisInput.secondsRemaining`, `.basisInput.volatilityPerSecond`, `.basisInput.volatilitySamples`, `.confidenceInput.basisPresent`, `.confidenceInput.rangePercent`, `.confidenceInput.secondsRemaining`, `.confidenceInput.venueProbabilityCount`, `.confidenceInput.volatilitySamples`.
- Settlement-average estimate: `settlementAverageEstimate.method`, `.windowSeconds`, `.observedSettlementSeconds`, `.effectiveVarianceSeconds`, `.expectedAveragePrice`, `.standardDeviationPercent`, `.probabilityUp`.
- Per-contract provenance, on both venues: `market.contract.*` and `kalshi.contract.*` — `version`, `registryId`, `venue`, `contractId`, `marketUrl`, `closesAt`, `capturedAt`, `rulesSource`, `rulesFingerprint`, `rulesText`, `referenceSource`, `settlementPriceMethod`, `settlementWindowSeconds`, `referenceWindowSeconds`, `comparability`, plus `kalshi.contract.referenceValue` and `kalshi.contract.roundingDecimals`.
- Cross-venue rule comparison: `targetComparison.comparability`, `.reason`, `.closeAligned`, `.settlementWindowAligned`, `.referenceWindowAligned`, `.oracleAligned`, `.methodAligned`; and `kalshi.comparability`.
- Venue quote members under v1's own names: `market.liquidity`, `market.volume`, `kalshi.liquidity`.

Present only on the new system: `polymarket.venue`, `polymarket.contractId`, `polymarket.liquidityUsd`, `polymarket.volumeUsd`, `kalshi.contractId`, `kalshi.probabilityDown`, `spot.change1hPercent`, `spot.change7dPercent`, `spot.change30dPercent`, `spot.change1yPercent`, `spot.high24h`, `spot.low24h`, `spot.volume24h`.

Every family in the v1-only list except the last is on the intentional non-parity list below. The last family and the first five entries of the new-system list are the same data under each system's own naming: v1 carries the Polymarket quote as `market.*` with `liquidity` and `volume`, and the new system carries it as `polymarket.*` with `liquidityUsd` and `volumeUsd`. `kalshi.liquidity` has no counterpart in this capture because the contract omits a member the venue did not report, rather than publishing a zero for it. The remaining new-system members are additive spot disclosure.

### R4. Hourly thresholds — identical listings, prices consistent with the completed-minutes rule

Version labels are identical on both sides: `modelVersion` `strike-threshold-zero-drift-v1`, `marketDataVersion` `kalshi-hourly-threshold-read-v1`.

Asset sets are identical and in the same order: `BTC`, `ETH`, `SOL`, `XRP`, `DOGE`, `BNB`, `HYPE`, `TON`, `NEAR`, `ZEC`; neither side carried an asset the other did not.

For all ten assets the `(openAt, closesAt)` group and the set of `(direction, ticker, strike)` candidates are **identical**. This is the comparison the procedure calls a real discrepancy if it fails, and it passed on every asset.

| Asset | Group same | Candidate set same | v1 price | New price | Diff | One-minute band | Within | Volatility v1 / new | Samples v1 / new | Reasons on the new side |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BNB | same | same | 786.38 | 786.51 | 0.13 | ±0.1977 | yes | 3.24924e-05 / 3.24519e-05 | 120 / 120 | — |
| BTC | same | same | 85796.7 | 85805.5 | 8.8 | ±25.28 | yes | 3.80168e-05 / 3.80299e-05 | 120 / 120 | — |
| DOGE | same | same | — | — | — | ±0 | n/a | — / — | — / — | `above-missing`, `below-missing` |
| ETH | same | same | 2712.63 | 2713.13 | 0.5 | ±0.7099 | yes | 3.3768e-05 / 3.37791e-05 | 120 / 120 | — |
| HYPE | same | same | 94.63 | 94.65 | 0.02 | ±0.05787 | yes | 7.79493e-05 / 7.89346e-05 | 120 / 120 | — |
| NEAR | same | same | — | — | — | ±0 | n/a | — / — | — / — | `no-active-hour-group` |
| SOL | same | same | — | — | — | ±0 | n/a | — / — | — / — | `no-active-hour-group` |
| TON | same | same | — | — | — | ±0 | n/a | — / — | — / — | `no-active-hour-group` |
| XRP | same | same | 1.50642 | 1.50677 | 0.00035 | ±0.0006145 | yes | 5.27082e-05 / 5.26531e-05 | 120 / 120 | — |
| ZEC | same | same | — | — | — | ±0 | n/a | — / — | — / — | `no-active-hour-group` |

The current price differs on each of the five assets with an active group, and in every case the difference is inside the one-minute movement band — consistent with the completed-minutes rule, which is what the procedure asks this comparison to establish. The volatility estimate again differs in the fourth significant figure with `volatilitySamples` 120 on both sides.

The two degraded states agreed on both sides. DOGE: both sides listed the hour group with no usable candidates, the new system naming `above-missing` and `below-missing` and v1 reporting `marketDataAvailable` false. NEAR, SOL, TON and ZEC: `no-active-hour-group` on the new side and no group on v1.

Model probability recomputation, from each side's own price, volatility and time remaining:

| Asset | Ticker | Side | Published `pYes` | Recomputed | Match | `askYes` v1 / new |
| --- | --- | --- | --- | --- | --- | --- |
| BNB | `KXBNB-26OCT0521-T974.99` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| BNB | `KXBNB-26OCT0521-T610` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| BNB | `KXBNB-26OCT0521-T974.99` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| BNB | `KXBNB-26OCT0521-T610` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| BTC | `KXBTC-26OCT0521-T94299.99` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| BTC | `KXBTC-26OCT0521-T75700` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| BTC | `KXBTC-26OCT0521-T94299.99` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| BTC | `KXBTC-26OCT0521-T75700` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| ETH | `KXETH-26OCT0521-T3394.99` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| ETH | `KXETH-26OCT0521-T1905` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| ETH | `KXETH-26OCT0521-T3394.99` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| ETH | `KXETH-26OCT0521-T1905` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| HYPE | `KXHYPE-26OCT0521-T127.2499` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| HYPE | `KXHYPE-26OCT0521-T52.75` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| HYPE | `KXHYPE-26OCT0521-T127.2499` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| HYPE | `KXHYPE-26OCT0521-T52.75` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| XRP | `KXXRP-26OCT0521-T2.1399` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| XRP | `KXXRP-26OCT0521-T0.68000` | v1 | 0.0000 | 0.0000 | yes | 0.01 / — |
| XRP | `KXXRP-26OCT0521-T2.1399` | new | 0.0000 | 0.0000 | yes | — / 0.01 |
| XRP | `KXXRP-26OCT0521-T0.68000` | new | 0.0000 | 0.0000 | yes | — / 0.01 |

Every listed candidate was deep out of the money at capture, so both sides publish `0.0000` and the recomputation matches trivially. Stated plainly: **this capture does not exercise the probability formula at an informative strike.** It establishes that both sides agree and that each reproduces its own published figure, and nothing about the formula's behaviour in the middle of its range. A reviewer repeating P4 when a near-the-money candidate is listed would test that; it is recorded as an open observation below.

### R5. Web views — the rendered figures are the API's

Each page was read from the web service inside the same window and the sampled fields checked against the operation behind it.

| Page | Sampled | Present |
| --- | --- | --- |
| `/` | bankroll equity `$66.33`; BTC spot price; basis reference source; paper source time; a feed state word; the research notice | all present |
| `/market/hourly` | a BTC candidate strike; the completed-minutes note; the research notice | all present |
| `/paper/budget` | equity; available; the source time; the research notice | all present |
| `/paper/performance` | settled positions, rendered `1,618`; accuracy as a percentage; the source time; the research notice | all present |

The settled count renders as `1,618` — the API's integer with the display grouping the web applies — and the equity renders as `$66.33` from the API's cents, which is the display conversion this repository documents rather than a figure the web computes. Source times are present on both paper views and on the home page, feed states are shown on the home page, the completed-minutes note is on the hourly view, and the research-only notice is on all four pages.

### Discrepancies

**None.**

## Context for the collection

### A. Delivery chain to the revisions observed

From GitHub Actions metadata. Every run below is a merge-to-`main` `push` delivery whose `deploy release vector` job ran `Resolve and verify the artifacts this commit published` before deploying:

| UTC | Head | Run | Deployed and verified |
| --- | --- | --- | --- |
| 2026-10-05 16:44 | `746d9f6` | [37343129955](https://github.com/money-noodle/money-noodle/actions/runs/37343129955) | api, web |
| 2026-10-05 19:13 | `b1b7a36` | [37361837276](https://github.com/money-noodle/money-noodle/actions/runs/37361837276) | api, web |
| 2026-10-05 23:03 | `9331244` | [37386233353](https://github.com/money-noodle/money-noodle/actions/runs/37386233353) | api, web |
| 2026-10-05 23:48 | `234aba1` | [37390554442](https://github.com/money-noodle/money-noodle/actions/runs/37390554442) | api, web — `Deploy api`, `Verify api health and the published contract`, `Deploy web`, `Verify web health` all success; both rollback steps skipped |

So the live pair is `234aba1` on both services, and the three M3 implementation merges (#210 at `746d9f6`, #211 at `b1b7a36`, #212 at `234aba1`) all reached it.

### B. Read-only probes recorded by the supervisor

Not part of this collection. These are the supervisor's earlier dated observations on the implementation tickets, kept because they place this collection in a sequence. Each is a single-sided observation of the new system — shapes and states, deliberately no figures — and **none of them is a comparison against the baseline**:

| Recorded | Ticket | Observation |
| --- | --- | --- |
| 2026-10-05 ~16:55Z | #210 | `/health/live` and `/health/ready` 200 at `git-746d9f6…`; the three paper reads 200, the full record about 298 kB with 500 forecasts; source times disclosed and old, early September 2026, as the frozen projection implies |
| 2026-10-05 ~19:26Z | #211 | `/v1/market/overview` 200 with 7 assets, five feeds `fresh` with fetch times and `news` `unavailable` (`upstream-unavailable`); `/v1/market/hourly-thresholds` 200 with 10 markets, listings fresh, assets without an active hour group reporting `no-active-hour-group` |
| 2026-10-05 23:12Z | #231 | after the news address fix, `/v1/market/overview` reports `feeds.news` `fresh` with 12 headlines; all other feeds fresh |
| 2026-10-05 23:58Z | #212 | all four web pages render 200 against the live API; every home-page feed shows `fresh` with its obtained time; the hourly view carries the completed-minutes note; the paper views show their early-September source times; the research notice is on every view |

The #211 and #231 pair is worth keeping: the explicit freshness state made a real misconfiguration visible on first contact, and the same probe after the fix showed the feed fresh. That is the new behaviour working, and it is why the procedure records the feed states at collection time rather than assuming them — which R3 then did, finding all six `fresh`.

## Intentional non-parity

Sourced from the repository's own contract and from the maintainer's decisions recorded on #211. These are differences by decision; a collection run must not file any of them as a discrepancy.

| Difference | Direction | Authority |
| --- | --- | --- |
| Forecast probability, blended figure, edge, confidence and its breakdown, explanatory factors, the entry-policy `signal`, enabled venues, settlement-average and maker-fill estimates, calibration replay, cycle regime, and the policy manifest | present on v1, absent on the new system | #211 decision 1: model output and entry policy move with the engine in M4 (#80) |
| Asset ordering | v1 sorts by a policy-derived strength score; the new system publishes registry order | #211 decision 1 — the score is model output; `getMarketOverview` states the order carries no ranking |
| News sentiment label and score | present on v1, absent | #211 decision 1 — a lexical score presented beside market data is model output |
| Per-contract provenance on the overview (`market.contract.*`, `kalshi.contract.*`) and the cross-venue rule comparison (`targetComparison`, `kalshi.comparability`) | present on v1, absent on the new system's overview | #211 decision 1 and the contract: `MarketAssetOverview` declares no provenance or comparison member, and the settlement-terms part that needs no model output is published by the hourly view as `rulesFingerprint` and `settlementPriceMethod` |
| Venue quote member naming | v1 carries the Polymarket quote as `market.*` with `liquidity` and `volume`; the new system carries it as `polymarket.*` with `liquidityUsd` and `volumeUsd` | `MarketVenueQuote` in the contract: each quote names its own venue and states its units |
| Per-feed `state`, `ageSeconds`, `fetchedAt` and `reason` | absent on v1, added | #211 decision 2 — `getMarketOverview`: a feed past its five-minute limit is `unavailable` and its members are absent, "never zero, and never inferred" |
| Completed one-minute candles only, for the hourly current price and both volatility estimates | v1 uses the forming candle | #211 decision 3 — stated in both market operation descriptions |
| `refresh` / `refresh=live` cache bypass | present on v1, removed | #211 decision 4 — `getMarketOverview`: "No caller-facing refresh control exists" |
| Last-good value on upstream failure, marked stale with its age, then `unavailable` after five minutes | v1 served last-good values silently and indefinitely | #211 decision 5 |
| Upstream failure detail in a public response | v1 passed the raw thrown message through, including status and host; the new system publishes one of four fixed reason codes | #211 decision 5; `MarketFeedReason` in the contract |
| Placeholder quotes and zero-for-absent | v1 published a fabricated fifty-fifty market with zero liquidity for an unlisted asset and defaulted missing provider numbers to zero; the new system omits the member | `MarketVenueQuote` and `MarketSpot` descriptions |
| Unavailability shape | v1 answers 503 with a bare `{ "error": string }` carrying the raw message; the new system answers RFC 9457 `application/problem+json` with `MN-READ-MODEL-UNREACHABLE`, `MN-READ-MODEL-NOT-PUBLISHED` or `MN-READ-MODEL-INVALID` | `ReadModelProblem` in the contract |
| Response cache and cache headers | v1 caches the whole hourly response for 60 s in process and sends `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300`; the new reads have neither | #210 scope note and #211 decision 4 |
| `schemaVersion` and `requestId` on every response, `sourceUpdatedAt` and `executionKey` on the paper records | absent on v1, added | #210 parity rule: source times are disclosed and no staleness threshold is invented |

## Open observations

Neither is a discrepancy and neither is filed. Both are things this collection could not settle, recorded for the maintainer rather than resolved here.

1. **The completed-minutes sample-count signature was not observed.** This document predicted that the rule would show up as `volatilitySamples` one lower on the new system, because a dropped forming candle is one fewer return. Both sides reported 120 on every asset, on the overview and on the hourly view, while the volatility estimate itself differed in its fourth significant figure throughout. The difference is real and localised — each side's `zScore` and model probability reproduce exactly from its own published inputs, so the two systems run the same arithmetic over slightly different volatility inputs — and the completed-minutes rule is the expected cause, but the sample count does not corroborate it. Nothing further is inferred here. A reviewer who wants it settled can compare each side's `currentPrice` and sample window against the exchange's own public one-minute series at capture time, which is what P4 describes.
2. **The probability formula was not exercised at an informative strike.** Every candidate listed at capture was deep out of the money, so both sides published `0.0000` and the recomputation matched trivially. The comparison establishes agreement and self-consistency, not the formula's behaviour across its range. Repeating P4 when a near-the-money candidate is listed would test that.

## Limitations

1. **One collection, one window.** Forty-three seconds on 2026-10-06 against one revision pair. Paper parity is stable by construction while the baseline's writer stays stopped; the market comparison is a snapshot of two live feeds and says nothing about either side's behaviour an hour later.
2. **Degraded behaviour was observed, not induced.** No failure was forced in either system, so what R3 and R4 show is the states the two systems happened to be in: every feed `fresh`, and five assets with no active hour group. The `stale`, `unavailable` and three read-model refusal paths are specified in the contract and tested in the repository, but they are not exercised here.
3. **The two open observations above** bound what the market comparison establishes: the volatility input difference is explained but not corroborated by the sample count, and the probability formula was only exercised at the extreme of its range.
4. **The frozen projection is a condition, not a property.** It holds while the baseline's writer stays stopped. R2's identical source times are the check; if they ever differ, the paper comparison becomes a race and has to be re-established before its figures mean anything.
5. **Raw captures are not in this repository.** The tables were produced by a script over stored responses held in the supervisor's private operations workspace, about 1.5 MB, available to the maintainer on request. A reviewer re-running the procedure produces their own.
6. **One asset's member inventory stands for seven.** R3 lists BTC's members in full; the other six assets were compared by the same leaf-path inventory, and the per-asset figure tables cover all seven.

## Conclusion

The M3 acceptance criterion on #79 — "agreed public dashboard behaviour and paper results independently verified against the accepted baseline through the new boundaries" — is **met for this collection, with zero discrepancies.**

What that rests on. Paper data is exact: 376, 60 and 8,484 identical leaves across the three reads, the same source and generation times on both sides, every money and count figure equal under exact comparison, the reconciliation residual `0` cents on both, and the only members present on one side alone are the additive ones — `sourceUpdatedAt`, `executionKey` per execution, `schemaVersion` and `requestId` — plus seven timestamps republished with milliseconds. Market data agrees on everything both systems read from the same place: identical spot prices on all seven assets, identical venue probabilities, combined probability and settlement references, identical settlement times, identical asset sets, and twelve of twelve headlines in common. The hourly listing agrees exactly where agreement is required — the same hour group and the same `(direction, ticker, strike)` set on all ten assets, the same version labels, and the same degraded states on the five assets without a usable pair. Both systems' derived figures reproduce from their own published inputs on every asset, so where they differ, the difference is an input, not a formula: the realized volatility estimate in its fourth significant figure, and the hourly current price inside one minute of movement, both consistent with the completed-minutes rule that M3 adopted deliberately. The web views render the API's own figures, with source times, feed states, the completed-minutes note and the research notice present on every page.

The differences that remain are the ones this document listed in advance as intentional, and the collection found no others: no forecast, signal, policy or provenance member on the new side, registry order instead of a policy score, explicit per-feed freshness, no refresh bypass, no response cache, and RFC 9457 problem documents in place of a bare error string.

Two things this collection does not establish, recorded above as open observations: the sample-count signature expected from the completed-minutes rule was not observed, and no candidate was near the money, so the probability formula was only exercised at the extreme of its range.

**Discrepancies:** none. None filed.
