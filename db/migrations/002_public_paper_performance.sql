-- Money Noodle: public paper-only track-record projection.
-- Apply with a worker/admin Postgres role before enabling MONEY_NOODLE_POSTGRES_PAPER_SYNC=true.
-- The Vercel dashboard role needs SELECT only on this table.

-- Stored as one JSONB document rather than normalized tables. This is a read-only projection of an
-- already-computed payload, never a query surface: the hosted dashboard reads the whole row and serves
-- it verbatim, and the worker's JSON ledger plus forecast log remain authoritative. Normalizing
-- calibration bins, benchmarks, segments, lead-time slices, timelines, walk-forward runs, and 500
-- forecast rows would add a schema migration to every scoring change for no reader benefit.
create table if not exists money_noodle_public_paper_performance (
  singleton boolean primary key default true check (singleton = true),
  -- A PublicPaperPerformance payload with durable/generatedAt stripped; both are set on read.
  payload jsonb not null,
  source_updated_at timestamptz not null
);
