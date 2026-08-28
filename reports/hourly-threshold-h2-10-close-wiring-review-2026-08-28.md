# Hourly threshold H2: ten-close wiring review

**Review date:** 2026-08-28  
**Fixed cohort:** the first ten elapsed scheduled UTC research closes after activation, from
`2026-08-27T08:00:00.000Z` through `2026-08-27T17:00:00.000Z`  
**Activation:** `2026-08-27T07:04:37.842Z`  
**Generation:** `hourly-threshold-observation-v1`  
**Decision:** The count gate was met, but the wiring smoke did **not** close cleanly because 72 of 596 expected
minute buckets were absent. Continue H2 unchanged, count missing minutes against availability, and keep H3 off.

## Question and authority

This is the precommitted ten-independent-close smoke from
[`docs/second-market-hourly-crypto-design.md`](../docs/second-market-hourly-crypto-design.md) §5.2. It asks only
whether the H2 writer, identity, availability, outcome, archive, and non-interference wiring works. It does not rank
the model, select persistence or cutoff parameters, authorize paper capability, or create live authority.

The cohort was fixed at the first ten **elapsed** research closes. Later rows were excluded even though 19 closes had
elapsed by the review read at `2026-08-28T02:58:14.444Z`. No backfill was added and no surviving-row filter was used.
The read-only analyzer is `scripts/analyze-hourly-threshold-observations.mjs`.

## Findings

### 1. Count eligibility passed; minute cadence did not

From the activation minute through the tenth cutoff there were 596 expected minute buckets and 5,960 expected
asset/minute rows (ten planned assets). H2 retained:

- 524 minute buckets and 5,240 observations;
- 87.92% minute and row capture;
- zero duplicate observation IDs;
- zero malformed or unknown journal events;
- exactly ten distinct assets in every retained bucket; and
- 72 absent minute buckets, or 720 absent planned asset/minute observations.

The missing UTC intervals were `15:34–15:39` (6 minutes), `15:41–15:42` (2), `15:52–16:08` (17),
`16:10–16:14` (5), `16:16–16:25` (10), `16:27–16:41` (15), and `16:43–16:59` (17). The retained
journal contains no event that distinguishes process downtime, host contention, an in-flight skipped tick, or a
feed failure for those minutes, so attributing one cause would be speculation. Repeated maintenance and concurrent
analysis were material conditions, but they do not prove the cause of each gap.

The analyzer previously exposed only the elapsed-close count. This review adds a fixed first-ten-close projection
with expected/observed buckets, missing buckets, incomplete buckets, duplicate events, and availability against the
full expected denominator. `smoke10Ready: true` means the count made the review due; it does not override this
cadence finding.

### 2. Availability states were explicit where a row existed

There were 1,998 available rows: 38.13% of retained rows and 33.52% of all 5,960 planned rows when absent minutes
are counted unavailable rather than silently dropped.

| Asset | Retained rows | Available | Retained-row availability | Availability vs 596 expected minutes | Exact contracts |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTC | 524 | 399 | 76.15% | 66.95% | 16 |
| ETH | 524 | 400 | 76.34% | 67.11% | 16 |
| XRP | 524 | 400 | 76.34% | 67.11% | 16 |
| BNB | 524 | 397 | 75.76% | 66.61% | 16 |
| HYPE | 524 | 402 | 76.72% | 67.45% | 16 |
| DOGE | 524 | 0 | 0% | 0% | 0 |
| SOL | 524 | 0 | 0% | 0% | 0 |
| TON | 524 | 0 | 0% | 0% | 0 |
| NEAR | 524 | 0 | 0% | 0% | 0 |
| ZEC | 524 | 0 | 0% | 0% | 0 |

The first two close windows had no exact qualifying group. Each of the next eight had two independent contracts for
BTC, ETH, XRP, BNB, and HYPE. This is a listing-availability finding, not permission to narrow the planned asset set.

### 3. Exact identity and outcome wiring passed

The fixed cohort contained 80 unique exact contracts: two directions × five listed assets × eight close windows.
All 80 were closed and resolved from the exact Kalshi ticker with the same rules fingerprint:

- closed outcome coverage: 80/80 (100%);
- invalid outcomes: 0;
- contradictory results or rules fingerprints: 0; and
- resolution delay: 99.0 seconds minimum, 158.3 seconds median, 571.8 seconds p95, and 572.3 seconds maximum.

All 80 outcomes were NO and every modeled YES probability was at most `3.25e-43`. The strikes were far from the
Kraken reference spot. That makes the cohort economically inert and the near-zero row-weighted Brier score
uninformative; this smoke does not evaluate model quality. Kalshi settles on CF Benchmarks while the model reference
is Kraken, which remains the load-bearing target-integrity caveat for the 60-close review.

### 4. Archive and non-interference wiring passed

`hourly-threshold-observations.journal.jsonl` is in the archive allowlist and the archive run beginning
`2026-08-27T18:09:28.314Z` uploaded and read-back verified it; `data/archive-state.json` recorded the 148-file run as
successful at `2026-08-27T18:11:38.987Z`. This establishes inclusion and read-back for a post-cutoff copy, not remote
retention or deletion authority.

The H2 isolation tests continue to deny imports from policy, paper/live execution, budget, settlement, control, and
reconciliation modules. H2 remained `paper: false, live: false`; the analyzer and journal have no order or promotion
path. Current funded readiness is deliberately not used as proof of economic value.

## Gate result

| Wiring item | Result |
| --- | --- |
| Ten elapsed closes available for review | Pass |
| Append-only schema and idempotent IDs | Pass |
| Ten complete assets per retained minute | Pass |
| One retained bucket per expected minute | **Fail: 524/596 (87.92%)** |
| Explicit listing availability | Pass for retained rows; missing rows stay unavailable |
| Exact ticker/rules identity | Pass |
| Exact-provider outcome resolution | Pass: 80/80 |
| Archive inclusion/read-back | Pass |
| Execution-authority isolation | Pass |
| Overall ten-close wiring smoke | **Incomplete because cadence did not hold** |

## Consequence

H2 continues prospectively under the same generation. The 72 missing buckets remain missing and count against
coverage; they must not be reconstructed. The 60-close review remains closed, H3 remains unspecified and off, and
hourly live capability remains withheld. Before the 60-close review, continued collection must show whether cadence
stabilizes after maintenance and concurrent heavy analysis ended, while the analyzer keeps the full planned
denominator visible. No forecast, market membership, policy, persistence, execution, sizing, budget, settlement,
paper, or live behavior changes from this review.
