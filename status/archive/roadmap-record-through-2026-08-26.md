## Detailed Roadmap and Historical Delivery Record

### Forecast storage — v3 repaired; automatic seal and independent restore verified

The original migration trigger was ~396 MB retained heap, roughly 40 MB/day growth, and 6–11 second startup.
The migration met its clean-start target on 2026-08-16. On 2026-08-22, independently bundled dashboard
writers were proven to have separate module-local queues and caches; their interleaved seals corrupted v2 and
lost at least 88 qualified rows from local artifacts. The archive-backed owning repair installed
content-addressed v3 and the verifier is green again. The subsequent 2.43 GiB observation led to a native
profile and bounded public-history repair, then process-global provenance/cycle-path caches. Those changes
removed confirmed churn but production still peaked near 3 GiB; the shared execution ledger is the next
measured whole-file path and requires a separate money-path ownership design.

This section previously read "a 15-second system cannot keep full-history parse/stringify in the request or collector path." That premise was wrong and is worth recording as wrong, because it is what turned this into a fire drill. The parse costs ~1.2 s once per process; the ~10 s blocks were quadratic grouping in `summarizePerformance`. Sharding is still the right answer, but for memory rather than for blocking.

Started 2026-08-14:

- Added `lib/forecast-storage.ts` and `scripts/verify-forecast-storage.ts`.
- `npm run verify:forecast-storage` began as the migration gate over the legacy snapshot and journal. On 2026-08-19 that path returned `ok: true` over 52,417 rows and 10 planned shards while the active index held 58,360 rows across 12 shards, exposing that it no longer verified production storage. It now detects the active layout and checks indexed shard/rollup hashes and counts, terminal/open separation, duplicate identities, journal replay, and the direct full-history summary against the stored-rollup-plus-current-open summary. The first corrected run passed over 58,756 current rows, 57,728 sealed rows, 1,028 current open rows, 12 shards, and 1,820 journal events. `--write` refuses an active layout because only `sealForecastStorage` under the forecast write lock may mutate it.
- The gate compares the whole summary field by field, not eight counters: exact for anything countable, and a `1e-12 × max(1, |left|, |right|)` combined absolute/relative tolerance for float aggregates, because IEEE addition is not associative and a different row order legitimately moves the last digits. The absolute floor prevents last-bit noise near zero from becoming a false relative failure. Byte-identical output is not an achievable bar.
- Passing the gate required giving every reported ordering and tie-sensitive selection a total order by `id`. Ties are the ordinary case here, so `timeline`, both streaks, the per-cycle representative row, `recent`, grouped sorts, and the missed-buy selections previously could depend on durable row order. The missed-buy gate now uses the compact persisted provenance reference directly and covers an asset/window split across shards, including a globally nearest snapshot that contributes no candidate.
- A verified `--write` run over 49,703 live rows emitted `forecast-storage-v2`: 79 open rows, 49,624 terminal rows across 8 shards, and 6.6 MB of sufficient-statistic rollups standing in for roughly 190 MB of history. Both shard rows and rollups have indexed SHA-256 checksums, and the verification path now consumes the exact rollup objects that are written rather than rebuilding them invisibly from rows. The older 14 MB / 3,082-row open artifact was a symptom of event-loop starvation; resolution has caught up.
- **V3 incident repair, 2026-08-22.** V2's caller-held lock was module-local, while Next produced three writer copies; a stale seal could omit another copy's journal events and truncate them. V2 also overwrote active filenames before publishing its index, so a crash could invalidate the prior generation. V3 permits only `background-collector` to import calculation mutation, shares a process-global queue, holds a process-lifetime filesystem lease, compacts from reloaded durable state, uses immutable content-addressed artifacts, verifies them after write, and publishes `index.json` last. The repair restored 88 archived qualified rows and moved every corrupt source to `.corrupt-*`; the first v3 gate passed over 70,837 rows with zero errors. The dominant caveat is an evidence gap whose losing-writer-only rows cannot be enumerated. See the dated incident report rather than treating 88 as a complete loss count.
- Off-machine archive and restore verification passed on 2026-08-24: the expanded stable-source manifest held 138 files / 1,436,922,799 source bytes, restored byte-exactly, and passed the full forecast and v9 execution-ledger verifiers. Dedicated application credentials retain object read/write and bucket-read permissions but no object-delete or bucket-write permission. Rolling local deletion remains disabled until Object Lock/enforceable retention or an independent replica and the owner-aware tier catalog exist. See `reports/object-storage-restore-and-disk-reclamation-2026-08-24.md`.

Plan:

1. ~~Build `summarize(sealedRollups, openRows)` beside the current function, both running and compared under the existing gate on live data, with nothing switching over.~~ **Done.** `summarizeFromRollups` in `lib/forecast-rollup.ts` reproduces the full summary under the gate over the 49,703-row live history, in 134 ms against 624 ms, from 6.6 MB of rollups standing in for roughly 190 MB of rows. Both paths run on every gate run and nothing has switched over. The merge depends on no property of the layout: it sorts ordered columns, merges cycles/windows by key, and globally re-selects the missed-buy snapshot per asset/window. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §4.1.
2. ~~Switch the reader.~~ **Done 2026-08-16, and measured.** `readForecasts()` returns the open set; sealed shards load lazily for the evaluator and the on-demand reports. Retained heap to serve the hot set fell from **426 MB to 17 MB** (RSS 493 MB to 70 MB): 1,549 open rows plus nine shard rollups standing in for 50,713 sealed rows. `/api/dashboard` warms in ~1 s and then serves in ~12 ms. The summary is unchanged, produced by `summarizeFromStorage` as sealed statistics plus the open rows, which the gate proves field-by-field against the direct scan.

   The switch is gated on `index.json`: absent or version-mismatched, every path falls back to reading whole history exactly as before, so it reverts by deleting one file. Sealing now also clears the journal — without that the next read replays events for rows already inside a shard and double-counts every lifetime figure.
3. Keep retention policy unchanged during the migration; this is a storage-layout change, not evidence deletion.

Rollups must come before sharding, not after. Every cycle `updateTracking` reads the whole array and the cached summary scans all of it every 60 seconds, so switching the reader while the summary still needs sealed rows would either keep the archive resident anyway or re-read the history every minute. The residency win is gated on the summary no longer needing sealed rows.

The worker boundary previously listed here is deferred indefinitely. It relocates work without reducing residency, which is not what binds. See [docs/forecast-storage-design.md](/Users/raiphairow/code/money/docs/forecast-storage-design.md) §5.

The migration's done criteria were: retained heap and startup time measurably drop, forecast scoring match
pre-migration output under the gate, 15-second collection remain fresh through restart, and the dashboard
report degraded rollup state explicitly. All four had met as of 2026-08-16. The 2026-08-22 integrity failure
reopens the scoring/health gate; it does not rewrite the earlier clean-start measurement.
`/api/performance` carries `forecastStorage`, and the signed Performance dialog shows an explicit
incomplete-figures notice when a shard rollup cannot be read.

Current follow-ups:

- **Automatic v3 seal and independent restore passed.** Restored generations generated at
  `2026-08-23T17:03:39.476Z` and `2026-08-24T13:38:01.496Z` passed the complete direct-versus-rollup verifier;
  the latter held 73,680 sealed rows in 17 shards plus 1,137 current rows after journal replay. The corrupt v2
  artifacts and frozen legacy snapshot remain preserved because passing restore does not itself authorize
  eviction. Design: [docs/forecast-storage-generation-repair-design.md](docs/forecast-storage-generation-repair-design.md);
  restore report: [reports/object-storage-restore-and-disk-reclamation-2026-08-24.md](reports/object-storage-restore-and-disk-reclamation-2026-08-24.md).
- **Execution-ledger v9 is active; observational residency remains open.** Seven emitted execution bundles
  share one serializer and committed snapshot; mutation clones, commit-boundary publication, failed-write
  invalidation, detached scoped reads, and a global pause barrier remain tested. V9 reduced the 3,794-row hot
  ledger from 36.35 MB to 6.26 MB without deleting evidence, and fixed polling no longer hydrates immutable
  batches. Structured-clone samples fell materially, while large append-only observational journals still
  produce parse/GC spikes and require separate owning-store designs. Measurements and caveats:
  [reports/execution-ledger-v9-migration-2026-08-22.md](reports/execution-ledger-v9-migration-2026-08-22.md);
  designs: [docs/execution-ledger-runtime-design.md](docs/execution-ledger-runtime-design.md) and
  [docs/execution-ledger-v9-design.md](docs/execution-ledger-v9-design.md).
- **Payload split** (design §7 item 2, agreed separately): the freshness badge should judge only market data,
  so no future slow subsystem can blank the trading view.
- **Do not retire the legacy snapshot while verification fails.** `data/forecast-history.json` is the frozen
  coexistence copy and must remain untouched until the sharded layout verifies again and an independent
  restore/evaluator pass succeeds.

### Long-shot round trip — retired; historical implementation record

**Current status (2026-08-26): retired and removed from runtime/product authority.** The remainder of this section preserves implementation history and dated evidence. Strategy-specific execution, collection, allocation, API/UI, and estimation tools no longer run; durable data and the retired ledger identity remain.

Started 2026-08-14. A second policy on `crypto-15m`, running beside the edge policy. The launch cohort
bought a side whose executable ask reached 10¢ with at least ten minutes left and sold through a one-second
reduce-only IOC poll at 90¢. **The active local cohort changed on 2026-08-18 to 12¢→97¢/600s, paper only.**
That change was selected from a 50-cell retrospective fine-path sweep, so it starts a new forward collection
cohort and is not evidence-backed promotion. Design and launch arithmetic are in
[docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md);
SPEC §12.10 and the 2026-08-14 decision-log entries carry the decisions.

Implementation is complete under an explicit operator decision and bounded learning budget: 30% of the
`crypto-15m` cap, a 20¢ opening ticket, and a derived halt at 300¢ of policy equity. Economic review is now
locked to 60 independent settlement windows under hold-v2; attempt count is diagnostic only.

What the screening does and does not support is recorded honestly. Buy-and-hold on this trigger has no edge:
20.2% ± 3.7pp over 119 candidates against a 22.2% break-even, so the cheap side wins about exactly what it
costs. The round-trip exit is **unmeasured**, and that is the reason to collect rather than a reason to
believe. (The "68.4% where the true figure must be 100%" reading of that blindness is **withdrawn** as of
2026-08-17: winners need not pass through 90¢, because these contracts settle on a close-price comparison.
See design §14b.)

Delivery order:

1. ~~Pure rule layer and ticket/cap arithmetic.~~ **Done.** `lib/long-shot-policy.ts`. Entry rule, ticket
   sizing, caps, and round-trip economics asserted against the production fee and sizing code rather than a
   copy, so a fee-model change breaks the test.
2. ~~`strategyId` on orders and summaries.~~ **Done.** `lib/strategy-registry.ts`, absent meaning the edge
   policy exactly as absent `marketId` means `crypto-15m`. One ledger, not two, because reconciliation is
   account-wide and a split file would leave real resting orders unmatched. `lib/strategy-isolation.test.ts`
   pins the money boundary in both directions.
3. ~~Per-policy budget sub-allocation and the derived halt.~~ **Done.** `lib/strategy-budget-policy.ts`. The
   percentage funds a strategy once; its equity then rolls forward on its own P&L. Applying the percentage
   continuously would size one strategy's ticket from the other's results and dilute its own losses so the
   halt could never fire on the strategy that earned it.
4. ~~Resting reduce-only GTC limit exits.~~ **Superseded.** Kalshi refuses `reduce_only` with
   `good_till_canceled`; verified against the production API. `lib/target-exit-policy.ts` polls the
   owned-side bid every two seconds and submits a reduce-only IOC at the mark instead.
5. ~~Buy-and-hold sentinels, written at trigger time.~~ **Done.** `lib/hold-sentinel.ts`.
6. ~~Contract price-path recorder.~~ **Done.** `lib/contract-path.ts`. Compact per-window triples rather
   than the rewritten array `cycle-path-store` uses, at under 700 KB/day.
7. ~~Reporting split by entry generation and regime.~~ **Done.** `lib/long-shot-report.ts`.

8. ~~Durable stores and collection wiring.~~ **Done, collection only.** `lib/contract-path-store.ts`,
   `lib/hold-sentinel-store.ts`, and `lib/long-shot-execution.ts` run detached from `processCycle`
   alongside the calendar and persistence lanes. Contract paths and hold sentinels accumulate from the
   next cycle onward.

9. ~~Execution.~~ **Done.** `runLongShot` and `runLongShotExits` in `paper-execution.ts`, inside the
   serialized engine queue and deliberately separate from `runPaper`/`runLive` — threading a second policy
   through the edge policy's selection, persistence, maker-retry, portfolio-ranking and regime-gate path
   would change behaviour the mirror invariant depends on. Exits run before entries so a position that
   reaches its mark frees its slot for a same-cycle re-entry.
10. ~~One-second exit poll.~~ **Done.** `TARGET_EXIT_POLL_MS`. Quotes are fetched outside the write queue and only the ledger
    mutation is queued, per the 2026-08-14 decision that upstream waits must not sit inside the queue they
    serve. A tick never queues behind itself, so a slow venue produces fewer polls rather than a backlog.

Paper-enabled and running as of 2026-08-15; the separate live flag is currently false. Entry is a price-capped taker IOC at the mark — an explicit exception
to maker-only production execution, because the trigger is defined as the ask reaching the mark. Every
account-wide protection still applies unchanged: kill switch, live arming, the reconciliation barrier, the
drain, and the shared hourly filled-order ceiling.

Funded at 30% of the Kalshi `crypto-15m` cap: 600¢, a 20¢ ticket, halting below 300¢. `npm run fund:long-shot`
reports and re-applies it, refusing unless automation is paused with nothing reserved or open.

Current state at `2026-08-22T05:32:51Z`: paper v2 had 50 resolved attempts across 26 independent windows,
−114.64¢ exact P&L on 1,902¢ staked, two `won` settlements and four target sales. Hold-v2 had 50 paired
resolved sentinels in the same 26 windows, six in-the-money settlements and four paths touching 97¢. This
is progress toward the locked 60-window review, not an interim decision. **The long-shot live lane remains
blocked by its own per-strategy arming flag** because `MONEY_NOODLE_LONG_SHOT_LIVE_ENABLED` is unset; it has
zero v2 live attempts even though the account-wide edge desk was active/live at the snapshot. Distinguishing
those controls is what prevents a paper research policy from inheriting funded authority.

**Historical launch cohort as of 2026-08-17:** 25 resolved paper attempts under
`long-shot-round-trip-buy10-sell90-win600-v1`, of which 1 sold at the mark, against the 60
`LONG_SHOT_REVIEW_ATTEMPTS` required before a first review. That cohort was superseded before reaching its
bar and must not be pooled with 12¢→97¢. The three `sold` rows in the earlier
`buy40` cohort were strict-value exits, not round trips: `observeAndExecuteStandaloneExits` is now scoped
to `EDGE_BINARY_BUY` precisely because it closed long-shot positions at 48–76¢ on 2026-08-15. Do not read
them as the exit working.

Live findings so far, in the order they were measured:

- **Cheap sides are common; cheap sides *early* are rare.** Only 2% of sides that reach 10¢ do so inside
  the first five minutes — a contract becomes cheap *because* the underlying already moved, so cheapness
  and clock-remaining are close to mutually exclusive. The entry window, not the price mark, is what
  limits candidate flow.
- **Fifteen-second entry sampling was not the constraint.** Of 586 recorded cheap-side episodes, only 13%
  lasted a single sample and half persisted beyond ninety seconds. One-second polling was added anyway,
  for the shared quote cache and to make a wider window affordable, not to catch flickers.
- **A still-falling price is a trend, not a dip.** Candidates still falling at the next sample reached 90¢
  0.9% of the time against 2.6% for those that stalled. Real, and worth filtering — but it moves the rate
  from 2.2% to 2.6% against a 12.5% bar.
- **No configuration of marks clears break-even.** All sixteen cells of an entry/exit sweep land between
  0.48 and 0.72, and the flatness rather than the best cell is the finding. See
  [docs/long-shot-policy-design.md](/Users/raiphairow/code/money/docs/long-shot-policy-design.md) §14a and
  `npm run analyze:long-shot-marks`.
- **No buy→sell *gap* is priced loosely enough to pay either**, measured 2026-08-17 over 1,506 windows
  spanning 62 hours. Banding the entry (so a 40→60 row describes buying at 40, which a cumulative ≤40¢
  cohort does not) and grading misses at their real settlement, 131 populated cells span 0.43–0.82. The
  touch rate tracks break-even at ~0.6–0.8× of it everywhere: narrow gaps are achieved more often in
  almost exact proportion to paying less. See §14b and `npm run analyze:long-shot-gaps`.
- **Selling earlier trades return for the appearance of success.** Dropping the exit from 90¢ to 20¢ raises
  the sold-at-mark rate from 8.2% to 26.5% by selling all five winners in the cohort at ~2× rather than
  letting them settle at ~10×, in exchange for rescuing 8 of 44 losers. Paired on identical triggers, every
  exit earlier than 90¢ is negative; only 95¢ (+0.044) and never selling (+0.088) are positive, both
  t=1.76 among 17 comparisons. **Sold-at-mark rate is not a proxy for return, and moves against it here.**
- **The coverage correction is withdrawn, and with it the last cell above break-even.** Both §14a's
  1.36× and its successor rested on "every winner passed through 90¢ on its way to 100¢". **That is false
  here**: these contracts settle on a close-price comparison, and over 1,033 resolved windows the winning
  side was still bid **below 90¢ in 10.0% of cases**, below 10¢ in 0.8%. The like-for-like replacement —
  dense 1s paths decimated to 15s — implies 1.00–1.25× where entry detection is stable and swings wildly
  at ≤10¢, so **no correction is applied**. Uncorrected, **not one of the 131 grid cells clears 1.00**;
  the best reaches 0.82. This also removes the structural argument in design §3.3 that selling early beats
  holding — about a tenth of winners are reachable only by holding, which is the direction the paired
  never-sell comparison already pointed.
- **No entry filter screens out bad candidates.** Thirty entry-time filters measured 2026-08-17 on the
  wide ≤30¢ cohort (n=429) and re-checked in the production band. Closed off as unsupported: **the
  forecast model as a veto** (it prices the side at or above the ask on 100% of production-band
  candidates — there is no disagreement to trade on, so the entry rule ignoring the forecast per design §2
  costs nothing), **spread filtering** (98% of candidates sit inside 4¢), and **asset exclusion** (no
  asset is 1.6 SE from the cohort mean; §13 stays empty). The stall filter measures a 1.04 lift here
  against the 0.9%-vs-2.6% reading §7 records — a disagreement, reported rather than smoothed. See
  [reports/long-shot-filter-screen-2026-08-17.md](/Users/raiphairow/code/money/reports/long-shot-filter-screen-2026-08-17.md)
  and `npm run analyze:long-shot-filters`.
- **The one signal that separates candidates does not select any.** Three separately-derived measures —
  fell <10¢ from the window high, local volatility <0.1%, volatility ratio <1 — move together and all say
  *the side that got cheap without a big move is the better bet*, which is the opposite of the intuition
  that a long shot needs a large move. It **keeps 1 of 49 candidates at ≤10¢**: sides reach 10¢ *by*
  collapsing, restating §7. The subset surviving the confound check is stronger (n=16, ratio 1.27, return
  +0.834 ± 0.391) but its mean entry is **28.8¢** — a different strategy, not a filter on this one, and
  n=16 after thirty tests is a hypothesis rather than a result.

Evidence stance: **stop tuning; treat 12¢→97¢ as a fresh paper cohort.** Nothing measured authorized the
parameter change. On the current 2-second retrospective sweep the selected cell held 149 entries, ratio
0.83, sell-at-mark +9.0% ±46.3pp and hold +11.5% ±47.3pp; it was one of 50 screened configurations. Only
forward records under its derived version may answer whether anything survives selection, and the current
hold-sentinel capture gap must be closed first.

**Revisit triggers.** The dense-path trigger has arrived: on 2026-08-19
`npm run analyze:long-shot-fine-marks` covered 562 settled fine windows at a mean 266 samples each. Finer
sampling raised touch rates but did not produce a promotable mark; the only displayed ratio above one had
an interval spanning zero and trailed hold. The active first-review trigger is **60 independent settlement windows at one policy version** under
`long-shot-hold-v2`. The execution report's legacy `LONG_SHOT_REVIEW_ATTEMPTS = 60` indicator is diagnostic
only and cannot unlock the economic review. The 12¢→97¢ v1 execution cohort had 9 attempts in 5 windows at
the repair read and remains superseded by mandatory-trailing v2; invalid hold-v1 records stay excluded. The
2026-08-21 operator decision above commits the untouched order-policy-v2/hold-v2 cohort through its 60-window
boundary without arming live or changing parameters on an interim result.

**A proposed volatility-trading strategy was measured and does not work as described** (2026-08-18,
[reports/maker-fill-adverse-selection-2026-08-18.md](/Users/raiphairow/code/money/reports/maker-fill-adverse-selection-2026-08-18.md),
`npm run analyze:maker-fills`). Entering on an intra-cycle direction change far from the 50¢ open is a
**coin flip**: eighteen configurations on the unbiased fifteen-second data, 1,200–2,000 signals each, all
between 48.3% and 50.5% with every interval covering 50%. And the taking economics are prohibitive — a
round trip at 70¢ needs an **8.14¢ move** at the current ticket and never less than ~4¢ at any size,
because most of the cost is proportional. Fees peak at 50¢, so trading near the middle is worst.

What survives is **execution, not prediction**: Kalshi charges nothing on a resting fill, so posting
collects the spread rather than paying it. Resting buys show **no detectable adverse drift** — every
horizon indistinguishable from zero across 15,000–17,000 fills over 1,611 windows, against an
unconditional control at zero. That is *no evidence of* adverse selection rather than evidence of none:
the mechanism is queue position, and a fifteen-second sample cannot distinguish a one-tick touch from a
sweep. Settling it needs depth recorded at the posted price over time, which the contract-path recorder
does not carry although the venue exposes it. **Nothing here authorizes a market-making strategy.**

**The bounded maker-fill experiment stopped and its persisted sample cannot answer the question**
(2026-08-19 review in [reports/open-experiment-status-2026-08-19.md](reports/open-experiment-status-2026-08-19.md)).
It collected 10,448 rows over 447 asset-contract windows and 64 settlement windows during 16.6 hours on
2026-08-18. The standalone process is no longer running.

The intended fill rule in `lib/maker-depth-experiment.ts` is sound: a post fills only after traded volume at
or through its price exceeds size displayed ahead at posting. The recorded schema is not sufficient to
apply it. `fetchKalshiTradePrintsSince` returns `takerSide`, but `scripts/experiment-maker-depth.ts` discards
that field and persists every print on both outcome scales. Only an opposite-outcome taker consumes a
selected-side resting bid, so one print can be credited as queue progress on both sides. The resulting fill
rate is an upper bound and post-fill drift is not decision-grade. Its package command and historical
backfill command were removed on 2026-08-19, and both scripts now fail closed if invoked directly. Any new
depth measurement needs an agreed prospective schema carrying taker direction; displayed queue would still
remain a proxy for private FIFO rank. **Nothing here authorizes a market-making strategy.**

**The swing-trading premise is measured and closed** (2026-08-18,
[reports/swing-trading-2026-08-18.md](/Users/raiphairow/code/money/reports/swing-trading-2026-08-18.md),
`npm run analyze:swing-exit`). The swing is **real** — the owned-side bid reaches entry +2¢ in 64–81% of
positions — and selling into it loses to simply holding in every band and target size, by about 0.15 per $1
over 2,835 positions. A high hit rate with a capped gain and an uncapped loss is the shape.

Two further results from the same file:

- **Trajectory is a real signal, and smaller than the cost of taking it.** Trend efficiency (`slope ÷
  range`, already computed as `cycleRegime.trendEfficiency`) shows monotone mean reversion worth 2–3¢
  between extreme quintiles, and it **survives** measurement on a single consistent price series — bid-only
  t=3.52, ask-only t=2.64 — so it is not merely bid-ask bounce, though the spread's own reversion is
  enormous (t=20.65) and accounts for roughly 1.5¢ of the 3.3¢ mid effect. Traded as a taker it still loses
  (−1.4 to −2.1¢ gross before fees), because **the spread is widest exactly when trend efficiency is
  extreme**: a ~2¢ signal cannot cover a ~3.5¢ entry. An earlier reading here called it pure bid-ask bounce
  and is withdrawn. Any trajectory feature must be reported in traded form beside observed form.
- **A stop helps substantially and does not rescue it**, cutting the loss from −0.20 to −0.07 per $1. This
  **corrects §15b**, where stops appeared to hurt: that reading used the lowest bid of the whole window
  with no ordering and so fired the stop on positions that had already hit their target. Note the
  structural tilt it exposes — at a symmetric ±3¢ the stop fires 66% against the target's 30%, because
  entry pays the ask and is marked against the bid, putting the stop about a spread closer.

**Fine path recording is live** (design §18, 2026-08-18). Every eligible contract is now recorded at
**two seconds** rather than fifteen, using quotes `longShotEntryTick` already fetches for the entry
decision — **no additional venue requests**. Before this, fine sampling began only once a side fell below
the entry mark, at roughly 9¢/91¢: across 57 such windows, **zero** had the 20–80¢ range inside the fine
region, so every trajectory measurement in this repo was made at a resolution that hides ~37% of price
movement and conceals a 2¢-or-larger swing in 8.7% of intervals. Compaction thins windows older than
`CONTRACT_PATH_FINE_RETENTION_DAYS` back to the coarse grid, so the resolution is not a permanent ~130 MB
liability.

A standalone two-second poller was tried first and **withdrawn within a minute**: it rate-limited the live
desk inside thirty seconds on the endpoint it was polling. Kalshi's budget is per account and the repo's
limiter is per process, so a second process duplicating the desk's reads competes with it. Recorded here
because the instinct to add a separate collector will recur.

The one open hypothesis is the **quiet-market signal** above. If it is worth testing it needs a committed
sentinel arm at a higher entry band, written at decision time and followed to settlement — not a filter
bolted onto a policy whose candidates it does not select, and not a retroactive re-screen (§5.5). That is a
design decision, not a parameter, and is unstarted.

**Operator-defined analysis bands are implemented** (design §15a). The dashboard's long-shot dialog now
carries a band editor: each band is one hypothesis — buy inside an entry range, sell at an exit — measured
against every recorded window, with touch rate, break-even, ratio, and clustered return per $1. Saving
starts no backfill, because the stored candidate summaries carry no band, entry mark, or entry window:
`lib/long-shot-candidate.ts` keeps the first occurrence of each distinct ask with the peak bid reachable
after it, so any band is a lookup. Measured on the current data, backfill of 1,590 paths takes 69ms and a
band evaluates in single-digit milliseconds.

Two guards are structural rather than procedural, because this is a retroactive-screening surface and
AGENTS §5.5 says screening may filter an idea and may never promote one: no module that can price, size,
gate, or trade may import the band store (`lib/analysis-bands.test.ts` asserts it), and the number of
configurations ever evaluated is displayed as the multiple-comparison denominator.

Remaining: the report surface, and the durable stores' retention policy once the journal starts growing.

Implementation is done; economic review means 60 independent settlement windows—not 60 attempts—are
reportable for one untouched hold-v2/order-policy-v2 cohort, clustered by settlement window.

### Walk-forward model review — evaluator v3 required

The evaluator and promotion ledger exist, but promotion criteria still need to become decision-grade.

The 2026-08-20 review of `walk-forward:975:fnv1a-bccfee60` establishes that adding thresholds to the
existing score is not enough. Its cohort fingerprint no longer reproduces after later settlements; its
baseline is not the buy policy active at generation or v22 today; and a candidate cannot change the stored
production-selected side, provider or cost. Full findings and paired uncertainty:
[reports/walk-forward-model-candidate-review-2026-08-20.md](reports/walk-forward-model-candidate-review-2026-08-20.md).

Design evaluator v3 before coding it:

- Freeze every cited run's ordered settlement-window and selected-row cohort in a content-addressed
  manifest so late resolution cannot rewrite an immutable checkpoint.
- Replay one explicit `BuyPolicy` and regenerate side, provider and all-in cost from every decision-time
  actionable quote; never inherit production's selected side.
- Report paired, window-clustered signal-policy return separately from a prospective simulated-execution
  lane using versioned route, depth and trade evidence. The candidate lane receives no order authority.
- Predeclare gates for return lower bound, Brier/log-loss non-regression, coverage, continuous drawdown,
  replay coverage and fold consistency. Score quality candidates only on exact confidence-input rows.
- Treat 25-window checkpoints as monitoring, not repeated promotion attempts. Lock the reviewed
  `(basisWeight=0.65, slowTiltScale=0.5)` candidate for one future prospective cohort and one review at an
  agreed independent-window bar.

Until that implementation exists, v2 continues to collect and report monitoring checkpoints but
`evaluatePromotionEligibility` refuses its evaluator generation before considering its numerical gates.

Current stance: Blend 0.4 retained. The stored 1,150-window checkpoint generated
`2026-08-22T03:31:28.252Z` crossed evaluator v2's mechanical review threshold: candidate 14.27% against
baseline 12.11% over 575 test windows, positive 5/5 folds and better in 3/5. It still cannot promote: v2
inherits an incomplete policy/execution boundary, the cohort fingerprint can move after late resolution,
and overlapping checkpoints are repeated looks. No production parameter or promotion ledger changed.

### Profit-reversal exit policy — prospective evidence open

Strict value exits and the 75% profit-reversal lock are measured separately. Strict value remains executable. `profit-reversal-75-v1` is already withheld from execution by default on its own negative evidence; arming and high-water observations continue so the counterfactual remains prospective. The local environment explicitly keeps it disabled.

Remaining work:

- Keep collecting complete position paths so HOLD arms are no longer approximate.
- Re-run exit policy reports after enough new armed downturns under the current implementation.
- Require a separate manual evidence review before `MONEY_NOODLE_PROFIT_REVERSAL_EXIT=true` may restore execution or before a replacement reduce-only rule is introduced.
- Preserve strict reduce-only semantics: exits reduce only existing exposure and never become opposite-side buys.

The small historical live cohort supports conservative withholding, not permanent refutation or a replacement rule.

### Maker queue/depth evidence — collection open

Instrumentation and the queue-aware paper simulator are implemented; the next step is held-out evidence, not live execution changes. Before this deployment, same-signal paper/live maker agreement was only 29.7% across 37 paired attempts (19 live-only fills and 7 paper-only fills), which is the baseline the new independent and matched-live lanes must improve on prospectively. The first post-deployment review has only 2 matched intents.

Remaining work:

- Segment fill and return by displayed-ahead proxy, imbalance, repricing path, resting duration, profit state, probability deterioration, asset, side, and time remaining.
- Compare accepted filled orders with accepted no-fills by settlement window.
- Measure independent-paper/live agreement and disagreements against the separately stored matched-live overlay; never substitute the selected live fill for the independent paper result.
- Keep v2/v3/v4/v5 paper cohorts separate from neutral
  `paper-managed-execution-route-ioc-requalify3-calibrated-v6`; recalibrate only after enough complete
  prospective `entry-execution-mirror-pair-v1` live/paper pairs exist in one exact execution generation.
- Current execution identity is `maker-high30-requalify3-fresh1c-idv2-v6` with
  `entry-sizing-reduce30-below-edge30-v1`. Below
  30pp each qualified episode is a reduced-size managed maker; at 30pp+ it is one full-base capped IOC only
  after the exact refreshed quote re-clears every absolute gate. A maker zero-fill may requalify up to the
  three-episode ceiling, but there is no taker fallback. Historical v3/v4 rows retain their execution stamps
  and must not be pooled with v5 or v6; v6 retains v5 economics but changes live wire identity and reconciliation ownership.
- The pre-decision shadow had shown no discrimination: over 618 stamped orders on 2026-08-18, 74 were
  taker-flagged but all executed maker; flagged and unflagged fill rates were 51% and 50%, and fill-selection
  gaps were −11.2pp and −13.1pp. That evidence did not authorize v4 or v5; both 2026-08-19 changes are
  explicit operator decisions, not claimed promotions.
- A wholesale switch to taking remains only the counterfactual in
  [reports/take-the-ask-2026-08-18.md](reports/take-the-ask-2026-08-18.md). It is not the deployed policy.

Forbidden for now: depth-aware sizing, any multiplier above 1, more than three entry episodes, rearming
without fresh post-completion persistence, rearming after any fill or taker result, taker fallback after a
maker miss, direction-based production cancellation, bypassing any fresh high-edge gate, or queue-aware live
gates.

### Organic live switch and exit verification — open

The switch engine, reconciliation matcher, partial-exit handling, replacement withholding, and switch-versus-hold accounting are implemented and tested. A real organic switch has still not been economically verified end to end.

When it occurs naturally, verify:

- Reduce-only exit order side/action.
- Venue fills, fees, remaining quantity, and reservation release.
- Replacement withholding after zero or partial exit.
- Replacement submission only after a complete confirmed exit.
- Switch-versus-hold and standalone exit counterfactual accounting.

Never force a live switch just to exercise the path.

### Provider variant and policy visibility — open

The provider registry foundation is in place. The next useful work is observability and clean attribution before new execution adapters.

Remaining work:

- Add dashboard, performance, open-order, and decision-history filters for live/paper, provider, provider variant, market, and policy version.
- Move static policy manifest details into a durable model/policy registry with historical parameter diffs, dataset fingerprints, and audited promotion/rollback lineage.
- Add per-(provider, market) policy overrides for thresholds, sizing, and execution style.
- Defer candidate-set funding/ranking changes until there is a second live-capable provider, because it cannot change behavior before then.
- Add any new provider read/paper-first behind official API verification, operator eligibility, and explicit capabilities. No scraping path may imply live capability.

### Secondary work after safety and evidence

These are useful, but lower priority than storage, evaluation, exits, and maker evidence:

- Operator alerts for fills, orders, settlement, reconciliation, and drain state.
- Historical execution replay/backtesting with clearly labeled reconstructed assumptions.
- Demo/sandbox venue testing where supported.
- Consolidated venue exposure/P&L views that never blend live with paper.
- Durable workers, leases, backups, restore tests, runbooks, and deployment observability.
- Same-origin/CSRF enforcement on every mutation or billable research route, not only trading/model-promotion controls.
- Dependency pinning and security cleanup for packages currently set to `latest`.
- GitHub unreachable-object purge request and confirmation that the old Kalshi key ID is revoked.

## Guardrails

- Do not increase stake size from live P&L alone. Require independent live windows, lifetime and current-epoch P&L, drawdown, maker adverse-selection evidence, walk-forward results, reconciliation health, and real switch/exit verification.
- Do not add venue prices to the tradeable probability. They remain benchmarks and execution costs.
- Do not promote DOWN/NO or any side-specific gate mechanically. Side-specific profitability must be proven in held-out clustered windows.
- Do not manually trade the same active Kalshi ticker while automation owns or may enter it; shared-account netting has already caused reconciliation to block correctly.
- Do not let public/stateless deployments gain execution authority. They may read replicated paper projections only.

## Retired From Roadmap

These were previously listed as remaining work and are now implemented:

- Accepted-order `not_found` consistency handling and separated issuance/approved/submitted/amended/fill prices.
- Exact-contract maker-execution paper shadow, shared live/paper repricing transitions, public trade/queue fill evidence, and separate matched-live overlays.
- Explicit averaging-window parsing, Kraken-to-venue reference drift, and target-integrity reporting.
- Complete position-lifecycle, liquidation, queue/depth, and path observations.
- Versioned HOLD/EXIT/SWITCH action counterfactuals.
- Separate strict-value versus profit-reversal exit reports.
- Durable budget epochs, peak-equity drawdown, and stake-expansion criteria.
- Immutable model promotion/rollback core and authenticated write route.
- Public paper performance projection to Postgres.
- Market identity, per-provider tracking, per-provider budgets, and global-caps regression guard.
