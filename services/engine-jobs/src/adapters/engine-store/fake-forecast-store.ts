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
  readonly events: { id: string; runId: string }[] = [];
  failureAt: 'after-cycle' | 'after-sample' | null = null;
  private validate(row: ForecastRow): void {
    if (
      !row.id ||
      !row.symbol ||
      ![row.issuedAt, row.closesAt].every((v) => Number.isFinite(Date.parse(v))) ||
      !['pending', 'resolved', 'invalid'].includes(row.status)
    )
      throw Error('Forecast row constraint rejected.');
  }
  private fail(stage: 'after-cycle' | 'after-sample'): void {
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
    if (!this.cycleStore.runRecords.has(grant.owner)) throw new Error('Missing cycle provenance.');
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
      row.symbol !== input.asset ||
      !Number.isFinite(Date.parse(input.calculatedAt)) ||
      !Number.isFinite(input.currentPrice) ||
      !(input.currentPrice > 0)
    )
      throw Error('Oracle sample constraint rejected.');
    const cycle = row.symbol + ':' + row.closesAt;
    this.fail('after-cycle');
    const points = this.samples.get(input.asset) ?? [],
      at = Date.parse(input.calculatedAt);
    const staged = points.some((p) => p.time === at)
      ? points
      : [...points, { time: at, price: input.currentPrice }];
    this.fail('after-sample');
    const duplicate = this.rows.has(row.id) || this.seed.has(row.id);
    const copy = structuredClone(row);
    this.fence(grant);
    this.cycles.add(cycle);
    this.samples.set(input.asset, staged);
    if (duplicate) return false;
    this.rows.set(row.id, { id: row.id, row: copy, restoreRunId: null });
    this.events.push({ id: row.id, runId: grant.owner });
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
      original.row.closesAt !== row.closesAt
    )
      throw Error('Forecast identity mismatch.');
    if (
      original.restoreRunId !== null &&
      (!this.seed.has(original.id) ||
        this.seed.get(original.id)?.restoreRunId !== original.restoreRunId)
    )
      throw Error('Invalid restore origin.');
    if (original.restoreRunId === null && !this.rows.has(original.id))
      throw Error('Missing cycle origin.');
    const previous = this.rows.get(original.id);
    if (previous !== undefined && previous.row.status !== 'pending') return;
    this.fail('after-cycle');
    const staged = structuredClone(row);
    this.fail('after-sample');
    this.fence(grant);
    this.cycles.add(row.symbol + ':' + row.closesAt);
    this.rows.set(row.id, { id: row.id, row: staged, restoreRunId: original.restoreRunId });
    this.events.push({ id: row.id, runId: grant.owner });
  }
}
