# Incremental reconciliation activation monitor — 2026-08-23

## Question and method

Did the activated checkpointed reconciliation remain fast and independent during one funded hour, including
periods with real locally active transactions, without weakening fail-closed account agreement?

This was a read-only observation from **2026-08-23T07:21:02Z through 08:21:03Z**. It sampled the local dashboard
every 15 seconds, the authenticated control summary every minute, the durable reconciliation checkpoint, worker
RSS/CPU, control state, and start/end execution ledgers. It made no control mutation and changed no policy,
budget, order, or durable evidence. The raw artifact is
`/tmp/mn-incremental-monitor-20260823T072102Z`.

The monitor emitted 241 timestamped samples. Its TSV formatter also emitted an empty continuation line after
minute control samples, and failed `curl` rows contain both curl's write-out and the fallback fields. Totals below
exclude those empty lines and decode the 11 failed-dashboard rows with the shifted failure layout. That formatting
defect affects convenience parsing, not the HTTP outcomes, timestamps, durable start/end snapshots, checkpoint,
or worker measurements.

## Reconciliation result

Twelve periodic checkpoints completed during the hour. **All 12 were READY, all advanced the durable watermark,
and none recorded a consecutive failure.** Durations were:

`0.608, 0.594, 0.577, 0.444, 0.496, 0.571, 0.598, 3.337, 11.722, 0.562, 0.588, 0.445 seconds`.

The maximum, 11.722 seconds at 08:04Z, overlapped locally active BTC and DOGE transactions. The 3.337-second pass
at 07:59Z overlapped the BNB position lifecycle. Thus this is no longer only an empty-account check: incremental
reconciliation completed while tracked funded transactions existed, current cash/positions/resting orders still
agreed, and reservations returned to zero. It did not observe an uncertain create response or pending recovery,
so that crash/recovery branch remains test-backed rather than production-observed.

Funded control remained active throughout. It started at 2,465¢ available / 0¢ reserved / +465¢ current-epoch
whole-cent P&L and ended at 2,454¢ / 0¢ / +454¢. Six live attempts occurred beside six paper attempts. Three live
orders filled and settled, three finished unfilled, no uncertain state remained, and no reconciliation audit
reported a contradiction or recovered fill.

This closes the original five-minute reconciliation bottleneck: the prior one-hour observation had successful
passes at 57.9–65.2 seconds plus five timeouts; this hour had 12/12 READY with a 0.444-second minimum and
11.722-second maximum under active traffic.

## Availability result and newly isolated stall

Outside one interval, successful dashboard reads were fast: 230 returned HTTP 200, with median 2.8 ms, p95
164.4 ms, p99 495.0 ms, and maximum 1.597 seconds. Fifty-nine authenticated control reads returned 200 with
median 114.8 ms, p95 272.8 ms, and maximum 542.1 ms.

A separate **07:30:25Z–07:33:09Z main-worker stall** remained:

- 11 consecutive dashboard reads timed out at eight seconds;
- two control reads timed out at eight seconds;
- collector success had one 177.868-second gap;
- CPU stayed approximately 97.5–119.1% in sampled points and RSS peaked at 1,154,416 KiB;
- the preceding periodic reconciliation had already completed READY at 07:29:30.812Z in 0.594 seconds, and the
  next did not begin until 07:34:31.874Z.

Source and durable timing identify the automatic walk-forward evaluator as the load-bearing explanation, not
reconciliation. The collector awaits `maybeRunWalkForwardEvaluation` (`lib/background-collector.ts`). At the
1,250-window threshold, that function loads shard history and runs the synchronous CPU evaluation on the same
Node worker (`lib/model-evaluation-store.ts`, `runWalkForwardEvaluation` in `lib/walk-forward.ts`). The new durable
run is stamped `generatedAt: 2026-08-23T07:30:29.063Z`, ends at the 07:30 settlement window, and
`data/model-evaluations.json` was published at approximately 07:33:08Z, matching recovery.
A native profile at the next checkpoint would prove exact stack proportions, but the awaited source path,
threshold identity, sustained CPU, publication time, and absence of overlapping reconciliation make the
attribution strong.

The other nine collector gaps barely over 30 seconds aligned with managed entry/position work and were not
multi-minute stalls. Across the whole hour, RSS was 160,304–1,154,416 KiB (median 750,528; p95 1,016,064) and CPU
was 0.1–155.8% (median 6.6; p95 101.9). These are process samples, not retained-heap measurements.

## Finding and authorization

Incremental reconciliation passed its first active-hour operational gate. Continue monitoring uncertain recovery,
but reconciliation is no longer the observed source of collector starvation.

The automatic evaluator is now the highest operational availability issue. Evaluator v2 is already barred from
promotion, so options for a design decision are: disable its automatic in-process checkpoints and run it offline;
move evaluation to an independently supervised process over a durable snapshot; or implement evaluator v3 with a
bounded incremental/frozen-cohort design. This report authorizes no structural change by itself. It does establish
that leaving the current awaited evaluator in the collector can still make the dashboard, controls, and collection
unavailable for nearly three minutes about every 25 evaluation windows.
