import type { ForecastStore, ForecastInput, ForecastRow } from '../domain/forecast.js';
import type { LeaseGrant } from '../domain/cycle-store.js';
export interface ContractSnapshot {
  cycles: number;
  samples: number;
  rows: number;
  events: number;
  revision: number | null;
  originRunId: string | null;
  originRestoreRunId: string | null;
  lastRunId: string | null;
  eventRevisions: readonly number[];
}
const require = (truth: boolean, message: string) => {
  if (!truth) throw Error('Forecast store conformance: ' + message);
};
export async function forecastStoreConformance(
  store: ForecastStore,
  grant: LeaseGrant,
  row: ForecastRow,
  input: ForecastInput,
  snapshot: () => Promise<ContractSnapshot>,
): Promise<void> {
  const initial = await snapshot();
  require(await store.recordObservation(grant, row, input), 'first observation inserted');
  const alternate = {
    ...row,
    id: row.id + '-alternate',
    closesAt: new Date(row.closesAt).toISOString().replace('Z', '+00:00'),
  };
  require(await store.recordObservation(grant, alternate, input), 'alternate observation inserted');
  require(!(await store.recordObservation(grant, row, input)), 'duplicate did not insert');
  const recorded = await snapshot();
  require(recorded.cycles === initial.cycles + 1, 'equivalent timestamps share one cycle');
  require(recorded.samples === initial.samples + 1, 'duplicate samples share one identity');
  require(recorded.rows === initial.rows + 2 &&
    recorded.events === initial.events + 2, 'duplicate observations do not duplicate rows/events');
  const original = { id: row.id, row, restoreRunId: null };
  await store.patchForecast(grant, original, {
    ...row,
    lastResolutionCheckAt: '2026-10-10T12:16:00.000Z',
  });
  await store.patchForecast(grant, original, {
    ...row,
    lastResolutionCheckAt: '2026-10-10T12:17:00.000Z',
  });
  const pending = await snapshot();
  require(pending.revision === 3, 'pending patches increment revisions');
  require(JSON.stringify(pending.eventRevisions) ===
    JSON.stringify([1, 2, 3]), 'event primary keys track revisions');
  require(pending.originRunId === grant.owner &&
    pending.originRestoreRunId === null &&
    pending.lastRunId === grant.owner, 'origin and last run FK attribution');
  await store.patchForecast(grant, original, { ...row, status: 'resolved' });
  const terminal = await snapshot();
  await store.patchForecast(grant, original, { ...row, status: 'pending' });
  require(JSON.stringify(await snapshot()) ===
    JSON.stringify(terminal), 'terminal retry immutable');
  for (const action of [
    () => store.patchForecast(grant, { ...original, id: 'wrong-id' }, row),
    () =>
      store.recordObservation(
        grant,
        { ...row, id: row.id + '-bad', status: 'bad' as ForecastRow['status'] },
        input,
      ),
    () =>
      store.patchForecast(
        grant,
        {
          id: row.id + '-missing-restore',
          row: { ...row, id: row.id + '-missing-restore' },
          restoreRunId: 'missing-restore-fk',
        },
        { ...row, id: row.id + '-missing-restore' },
      ),
  ]) {
    const before = await snapshot();
    let failed = false;
    try {
      await action();
    } catch {
      failed = true;
    }
    require(failed, 'invalid identity/status/restore origin rejected');
    require(JSON.stringify(await snapshot()) ===
      JSON.stringify(before), 'failed operation rolls back complete transaction');
  }
}

export async function eventFailureConformance(
  store: ForecastStore,
  grant: LeaseGrant,
  row: ForecastRow,
  input: ForecastInput,
  snapshot: () => Promise<ContractSnapshot>,
): Promise<void> {
  const before = await snapshot();
  let rejected = false;
  try {
    await store.recordObservation(grant, row, input);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('event');
  }
  require(rejected, 'event-stage error propagated');
  require(JSON.stringify(await snapshot()) ===
    JSON.stringify(before), 'event-stage failure rolls back cycle/sample/row/event');
}
