-- #243 stage 2: additive cycle provenance. Schema-owner application only.
-- Existing restore tables and migrations 0001-0004 are intentionally untouched.
-- A contract cycle owns many observation identities, NOT just one forecast.
begin;
create table if not exists engine.forecast_cycle (
  asset text not null,
  closes_at timestamptz not null,
  first_run_id text not null references engine.job_run_record(run_id),
  primary key (asset, closes_at)
);
create table if not exists engine.forecast_cycle_row (
  forecast_id text primary key,
  asset text not null,
  closes_at timestamptz not null,
  issued_at timestamptz not null,
  status text not null check (status in ('pending', 'resolved', 'invalid')),
  row jsonb not null,
  origin_run_id text references engine.job_run_record(run_id),
  origin_restore_run_id text references engine.restore_run(run_id),
  last_run_id text not null references engine.job_run_record(run_id),
  revision bigint not null default 1,
  check ((origin_run_id is not null) <> (origin_restore_run_id is not null)),
  foreign key (asset, closes_at) references engine.forecast_cycle(asset, closes_at)
);
-- The immutable event key also covers retries of a resolution pass.
create table if not exists engine.forecast_cycle_event (
  forecast_id text not null references engine.forecast_cycle_row(forecast_id),
  revision bigint not null,
  run_id text not null references engine.job_run_record(run_id),
  recorded_at timestamptz not null,
  fencing_token bigint not null,
  event jsonb not null,
  primary key (forecast_id, revision)
);
create table if not exists engine.forecast_oracle_sample (
  asset text not null,
  observed_at timestamptz not null,
  price double precision not null check (price > 0 and price < 'Infinity'::double precision),
  run_id text not null references engine.job_run_record(run_id),
  primary key (asset, observed_at)
);
create index if not exists forecast_cycle_due_idx on engine.forecast_cycle_row(closes_at) where status = 'pending';
grant select, insert, update on engine.forecast_cycle, engine.forecast_cycle_row,
  engine.forecast_cycle_event, engine.forecast_oracle_sample to engine_writer;
grant select on engine.forecast_cycle, engine.forecast_cycle_row,
  engine.forecast_cycle_event, engine.forecast_oracle_sample to engine_reader;
revoke update on engine.forecast_cycle_event from engine_writer;
revoke delete on engine.forecast_cycle, engine.forecast_cycle_row,
  engine.forecast_cycle_event, engine.forecast_oracle_sample from engine_writer, engine_reader, engine_control_recorder;
revoke all on engine.forecast_cycle, engine.forecast_cycle_row,
  engine.forecast_cycle_event, engine.forecast_oracle_sample from engine_control_recorder;
commit;
