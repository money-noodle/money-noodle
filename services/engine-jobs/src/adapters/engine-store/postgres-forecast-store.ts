import postgres from 'postgres';
import { FencingTokenRejectedError, type LeaseGrant } from '../../domain/cycle-store.js';
import { boundReference, recordObject } from '../../domain/contract-binding.js';
import type {
  ForecastBaselineRun,
  ForecastBaselineSnapshot,
} from '../../domain/forecast-baseline.js';
import type {
  DueForecast,
  ForecastRow,
  ForecastStore,
  PricePoint,
  Venue,
} from '../../domain/forecast.js';

/** Fixed SQL and bound parameters only; runtime never performs DDL or touches public. */
export function createPostgresForecastStore(
  connectionString: string,
  testEffects?: { beforeEvent?: () => void },
): ForecastStore & { close(): Promise<void> } {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connection: {
      statement_timeout: 3000,
      lock_timeout: 2000,
      idle_in_transaction_session_timeout: 4000,
    },
  });
  type Transaction = postgres.TransactionSql;
  async function guard(tx: Transaction, grant: LeaseGrant): Promise<void> {
    const held = await tx.unsafe(
      'select capability from engine.job_lease where capability=$1 and owner=$2 and fencing_token=$3 and expires_at > clock_timestamp() for update',
      [grant.capability, grant.owner, grant.fencingToken],
    );
    if (held.length !== 1)
      throw new FencingTokenRejectedError('Forecast writer no longer holds a live lease.');
  }
  async function cycle(tx: Transaction, grant: LeaseGrant, row: ForecastRow): Promise<void> {
    await guard(tx, grant);
    await tx.unsafe(
      'insert into engine.forecast_cycle(asset,closes_at,first_run_id) values($1,$2,$3) on conflict do nothing',
      [row.symbol, row.closesAt, grant.owner],
    );
  }
  async function event(tx: Transaction, grant: LeaseGrant, row: ForecastRow): Promise<void> {
    testEffects?.beforeEvent?.();
    await guard(tx, grant);
    await tx.unsafe(
      'insert into engine.forecast_cycle_event(forecast_id,revision,run_id,recorded_at,fencing_token,event) select forecast_id,revision,$2,clock_timestamp(),$3,row from engine.forecast_cycle_row where forecast_id=$1 on conflict do nothing',
      [row.id, grant.owner, grant.fencingToken],
    );
  }
  return {
    async assertLease(grant): Promise<void> {
      await sql.begin(async (tx) => {
        await guard(tx, grant);
      });
    },
    /**
     * The restored baseline, counted from the rows themselves. One read-only statement
     * over tables migration 0002 and 0005 already define: no new table, column, grant or
     * migration, and no write. The baseline is the single COMPLETED restore run; counts
     * attributed to it come from the `restore_run_id` every restored row carries, and the
     * overlay split comes from 0005's `origin_run_id` XOR `origin_restore_run_id`. With no
     * completed run the attributed counts are zero by construction, which the pure
     * decision reports as a missing baseline rather than a clean one.
     */
    async readBaseline(): Promise<ForecastBaselineSnapshot> {
      const [row] = await sql.unsafe<
        {
          runs: string;
          open_runs: string;
          ledger_state_total: string;
          ledger_state_baseline: string;
          ledger_order_total: string;
          ledger_order_baseline: string;
          forecast_row_total: string;
          forecast_row_baseline: string;
          cycle_adopted: string;
          cycle_recorded: string;
        }[]
      >(
        `with baseline as (
           select run_id, manifest_digest, schema_version
             from engine.restore_run
            where completed_at is not null
            order by started_at desc, run_id
         ), one as (select run_id from baseline limit 1)
         select
           (select coalesce(json_agg(json_build_object(
                     'runId', run_id, 'manifestDigest', manifest_digest,
                     'schemaVersion', schema_version)), '[]'::json) from baseline)::text as runs,
           (select count(*) from engine.restore_run where completed_at is null)::text as open_runs,
           (select count(*) from engine.ledger_state)::text as ledger_state_total,
           (select count(*) from engine.ledger_state
             where restore_run_id = (select run_id from one))::text as ledger_state_baseline,
           (select count(*) from engine.ledger_order)::text as ledger_order_total,
           (select count(*) from engine.ledger_order
             where restore_run_id = (select run_id from one))::text as ledger_order_baseline,
           (select count(*) from engine.forecast_row)::text as forecast_row_total,
           (select count(*) from engine.forecast_row
             where restore_run_id = (select run_id from one))::text as forecast_row_baseline,
           (select count(*) from engine.forecast_cycle_row
             where origin_restore_run_id is not null)::text as cycle_adopted,
           (select count(*) from engine.forecast_cycle_row
             where origin_run_id is not null)::text as cycle_recorded`,
      );
      // A count that is not a plain non-negative integer is not believed: `-1` makes the
      // pure decision refuse `baseline-malformed` rather than letting a bad read pass.
      const count = (value: unknown): number =>
        typeof value === 'string' && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value))
          ? Number(value)
          : -1;
      const runs: ForecastBaselineRun[] = [];
      try {
        const parsed: unknown = JSON.parse(row?.runs ?? '[]');
        if (Array.isArray(parsed)) runs.push(...(parsed as ForecastBaselineRun[]));
      } catch {
        // Leave `runs` empty: no baseline is proven, so the decision refuses.
      }
      return {
        completedRuns: runs,
        cycleRows: {
          adoptedFromBaseline: count(row?.cycle_adopted),
          recordedByRuns: count(row?.cycle_recorded),
        },
        forecastRows: {
          attributedToBaseline: count(row?.forecast_row_baseline),
          total: count(row?.forecast_row_total),
        },
        ledgerOrders: {
          attributedToBaseline: count(row?.ledger_order_baseline),
          total: count(row?.ledger_order_total),
        },
        ledgerState: {
          attributedToBaseline: count(row?.ledger_state_baseline),
          total: count(row?.ledger_state_total),
        },
        openRuns: count(row?.open_runs),
      };
    },
    async readEnabledVenues(): Promise<readonly Venue[]> {
      const rows = await sql.unsafe<{ provider_id: string; record: Record<string, unknown> }[]>(
        'select provider_id,record from engine.provider_registry',
      );
      // Restored paper controls are the authority. No default-on provider and no live flag.
      return rows
        .filter(
          (r) =>
            r.record.paperEnabled === true &&
            (r.provider_id === 'polymarket' || r.provider_id === 'kalshi'),
        )
        .map((r) => r.provider_id as Venue);
    },
    async readOracleHistory(asset: string, since: Date): Promise<readonly PricePoint[]> {
      const rows = await sql.unsafe<{ observed_at: Date; price: number }[]>(
        'select observed_at,price from engine.forecast_oracle_sample where asset=$1 and observed_at >= $2 order by observed_at limit 500',
        [asset, since.toISOString()],
      );
      return rows.map((r) => ({ time: r.observed_at.getTime(), price: r.price }));
    },
    async recordObservation(grant, row, input): Promise<boolean> {
      return sql.begin(async (tx) => {
        await guard(tx, grant);
        await cycle(tx, grant, row);
        // Bind pre-serialized JSON as text; otherwise inferred jsonb invokes the
        // driver JSON serializer a second time and stores a JSON string.
        // Retry must not replace an existing observation, including one in the restored open set.
        await guard(tx, grant);
        const inserted = await tx.unsafe(
          'insert into engine.forecast_cycle_row(forecast_id,asset,closes_at,issued_at,status,row,origin_run_id,last_run_id) select $1,$2,$3,$4,$5,$6::text::jsonb,$7,$7 where not exists(select 1 from engine.forecast_row where forecast_id=$1) on conflict do nothing returning forecast_id',
          [
            row.id,
            row.symbol,
            row.closesAt,
            row.issuedAt,
            row.status,
            JSON.stringify(row),
            grant.owner,
          ],
        );
        await guard(tx, grant);
        await tx.unsafe(
          'insert into engine.forecast_oracle_sample(asset,observed_at,price,run_id) values($1,$2,$3,$4) on conflict do nothing',
          [input.asset, input.calculatedAt, input.currentPrice, grant.owner],
        );
        if (inserted.length > 0) await event(tx, grant, row);
        await guard(tx, grant);
        return inserted.length > 0;
      });
    },
    async readDueForecasts(now, limit): Promise<readonly DueForecast[]> {
      const rows = await sql.unsafe<
        { forecast_id: string; row: ForecastRow; restore_run_id: string | null }[]
      >(
        `with pending as (
 select forecast_id,row,origin_restore_run_id as restore_run_id,asset,closes_at from engine.forecast_cycle_row where status='pending' and closes_at < $1
 union all select f.forecast_id,f.row,f.restore_run_id,f.row->>'symbol',(f.row->>'closesAt')::timestamptz from engine.forecast_row f where f.status='pending' and (f.row->>'closesAt')::timestamptz < $1 and not exists(select 1 from engine.forecast_cycle_row c where c.forecast_id=f.forecast_id)
), eligible as (
 select *,coalesce((row->>'lastResolutionCheckAt')::timestamptz,'-infinity'::timestamptz) as checked from pending
 where coalesce((row->>'lastResolutionCheckAt')::timestamptz,'-infinity'::timestamptz) + make_interval(secs=>least(1800,60*power(2,least(5,greatest(0,coalesce((row->>'resolutionAttempts')::numeric,0)-1))))) <= $1
), cycles as (
 select asset,closes_at,min(checked) as oldest from eligible group by asset,closes_at order by oldest,closes_at,asset limit 20
), ranked as (
 select e.*,c.oldest,row_number() over(partition by e.asset,e.closes_at order by e.checked,e.forecast_id) as ordinal from eligible e join cycles c using(asset,closes_at)
) select forecast_id,row,restore_run_id from ranked order by ordinal,oldest,closes_at,asset,forecast_id limit $2`,
        [now.toISOString(), Math.max(1, Math.min(Math.trunc(limit), 2000))],
      );
      const registryIds = [
        ...new Set(
          rows.flatMap((r) =>
            Object.entries(r.row.venueContracts ?? {})
              .filter(([venue]) => venue === 'polymarket' || venue === 'kalshi')
              .map(([, ref]) => ref)
              .map((ref) => {
                const raw = recordObject(ref) ?? {};
                return typeof raw.registryId === 'string' && raw.registryId.length <= 400
                  ? raw.registryId
                  : null;
              })
              .filter((id): id is string => id !== null),
          ),
        ),
      ];
      const refs = registryIds.length
        ? await sql.unsafe<{ registry_id: string; record: Record<string, unknown> }[]>(
            'select registry_id,record from engine.contract_provenance where registry_id in(select jsonb_array_elements_text($1::text::jsonb)) limit 4000',
            [JSON.stringify(registryIds)],
          )
        : [];
      const registry = new Map(refs.map((r) => [r.registry_id, r.record]));
      return rows.map((r) => {
        const contracts = Object.fromEntries(
          Object.entries(r.row.venueContracts ?? {}).map(([venue, ref]) => {
            const raw = recordObject(ref) ?? {};
            if (venue !== 'polymarket' && venue !== 'kalshi')
              return [venue, { integrityFailure: 'unknown-venue' }];
            const fallback = r.row.marketUrl.split('/').filter(Boolean).at(-1) ?? '';
            const valid = boundReference(ref, registry, venue, r.row.closesAt, fallback);
            if (valid === null || (valid.asset !== undefined && valid.asset !== r.row.symbol))
              return [
                venue,
                { registryId: raw.registryId, integrityFailure: 'missing-provenance' },
              ];
            return [venue, valid];
          }),
        );
        return {
          id: r.forecast_id,
          row: { ...r.row, venueContracts: contracts },
          restoreRunId: r.restore_run_id,
        };
      });
    },
    async patchForecast(grant, original, row): Promise<void> {
      if (
        original.id !== row.id ||
        original.row.id !== row.id ||
        original.row.symbol !== row.symbol ||
        Date.parse(original.row.closesAt) !== Date.parse(row.closesAt)
      )
        throw Error('Forecast identity mismatch.');
      await sql.begin(async (tx) => {
        await guard(tx, grant);
        await cycle(tx, grant, row);
        // A seed resolution creates an overlay; the restored row and restore FK never change.
        await guard(tx, grant);
        const updated = await tx.unsafe(
          "insert into engine.forecast_cycle_row(forecast_id,asset,closes_at,issued_at,status,row,origin_run_id,origin_restore_run_id,last_run_id) values($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9) on conflict(forecast_id) do update set status=excluded.status,row=excluded.row,last_run_id=excluded.last_run_id,revision=engine.forecast_cycle_row.revision+1 where engine.forecast_cycle_row.status='pending' returning forecast_id",
          [
            row.id,
            row.symbol,
            row.closesAt,
            row.issuedAt,
            row.status,
            JSON.stringify(row),
            original.restoreRunId === null ? grant.owner : null,
            original.restoreRunId,
            grant.owner,
          ],
        );
        if (updated.length > 0) await event(tx, grant, row);
        await guard(tx, grant);
      });
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
