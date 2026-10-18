// The transaction-local authority read, in ONE place so every adapter that needs it
// runs the SAME verified statements rather than a second copy. SELECT only.
//
// `engine_writer` already holds select on every table read here: 0001 grants select on
// `engine.control_intent`, 0006 grants select on `engine.paper_funding_root` and
// `engine.paper_budget_root`. No new grant is required and none is added.
//
// Every derived fact is computed by PostgreSQL. Ordering and the reset barrier are row
// comparisons over `(epoch, recorded_at, id)` — the ordering ADR-0013 §3 names and
// `control_intent_latest_idx` indexes. Clock validity is compared against
// `clock_timestamp()` using the existing approved `MAX_INTENT_CLOCK_SKEW_MS`; no
// freshness tolerance is invented. The conservation identity is recomputed in exact
// arbitrary-precision `numeric`. Timestamps cross as exact signed epoch-microsecond
// TEXT and whole cents as TEXT, so nothing is truncated to millisecond `Date`
// precision and no money value becomes a JS float.

import type postgres from 'postgres';

import { MAX_INTENT_CLOCK_SKEW_MS } from '../../domain/intent.js';
import type { PaperAuthorityRawReads } from '../../domain/paper-authority-evidence.js';

type Transaction = postgres.TransactionSql;

/** Exact signed epoch microseconds as TEXT, extracted before any driver Date.
 * `control_intent.recorded_at` carries no `isfinite` check, so a non-finite timestamp
 * is reported as NULL rather than allowed to raise on the numeric cast. */
export const MICRO = (column: string): string =>
  `case when isfinite(${column}) then (extract(epoch from ${column})*1000000)::numeric(30,0)::text else null end`;

/** `(epoch, recorded_at, id)` as a PostgreSQL row, compared lexicographically by the
 * server. */
const ORDER_KEY = (alias: string): string =>
  `row(${alias}.epoch, ${alias}.recorded_at, ${alias}.id)`;

/** `epoch_text`, never `epoch`: an output column named `epoch` SHADOWS the table column
 * in `order by epoch desc`, which would order the authoritative epoch as TEXT and put
 * epoch 9 above epoch 10. The alias keeps the ordering on the integer column. */
const INTENT_COLUMNS = `id,capability,action,actor,epoch::text as epoch_text,${MICRO('recorded_at')} as recorded_at_us,(isfinite(recorded_at) and recorded_at - clock_timestamp() <= $2::interval) as time_valid,parameters`;

export const AUTHORITY_SQL = {
  /** The standing intent: GLOBAL latest for the capability, NOT filtered to the
   * requested epoch, newest first under the authoritative ordering. A malformed newest
   * row is returned as the newest row. `limit 1` is "the newest row", never a page. */
  latest: `select ${INTENT_COLUMNS} from engine.control_intent where capability=$1 order by epoch desc, recorded_at desc, id desc limit 1`,
  /** The configure row a request could bind: newest `configure` for the capability AT
   * the requested epoch, malformed parameters included. The reducer requires an equal
   * epoch, so the filter is that requirement and not a narrowing of the standing
   * intent. */
  configure: `select ${INTENT_COLUMNS} from engine.control_intent where capability=$1 and action='configure' and epoch=$3 order by epoch desc, recorded_at desc, id desc limit 1`,
  /** Ordering and the reset barrier over the two rows the server already chose. The
   * reset is global for the capability under the same ordering, so a reset recorded
   * under a newer epoch orders after a configure under an older one. */
  ordering: `select (${ORDER_KEY('c')} <= ${ORDER_KEY('l')}) as configure_at_or_before_latest, (r.id is null or ${ORDER_KEY('r')} < ${ORDER_KEY('c')}) as configure_after_reset, r.id as newest_reset_id from engine.control_intent c cross join engine.control_intent l left join (select id,epoch,recorded_at from engine.control_intent where capability=$1 and action='reset' order by epoch desc, recorded_at desc, id desc limit 1) r on true where c.id=$2 and l.id=$3`,
  /** The funding and budget root pair, joined on the FULL primary key, located by the
   * configure row's own persisted parameters and actor — extracted in SQL, so no JS
   * coercion picks the key. Identity is reported from the ROWS, so a consumer compares
   * two independent persisted sources. `other_epoch_root_exists` is audit only; no
   * epoch policy is invented, and the lookup deliberately uses the requested epoch. */
  funding: `select f.funding_id,f.epoch::text as epoch_text,f.budget_id,b.starting_cents::text as starting_cents,b.available_cents::text as available_cents,b.reserved_cents::text as reserved_cents,b.realized_cents::text as realized_cents,b.correction_cents::text as correction_cents,b.revision::text as revision,((b.available_cents::numeric + b.reserved_cents::numeric) = (b.starting_cents::numeric + b.realized_cents::numeric + b.correction_cents::numeric)) as identity_holds,(b.revision >= 1) as revision_valid,(b.birth_config_intent_id = f.birth_config_intent_id) as birth_bound,exists(select 1 from engine.control_intent bi where bi.id=f.birth_config_intent_id and bi.capability=$1 and bi.action='configure' and bi.epoch=f.epoch and bi.actor=f.actor) as birth_intent_bound,exists(select 1 from engine.paper_funding_root o where o.funding_id=f.funding_id and o.budget_id=f.budget_id and o.epoch<>f.epoch) as other_epoch_root_exists from engine.control_intent ci join engine.paper_funding_root f on f.funding_id = ci.parameters->>'funding_id' and f.epoch = $3 and f.budget_id = ci.actor || ':paper' join engine.paper_budget_root b on b.funding_id=f.funding_id and b.epoch=f.epoch and b.budget_id=f.budget_id where ci.id=$2`,
  observed: `select ${MICRO('clock_timestamp()')} as observed_at_us`,
} as const;

/** The existing approved allowance, carried to the server as an interval so the
 * comparison is made against the database clock. */
export const SKEW_INTERVAL = `${MAX_INTENT_CLOCK_SKEW_MS} milliseconds`;

async function one(
  tx: Transaction,
  query: string,
  values: readonly unknown[],
): Promise<Record<string, unknown> | null> {
  const rows = await tx.unsafe(query, values as never[]);
  // More than one row where the record permits one is a refusal input, never a pick.
  return rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
}

/** Reads the authority inside the CALLER's transaction, so a writer validates present
 * authority in the same transaction and snapshot as its mutation rather than trusting a
 * historical receipt. `midRead` lands between the standing-intent read and everything
 * compared against it, for the test that distinguishes one snapshot from two.
 *
 * This helper performs NO final fence, so it does not return `leaseStillHeld` at all:
 * the return type omits it and every caller must supply the result of its OWN locking
 * read plus fresh-clock revalidation. A caller that forgets does not compile, which is
 * the point — it is never a caller permission and never a placeholder. */
export async function readPaperAuthorityRawInTransaction(
  tx: Transaction,
  capability: string,
  epoch: number,
  leaseHeld: boolean,
  midRead?: () => Promise<void>,
): Promise<Omit<PaperAuthorityRawReads, 'leaseStillHeld'>> {
  const observed = leaseHeld ? await one(tx, AUTHORITY_SQL.observed, []) : null;
  const latest = leaseHeld
    ? await one(tx, AUTHORITY_SQL.latest, [capability, SKEW_INTERVAL])
    : null;
  await midRead?.();
  const configure = leaseHeld
    ? await one(tx, AUTHORITY_SQL.configure, [capability, SKEW_INTERVAL, epoch])
    : null;
  const ordering =
    latest === null || configure === null
      ? null
      : await one(tx, AUTHORITY_SQL.ordering, [capability, configure.id, latest.id]);
  const funding =
    configure === null
      ? null
      : await one(tx, AUTHORITY_SQL.funding, [capability, configure.id, epoch]);
  return {
    configure,
    funding,
    latest,
    leaseHeld,
    observedAtMicroseconds: observed === null ? null : observed.observed_at_us,
    ordering,
  };
}
