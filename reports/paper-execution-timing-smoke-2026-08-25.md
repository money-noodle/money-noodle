# Paper execution timing shadow smoke — 2026-08-25

> **Finding:** F2 is durably collecting complete, event-time-bounded evidence, but two independent settlement
> windows are only an operational smoke sample. It contains no accepted live maker with which to validate the
> acceptance candidate. No paper fill, bankroll, live policy, or promotion changes.
>
> **Attribution correction:** the unmatched venue positions observed during this watch were created outside Money
> Noodle and were acceptable operator activity. Temporal overlap did not make them outcomes of Money Noodle's
> `market_not_found` attempts. The original monitoring interpretation incorrectly joined those events causally.

## Question and method

The review monitored `paper-execution-timing-shadow-v1` from its first durable decision at
**2026-08-25T06:47:41.724Z** through **2026-08-25T07:32:29Z**. The active watch stopped before its two-hour maximum
after two independent UTC settlement windows had complete decision, acceptance, and grace records, no unavailable
row, no timing-shadow runtime error, and the second fail-closed live reconciliation episode had returned READY.

`npm run analyze:paper-execution-timing` reloaded the detached journal and execution ledger. Expected coverage is
anchored on the first recorded paper order's creation time—not the later shadow append—so the activation row stays
in the denominator. Live acceptance is joined only afterward by exact prospective mirror-pair identity. Missing,
pending, and ambiguous live pairs remain separate.

The caveat that most threatens interpretation is sample and target absence: **seven paper makers in two correlated
settlement windows, with zero accepted exact live maker targets**. Five paper rows had no live counterpart while
funded execution was suspended. The two known live targets were both provider create failures followed by
reconciled absence, not post-only acknowledgement races. This verifies wiring, not candidate accuracy.

## 1. Evidence completeness passed the bounded smoke

| Measure | Result |
| --- | ---: |
| Timing records | 7 |
| Expected exact paper makers | 7 |
| Missing decisions | 0 |
| Independent UTC close windows | 2 |
| Acceptance evidence | 7/7 |
| Final-grace evidence | 7/7 |
| Unavailable rows | 0 |
| Timing-shadow runtime errors | 0 |
| Event-time replay differences from production | 0 |

All seven decisions retained the frozen 400ms create delay, 250ms acknowledgement delay, three-second final grace,
exact provider contract, side, close, mirror identity, quantity, issuance cap, and paper execution generation.
Every grace replay admitted only bounded public prints whose venue timestamps lay inside the original 12-second
horizon. No replay added or removed a fill in this sample.

## 2. Timing remained bounded but scheduling was not exact

| Timing measure | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Create public-read latency | 68ms | 69ms | 105ms |
| Acknowledgement public-read latency | 71ms | 73ms | 153ms |
| Create request lateness beyond 400ms | 2ms | 43ms | 101ms |
| Acknowledgement request lateness beyond 250ms | 2ms | 198ms | 243ms |
| Final-grace request lateness beyond 3s | 71ms | 192ms | 226ms |

The candidate records actual request and observation timestamps, so these delays are measured rather than treated as
the nominal constants. The acknowledgement maximum means the effective observed gap sometimes approached 493ms;
that remains valid candidate evidence but must be reported when comparing it with live acknowledgement behavior.
There was no optional-request error or evidence that a timing observer changed a paper result in these two windows.

## 3. Acceptance target is not mature

Exact-pair state at the review:

- two known live non-acceptances;
- five missing live counterparts;
- zero pending or ambiguous pairs after reconciliation;
- zero accepted live maker targets.

Both known live attempts returned `market_not_found · market not found` after their exact create quote, entered the
uncertain/reserved fail-closed path, and later reconciled to no accepted durable client order or fill. The public
400ms/250ms candidate classified both books as passively acceptable. That is not evidence that its race model is
wrong: a public bid/ask model is not intended to predict a provider `market_not_found` response. The analyzer now
retains this non-acceptance provenance rather than pooling it silently with a post-only race.

Consequently, accepted recall is undefined and the 10-window wiring milestone remains closed. The first useful
acceptance claim requires actual accepted and post-only-race targets; counts alone do not supply them.

## 4. Funded safety behavior during the watch

Two distinct event families overlapped and must not be joined causally:

1. Money Noodle's exact BNB and SOL live create attempts returned `market_not_found`, entered the ordinary
   uncertain/reserved fail-closed path, and later reconciled to no accepted durable client order or fill.
2. Reconciliation observed BNB and SOL venue positions absent from Money Noodle's local ledger. The operator has
   identified these as acceptable orders created outside Money Noodle—not hidden outcomes of the two local create
   attempts.

Because reconciliation is account-wide and does not own those external causal records, it suspended until the
external position mismatches disappeared: READY at 2026-08-25T07:00:30Z for BNB and at
2026-08-25T07:30:30Z for SOL, followed by guarded auto-resume. That is expected fail-closed behavior under the
current ownership model, not evidence of a Money Noodle accounting contradiction.

The final local attempt rows are rejected with no accepted venue ID or authoritative fill, reservations returned to
zero, and control revision 6,611 was active with 2,094¢ available. The timing observer logged no runtime error. Its
public requests may share the venue token pool, but the local outcomes were explicit provider `market_not_found`
responses rather than 429s, timeouts, or ambiguous transport errors; this sample does not establish F2 as their
cause. External venue activity is outside this F2 acceptance cohort unless separately captured with authoritative
causal identity.

## Decision

Continue F2 unchanged to the predeclared 10-window wiring review. Do not promote an acceptance delay, final grace,
or queue adjustment from two windows. Keep `market_not_found`, reconciled absence, post-only race, accepted maker,
and missing-live rows separate. Nothing here is financial advice.
