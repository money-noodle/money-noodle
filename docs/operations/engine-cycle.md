# Running the engine cycle

> **Status:** Operational runbook for the `engine-cycle` job of [`services/engine-jobs`](../../services/engine-jobs/README.md). Stage 1 of [#243](https://github.com/money-noodle/money-noodle/issues/243): the skeleton. Working [ADR-0013](../architecture/decisions/ADR-0013-m4-engine-boundary.md) §1, §3 and §5 are the authority; this file is how the thing is brought up and read.

The cycle job is the engine's cadence. It is not a resident worker: Cloud Scheduler starts one short Cloud Run Job execution a minute, each execution ticks a few times and exits, and "is the engine running?" is answered by rows in the engine store rather than by a process somebody has to find. ADR-0013 §5 refuses a resident worker in any deployment, and this is how a 15-second cadence survives that refusal.

**Stage 1 performs no cycle.** It takes the lease, evaluates the persisted intent, records the run, ticks, writes one outcome row and exits. There is no feed call, no market read, no forecast and no paper execution: those are stages 2 and 3, and they land inside the tick body this file describes. The frame is deliberately first, because a cadence that can run twice, or run while paused, is not made safe by what it does inside a tick.

## What one run does

1. **Takes the lease.** One row per capability in `engine.job_lease`, taken by a single statement that only takes over a row that has already expired. Two executions racing cannot both get past this line. The lease carries an owner (the run id), an expiry derived from the run's own tick budget, and a **fencing token** that increments on every acquisition. ADR-0013 §1: "v1's lease was a file, which is exactly the kind of state that makes a second runner unsafe and a crash leave a stale lock."
2. **Checks the run id.** The run id is the Cloud Run execution name, so the platform's own retry of an execution re-enters a run that is already recorded and writes nothing.
3. **Opens its record** in `engine.job_run_record`, before anything can fail, so a crashed run still spends its run id rather than inviting a retry to do the work twice.
4. **Evaluates intent** against `engine.control_intent` (below). Paused, missing or stale ends the run here.
5. **Refuses a lane it cannot run.** `--mode forecast` and `--mode paper` are accepted by the entrypoint and refused at run start, so changing the committed arguments before the lane is ported changes what is refused rather than what runs.
6. **Ticks.** `--ticks 4` by default: four ticks at 15-second spacing, which is one scheduled minute at v1's cadence. Each tick pushes the lease's heartbeat forward. In stage 1 that is the whole tick body.
7. **Writes exactly one outcome row** against the intent it evaluated, updates its job-health row, closes its run record and releases the lease.

Every write after step 1 carries the fencing token the run was granted, and the store refuses a write whose token is no longer the current one. A run that lost its lease to an expiry — a long pause, a stalled network — finds its own late writes refused instead of overwriting the new owner's.

**A refusal is the job working.** Every refusal path closes the record, updates job health, releases the lease and exits **0**. Exit 1 is an unexpected error; exit 2 is an input the entrypoint will not accept. Anything else would make the platform retry a correct refusal.

## The intent rule

The job may run only when the persisted control table says so. The rule, exactly as implemented in `services/engine-jobs/src/domain/intent.ts`:

The job reads every `engine.control_intent` row for the capability **`budget:paper`** — the capability the API already records paper budget controls under; there is no new capability — and takes the **latest** row by ADR-0013 §3's ordering `(epoch, recorded_at, id)`, where the epoch outranks the time and the id is the final tiebreak so the ordering is total. That row must satisfy all three of §3's conditions: it must be the latest row (structurally true of the row just selected), its `epoch` must equal the epoch this job is configured with, and its `recorded_at` must not be more than **five minutes** in the future. The run then proceeds only if that row's action is **`resume` or `configure`**; a `pause`, a `reset`, or any other action — including `provider-enable`, and including an action nobody has taught this job about — leaves the engine paused. Missing and stale are treated identically to paused, which is ADR-0013 §3's own instruction, and the epoch is checked before the clock so a row from another epoch is stale whatever time it carries. Nothing else is consulted: not a flag, not a file, not the previous run.

## Reason codes

A run records a fixed code, never a sentence, so two runs in the same situation are comparable. The closed set:

| Reason | Outcome | What happened |
| --- | --- | --- |
| `dry-run` | `applied` | The run executed. Stage 1's only success: bookkeeping ticks and no effect. |
| `intent-missing` | `refused` | No intent row exists for the capability at all. |
| `intent-stale-epoch` | `refused` | The latest row carries an epoch that is not the one this job is configured with. |
| `intent-future` | `refused` | The latest row was recorded further ahead than the allowed five minutes. |
| `intent-paused` | `refused` | The latest row is a `pause`, a `reset`, or another non-running action. |
| `lease-held` | `refused` | Another owner holds a live lease on this capability. |
| `mode-not-implemented` | `refused` | A lane stage 2 or 3 implements was requested. Nothing ran. |
| `run-already-recorded` | `refused` | This run id already has a record: the execution is a retry of a recorded run. |

`run-incomplete` also appears in `engine.job_run_record`, but it is not a run outcome: it is the placeholder an open record carries between step 3 and step 7, so a record that still says `run-incomplete` is a run that never finished.

Two refusals write less than the others, for reasons worth knowing:

- **`lease-held`** writes nothing at all. Every write is fenced by a token this run does not hold, so a run that lost the race has nothing it may legitimately say in the store — the owner holding the lease is the one writing. The refusal is in the execution log only.
- **`intent-missing`** and **`run-already-recorded`** append no `engine.control_outcome` row. `control_outcome.intent_id` is a foreign key, and in the first case there is no intent row to reference; in the second the run that did the work already wrote its own. Both are visible in `engine.job_run_record`, and `intent-missing` also lands on the job-health row.

## Where the state lives

| Table | Migration | What it carries |
| --- | --- | --- |
| `engine.control_intent` | 0001 | What somebody asked for. Append-only; the job only reads it. |
| `engine.control_outcome` | 0001 | What the job did about one intent row. One row per run that evaluated an intent. |
| `engine.job_run` | 0001 | One row per capability for the signed-in job-health view. The cycle job's row is keyed **`engine-cycle`**, not `budget:paper`: the table is keyed by capability and the view lists every row, so the job gets its own key rather than overwriting the paper budget's. |
| `engine.job_lease` | **0004** | One row per capability: owner, fencing token, expiry, heartbeat. |
| `engine.job_run_record` | **0004** | One row per run id: mode, ticks, outcome, reason, the token it held. |

ADR-0013 §1 gives this job a second idempotency rule — the per-cycle key `(asset, cycle close time)` — and that table is **deliberately not created yet**. Stage 1 records no cycle; the table arrives with the rows it keys. `0004`'s header says so.

## Bringing it up

In this order. Nothing in this repository performs any of it, and the schedule is created paused so no step is racing a cadence.

1. **Bootstrap apply**, with maintainer credentials. Two identities: `engine-cycle-runtime`, which the execution runs as, and `engine-cycle-scheduler`, which starts it. They are separate principals on purpose — a runtime identity holds `roles/run.invoker` nowhere, so a workload cannot start a workload — and the trigger identity holds **no project role at all**.
2. **Platform apply.** The `engine-cycle-writer-database-url` container, declared empty, with its accessor grant to `engine-cycle-runtime` alone. A separate container from the restore's, so retiring the one-time job retires its credential without touching the cadence's.
3. **Enter the secret version** out of band, as `engine_writer`. No value passes through this repository, a plan, or state ([`ADR-0005`](../architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md)).
4. **Apply migration 0004** as the schema owner. Required before the first execution: without `engine.job_lease` the job cannot take a lease and fails its first statement.
5. **Dispatched `engine-jobs` apply** at the published digest. The schedule is created **paused**, so this installs a cadence that fires nothing.
6. **Record a `resume`** for `budget:paper` through the API's control endpoint, if the engine is meant to run. Until then every execution refuses with `intent-paused` or `intent-missing`, which is the correct answer.
7. **Start one execution by hand** and read its JSON summary and its rows. Only then un-pause.

Un-pausing is a one-line change to `infra/stacks/engine-jobs/cycle.tfvars` with its own pull request:

```hcl
cycle_schedule_paused = false
```

so "the engine started cycling" is a reviewed event with a diff rather than a console click. The same file carries `cycle_secret_binding_enabled`, which turns on the secret reference once step 3 is done, and `cycle_arguments`, which says which lane runs.

## Raising the control epoch

The epoch invalidates standing intent. ADR-0013 §3: "The control epoch increments on any event that invalidates prior intent — a restore or reseed, a budget reset, a schema migration — so a resume recorded before a reseed cannot silently authorise the engine after it."

It is configuration on both sides, never a stored counter, because a service that could increment it could silently invalidate the operator's wish:

- the API records new intent under `PLATFORM_API_ENGINE_CONTROL_EPOCH`;
- this job evaluates intent against `ENGINE_CYCLE_CONTROL_EPOCH`, set from `cycle_control_epoch` in the engine-jobs stack.

**Raise both, in the same change, with the event that caused it.** An epoch the two disagree on is an operator whose `resume` the engine ignores: the API records epoch *n+1* and the job still only accepts *n*, or the reverse, and every run refuses with `intent-stale-epoch`. That refusal is the designed failure mode — it is what stops a pre-reseed resume authorising a post-reseed engine — but it is not a state to leave the platform in by accident. After raising it, record a fresh `resume`.

## Reading a run

The execution log carries one JSON line: `outcome`, `reason`, `runId`, `capability`, `mode`, `ticksCompleted`, `fencingToken` and the `intentId` it evaluated. Counts and codes only; no connection string, no row content, no account identifier ([`SECURITY.md`](../../SECURITY.md)).

Then, as a reader of the engine store:

- `engine.job_run_record` ordered by `started_at` is every run and what it decided.
- `engine.control_outcome` joined to `engine.control_intent` is what the job did about each thing somebody asked for.
- `engine.job_lease` for `budget:paper` shows the current owner and whether its lease is still live. A row whose `expires_at` is in the past with no newer run is a crashed execution, and the next run takes it over and increments the token — no administrative repair step exists or is needed.

## What this job does not do

- It performs **no** external effect in stage 1: no feed call, no market read, no forecast, no paper execution, no projection write.
- It holds **no venue credential and no live execution path**, and the repository check in `services/engine-jobs/src/cycle.test.ts` fails the build if a module under `src/cycle` or `src/domain` imports a signed venue client, a live wire module or a reconciliation path. ADR-0013 §5 refuses all three, and stages 2 and 3 inherit the check.
- It does **not** migrate its own schema. `0004` is the schema owner's, like every other migration (ADR-0013 §2).
- It does **not** increment the control epoch, and could not: the epoch is configuration it reads.
- It does **not** write the public projection. That is [#244](https://github.com/money-noodle/money-noodle/issues/244)'s job, under its own identity.

## What stage 2 onwards adds

- **Stage 2** ports the forecast lane into the tick body, with the per-cycle `(asset, cycle close time)` key as its own migration, and turns `--mode forecast` from a refusal into a lane.
- **Stage 3** ports the paper engine the same way, for `--mode paper`.
- **Stage 4** is the staged bring-up evidence: dated validation records for a cadence that has actually run.

Stages 2 and 3 need the private v1 source and are not guessed at here.
