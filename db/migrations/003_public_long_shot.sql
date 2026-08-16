-- Money Noodle: public paper-only projection of the long-shot round-trip policy.
-- Apply with a worker/admin Postgres role before enabling MONEY_NOODLE_POSTGRES_PAPER_SYNC=true.
-- The Vercel dashboard role needs SELECT only on this table.

-- One JSONB document, for the same reason as 002: this is a read-only projection of an already-computed
-- payload rather than a query surface. The hosted dashboard reads the whole row and serves it verbatim,
-- and the worker's order ledger, sentinel store, and contract paths remain authoritative. Normalizing
-- the funnel, the per-generation and per-regime segments, the peak-bid buckets, and the hold comparison
-- would add a migration to every reporting change for no reader benefit.
--
-- The payload carries the PAPER track only. A stateless deployment must never gain execution authority
-- or report live money: the live lane's equity, tickets, and P&L stay on the worker.
create table if not exists money_noodle_public_long_shot (
  singleton boolean primary key default true check (singleton = true),
  payload jsonb not null,
  source_updated_at timestamptz not null
);
