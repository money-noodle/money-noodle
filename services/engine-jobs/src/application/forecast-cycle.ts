import {
  forecast,
  forecastCycleKey,
  validatedContract,
  resolutionDue,
  resolveForecast,
  type Contract,
  type ForecastFeeds,
  type ForecastStore,
  type Outcome,
} from '../domain/forecast.js';
import type { LeaseGrant } from '../domain/cycle-store.js';
/** Bounded awaited provider work; never detached on process exit. */
export async function runForecastTick(
  store: ForecastStore,
  feeds: ForecastFeeds,
  grant: LeaseGrant,
  now: () => Date,
): Promise<void> {
  await store.assertLease(grant);
  const enabled = await store.readEnabledVenues();
  await store.assertLease(grant);
  for (const input of await feeds.calculate(now(), enabled, store)) {
    const row = forecast(input, now(), enabled);
    if (row !== null) await store.recordObservation(grant, row, input);
  }
  await store.assertLease(grant);
  const cycles = new Set<string>(),
    requests = new Map<string, Contract>();
  const due = (await store.readDueForecasts(now(), 2000)).filter((original) => {
    if (!resolutionDue(original.row, now())) return false;
    const key = forecastCycleKey(original.row.symbol, original.row.closesAt);
    if (key === null) return false;
    if (!cycles.has(key) && cycles.size >= 20) return false;
    cycles.add(key);
    return true;
  });
  const target = (row: (typeof due)[number]['row']): Contract | undefined => {
    const venue = Object.keys(row.venueContracts).length
        ? (row.entryVenue ?? 'polymarket')
        : 'polymarket',
      reference = row.venueContracts[venue],
      slug = row.marketUrl.split('/').filter(Boolean).at(-1) ?? '';
    if (reference !== undefined)
      return validatedContract(reference, venue, row.closesAt, slug) ?? undefined;
    if (Object.keys(row.venueContracts).length !== 0 || !slug) return undefined;
    return { venue: 'polymarket', contractId: slug, slug, closesAt: row.closesAt };
  };
  for (const original of due) {
    const c = target(original.row);
    if (c !== undefined) requests.set(c.venue + ':' + c.contractId, c);
  }
  await store.assertLease(grant);
  const outcomes = new Map<string, Outcome | null>();
  await Promise.all(
    [...requests].slice(0, 40).map(async ([key, c]) => {
      outcomes.set(key, await feeds.resolve(c).catch(() => null));
    }),
  );
  for (const original of due) {
    const c = target(original.row),
      result = c === undefined ? null : (outcomes.get(c.venue + ':' + c.contractId) ?? null);
    await store.patchForecast(grant, original, resolveForecast(original.row, result, now()));
  }
}
