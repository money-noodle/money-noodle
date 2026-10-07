-- Money Noodle — M4 restore target tables in the `engine` schema (#241, ADR-0013).
--
-- NOTHING IN THIS REPOSITORY APPLIES THIS FILE. The schema owner runs it by hand,
-- out of band, after 0001 and before the first execution of the `restore` job
-- (ADR-0013 §2: "Migrations are applied by the schema owner out of band, never by
-- `engine_writer`"). The job connects as `engine_writer`, holds no DDL, and refuses
-- to load when any table below already has rows or `engine.restore_run` records a
-- prior run for the same manifest digest and schema version.
--
-- It lives beside 0001 because the `engine` schema has one owner and one ordered
-- migration history; the jobs family writes these tables but does not own the
-- schema (overview.md: "migrations of the schema it writes" is outside the family).
--
-- Every table is a row-per-record projection of one v1 store, transformed at the
-- paper seam (maintainer decision 2026-10-06): paper rows only, mirror-pair ids as
-- inert text with no foreign key, live-side state absent. Sealed forecast shards
-- and evidence batches are rows here, per ADR-0013 §2. `restore_run_id` on every
-- row is what makes "discard the schema contents" a precise rollback.
--
-- Re-running is safe: every statement is `if not exists`.

begin;

create table if not exists engine.restore_run (
  run_id           text primary key,
  manifest_digest  text not null,
  manifest_key     text not null,
  schema_version   text not null,
  started_at       timestamptz not null,
  completed_at     timestamptz,
  unique (manifest_digest, schema_version)
);

-- 1. The execution ledger, paper rows only. `mirror_pair_id` is inert metadata:
--    the live half of the pair is never loaded, so there is nothing to join to.
create table if not exists engine.ledger_order (
  order_id          text primary key,
  execution_mode    text not null check (execution_mode = 'paper'),
  status            text not null,
  strategy_id       text,
  stake_cents       bigint not null,
  pnl_cents         bigint,
  paper_bankroll_id text,
  mirror_pair_id    text,
  evidence_sha256   text,
  evidence_row_key  text,
  row               jsonb not null,
  restore_run_id    text not null references engine.restore_run (run_id)
);

create table if not exists engine.ledger_state (
  key             text primary key,
  value           jsonb,
  restore_run_id  text not null references engine.restore_run (run_id)
);

-- 2. Evidence batches as rows, paper rows only.
create table if not exists engine.evidence_row (
  batch_sha256    text not null,
  row_key         text not null,
  order_id        text not null,
  evidence        jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id),
  primary key (batch_sha256, row_key)
);

-- 3. Trading control, paper fields only.
create table if not exists engine.trading_control (
  key             text primary key,
  value           jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id)
);

-- 4. Provider registry, `liveEnabled` dropped.
create table if not exists engine.provider_registry (
  provider_id     text primary key,
  record          jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id)
);

-- 4b. Provider budget configuration (v1 store `provider-budgets.json`), paper
--     ceilings only: the live ceiling is live-side and dropped at the seam.
create table if not exists engine.provider_budget (
  provider_id               text primary key,
  paper_limit_cents         bigint not null,
  allocations               jsonb not null,
  updated_at                text,
  configuration_revision    bigint,
  configuration_updated_at  text,
  restore_run_id            text not null references engine.restore_run (run_id)
);

-- 5. Forecast journal, the suffix the last sealed generation had not incorporated.
create table if not exists engine.forecast_journal_event (
  sequence        bigint primary key,
  event           jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id)
);

-- 6. Sealed forecast shards and their rows.
create table if not exists engine.forecast_shard (
  shard_id        text primary key,
  rows_sha256     text not null,
  rollup_sha256   text not null,
  ids_sha256      text,
  row_count       integer not null,
  rollup          jsonb,
  restore_run_id  text not null references engine.restore_run (run_id)
);

create table if not exists engine.forecast_row (
  forecast_id     text primary key,
  shard_id        text references engine.forecast_shard (shard_id),
  status          text not null,
  row             jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id)
);

create index if not exists forecast_row_shard_idx on engine.forecast_row (shard_id);

-- 7. Contract provenance.
create table if not exists engine.contract_provenance (
  registry_id     text primary key,
  record          jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id)
);

-- 8. Model promotions, the immutable manual ledger.
create table if not exists engine.model_promotion (
  sequence        bigint primary key,
  record          jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id)
);

-- Research journals and snapshots: unrecoverable if lost, no money.
create table if not exists engine.research_journal_event (
  store           text not null,
  sequence        bigint not null,
  event           jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id),
  primary key (store, sequence)
);

create table if not exists engine.research_snapshot (
  store           text primary key,
  snapshot        jsonb not null,
  restore_run_id  text not null references engine.restore_run (run_id)
);

-- Grants. Exactly what ADR-0013 §2 gives each role; nothing is widened.
grant select, insert, update on
  engine.restore_run,
  engine.ledger_order,
  engine.ledger_state,
  engine.evidence_row,
  engine.trading_control,
  engine.provider_registry,
  engine.provider_budget,
  engine.forecast_journal_event,
  engine.forecast_shard,
  engine.forecast_row,
  engine.contract_provenance,
  engine.model_promotion,
  engine.research_journal_event,
  engine.research_snapshot
  to engine_writer;

grant select on
  engine.restore_run,
  engine.ledger_order,
  engine.ledger_state,
  engine.trading_control,
  engine.provider_registry,
  engine.provider_budget,
  engine.forecast_shard,
  engine.forecast_row,
  engine.model_promotion
  to engine_reader;

revoke delete on all tables in schema engine from engine_writer, engine_reader,
  engine_control_recorder;
revoke create on schema engine from engine_writer, engine_reader, engine_control_recorder;

commit;

-- Rollback of a restore is to discard the schema contents, run by the schema
-- owner, never by a job (docs/operations/restoring-the-v1-archive.md):
--
--   truncate engine.research_snapshot, engine.research_journal_event,
--     engine.model_promotion, engine.contract_provenance, engine.forecast_row,
--     engine.forecast_shard, engine.forecast_journal_event, engine.provider_budget,
--     engine.provider_registry, engine.trading_control, engine.evidence_row, engine.ledger_state,
--     engine.ledger_order, engine.restore_run;
