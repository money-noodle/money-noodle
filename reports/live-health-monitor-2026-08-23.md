# Funded live health monitor — 2026-08-23

## Question and method

After incremental reconciliation and offline-only evaluator activation, does a funded hour expose another
imminent availability, account-safety, resource, or durability problem?

Read-only monitoring covered **2026-08-23T19:25:35.552Z–20:25:35.599Z**. It made 240 local dashboard reads at
15-second cadence, 60 authenticated control reads at one-minute cadence, sampled reconciliation checkpoints,
task health, worker RSS/CPU, selected durable file sizes, disk capacity, evaluator identity, logs, and start/end
execution/control snapshots. It changed no control, policy, order, ledger, or evidence. Raw artifacts are under
`/tmp/mn-live-health-monitor-20260823T192535Z`.

Authenticated control reads themselves perform readiness/account work and add one low-frequency signed reader;
that is the main measurement perturbation. One hour is enough to catch twelve periodic reconciliations and several
managed orders, but not enough to establish a resource trend or venue-error frequency. Settlement windows—not
individual attempts—remain the independent economic unit; this report evaluates operations, not policy return.

## Healthy results

- Dashboard: **240/240 HTTP 200**, median 4.6 ms, p95 91.3 ms, p99 322.8 ms, maximum 747.5 ms; no response over
  one second.
- Control: **60/60 HTTP 200**, median 141.0 ms, p95 281.4 ms, maximum 2.984 seconds. The two reads over one second
  occurred while managed-maker transactions were actively serialized; dashboard reads remained 4–5 ms.
- Collector: 226 distinct observed successes; median gap 15.024 seconds, p95 29.382, maximum 44.877; no gap over
  45 seconds and no recurrence of the evaluator/reconciliation multi-minute stalls.
- Sources: all normal except the bounded cancellation incident below. The process stayed on PID 14071; no restart.
- Reconciliation: twelve ordinary periodic checkpoints advanced during the hour. Ordinary passes were generally
  0.644–1.536 seconds; one 7.850-second pass overlapped active managed transactions. Every periodic pass completed
  READY. Reservations peaked at 54¢ during concurrent issuance and ended at zero.
- Resources: RSS 160,544–919,312 KiB (median 496,256; p95 700,864), ending at 482,304 KiB. CPU was bursty with
  median 6.9%, p95 100.1%, and maximum 146.4%. This is process RSS/CPU, not retained heap, but there was no sustained
  rise or >1 GiB event in this hour.
- Evaluator: `data/model-evaluations.json` remained byte-identical at v2 checkpoint 1,275. After the hour, the
  durable walk-forward dataset reached exactly **1,300 windows**. An additional 47 dashboard reads spanning that
  boundary had zero failures, maximum 738 ms, and no evaluator-file write, confirming automatic in-worker replay
  stayed retired.
- Server log delta was empty.

Control remained active. It moved from 2,406¢ available / 0¢ reserved / +406¢ current-epoch whole-cent P&L to
2,382¢ / 0¢ / +382¢. Twenty-seven order rows were added. One live BNB position filled and settled for −24¢; all
other live rows ended unfilled. No account contradiction or retained reservation remained.

## One fail-closed cancellation incident

At 20:12:54Z, live DOGE UP order `01a03041-3558-7fbd-ac16-3531612a03ad` was accepted. Managed cancellation later
returned `not_found`, so the engine correctly treated cancellation as uncertain, retained authority, and
system-suspended at 20:13:13Z. Immediate automatic reconciliation also refused to claim success because it could
not confirm the cancellation. The next periodic incremental pass completed READY at 20:14:25Z; full readiness
checks guarded-auto-resumed, and later settlement/reconciliation left the local row authoritatively unfilled,
zero reserved budget, zero managed positions, and no resting-order contradiction.

This is a successful fail-closed recovery, not an unresolved funded state. It is also the first production
observation in this monitoring sequence of targeted uncertainty recovery. The remaining defect is observability:
`managed-maker` continued reporting the old cancellation error as degraded after authoritative reconciliation was
READY, while the account and reconciliation task were healthy. A later managed-maker success cleared it by
20:33Z, but the stale interval can mislead the operator and should be fixed separately. Repeated venue `not_found`
cancellations would elevate the venue-mechanics issue; one recovered event does not establish a rate.

## Impending maintenance and capacity

1. **Forecast v3's first threshold seal is approaching.** The forecast journal grew from 6,378,107 to 9,170,124
   bytes, +2,792,017 bytes in one hour. The owning threshold is 50 MiB (`JOURNAL_COMPACTION_BYTES` in
   `src/lib/forecast-tracker.ts`). At this one-hour rate it would arrive in roughly **15.5 hours**. The rate can vary,
   but this is the next integrity/availability gate because v3's first automatic seal and independent archive
   restore remain unobserved.
2. **Offline evaluator checkpoint 1,300 is now due.** This is monitoring-only, not a live-readiness blocker. It
   must be run only during a planned pause/drain with the worker stopped or against an isolated snapshot; it must
   not be reattached to the funded process.
3. **Disk is 97% allocated but not immediately exhausted.** Available space fell from 34,070,932 to 34,065,728
   KiB, 5,204 KiB in the hour. Roughly 32.5 GiB remains. The one-hour linear rate is not a reliable exhaustion
   forecast because builds, archives, and seals are bursty, but capacity alerts/housekeeping should precede a
   large build or archive expansion.
4. Other selected journals grew modestly: paper ledger +457,741 bytes, exit sentinels +178,469, portfolio choices
   +150,165, contract paths +98,680, calendar evaluation +87,638, and live skips +38,479. Their existing separate
   bounded-store work remains justified, but none approached an immediate failure boundary in this hour.

## Conclusion

No unresolved funded-account or imminent reconciliation/evaluator failure was found. The next operational watch
is the forecast-v3 50 MiB seal, not reconciliation. Schedule the now-due offline evaluator checkpoint during
planned maintenance, and fix stale managed-maker health after authoritative recovery so status reflects current
account safety. The previously identified strict-value exit issue remains the highest economic-policy priority;
this operational hour does not change or authorize that policy.
