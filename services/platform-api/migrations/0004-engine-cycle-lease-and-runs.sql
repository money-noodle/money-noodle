-- Money Noodle — the cycle job's lease and its per-run record (#243, ADR-0013).
--
-- NOTHING IN THIS REPOSITORY APPLIES THIS FILE. The schema owner runs it by hand,
-- out of band, after 0003 and before the first execution of the `engine-cycle`
-- job (ADR-0013 §2: "Migrations are applied by the schema owner out of band,
-- never by `engine_writer`"). The job connects as `engine_writer`, holds no DDL,
-- and cannot run this.
--
-- Two tables, both of them properties ADR-0013 asks the store to enforce rather
-- than the job to promise.
--
-- 1. `engine.job_lease` is the lease §1 moved off disk: "v1's lease was a file,
--    which is exactly the kind of state that makes a second runner unsafe and a
--    crash leave a stale lock. The lease is a store row with an owner, an expiry
--    and a fencing token; one authoritative execution owner is then a property
--    the store enforces rather than a convention." One row per capability, so
--    "one owner" is the primary key. The job takes it with a single statement
--    that only takes over an expired row, and the fencing token increments on
--    every acquisition so a run that lost its lease finds its own later writes
--    refused instead of overwriting the new owner's.
--
-- 2. `engine.job_run_record` is idempotency per run id, which §1's table gives
--    the cycle job as its first rule. The run id is the Cloud Run execution
--    name, so the platform's own retry of an execution re-enters a recorded run
--    and writes nothing. The record is opened before the run does anything and
--    closed with what it did, so a crashed run still spends its run id rather
--    than inviting a retry to do the work twice.
--
-- **Deferred, deliberately not created here:** §1's *second* idempotency rule for
-- this job — the per-cycle key `(asset, cycle close time)`, "which is unique in
-- the store", so "a Scheduler retry re-enters an already-recorded cycle and
-- writes nothing". Stage 1 of #243 records no cycle at all; that table belongs to
-- the stage that ports the forecast lane and will arrive with the rows it keys.
--
-- Grants follow 0001 exactly: `engine_writer` writes, `engine_reader` reads, and
-- `engine_control_recorder` gets nothing here — it holds `INSERT` on the two
-- append-only control tables and nothing else, and a lease is not a control fact.
--
-- Re-running is safe: every statement is `if not exists`.

begin;

-- One row per capability. The capability is the primary key, which is what makes
-- "one authoritative execution owner" a constraint rather than an intention.
create table if not exists engine.job_lease (
  capability     text primary key,
  -- The run that holds it. The job passes its own run id, so an abandoned lease
  -- names the execution to go and look at.
  owner          text not null,
  -- Increments on every acquisition, including a takeover of an expired lease.
  -- Every write the job makes names the token it was granted; a write under an
  -- older token is refused by the adapter's `exists (…)` guard.
  fencing_token  bigint not null check (fencing_token >= 1),
  acquired_at    timestamptz not null,
  -- Derived from the run's own tick budget plus grace, so a run cannot hold the
  -- lease for longer than it could possibly need it.
  expires_at     timestamptz not null,
  heartbeat_at   timestamptz not null,
  check (expires_at >= acquired_at)
);

-- Who holds a live lease, for an operator looking at a capability that is not
-- cycling. Not a uniqueness constraint: the primary key is already that.
create index if not exists job_lease_expiry_idx
  on engine.job_lease (expires_at desc);

-- One row per run id, opened at the start and closed at the end.
create table if not exists engine.job_run_record (
  run_id         text primary key,
  capability     text not null,
  -- `dry`, `forecast` or `paper`. Stage 1 implements `dry`; the others are
  -- accepted by the entrypoint and refused at run start, so a premature
  -- configuration change cannot execute an unported lane.
  mode           text not null,
  started_at     timestamptz not null,
  finished_at    timestamptz,
  ticks          integer not null default 0 check (ticks >= 0),
  outcome        text not null check (outcome in ('applied', 'refused', 'superseded')),
  -- A fixed code, never a sentence: `dry-run`, `intent-missing`,
  -- `intent-stale-epoch`, `intent-future`, `intent-paused`, `lease-held`,
  -- `mode-not-implemented`, `run-already-recorded`, or `run-incomplete` while the
  -- run is still open. Documented in docs/operations/engine-cycle.md.
  reason         text not null,
  -- The token the run held while it wrote this row, so an operator can line a
  -- record up against the lease it was made under.
  fencing_token  bigint
);

create index if not exists job_run_record_capability_idx
  on engine.job_run_record (capability, started_at desc);

-- Grants. Exactly the shape 0001 set, widened to the two new tables and nothing
-- else.
grant select, insert, update on engine.job_lease, engine.job_run_record to engine_writer;
grant select on engine.job_lease, engine.job_run_record to engine_reader;

-- Nobody deletes from these: a lease is released by expiring it, and a run
-- record is history.
revoke delete on engine.job_lease, engine.job_run_record
  from engine_writer, engine_reader, engine_control_recorder;

commit;

-- Rollback, run by the schema owner and never by a job. Dropping the lease while
-- a run holds it is safe only when no execution is running, which is why the
-- schedule is created paused:
--
--   truncate engine.job_run_record, engine.job_lease;
--
-- and, to remove the tables entirely:
--
--   drop table if exists engine.job_run_record, engine.job_lease;
