-- #243 stage 3: roots/orders/reservations plus first immutable entry-effect storage.
-- Rai approved authoring and isolated HOSTED tests on 2026-10-11T22:44:52Z.
-- NOT production application, bankroll creation, configuration adoption or activation.
-- Schema owner only; no runtime DDL. No INSERT, seed/default money or principal values.
-- Entry-effect hosted proof, sale/settlement/gate storage and adapters remain unfinished.
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

-- Initial order/reservation slice. No legacy-table index/ALTER, seed or data writes.
-- Legacy pair FK plus restore FK proves existence, NOT matching restore association;
-- the fenced adapter must verify ledger_order.restore_run_id and genuine funding.
-- SQL ASCII/raw-character bounds still require the JS Unicode/UTF16 admission decoder.
create table if not exists engine.paper_order (
  order_key text primary key check (length(order_key) between 1 and 120 and order_key=btrim(order_key,E' \t\n\r\f\013')),
  logical_order_id text not null check (length(logical_order_id) between 1 and 256 and logical_order_id=btrim(logical_order_id,E' \t\n\r\f\013')),
  funding_id text not null,
  epoch integer not null,
  budget_id text not null,
  root_birth_config_intent_id text not null,
  issuance_config_intent_id text references engine.control_intent(id),
  current_effect_config_intent_id text not null references engine.control_intent(id),
  latest_intent_id text not null references engine.control_intent(id),
  source_kind text not null check (source_kind in ('new','restored')),
  origin_run_id text references engine.job_run_record(run_id),
  origin_restore_run_id text references engine.restore_run(run_id),
  legacy_order_id text,
  legacy_ledger_position integer check (legacy_ledger_position >= 0),
  row_kind text not null check (row_kind in ('entry','sale-child')),
  parent_order_key text,
  parent_row_kind text,
  entry_episode_key text check (length(entry_episode_key) between 1 and 120 and entry_episode_key=btrim(entry_episode_key,E' \t\n\r\f\013')),
  entry_attempt integer check (entry_attempt between 1 and 3),
  execution_mode text not null check (execution_mode='paper'),
  symbol text not null check (symbol ~ '^[A-Z0-9-]{1,24}$'),
  contract_id text not null check (length(contract_id) between 1 and 120 and contract_id=btrim(contract_id,E' \t\n\r\f\013')),
  venue text not null check (venue in ('kalshi','polymarket')),
  side text not null check (side in ('UP','DOWN')),
  execution_policy_version text not null check (length(execution_policy_version) between 1 and 120),
  liquidity_role text not null check (liquidity_role in ('maker','taker')),
  status text not null check (status in ('pending_reservation','open','uncertain','unfilled','rejected','won','lost','invalid','sold')),
  issued_at timestamptz not null check (isfinite(issued_at)),
  closes_at timestamptz not null check (isfinite(closes_at) and closes_at>issued_at),
  completed_at timestamptz check (isfinite(completed_at) and completed_at>=issued_at),
  issued_quantity numeric not null check (issued_quantity>0 and issued_quantity<=1000000),
  issued_limit_price numeric not null check (issued_limit_price>0 and issued_limit_price<1),
  issued_reservation_cents bigint not null check (issued_reservation_cents between 0 and 1000000000000),
  issued_fee_cents bigint not null check (issued_fee_cents between 0 and 1000000000000),
  filled_quantity numeric not null check (filled_quantity>=0 and filled_quantity<=issued_quantity),
  remaining_quantity numeric not null check (remaining_quantity>=0 and remaining_quantity<=filled_quantity),
  raw_purchase_cents numeric not null check (raw_purchase_cents>=0 and raw_purchase_cents<=1000000000000),
  raw_fee_cents numeric not null check (raw_fee_cents>=0 and raw_fee_cents<=1000000000000),
  raw_remaining_cost_cents numeric not null check (raw_remaining_cost_cents>=0 and raw_remaining_cost_cents<=raw_purchase_cents+raw_fee_cents),
  retained_stake_cents bigint not null check (retained_stake_cents between 0 and 1000000000000),
  revision bigint not null check (revision>=1),
  last_run_id text not null references engine.job_run_record(run_id),
  recorded_at timestamptz not null check (isfinite(recorded_at)),
  unique (order_key,funding_id,epoch,budget_id),
  unique (order_key,funding_id,epoch,budget_id,row_kind),
  unique (legacy_order_id,legacy_ledger_position),
  unique (funding_id,epoch,budget_id,entry_episode_key,entry_attempt),
  foreign key (funding_id,epoch,budget_id) references engine.paper_budget_root(funding_id,epoch,budget_id),
  foreign key (funding_id,epoch,budget_id,root_birth_config_intent_id) references engine.paper_funding_root(funding_id,epoch,budget_id,birth_config_intent_id),
  foreign key (legacy_order_id,legacy_ledger_position) references engine.ledger_order(order_id,ledger_position),
  foreign key (parent_order_key,funding_id,epoch,budget_id,parent_row_kind) references engine.paper_order(order_key,funding_id,epoch,budget_id,row_kind),
  check ((source_kind='new' and origin_run_id is not null and origin_restore_run_id is null and legacy_order_id is null and legacy_ledger_position is null and issuance_config_intent_id is not null)
    or (source_kind='restored' and origin_run_id is null and origin_restore_run_id is not null and legacy_order_id is not null and legacy_ledger_position is not null)),
  check ((row_kind='entry' and parent_order_key is null and parent_row_kind is null and issued_reservation_cents>0
      and ((entry_episode_key is not null and entry_attempt is not null) or (source_kind='restored' and entry_episode_key is null and entry_attempt is null)))
    or (row_kind='sale-child' and parent_order_key is not null and parent_row_kind is not null and parent_row_kind='entry' and parent_order_key<>order_key and entry_episode_key is null and entry_attempt is null and issued_reservation_cents=0)),
  check (venue='kalshi' and issued_quantity*100=trunc(issued_quantity*100) and filled_quantity*100=trunc(filled_quantity*100) and remaining_quantity*100=trunc(remaining_quantity*100)
    or venue='polymarket' and issued_quantity=trunc(issued_quantity) and filled_quantity=trunc(filled_quantity) and remaining_quantity=trunc(remaining_quantity)),
  check (filled_quantity<>0 or (raw_purchase_cents=0 and raw_fee_cents=0 and raw_remaining_cost_cents=0 and retained_stake_cents=0)),
  check (status not in ('unfilled','rejected') or (filled_quantity=0 and remaining_quantity=0 and completed_at is not null)),
  check (status not in ('won','lost','invalid','sold') or (remaining_quantity=0 and retained_stake_cents=0 and completed_at is not null))
);

-- One retained hold row per ENTRY, including terminal zero holds; not sale proceeds.
-- Returned includes issuance excess + later stake reductions, not realized profit.
-- Cross-row reserved sums/status, immutable issued terms, CAS revisions, exactly-once
-- release/events, current effect config and lease/clock fences require atomic adapters.
create table if not exists engine.paper_reservation (
  order_key text primary key,
  funding_id text not null,
  epoch integer not null,
  budget_id text not null,
  order_row_kind text not null check (order_row_kind='entry'),
  issuance_config_intent_id text references engine.control_intent(id),
  current_effect_config_intent_id text not null references engine.control_intent(id),
  latest_intent_id text not null references engine.control_intent(id),
  original_cents bigint not null check (original_cents between 1 and 1000000000000),
  held_cents bigint not null check (held_cents between 0 and 1000000000000),
  returned_cents bigint not null check (returned_cents between 0 and 1000000000000),
  status text not null check (status in ('held','released')),
  released_at timestamptz check (isfinite(released_at)),
  revision bigint not null check (revision>=1),
  last_run_id text not null references engine.job_run_record(run_id),
  recorded_at timestamptz not null check (isfinite(recorded_at)),
  foreign key (order_key,funding_id,epoch,budget_id,order_row_kind) references engine.paper_order(order_key,funding_id,epoch,budget_id,row_kind),
  foreign key (funding_id,epoch,budget_id) references engine.paper_budget_root(funding_id,epoch,budget_id),
  check (held_cents+returned_cents=original_cents),
  check ((status='held' and held_cents>0 and released_at is null) or (status='released' and held_cents=0 and released_at is not null))
);
revoke all on engine.paper_order,engine.paper_reservation from public,engine_writer,engine_reader,engine_control_recorder;
grant select,insert,update on engine.paper_order,engine.paper_reservation to engine_writer;
grant select on engine.paper_order,engine.paper_reservation to engine_reader;
-- No triggers/parent indexes/ALTER, default economics, seed INSERT or new grants elsewhere.
-- NUMERIC is unscaled: no silent cents/quantity rounding; upper comparisons reject NaN/Infinity.
-- Final filled/inventory lattice is not a constraint on future raw print accumulators.
-- Raw sale proceeds/PnL vs integer credits/events will be separate later storage.


-- First immutable money slice: ENTRY finalization only, not sale/settlement/gates.
-- Revision metadata is expected history, NOT CAS against live rows or a lease fence.
-- Composite identities prove existence; adapter must validate current config/run,
-- complete evidence, matched issuance/venue/contract and atomic budget/order/hold changes.
create table if not exists engine.paper_entry_effect (
  transition_key text primary key check (length(transition_key) between 1 and 120 and transition_key=btrim(transition_key,E' \t\n\r\f\013')),
  order_key text not null references engine.paper_reservation(order_key),
  funding_id text not null,
  epoch integer not null,
  budget_id text not null,
  order_row_kind text not null check (order_row_kind='entry'),
  effect_kind text not null check (effect_kind in ('entry-fill','entry-no-fill')),
  current_effect_config_intent_id text not null references engine.control_intent(id),
  run_id text not null references engine.job_run_record(run_id),
  recorded_at timestamptz not null check (isfinite(recorded_at)),
  order_revision_before bigint not null check (order_revision_before between 1 and 9007199254740990),
  order_revision_after bigint not null check (order_revision_after=order_revision_before+1),
  reservation_revision_before bigint not null check (reservation_revision_before between 1 and 9007199254740990),
  reservation_revision_after bigint not null check (reservation_revision_after=reservation_revision_before+1),
  budget_revision_before bigint not null check (budget_revision_before between 1 and 9007199254740990),
  budget_revision_after bigint not null check (budget_revision_after=budget_revision_before+1),
  result_status text not null check (result_status in ('open','unfilled','rejected')),
  reservation_before_cents bigint not null check (reservation_before_cents between 1 and 1000000000000),
  retained_stake_cents bigint not null check (retained_stake_cents between 0 and 1000000000000),
  released_cents bigint not null check (released_cents between 0 and 1000000000000),
  unique (order_key,order_revision_after),
  unique (order_key,reservation_revision_after),
  unique (funding_id,epoch,budget_id,budget_revision_after),
  unique (transition_key,order_key,funding_id,epoch,budget_id,effect_kind),
  foreign key (order_key,funding_id,epoch,budget_id,order_row_kind) references engine.paper_order(order_key,funding_id,epoch,budget_id,row_kind),
  foreign key (funding_id,epoch,budget_id) references engine.paper_budget_root(funding_id,epoch,budget_id),
  check (retained_stake_cents+released_cents=reservation_before_cents),
  check ((effect_kind='entry-fill' and result_status='open' and retained_stake_cents>0)
    or (effect_kind='entry-no-fill' and result_status in ('unfilled','rejected') and retained_stake_cents=0))
);

-- Final accounting evidence, not every off-lattice maker print/queue accumulator.
-- observed_quantity/raw_purchase_cents preserve unscaled raw evidence separately
-- from finalized_quantity and integer fee/stake/payout/release plans. No raw=rounded CHECK.
create table if not exists engine.paper_entry_fill_event (
  event_key text primary key check (length(event_key) between 1 and 120 and event_key=btrim(event_key,E' \t\n\r\f\013')),
  transition_key text not null unique,
  order_key text not null,
  funding_id text not null,
  epoch integer not null,
  budget_id text not null,
  effect_kind text not null check (effect_kind in ('entry-fill','entry-no-fill')),
  run_id text not null references engine.job_run_record(run_id),
  current_effect_config_intent_id text not null references engine.control_intent(id),
  evidence_version text not null check (length(evidence_version) between 1 and 120),
  venue text not null check (venue in ('kalshi','polymarket')),
  liquidity_role text not null check (liquidity_role in ('maker','taker')),
  evidence_disposition text not null check (evidence_disposition in ('observed','data-unavailable','quote-refused')),
  no_fill_reason text check (no_fill_reason in ('rested_no_fill','ioc_no_fill','data_unavailable','pre_submit_quote_moved')),
  observed_quantity numeric not null check (observed_quantity>=0 and observed_quantity<=1000000),
  finalized_quantity numeric not null check (finalized_quantity>=0 and finalized_quantity<=1000000),
  raw_purchase_cents numeric not null check (raw_purchase_cents>=0 and raw_purchase_cents<=1000000000000),
  fee_cents bigint not null check (fee_cents between 0 and 1000000000000),
  retained_stake_cents bigint not null check (retained_stake_cents between 0 and 1000000000000),
  potential_payout_cents bigint not null check (potential_payout_cents between 0 and 1000000000000),
  released_cents bigint not null check (released_cents between 0 and 1000000000000),
  recorded_at timestamptz not null check (isfinite(recorded_at)),
  foreign key (transition_key,order_key,funding_id,epoch,budget_id,effect_kind) references engine.paper_entry_effect(transition_key,order_key,funding_id,epoch,budget_id,effect_kind),
  foreign key (order_key,funding_id,epoch,budget_id) references engine.paper_order(order_key,funding_id,epoch,budget_id),
  foreign key (funding_id,epoch,budget_id) references engine.paper_budget_root(funding_id,epoch,budget_id),
  check ((venue='kalshi' and finalized_quantity*100=trunc(finalized_quantity*100))
    or (venue='polymarket' and finalized_quantity=trunc(finalized_quantity))),
  check ((effect_kind='entry-fill' and evidence_disposition='observed' and no_fill_reason is null
      and observed_quantity>0 and finalized_quantity>0 and raw_purchase_cents>0 and retained_stake_cents>0)
    or (effect_kind='entry-no-fill' and no_fill_reason is not null and observed_quantity=0 and finalized_quantity=0
      and raw_purchase_cents=0 and fee_cents=0 and retained_stake_cents=0 and potential_payout_cents=0)),
  check ((evidence_disposition='observed' and (no_fill_reason is null or no_fill_reason in ('rested_no_fill','ioc_no_fill')))
    or (evidence_disposition='data-unavailable' and no_fill_reason is not null and no_fill_reason='data_unavailable')
    or (evidence_disposition='quote-refused' and no_fill_reason is not null and no_fill_reason='pre_submit_quote_moved'))
);
revoke all on engine.paper_entry_effect,engine.paper_entry_fill_event from public,engine_writer,engine_reader,engine_control_recorder;
grant select,insert on engine.paper_entry_effect,engine.paper_entry_fill_event to engine_writer;
grant select on engine.paper_entry_effect,engine.paper_entry_fill_event to engine_reader;
-- No owner INSERT/default economics, no new old-table keys/indexes or platform grants.
-- One transition per order+budget revision in this initial single-order protocol.
-- Effect/event completeness, equal run/config/money fields across rows, fee/rounding
-- formulas, payout mapping and same-key/full-payload replay comparison require adapter.
-- A FK cannot require the reciprocal event: transaction must append BOTH or neither.
-- Sale raw net (including negative), integer credits/realized and settlement/gates NEXT.

commit;
