# Offline walk-forward evaluation design

> **Document type:** Evaluation design
> **Design status:** Accepted
> **Implementation:** Complete
> **Created:** 2026-08-23
> **Canonical requirements:** [`spec/forecasting-and-evidence.md`](../spec/forecasting-and-evidence.md), [`spec/storage-and-architecture.md`](../spec/storage-and-architecture.md)
> **Decision record:** [`spec/decision-log.md`](../spec/decision-log.md)
> **Design index:** [`docs/README.md`](README.md)

> **Status: approved direction; implementation design.** Written 2026-08-23 after the activated reconciliation
> monitor isolated a 177.868-second shared-worker stall at evaluator v2's 1,250-window checkpoint. This changes
> evaluation scheduling only. It changes no model, forecast, entry, execution, exit, budget, or promotion rule.

## 1. Finding and decision

`startBackgroundCollector` currently awaits `maybeRunWalkForwardEvaluation` after a checkpoint becomes due.
The store loads terminal forecast shards and `runWalkForwardEvaluation` performs the CPU replay synchronously in
the same Node worker that serves controls and runs collection. At the 1,250-window checkpoint on
2026-08-23T07:30Z, dashboard and control reads timed out and collector success stopped for nearly three minutes.
The preceding incremental reconciliation had already completed READY in 0.594 seconds.

Evaluator v2 (`expanding-window-v2-replay`) is monitoring-only and is mechanically barred from promotion. Its
checkpoint latency therefore has no justified place on a funded runtime's collector path.

**Decision:** remove automatic walk-forward evaluation from the persistent worker. Preserve the durable evaluator,
checkpoint sequence, fingerprints, and atomic store, but run due v2 checkpoints only through an explicit offline
command while funded automation is paused, reservations are zero, and the operator has separately established a
quiescent/stopped worker. Evaluator v3 or a separately supervised evaluator requires its own approved design.

## 2. Boundaries

- `background-collector.ts` must not import, call, await, or launch walk-forward evaluation.
- No timer in the web/funded process replaces the collector call. Fire-and-forget on the same event loop would
  retain the CPU stall and is explicitly forbidden.
- Dashboard and policy reads may continue reading the last atomically published evaluation history. Staleness is
  visible through `currentWindows` and `nextCheckpointWindows`; it is never filled with invented progress.
- The offline command uses the existing `model-evaluation-store` serializer and writes only
  `data/model-evaluations.json` through its atomic temp-and-rename path.
- The command refuses active operator intent/state, any reservation, and missing explicit offline confirmation.
  Those checks are necessary but cannot prove process-local drain state. The operator procedure remains: Pause,
  confirm quiescent/restart-safe, stop the worker or use an isolated durable snapshot, then invoke the command.
- A failed read, replay, or write leaves the previous evaluation file authoritative. Promotion remains impossible
  from evaluator v2 under `model-promotion.ts`.

## 3. Explicit command

`npm run evaluate:walk-forward-offline` loads the current durable dataset, catches up every due 25-window v2
checkpoint exactly once, atomically publishes the history, and prints bounded metadata: policy version, dataset
windows, prior/new run counts, checkpoint range, and next checkpoint. It prints no forecast payload, credentials,
or order data.

Invocation requires:

```bash
MONEY_NOODLE_OFFLINE_EVALUATION=CONFIRM_STOPPED npm run evaluate:walk-forward-offline
```

The command is an operational writer, not an `analyze:*` script. Analysis scripts remain read-only.

## 4. Tests and activation

Tests pin that:

1. the collector source has no model-evaluation dependency or call;
2. offline admission refuses active state, active intent, reservations, and missing typed confirmation;
3. a paused, zero-reservation control with exact confirmation is admitted;
4. the existing walk-forward scorer and promotion refusal tests remain unchanged.

Activation requires typecheck, the full test suite, a production build, quiescent restart, successful full startup
reconciliation, and explicit Resume. The first post-restart collector checkpoint must remain responsive. No manual
v2 run is required during activation because the 1,250-window run already published and the next checkpoint is
1,275.
