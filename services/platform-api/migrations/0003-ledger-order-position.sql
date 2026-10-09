-- Money Noodle — the execution ledger's legacy record identity (#241, ADR-0013).
--
-- NOTHING IN THIS REPOSITORY APPLIES THIS FILE. The schema owner runs it by hand,
-- out of band, after 0002 and before the first successful execution of the
-- `restore` job (ADR-0013 §2: "Migrations are applied by the schema owner out of
-- band, never by `engine_writer`"). The job connects as `engine_writer`, holds no
-- DDL, and cannot run this.
--
-- Why it exists: 0002 keyed `engine.ledger_order` on `order_id` alone, and the v1
-- ledger cannot be held that way. Its historical pre-episode paper records
-- contain a small, known set of duplicate logical ids, from one dated incident,
-- and v1's own ledger compaction states the rule: array position is part of the
-- legacy record identity, and compaction preserves it exactly rather than
-- silently deduplicating evidence. Order records are append-only evidence. The
-- first real load refused on `ledger_order_pkey` for exactly this reason, and the
-- answer is to key the table the way v1 keys the array, never to merge, drop or
-- upsert a record away.
--
-- `ledger_position` is the 0-based index of the record in the ledger's `orders`
-- array **as stored** — before the paper seam drops the live rows — so it is the
-- same position v1's compaction preserves. A position is an array index, not a
-- sequence this schema assigns: a reload of the same manifest reproduces it.
--
-- 0002 is not edited. An applied migration is history; this file is the change.
--
-- Grants are unchanged: 0002 granted `engine_writer` and `engine_reader` on the
-- table, and adding a column or an index does not alter a table-level grant.
--
-- Re-running is safe. The column add is `if not exists`, the primary key is only
-- replaced when it is not already the composite one, and the index is
-- `if not exists`.

begin;

-- The transient default exists only so `not null` can be added to a table that
-- might already hold rows. In production the table is empty — the first load
-- rolled back — and on a non-empty table every existing row is already unique on
-- `order_id` alone, so backfilling position 0 cannot collide.
alter table engine.ledger_order
  add column if not exists ledger_position integer not null default 0;

alter table engine.ledger_order
  alter column ledger_position drop default;

-- Replace the single-column primary key with the composite one, idempotently and
-- without assuming the old constraint's name.
do $$
declare
  key_name text;
  key_columns text;
begin
  select c.conname,
         (select string_agg(a.attname, ',' order by k.ord)
            from unnest(c.conkey) with ordinality as k(attnum, ord)
            join pg_attribute a
              on a.attrelid = c.conrelid and a.attnum = k.attnum)
    into key_name, key_columns
  from pg_constraint c
  where c.conrelid = 'engine.ledger_order'::regclass
    and c.contype = 'p';

  if key_columns is distinct from 'order_id,ledger_position' then
    if key_name is not null then
      execute format('alter table engine.ledger_order drop constraint %I', key_name);
    end if;
    alter table engine.ledger_order
      add constraint ledger_order_pkey primary key (order_id, ledger_position);
  end if;
end $$;

-- `order_id` is no longer the leading column of a unique index, and looking an
-- order up by its logical id is the ordinary read.
create index if not exists ledger_order_order_id_idx
  on engine.ledger_order (order_id);

commit;

-- Rollback is unchanged and is still "discard the schema contents", run by the
-- schema owner and never by a job: the `truncate` at the end of
-- 0002-engine-restore-tables.sql. Reverting this file itself is only possible
-- while the table is empty, because the single-column key it would restore is
-- precisely the one the v1 ledger violates:
--
--   alter table engine.ledger_order drop constraint ledger_order_pkey;
--   alter table engine.ledger_order add constraint ledger_order_pkey primary key (order_id);
--   drop index if exists engine.ledger_order_order_id_idx;
--   alter table engine.ledger_order drop column ledger_position;
