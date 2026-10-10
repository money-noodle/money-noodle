import { FencingTokenRejectedError, type LeaseGrant } from '../../domain/cycle-store.js';
import {
  selectDueForecasts,
  type DueForecast,
  type ForecastInput,
  type ForecastRow,
  type ForecastStore,
  type PricePoint,
  type Venue,
} from '../../domain/forecast.js';
import type { FakeCycleStore } from './fake-cycle-store.js';
/** SQL constraints and overlay semantics, not an unconstrained bag of rows. */
export class FakeForecastStore implements ForecastStore {
  readonly rows = new Map<string, DueForecast>();
  readonly seed = new Map<string, DueForecast>();
  readonly cycles = new Set<string>();
  readonly samples = new Map<string, readonly PricePoint[]>();
  readonly events: {
    id: string;
    runId: string;
    revision: number;
    fencingToken: number;
    event: ForecastRow;
  }[] = [];
  readonly cycleOrigins = new Map<string, string>();
  readonly rowMetadata = new Map<
    string,
    {
      originRunId: string | null;
      originRestoreRunId: string | null;
      lastRunId: string;
      revision: number;
    }
  >();
  readonly restoreRuns = new Set<string>();
  readonly eventKeys = new Set<string>();
  failureAt: 'after-cycle' | 'after-sample' | 'after-event' | null = null;
  private cycleKey(row: ForecastRow): string {
    return row.symbol + ':' + new Date(row.closesAt).toISOString();
  }
  private runFK(runId: string): void {
    if (!this.cycleStore.runRecords.has(runId)) throw Error('Missing cycle provenance.');
  }
  private validate(row: ForecastRow): void {
    if (
      !row.id ||
      !row.symbol ||
      ![row.issuedAt, row.closesAt].every((v) => Number.isFinite(Date.parse(v))) ||
      !['pending', 'resolved', 'invalid'].includes(row.status)
    )
      throw Error('Forecast row constraint rejected.');
  }
  private fail(stage: 'after-cycle' | 'after-sample' | 'after-event'): void {
    if (this.failureAt === stage) throw Error('Synthetic transaction failure ' + stage);
  }
  venues: readonly Venue[] = ['polymarket', 'kalshi'];
  constructor(
    readonly cycleStore: FakeCycleStore,
    readonly now: () => Date,
  ) {}
  private fence(grant: LeaseGrant): void {
    const held = this.cycleStore.leases.get(grant.capability);
    if (
      held === undefined ||
      held.owner !== grant.owner ||
      held.fencingToken !== grant.fencingToken ||
      held.expiresAt <= this.now()
    )
      throw new FencingTokenRejectedError('Forecast fence rejected.');
  }
  async assertLease(grant: LeaseGrant): Promise<void> {
    this.fence(grant);
  }
  async readEnabledVenues(): Promise<readonly Venue[]> {
    return this.venues;
  }
  async readOracleHistory(asset: string, since: Date): Promise<readonly PricePoint[]> {
    return (this.samples.get(asset) ?? []).filter((p) => p.time >= since.getTime());
  }
  async recordObservation(
    grant: LeaseGrant,
    row: ForecastRow,
    input: ForecastInput,
  ): Promise<boolean> {
    this.fence(grant);
    this.validate(row);
    if (
      !Number.isFinite(Date.parse(input.calculatedAt)) ||
      !Number.isFinite(input.currentPrice) ||
      !(input.currentPrice > 0)
    )
      throw Error('Oracle sample constraint rejected.');
    const cycle = this.cycleKey(row);
    this.fail('after-cycle');
    const points = this.samples.get(input.asset) ?? [],
      at = Date.parse(input.calculatedAt);
    const staged = points.some((p) => p.time === at)
      ? points
      : [...points, { time: at, price: input.currentPrice }];
    this.fail('after-sample');
    const duplicate = this.rows.has(row.id) || this.seed.has(row.id);
    const copy = structuredClone(row),
      newCycle = !this.cycles.has(cycle),
      newSample = !points.some((p) => p.time === at);
    if (newCycle || newSample || !duplicate) this.runFK(grant.owner);
    const event = {
      id: row.id,
      runId: grant.owner,
      revision: 1,
      fencingToken: grant.fencingToken,
      event: copy,
    };
    if (!duplicate) this.fail('after-event');
    this.fence(grant);
    this.cycles.add(cycle);
    if (newCycle) this.cycleOrigins.set(cycle, grant.owner);
    this.samples.set(input.asset, staged);
    if (duplicate) return false;
    this.rows.set(row.id, { id: row.id, row: copy, restoreRunId: null });
    this.rowMetadata.set(row.id, {
      originRunId: grant.owner,
      originRestoreRunId: null,
      lastRunId: grant.owner,
      revision: 1,
    });
    const eventKey = row.id + ':1';
    if (!this.eventKeys.has(eventKey)) {
      this.eventKeys.add(eventKey);
      this.events.push(event);
    }
    return true;
  }

  async readDueForecasts(now: Date, limit: number): Promise<readonly DueForecast[]> {
    return selectDueForecasts(
      [...this.rows.values(), ...[...this.seed.values()].filter((r) => !this.rows.has(r.id))],
      now,
      limit,
    ).map((r) => structuredClone(r));
  }
  async patchForecast(grant: LeaseGrant, original: DueForecast, row: ForecastRow): Promise<void> {
    this.fence(grant);
    this.validate(row);
    if (
      original.id !== row.id ||
      original.row.id !== row.id ||
      original.row.symbol !== row.symbol ||
      Date.parse(original.row.closesAt) !== Date.parse(row.closesAt)
    )
      throw Error('Forecast identity mismatch.');
    const previous = this.rows.get(row.id),
      previousMetadata = this.rowMetadata.get(row.id);
    const cycle = this.cycleKey(row),
      newCycle = !this.cycles.has(cycle);
    if (newCycle) this.runFK(grant.owner);
    if (previous !== undefined && previous.row.status !== 'pending') return;
    this.runFK(grant.owner);
    const origin = previousMetadata ?? {
      originRunId: original.restoreRunId === null ? grant.owner : null,
      originRestoreRunId: original.restoreRunId,
      lastRunId: grant.owner,
      revision: 0,
    };
    if (origin.originRestoreRunId !== null && !this.restoreRuns.has(origin.originRestoreRunId))
      throw Error('Invalid restore origin.');
    if ((origin.originRunId === null) === (origin.originRestoreRunId === null))
      throw Error('Origin XOR constraint.');
    if (origin.originRunId !== null) this.runFK(origin.originRunId);
    this.fail('after-cycle');
    const staged = structuredClone(row);
    this.fail('after-sample');
    const metadata = { ...origin, lastRunId: grant.owner, revision: origin.revision + 1 };
    const eventKey = row.id + ':' + metadata.revision,
      event = {
        id: row.id,
        runId: grant.owner,
        revision: metadata.revision,
        fencingToken: grant.fencingToken,
        event: staged,
      };
    this.fail('after-event');
    this.fence(grant);
    this.cycles.add(cycle);
    if (newCycle) this.cycleOrigins.set(cycle, grant.owner);
    this.rows.set(row.id, { id: row.id, row: staged, restoreRunId: metadata.originRestoreRunId });
    this.rowMetadata.set(row.id, metadata);
    if (!this.eventKeys.has(eventKey)) {
      this.eventKeys.add(eventKey);
      this.events.push(event);
    }
  }
}
