# Exit-sentinel pre-close availability diagnosis — 2026-08-26

> **Finding:** the remaining v2 coverage loss is outcome-selected. A losing owned side commonly reaches a fresh,
> one-sided Kalshi market with a zero executable bid during the final settlement minute. The production lifecycle
> correctly refuses to invent liquidation value, but v2 records that known non-executable state as generic
> `unavailable`. Every position made incomplete by cycle coverage was a loser. Current candidate economics are
> therefore not promotion-grade even when a numerical coverage threshold passes. A separate 190-response public
> 429 burst is real but is not the source of the identified exit gaps.

## Question and fixed boundary

After the approved post-close denominator correction, why did official paper completeness fall back below 90%,
and are the missing cycles unavailable evidence or known non-executable market states?

The fixed read was generated at **2026-08-26T01:10:56.502Z** from:

- 9,240 immutable `exit-policy-sentinel-v2` journal events;
- 150 durable sentinels with zero missing order links and zero invalid active sentinels;
- the hydrated v9 execution ledger;
- the sealed 2026-08-25 forecast shard;
- the local production worker log since its 2026-08-25T16:47Z restart; and
- exact public Kalshi contract responses read on 2026-08-26.

`npm run analyze:exit-sentinel-coverage` now reports the close-relative unavailable-cycle buckets and the economic
outcome split. It remains read-only and has no report, candidate, order, or promotion authority.

The largest caveat is that v2's generic unavailable event does not retain the rejected quote or a source/reason.
The exact no-bid mechanism is proven for representative affected windows and matches the complete timing/outcome
pattern, but old generic events cannot all be safely relabelled without prospective reason evidence.

## 1. Current close-bounded coverage

| Track | Resolved | Complete | Coverage | Pre-close observed | Pre-close unavailable |
| --- | ---: | ---: | ---: | ---: | ---: |
| Live | 78 | 71 | **91.03%** | 2,329 | 57 |
| Paper | 72 | 62 | **86.11%** | 1,897 | 50 |

Aggregate cycle observation remained high: 97.61% live and 97.43% paper. Position-level completeness falls more
quickly because several final misses can move one path below the locked 90% threshold.

### Close-relative concentration

| Seconds before exact close | Live unavailable | Paper unavailable |
| --- | ---: | ---: |
| 0–15 | 26 | 22 |
| >15–30 | 12 | 12 |
| >30–60 | 12 | 12 |
| >60–90 | 2 | 2 |
| >90 | 5 | 2 |
| **At most 90 seconds** | **52 / 57** | **48 / 50** |

The earlier quick count used strict bucket arithmetic and understated live's at-most-90 total as 50; the
reproducible analyzer gives the corrected **52/57**. The concentration is shared across tracks and contracts, not
a paper-only observer failure.

## 2. Generic unavailable conflates two different facts

`maintainExitPolicySentinels` classifies a cycle as observed only when an `ExitSentinelObservation` with the exact
cycle timestamp exists. `exitObservationTerms` refuses a quote when the owned-side bid is `<= 0`, so no lifecycle
observation is appended and maintenance records `unavailable`.

That refusal is correct for execution: a zero bid is not a sale price. It is not, however, the same evidence state
as a missing/stale quote. The system observed that no executable owned-side bid existed; the first-to-fire arm had
no possible sale and should simply retain state.

The sealed forecast shard demonstrates the transition for the losing `SOL UP 20:45Z` path:

| Forecast issue | Kalshi executable asks retained in durable row |
| --- | --- |
| 20:42:11Z | UP 0.006 / DOWN 0.997 |
| 20:43:10Z | UP 0.002 / DOWN 0.999 |
| 20:44:10Z | UP 0.001 only |

Kalshi's binary book makes owned-UP bid the complement of DOWN ask. The final row omits DOWN because its ask had
reached 1.000; `venueEntryOptions` deliberately rejects prices `>= 1`. The corresponding owned-UP bid was zero,
which `exitObservationTerms` correctly rejected. The sentinel then recorded five generic unavailable cycles from
64.432 through 12.211 seconds before close. The same one-sided sequence appears for affected `DOGE UP 19:30Z` and
`SOL UP 19:45Z` paths.

Exact public contract responses also state that the last 60 seconds are collected into the settlement average.
That timing supports the observed final-minute convergence but does not by itself prove when trading ceases; the
load-bearing evidence is the durable one-sided quote plus the code's zero-bid refusal.

## 3. Completeness is selected by economic outcome

| Track | All resolved wins / losses | Complete wins / losses | Incomplete wins / losses |
| --- | ---: | ---: | ---: |
| Live | 27 / 51 | 26 / 45 | **1 / 6** |
| Paper | 22 / 50 | 21 / 41 | **1 / 9** |

Every position made incomplete by cycle coverage was a loss: six live and nine paper. The two incomplete winners
had unrelated explicit causes:

- one live winner was enrolled only after close and has zero eligible cycles;
- one paper winner has 41/41 observed cycles but lacks exact IOC book evidence at the trailing arm's trigger.

This does **not** show that an exit candidate would have saved those losses. At zero bid it could not sell. It shows
that the complete cohort preferentially excludes positions whose owned side converged to zero, so candidate cash,
means, and significance computed only over complete paths are biased upward. All `reviewUnlocked` flags were
already false; they must remain so regardless of whether the raw window count reaches 60.

## 4. Public Kalshi 429 burst is separate

The production log contains **190** `Kalshi read rate limit hit` messages. All name exact `/markets/<ticker>` paths
for the seven contracts closing at 2026-08-25T20:15Z:

- 36 each for HYPE and BNB;
- 29 DOGE;
- 28 ETH;
- 21 BTC;
- 20 each XRP and SOL.

This contradicts the prior operational assumption that public traffic was comfortably below the effective limit.
The shared public backoff is process-global, so one-second dense long-shot quote watching can interfere with other
public evidence readers even though calls use per-ticker cache keys.

The durable evidence does **not** authorize blaming this burst for current exit incompleteness:

- no active exit-v2 position in the incomplete list closed at 20:15Z;
- F2 currently reports 114/114 acceptance and grace records available;
- the log lacks caller and event timestamp, so dense-watch attribution remains a source-based hypothesis; and
- long-shot live arming is false, so this incident did not expose funded long-shot execution.

It does establish a reliability gap: public 429 events need durable caller/time/cadence attribution and aggregate
reporting before the traffic reference can again call the public reader solid.

## 5. Options

### A. Keep v2 unchanged and wait

This preserves the cohort but does not remove outcome selection. More positions can move numerical coverage in
either direction depending on how often their owned side reaches zero. V2 remains diagnostic only.

### B. Retrospectively count generic unavailable cycles as observed

Rejected. Old events do not prove whether their cause was zero bid, stale data, a missing prediction, worker
failure, or throttle backoff. Relabelling them after outcomes would erase genuine gaps and select efficacy evidence.

### C. Design a prospective v3 reasoned cycle — evaluation option

A new generation could distinguish at decision time:

- `observed_executable`: fresh exact contract, valid owned bid/ask, normal candidate reduction;
- `observed_non_executable`: fresh exact contract proves no valid owned-side sale price; candidate state cannot
  trigger or advance, but the cycle is available for path coverage;
- `unavailable`: no fresh exact evidence, malformed/crossed terms, throttle refusal, source failure, or missing
  contract identity.

The event would retain a bounded reason and exact provider/contract identity. It must not coerce a zero bid into
liquidation arithmetic, carry a stale value, or invent paper depth. Starting v3 avoids retrospective relabelling;
v2 stays immutable and separate. Tests would pin zero-bid, one-sided, crossed, stale, exact-close, throttle, and
paper-trigger-book cases plus source isolation from production policy.

The 429 issue should be designed separately: first add bounded caller/time attribution and recalculate actual
request bursts; only then consider scheduling/coalescing. It must not weaken one-second paper observation semantics
or give an evaluation store authority over execution.

## Decision boundary

The diagnosis supports a new prospective evidence-state design, not an exit-policy change and not a v2 accounting
amendment. Production `strict-value-v1`, all four candidates, buy/execution rules, capital, and funded automation
remain unchanged. The next action requires maintainer agreement on whether to write the v3 cycle design; no v3
implementation or traffic scheduler has been started. Nothing here is financial advice.
