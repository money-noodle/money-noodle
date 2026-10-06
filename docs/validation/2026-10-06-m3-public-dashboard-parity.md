# Validation procedure: M3 public dashboard parity against the v1 baseline

> **Status:** Reproducible procedure and a record of blocked collection. **This document carries no parity measurements**: the comparison was not performed. It is not acceptance evidence.
> **Attempted:** 2026-10-06T00:01Z to 2026-10-06T00:05Z
> **Source revision on `main` during the attempt:** `234aba14c12c2c176ac82c50ab9cf6af05dba49f`
> **Live revisions, from delivery evidence rather than from a probe:** platform-api and web both at `234aba1`, deployed and health-verified by [run 37390554442](https://github.com/money-noodle/money-noodle/actions/runs/37390554442)
> **Owning ticket:** #213. Acceptance of M3 is #79's decision, and the criterion it turns on is **not** met by this document.

## Why this document carries no measurements

The comparison in this ticket is read-only HTTP observation of two public sites. The session that was asked to perform it has no general outbound network access: its egress proxy refused the `CONNECT` for every host outside its own allowlist, which covers package registries and GitHub and nothing else.

Recorded refusals, verbatim from the proxy's own status endpoint (`kind`, `host`, `detail`):

| UTC | Host | Reason reported |
| --- | --- | --- |
| 2026-10-06T00:01:22.379Z | the `platform-api` service origin | `connect_rejected` — gateway answered 403 to CONNECT (policy denial or upstream failure) |
| 2026-10-06T00:01:40.077Z | `noodle.money` | `connect_rejected` — same |
| 2026-10-06T00:02:19.343Z | the `web` service origin | `connect_rejected` — same |
| 2026-10-06T00:02:19.636Z | `example.com` | `connect_rejected` — same |
| 2026-10-06T00:02:20.290Z | a public market provider | `connect_rejected` — same |

`example.com` is the control: it is refused too, so this is the session's egress policy and not a property of either system under test. `curl` reports `(56) CONNECT tunnel failed, response 403` and HTTP status `000` in every case; no request reached either site, and neither site was given any load.

Nothing in this document is a measurement of either system. The two sections that do carry evidence are labelled with where that evidence comes from.

## The procedure

Public URLs only, no credentials, no query parameters beyond those written here. Four rules the collection must hold to:

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
  - the new `volatilitySamples` counts returns between completed minutes, so expect it to be one lower than a v1 sample taken over the same window.
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

## What is already established, and by whom

### A. Delivery chain to the live revisions

Collected for this document from GitHub Actions metadata, which this session can read. Every run below is a merge-to-`main` `push` delivery whose `deploy release vector` job ran `Resolve and verify the artifacts this commit published` before deploying:

| UTC | Head | Run | Deployed and verified |
| --- | --- | --- | --- |
| 2026-10-05 16:44 | `746d9f6` | [37343129955](https://github.com/money-noodle/money-noodle/actions/runs/37343129955) | api, web |
| 2026-10-05 19:13 | `b1b7a36` | [37361837276](https://github.com/money-noodle/money-noodle/actions/runs/37361837276) | api, web |
| 2026-10-05 23:03 | `9331244` | [37386233353](https://github.com/money-noodle/money-noodle/actions/runs/37386233353) | api, web |
| 2026-10-05 23:48 | `234aba1` | [37390554442](https://github.com/money-noodle/money-noodle/actions/runs/37390554442) | api, web — `Deploy api`, `Verify api health and the published contract`, `Deploy web`, `Verify web health` all success; both rollback steps skipped |

So the live pair is `234aba1` on both services, and the three M3 implementation merges (#210 at `746d9f6`, #211 at `b1b7a36`, #212 at `234aba1`) all reached it.

### B. Read-only probes recorded by the supervisor

Not collected here. These are the supervisor's dated observations on the implementation tickets, reproduced because they are the only live evidence currently in the record. Each is a single-sided observation of the new system — shapes and states, deliberately no figures — and **none of them is a comparison against the baseline**:

| Recorded | Ticket | Observation |
| --- | --- | --- |
| 2026-10-05 ~16:55Z | #210 | `/health/live` and `/health/ready` 200 at `git-746d9f6…`; the three paper reads 200, the full record about 298 kB with 500 forecasts; source times disclosed and old, early September 2026, as the frozen projection implies |
| 2026-10-05 ~19:26Z | #211 | `/v1/market/overview` 200 with 7 assets, five feeds `fresh` with fetch times and `news` `unavailable` (`upstream-unavailable`); `/v1/market/hourly-thresholds` 200 with 10 markets, listings fresh, assets without an active hour group reporting `no-active-hour-group` |
| 2026-10-05 23:12Z | #231 | after the news address fix, `/v1/market/overview` reports `feeds.news` `fresh` with 12 headlines; all other feeds fresh |
| 2026-10-05 23:58Z | #212 | all four web pages render 200 against the live API; every home-page feed shows `fresh` with its obtained time; the hourly view carries the completed-minutes note; the paper views show their early-September source times; the research notice is on every view |

The #211 and #231 pair is worth keeping: the explicit freshness state made a real misconfiguration visible on first contact, and the same probe after the fix showed the feed fresh. That is the new behaviour working, and it is also why the procedure above records the feed states at collection time rather than assuming them.

## Intentional non-parity

Sourced from the repository's own contract and from the maintainer's decisions recorded on #211. These are differences by decision; a collection run must not file any of them as a discrepancy.

| Difference | Direction | Authority |
| --- | --- | --- |
| Forecast probability, blended figure, edge, confidence and its breakdown, explanatory factors, the entry-policy `signal`, enabled venues, settlement-average and maker-fill estimates, calibration replay, cycle regime, and the policy manifest | present on v1, absent on the new system | #211 decision 1: model output and entry policy move with the engine in M4 (#80) |
| Asset ordering | v1 sorts by a policy-derived strength score; the new system publishes registry order | #211 decision 1 — the score is model output; `getMarketOverview` states the order carries no ranking |
| News sentiment label and score | present on v1, absent | #211 decision 1 — a lexical score presented beside market data is model output |
| Per-feed `state`, `ageSeconds`, `fetchedAt` and `reason` | absent on v1, added | #211 decision 2 — `getMarketOverview`: a feed past its five-minute limit is `unavailable` and its members are absent, "never zero, and never inferred" |
| Completed one-minute candles only, for the hourly current price and both volatility estimates | v1 uses the forming candle | #211 decision 3 — stated in both market operation descriptions |
| `refresh` / `refresh=live` cache bypass | present on v1, removed | #211 decision 4 — `getMarketOverview`: "No caller-facing refresh control exists" |
| Last-good value on upstream failure, marked stale with its age, then `unavailable` after five minutes | v1 served last-good values silently and indefinitely | #211 decision 5 |
| Upstream failure detail in a public response | v1 passed the raw thrown message through, including status and host; the new system publishes one of four fixed reason codes | #211 decision 5; `MarketFeedReason` in the contract |
| Placeholder quotes and zero-for-absent | v1 published a fabricated fifty-fifty market with zero liquidity for an unlisted asset and defaulted missing provider numbers to zero; the new system omits the member | `MarketVenueQuote` and `MarketSpot` descriptions |
| Unavailability shape | v1 answers 503 with a bare `{ "error": string }` carrying the raw message; the new system answers RFC 9457 `application/problem+json` with `MN-READ-MODEL-UNREACHABLE`, `MN-READ-MODEL-NOT-PUBLISHED` or `MN-READ-MODEL-INVALID` | `ReadModelProblem` in the contract |
| Response cache and cache headers | v1 caches the whole hourly response for 60 s in process and sends `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300`; the new reads have neither | #210 scope note and #211 decision 4 |
| `schemaVersion` and `requestId` on every response, `sourceUpdatedAt` and `executionKey` on the paper records | absent on v1, added | #210 parity rule: source times are disclosed and no staleness threshold is invented |

## Open comparisons

Every one of these is unmeasured. A collection run fills each line with a verdict and, where relevant, both figures:

1. Budget: source time identity; the nine money and count fields; the execution list length and each execution's fields.
2. Performance summary: both source times; the forecast counters; the trade counters; the four most recent forecasts.
3. Full performance: both source times; the summary counters; `paperRecord`; per-venue records; fundings; forecast history length.
4. Overview: per asset spot price against the skew bound; venue quote sets and alignment; basis inputs and the `zScore` recomputation; headline set overlap; the asset sets on each side.
5. Hourly: per asset listing group identity; candidate `(direction, ticker, strike)` set identity; the completed-minutes difference in `currentPrice` and `volatilitySamples`, quantified; the model probability recomputation.
6. Web: three sampled figures per page against the operation behind it; source times, feed states, the completed-minutes note and the research notice.
7. Degraded behaviour, to the extent it can be observed without inducing it: whatever `feeds` states and `unavailableReasons` the collection actually sees, and the shape of any 503 either side returns of its own accord.

## Limitations

1. **No measurement of either system was taken.** The egress policy refused every request (above). Sections A and B are delivery metadata and the supervisor's prior probes; neither is a comparison.
2. **The supervisor's probes record no figures by design**, so even the new system's values are unknown to this document. They establish shapes, states and reachability at their own timestamps, nothing more.
3. **Market comparisons are inherently approximate.** Two systems reading the same provider at different instants will differ; the procedure bounds that with a figure the API itself publishes rather than with a fixed tolerance, and a reviewer should treat a single breach as a prompt to re-capture before filing it.
4. **The frozen projection is an assumption to re-verify, not a given.** It holds only while the v1 writer stays stopped. The procedure's first paper step checks it by comparing source times; if they ever differ, the paper comparison is a race and the rest of that section is void until it is re-established.
5. **The live revisions were not probed**, so the versions in the header come from delivery evidence. A deploy between then and a collection run makes the header wrong; P1 is what fixes that.

## Conclusion

The M3 acceptance criterion on #79 — "agreed public dashboard behaviour and paper results independently verified against the accepted baseline through the new boundaries" — is **not met by this document**. No value on either side was observed, so no parity verdict exists, and "no discrepancies found" would be a false statement rather than a result: nothing was examined.

What this document does establish is the three things that do not need a probe: the live pair is `234aba1` on both services and reached production through the reviewed pipeline (A); the new system has been observed alive, serving all five operations and all four views, with its feed states behaving as designed including on one real misconfiguration (B, attributed to the supervisor); and the complete list of differences that are intentional and must not be filed as defects.

To meet the criterion, the procedure above has to be run by something that can reach both public sites, and its results recorded in a dated document beside this one. Discrepancies, if any, are filed as issues then.

**Discrepancies:** none recorded — because no comparison was performed. This is not a finding of parity.
