-- Money Noodle — M4 schema for identity, the two budgets, and persisted control.
--
-- NOTHING IN THIS REPOSITORY APPLIES THIS FILE. It is run by the schema owner,
-- by hand, against the database, exactly as ADR-0013 §2 requires: "Migrations are
-- applied by the schema owner out of band, never by `engine_writer`." No service
-- in this repository holds a role that could execute it, no deploy references it,
-- and no test connects to a database.
--
-- It creates two schemas, and the split is the whole design:
--
--   * `platform` is the platform API's own schema, which `overview.md`'s accepted
--     boundary has always reserved for it. The account, its two budget records and
--     the session rows live here, because sessions need an `UPDATE` that none of
--     the engine's three roles has and widening one to carry this service's state
--     is precisely what ADR-0013 §2 refuses.
--   * `engine` is the engine store (ADR-0013 §2). The control table is append-only
--     and is the whole of the contract between the API and the jobs.
--
-- Roles are created without passwords here. The maintainer sets credentials out of
-- band; no secret value appears in this file, in a plan, or anywhere in the
-- repository (ADR-0005, SECURITY.md).
--
-- Placeholders to replace before running:
--   :account_id    the single account's identifier (ADR-0013 §4: one account)
--
-- Re-running is safe up to the seed rows at the end, which are guarded by
-- `on conflict do nothing`.

begin;

-- ---------------------------------------------------------------------------
-- Roles. Created without login credentials; the maintainer sets those out of band.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'platform_app') then
    create role platform_app login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'engine_writer') then
    create role engine_writer login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'engine_reader') then
    create role engine_reader login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'engine_control_recorder') then
    create role engine_control_recorder login;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The platform API's own schema.
-- ---------------------------------------------------------------------------

create schema if not exists platform;

create table if not exists platform.account (
  id          text primary key,
  created_at  timestamptz not null default now()
);

-- Exactly two budget records per account, both always present. The `check` fixes
-- the vocabulary and the `unique` stops a third from ever existing, so "one
-- account, two budgets" (ADR-0013 §4) is a database invariant rather than an
-- application convention that a later handler could break.
create table if not exists platform.budget (
  id          text primary key,
  account_id  text not null references platform.account (id),
  kind        text not null check (kind in ('paper', 'live')),
  created_at  timestamptz not null default now(),
  unique (account_id, kind)
);

-- Server-side sessions. `revoked_at` is the revocation; there is no delete, so a
-- withdrawn session stays visible to an audit reader (ADR-0013 §4).
create table if not exists platform.session (
  id          text primary key,
  account_id  text not null references platform.account (id),
  created_at  timestamptz not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  check (expires_at > created_at)
);

create index if not exists session_account_active_idx
  on platform.session (account_id, expires_at)
  where revoked_at is null;

grant usage on schema platform to platform_app;
grant select, insert, update on platform.session to platform_app;
grant select on platform.account, platform.budget to platform_app;

-- No `delete` anywhere, and no privilege on the public projection schema: the
-- API's own role cannot reach the tables ADR-0012 admits it to read, and the
-- projection's SELECT-only role cannot reach these.
revoke delete on all tables in schema platform from platform_app;

-- ---------------------------------------------------------------------------
-- The engine store (ADR-0013 §2).
-- ---------------------------------------------------------------------------

create schema if not exists engine;

-- Intent: what somebody asked for. Append-only (ADR-0013 §3).
create table if not exists engine.control_intent (
  id           text primary key default gen_random_uuid()::text,
  capability   text not null,
  action       text not null
                 check (action in ('configure', 'pause', 'resume', 'reset', 'provider-enable')),
  actor        text not null,
  epoch        integer not null check (epoch >= 1),
  recorded_at  timestamptz not null,
  run_id       text not null,
  parameters   jsonb
);

-- "Latest row for a capability, ordered by (epoch, recorded_at, id)" is the
-- staleness rule in ADR-0013 §3. This index is that ordering.
create index if not exists control_intent_latest_idx
  on engine.control_intent (capability, epoch desc, recorded_at desc, id desc);

-- A job records what it did by appending here, never by updating the intent it
-- read (ADR-0013 §3), which is why the recorder role below holds no `update`.
create table if not exists engine.control_outcome (
  id              text primary key default gen_random_uuid()::text,
  intent_id       text not null references engine.control_intent (id),
  applied_run_id  text not null,
  applied_at      timestamptz not null,
  outcome         text not null check (outcome in ('applied', 'refused', 'superseded')),
  reason          text not null
);

create index if not exists control_outcome_intent_idx
  on engine.control_outcome (intent_id, applied_at desc, id desc);

-- One row per capability, maintained by the job that owns it. Seeded with nulls
-- so the signed-in view can honestly show a job that has never run — which in M4
-- is every job, because none of them exists yet.
create table if not exists engine.job_run (
  capability    text primary key,
  last_run_id   text,
  last_run_at   timestamptz,
  last_outcome  text check (last_outcome in ('applied', 'refused', 'superseded'))
);

-- Grants. Each role gets exactly what ADR-0013 §2 gives it and nothing more.

-- `engine_writer`: the restore, cycle and observer jobs.
grant usage on schema engine to engine_writer;
grant select, insert, update on engine.control_intent, engine.control_outcome, engine.job_run
  to engine_writer;

-- `engine_reader`: the API's read path, and the jobs that only consume.
grant usage on schema engine to engine_reader;
grant select on engine.control_intent, engine.control_outcome, engine.job_run to engine_reader;

-- `engine_control_recorder`: `INSERT` on the append-only control tables and
-- nothing else — no `SELECT`, no `UPDATE`, no `DELETE`, nothing on any other
-- table or schema. The API's `returning id` reads back its own insert, which
-- `INSERT` alone permits.
grant usage on schema engine to engine_control_recorder;
grant insert on engine.control_intent, engine.control_outcome to engine_control_recorder;

-- Nobody deletes from an append-only table, including the role that fills it.
revoke delete on all tables in schema engine from engine_writer, engine_reader,
  engine_control_recorder;

-- No role here may create or drop anything. Migrations are the schema owner's
-- (ADR-0013 §2): a job that could migrate its own schema could destroy the
-- restored seed in a bad release.
revoke create on schema engine from engine_writer, engine_reader, engine_control_recorder;
revoke create on schema platform from platform_app;

-- No engine role touches the public projection, and the API's own role does not
-- either: ADR-0012's SELECT-only projection role stays the only way in there.
revoke all on schema public from engine_writer, engine_reader, engine_control_recorder,
  platform_app;

-- ---------------------------------------------------------------------------
-- Seed. The one account, its two budgets, and the job-health rows.
-- ---------------------------------------------------------------------------

insert into platform.account (id) values (:'account_id')
  on conflict (id) do nothing;

insert into platform.budget (id, account_id, kind)
values
  (:'account_id' || ':paper', :'account_id', 'paper'),
  (:'account_id' || ':live',  :'account_id', 'live')
  on conflict (account_id, kind) do nothing;

insert into engine.job_run (capability)
values
  ('budget:paper'),
  ('budget:live')
  on conflict (capability) do nothing;

commit;
