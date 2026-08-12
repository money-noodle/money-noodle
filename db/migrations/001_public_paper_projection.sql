-- Money Noodle: bounded public paper-budget projection.
-- Apply with a worker/admin Postgres role before enabling MONEY_NOODLE_POSTGRES_PAPER_SYNC=true.
-- The Vercel dashboard role needs SELECT only on these two tables.

create table if not exists money_noodle_public_paper_budget (
  singleton boolean primary key default true check (singleton = true),
  starting_cents bigint not null,
  available_cents bigint not null,
  equity_cents bigint not null,
  reserved_cents bigint not null,
  proposed_stake_cents bigint not null,
  running boolean not null,
  depleted boolean not null,
  open_orders integer not null,
  settled_orders integer not null,
  realized_pnl_cents numeric not null,
  bankroll_resets integer not null,
  source_updated_at timestamptz not null
);

create table if not exists money_noodle_public_paper_executions (
  execution_key text primary key,
  symbol text not null,
  venue text not null check (venue in ('polymarket', 'kalshi')),
  side text not null check (side in ('UP', 'DOWN')),
  status text not null,
  created_at timestamptz not null,
  closes_at timestamptz not null,
  ask_price numeric not null,
  quantity numeric not null,
  stake_cents numeric not null,
  fee_cents numeric not null,
  pnl_cents numeric,
  outcome text check (outcome in ('UP', 'DOWN')),
  no_fill_reason text,
  liquidity_role text check (liquidity_role in ('maker', 'taker')),
  source_updated_at timestamptz not null
);

create index if not exists money_noodle_public_paper_executions_created_at_idx
  on money_noodle_public_paper_executions (created_at desc);
