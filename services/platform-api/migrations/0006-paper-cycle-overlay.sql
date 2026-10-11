-- #243 stage 3, FIRST bounded storage slice: empty typed roots only.
-- Rai approved authoring and isolated HOSTED tests on 2026-10-11T22:44:52Z.
-- NOT production application, bankroll creation, configuration adoption or activation.
-- Schema owner only; no runtime DDL. No INSERT, seed/default money or principal values.
-- Orders/reservations/events/regime storage and hosted proof remain subsequent slices.
-- Reapplication is idempotent for this definition, not a schema-drift repair protocol.
begin;

-- Immutable identity of genuinely materialized existing paper funding.
-- Identity bounds use SQL characters/explicit ASCII outer whitespace, not JS UTF16/Unicode trim.
-- Admission decoder must ALSO apply its JS raw-length/trim checks; no identical domain claim.
-- Birth configuration is immutable provenance, NOT current admission configuration.
-- Current configure/resume snapshot and later events must bind actual current config.
-- A run FK establishes existence, NOT paper mode, lease or authority. Birth-config FK
-- establishes existence, NOT configure action/actor/epoch/current latest intent.
-- Adapter MUST validate those facts and matched restored source/run association.
-- Existing schemas provide no UNIQUE(key, restore_run_id); do not invent that FK.
create table if not exists engine.paper_funding_root (
  funding_id text not null check (length(funding_id) between 1 and 120 and funding_id = btrim(funding_id, E' \t\n\r\f\013')),
  epoch integer not null check (epoch >= 1),
  budget_id text not null check (length(budget_id) between 1 and 120 and budget_id = btrim(budget_id, E' \t\n\r\f\013')),
  actor text not null check (length(actor) between 1 and 114 and actor = btrim(actor, E' \t\n\r\f\013')),
  birth_config_intent_id text not null references engine.control_intent(id),
  origin_run_id text references engine.job_run_record(run_id),
  origin_restore_run_id text references engine.restore_run(run_id),
  restored_source_state_key text references engine.ledger_state(key),
  materialized_run_id text not null references engine.job_run_record(run_id),
  recorded_at timestamptz not null check (isfinite(recorded_at)),
  primary key (funding_id, epoch, budget_id),
  unique (funding_id, epoch, budget_id, birth_config_intent_id),
  check (budget_id = actor || ':paper'),
  check ((origin_run_id is not null) <> (origin_restore_run_id is not null)),
  check ((origin_restore_run_id is not null) = (restored_source_state_key is not null))
);

-- Mutable conserved balance, never replenished by schema existence or a cap.
-- Whole-cent budget plane is separate from later raw decimal cost/sale planes.
-- 1e12 is solely a representation/work safety ceiling, NOT selected funding.
-- Actual source correction definition/starting money must be verified by adapter;
-- do not erase corrections or equate integer realized gain with raw actual P&L.
create table if not exists engine.paper_budget_root (
  funding_id text not null,
  epoch integer not null,
  budget_id text not null,
  birth_config_intent_id text not null,
  latest_intent_id text not null references engine.control_intent(id),
  starting_cents bigint not null check (starting_cents between 0 and 1000000000000),
  available_cents bigint not null check (available_cents between 0 and 1000000000000),
  reserved_cents bigint not null check (reserved_cents between 0 and 1000000000000),
  realized_cents bigint not null check (realized_cents between -1000000000000 and 1000000000000),
  correction_cents bigint not null check (correction_cents between -1000000000000 and 1000000000000),
  revision bigint not null check (revision >= 1),
  last_run_id text not null references engine.job_run_record(run_id),
  recorded_at timestamptz not null check (isfinite(recorded_at)),
  primary key (funding_id, epoch, budget_id),
  foreign key (funding_id, epoch, budget_id, birth_config_intent_id)
    references engine.paper_funding_root(funding_id, epoch, budget_id, birth_config_intent_id),
  check (available_cents + reserved_cents = starting_cents + realized_cents + correction_cents)
);

-- Narrow grants on ONLY these new engine tables. Base grants are untouched.
-- Funding identity is append-only for engine roles; mutable balance has no delete.
revoke all on engine.paper_funding_root, engine.paper_budget_root
  from public, engine_writer, engine_reader, engine_control_recorder;
grant select, insert on engine.paper_funding_root to engine_writer;
grant select, insert, update on engine.paper_budget_root to engine_writer;
grant select on engine.paper_funding_root, engine.paper_budget_root to engine_reader;
-- No platform/public-schema grants, schema CREATE, recorder access or TRUNCATE.
-- Revision monotonicity/events, atomic cross-row totals, lease/final-clock fences,
-- control-recorder append serialization and origin association are NOT DDL proof.
commit;
