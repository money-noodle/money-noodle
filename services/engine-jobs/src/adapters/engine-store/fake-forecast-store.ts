import { FencingTokenRejectedError, type LeaseGrant } from '../../domain/cycle-store.js';
import {
  resolutionDue,
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
    this.cycles.add(row.symbol + ':' + row.closesAt);
    const points = this.samples.get(input.asset) ?? [],
      at = Date.parse(input.calculatedAt);
    if (!points.some((p) => p.time === at))
      this.samples.set(input.asset, [...points, { time: at, price: input.currentPrice }]);
    if (this.rows.has(row.id) || this.seed.has(row.id)) return false;
    this.rows.set(row.id, { id: row.id, row: structuredClone(row), restoreRunId: null });
    this.events.push({ id: row.id, runId: grant.owner });
    return true;
  }
  async readDueForecasts(now: Date, limit: number): Promise<readonly DueForecast[]> {
    return [...this.rows.values(), ...[...this.seed.values()].filter((r) => !this.rows.has(r.id))]
      .filter((r) => resolutionDue(r.row, now))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async patchForecast(grant: LeaseGrant, original: DueForecast, row: ForecastRow): Promise<void> {
    this.fence(grant);
    const previous = this.rows.get(original.id);
    if (previous !== undefined && previous.row.status !== 'pending') return;
    this.cycles.add(row.symbol + ':' + row.closesAt);
    this.rows.set(row.id, {
      id: row.id,
      row: structuredClone(row),
      restoreRunId: original.restoreRunId,
    });
    this.events.push({ id: row.id, runId: grant.owner });
  }
}
