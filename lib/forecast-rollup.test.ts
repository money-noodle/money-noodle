import { describe, expect, it } from 'vitest';
import { compareSummaries } from './forecast-storage';
import {
  LEGACY_FORECAST_ROLLUP_VERSION, buildSummaryRollup, leadingStreak, legacyRollupNeedsReseal,
  summarizeFromRollups,
} from './forecast-rollup';
import { summarizePerformance } from './performance';
import { BUY_POLICY_VERSION } from './prediction-policy';
import type { TrackedForecast } from './types';

function forecast(overrides: Partial<TrackedForecast> = {}): TrackedForecast {
  return {
    id: 'forecast-1',
    symbol: 'BTC',
    direction: 'UP',
    marketUrl: 'https://kalshi.com/markets/btc/2026-08-14T10:15:00Z',
    modelVersion: 'model-v1',
    policyVersion: 'buy-policy-v1',
    issuedAt: '2026-08-14T10:00:00Z',
    closesAt: '2026-08-14T10:15:00Z',
    probabilityUp: 0.62,
    polymarketProbabilityUp: 0.55,
    confidence: 0.7,
    status: 'pending',
    ...overrides,
  } as TrackedForecast;
}

/** A day of rows that settle in one window, which is the shape the real data actually has. */
function day(date: string, count: number, correctAt: (index: number) => boolean): TrackedForecast[] {
  return Array.from({ length: count }, (_, index) => forecast({
    id: `${date}:${String(index).padStart(3, '0')}`,
    symbol: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE', 'XRP'][index % 7],
    status: 'resolved',
    outcome: correctAt(index) ? 'UP' : 'DOWN',
    entrySide: 'UP',
    correct: correctAt(index),
    brierScore: correctAt(index) ? 0.15 : 0.45,
    logLoss: correctAt(index) ? 0.3 : 0.9,
    predictedEdge: 0.08,
    realizedReturn: correctAt(index) ? 0.4 : -0.35,
    entryAsk: 0.55,
    entryVenue: 'kalshi',
    secondsRemaining: 300,
    issuedAt: `${date}T10:00:00Z`,
    closesAt: `${date}T10:15:00Z`,
    resolvedAt: `${date}T10:15:30Z`,
  }));
}

const rollupsFor = (shards: Array<[string, TrackedForecast[]]>) =>
  shards.map(([id, rows]) => buildSummaryRollup(id, rows));

/**
 * A row that actually reaches `missedBuyCounterfactual`, which is harder than it looks: it needs a
 * matching Kalshi contract id on both the contract and the outcome, a snapshot within 300s ± 90s, and a
 * quote whose only disqualification is the selected-side floor.
 *
 * The fixture deliberately uses the durable compacted provenance shape (`registryId` plus capture
 * time, no `contractId`). Runtime reads rehydrate it, but storage verification and sealed rollups work
 * directly from the compacted rows and must enforce the same identity without loading the registry.
 */
function counterfactualRow(overrides: {
  id: string; symbol?: string; closesAt: string; price: number; probabilityUp?: number; outcome?: 'UP' | 'DOWN';
  policyVersion?: string;
}): TrackedForecast {
  const contractId = `KX${overrides.symbol ?? 'BTC'}15M-${overrides.closesAt}`;
  const closesAt = overrides.closesAt;
  return forecast({
    id: overrides.id,
    symbol: overrides.symbol ?? 'BTC',
    status: 'resolved',
    policyVersion: overrides.policyVersion ?? BUY_POLICY_VERSION,
    // 0.53 clears the 5pp net edge against a 0.40 quote while staying under the 0.55 floor, which is
    // precisely the "rejected only by the floor" case the counterfactual measures.
    probabilityUp: overrides.probabilityUp ?? 0.53,
    confidence: 0.7,
    outcome: overrides.outcome ?? 'UP',
    correct: true,
    entrySide: 'UP',
    brierScore: 0.2,
    logLoss: 0.4,
    predictedEdge: 0.06,
    realizedReturn: 0.2,
    secondsRemaining: 300,
    issuedAt: '2026-08-14T00:00:00Z',
    closesAt,
    resolvedAt: `${closesAt.slice(0, 19)}Z`,
    actionableVenuePrices: [{ venue: 'kalshi', side: 'UP', price: overrides.price }],
    venueContracts: { kalshi: { registryId: `kalshi:${contractId}:fp`, capturedAt: '2026-08-14T00:00:00Z' } } as unknown as TrackedForecast['venueContracts'],
    venueOutcomes: { kalshi: { venue: 'kalshi', contractId, outcome: overrides.outcome ?? 'UP', resolutionSource: 'test', resolvedAt: `${closesAt.slice(0, 19)}Z` } },
  } as Partial<TrackedForecast>);
}

describe('the leading streak', () => {
  it('is zero on an empty sequence', () => {
    expect(leadingStreak([])).toBe(0);
  });

  it('counts a winning run positive and a losing run negative', () => {
    expect(leadingStreak([true, true, true, false])).toBe(3);
    expect(leadingStreak([false, false, true])).toBe(-2);
  });

  it('spans the whole sequence when it never breaks', () => {
    expect(leadingStreak([true, true])).toBe(2);
  });
});

describe('summarising from rollups', () => {
  const shards: Array<[string, TrackedForecast[]]> = [
    ['2026-08-12', day('2026-08-12', 21, (index) => index % 3 !== 0)],
    ['2026-08-13', day('2026-08-13', 28, (index) => index % 4 !== 3)],
    ['2026-08-14', day('2026-08-14', 14, () => true)],
  ];
  const rows = shards.flatMap(([, items]) => items);

  it('reproduces the whole summary from sufficient statistics alone', () => {
    expect(compareSummaries(summarizePerformance(rows), summarizeFromRollups(rollupsFor(shards)))).toEqual([]);
  });

  it('reproduces it identically however the history is split into shards', () => {
    const direct = summarizePerformance(rows);
    // One shard per day, and the degenerate single-shard case, must agree with each other.
    expect(compareSummaries(direct, summarizeFromRollups(rollupsFor([['all', rows]])))).toEqual([]);
  });

  it('carries a streak across shard boundaries rather than reading only the newest', () => {
    // All 14 rows of the newest shard are correct and so are the first three the shard before it
    // contributes, so a correct answer has to reach past the boundary. Reading only the newest shard
    // would report 14.
    const summary = summarizeFromRollups(rollupsFor(shards));
    expect(summary.currentStreak).toBe(summarizePerformance(rows).currentStreak);
    expect(summary.currentStreak).toBe(17);
  });

  it('counts calibration windows over unqualified rows too', () => {
    // Unqualified rows are excluded from every track-record metric but still gate calibration readiness.
    const withUnqualified = [...rows, ...day('2026-08-15', 7, () => true).map((row) => ({ ...row, qualified: false }))];
    const split: Array<[string, TrackedForecast[]]> = [
      ...shards,
      ['2026-08-15', withUnqualified.filter((row) => row.qualified === false)],
    ];
    const direct = summarizePerformance(withUnqualified);
    const merged = summarizeFromRollups(rollupsFor(split));
    expect(merged.calibrationWindows).toBe(direct.calibrationWindows);
    expect(merged.calibrationWindows).toBeGreaterThan(merged.resolvedWindows);
    expect(merged.issued).toBe(direct.issued);
  });

  it('keeps pending rows in the counts and out of the resolved statistics', () => {
    const open = [forecast({ id: 'open-1', issuedAt: '2026-08-15T10:00:00Z', closesAt: '2026-08-15T10:15:00Z' })];
    const direct = summarizePerformance([...rows, ...open]);
    expect(compareSummaries(direct, summarizeFromRollups(rollupsFor([...shards, ['open', open]])))).toEqual([]);
  });
});

describe('when shards overlap in resolution time', () => {
  // Shards are keyed by issuance day, but a row issued just before midnight can resolve after one
  // issued just after it. This was measured as never happening across 49,469 rows and then happened
  // within the hour, so the merge must not depend on shard order at all.
  const late = day('2026-08-13', 6, () => true).map((row, index) => ({
    ...row,
    id: `late:${index}`,
    issuedAt: '2026-08-13T23:50:00Z',
    closesAt: '2026-08-14T00:45:00Z',
    resolvedAt: '2026-08-14T00:48:39Z',
    correct: false,
    outcome: 'DOWN' as const,
  }));
  const early = day('2026-08-14', 6, () => true).map((row, index) => ({
    ...row,
    id: `early:${index}`,
    issuedAt: '2026-08-14T00:05:00Z',
    closesAt: '2026-08-14T00:15:00Z',
    resolvedAt: '2026-08-14T00:15:15Z',
  }));
  const overlapping: Array<[string, TrackedForecast[]]> = [['2026-08-13', late], ['2026-08-14', early]];
  const rows = [...late, ...early];

  it('still reproduces the summary exactly', () => {
    expect(compareSummaries(summarizePerformance(rows), summarizeFromRollups(rollupsFor(overlapping)))).toEqual([]);
  });

  it('reads the streak from the rows that resolved last, not from the newest shard', () => {
    // Every row in the newest shard is correct, but they all resolved earlier. The streak belongs to
    // the rows that actually resolved last, which sit in the older shard and are all wrong.
    const summary = summarizeFromRollups(rollupsFor(overlapping));
    expect(summary.currentStreak).toBe(summarizePerformance(rows).currentStreak);
    expect(summary.currentStreak).toBe(-6);
  });

  it('does not depend on the order the rollups are merged in', () => {
    const forward = summarizeFromRollups(rollupsFor(overlapping));
    const backward = summarizeFromRollups(rollupsFor([...overlapping].reverse()));
    expect(compareSummaries(forward, backward)).toEqual([]);
  });
});

describe('the missed-buy counterfactual', () => {
  it('produces candidates at all, so the rest of these assertions are not vacuous', () => {
    const rows = [counterfactualRow({ id: 'cf-1', closesAt: '2026-08-14T00:15:00Z', price: 0.40 })];
    const direct = summarizePerformance(rows).missedBuyCounterfactual;
    expect(direct.candidates).toBe(1);
    expect(direct.windows).toBe(1);
    expect(direct.bestPerWindowCandidates).toBe(1);
  });

  it('reproduces the counterfactual from rollups', () => {
    const rows = [
      counterfactualRow({ id: 'cf-1', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.40 }),
      counterfactualRow({ id: 'cf-2', symbol: 'ETH', closesAt: '2026-08-14T00:15:00Z', price: 0.35, outcome: 'DOWN' }),
      counterfactualRow({ id: 'cf-3', symbol: 'SOL', closesAt: '2026-08-14T00:30:00Z', price: 0.30 }),
    ];
    const direct = summarizePerformance(rows);
    const merged = summarizeFromRollups(rollupsFor([['2026-08-14', rows]]));
    expect(direct.missedBuyCounterfactual.bestPerWindowStandardError).not.toBeNull();
    expect(compareSummaries(direct, merged)).toEqual([]);
  });

  it('stores policy identity in the counterfactual merge key', () => {
    const rollup = buildSummaryRollup('current', [
      counterfactualRow({ id: 'cf-policy', closesAt: '2026-08-14T00:15:00Z', price: 0.40 }),
    ]);
    expect(rollup.counterfactual.assetWindows[0]).toMatchObject({ policyVersion: BUY_POLICY_VERSION });
    expect(rollup.counterfactual.assetWindows[0].key).toContain(`${BUY_POLICY_VERSION}:BTC:`);
  });

  it('excludes a differently scoped v2 counterfactual cohort', () => {
    const row = counterfactualRow({ id: 'cf-current', closesAt: '2026-08-14T00:15:00Z', price: 0.40 });
    const current = buildSummaryRollup('current', [row]);
    const retired = structuredClone(current);
    retired.shardId = 'retired';
    retired.counterfactual.assetWindows = retired.counterfactual.assetWindows.map((item) => ({
      ...item, policyVersion: 'retired-policy-v1', key: item.key.replace(BUY_POLICY_VERSION, 'retired-policy-v1'),
    }));

    const merged = summarizeFromRollups([retired, current]);
    expect(merged.missedBuyCounterfactual.candidates).toBe(1);
    expect(merged.missedBuyCounterfactual.windows).toBe(1);
  });

  it('excludes unscoped legacy v1 counterfactual rows without discarding the rest of the rollup', () => {
    const row = counterfactualRow({ id: 'cf-legacy', closesAt: '2026-08-14T00:15:00Z', price: 0.40 });
    const legacy = buildSummaryRollup('legacy', [row]);
    legacy.version = LEGACY_FORECAST_ROLLUP_VERSION;
    legacy.counterfactual.assetWindows = legacy.counterfactual.assetWindows.map(({ policyVersion: _policyVersion, ...item }) => item);

    const merged = summarizeFromRollups([legacy]);
    expect(merged.resolved).toBe(1);
    expect(merged.missedBuyCounterfactual.candidates).toBe(0);
    expect(merged.missedBuyCounterfactual.windows).toBe(0);
  });

  it('requires a legacy rollup containing active-policy rows to be resealed', () => {
    const currentRow = counterfactualRow({ id: 'cf-current-legacy', closesAt: '2026-08-14T00:15:00Z', price: 0.40 });
    const retiredRow = counterfactualRow({
      id: 'cf-retired-legacy', closesAt: '2026-08-14T00:30:00Z', price: 0.40, policyVersion: 'retired-policy-v1',
    });
    const legacy = buildSummaryRollup('legacy', [currentRow]);
    legacy.version = LEGACY_FORECAST_ROLLUP_VERSION;

    expect(legacyRollupNeedsReseal(legacy, [currentRow], BUY_POLICY_VERSION)).toBe(true);
    expect(legacyRollupNeedsReseal(legacy, [retiredRow], BUY_POLICY_VERSION)).toBe(false);
    expect(legacyRollupNeedsReseal(buildSummaryRollup('current', [currentRow]), [currentRow], BUY_POLICY_VERSION)).toBe(false);
  });

  it('selects one nearest snapshot when the same asset/window is split across shards', () => {
    const farther = { ...counterfactualRow({ id: 'cf-farther', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.30 }), secondsRemaining: 330 };
    const nearest = counterfactualRow({ id: 'cf-nearest', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.40 });
    const rows = [farther, nearest];
    const merged = summarizeFromRollups(rollupsFor([['2026-08-13', [farther]], ['2026-08-14', [nearest]]]));

    expect(compareSummaries(summarizePerformance(rows), merged)).toEqual([]);
    expect(merged.missedBuyCounterfactual.candidates).toBe(1);
  });

  it('does not fall back to a farther qualifying snapshot when the global nearest is ineligible', () => {
    const farther = { ...counterfactualRow({ id: 'cf-farther', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.30 }), secondsRemaining: 330 };
    const nearest = counterfactualRow({
      id: 'cf-nearest-ineligible', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.40, probabilityUp: 0.62,
    });
    const rows = [farther, nearest];
    const merged = summarizeFromRollups(rollupsFor([['2026-08-13', [farther]], ['2026-08-14', [nearest]]]));

    expect(summarizePerformance(rows).missedBuyCounterfactual.candidates).toBe(0);
    expect(compareSummaries(summarizePerformance(rows), merged)).toEqual([]);
  });

  it('breaks equal-distance snapshot ties by id independently of row and shard order', () => {
    const first = counterfactualRow({ id: 'a', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.40 });
    const second = counterfactualRow({ id: 'b', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.30 });
    const direct = summarizePerformance([second, first]);
    const merged = summarizeFromRollups(rollupsFor([['newer', [second]], ['older', [first]]]));

    expect(direct.missedBuyCounterfactual.candidates).toBe(1);
    expect(compareSummaries(direct, merged)).toEqual([]);
  });

  it('keeps one best candidate for a window split across two shards, not one per shard', () => {
    // Both rows sit in the same settlement window but different shards. The stronger edge is the
    // cheaper quote, and best-per-window must pick it once rather than contributing from each shard.
    const cheap = counterfactualRow({ id: 'cf-cheap', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.30 });
    const dear = counterfactualRow({ id: 'cf-dear', symbol: 'ETH', closesAt: '2026-08-14T00:15:00Z', price: 0.45 });
    const rows = [cheap, dear];
    const merged = summarizeFromRollups(rollupsFor([['2026-08-13', [cheap]], ['2026-08-14', [dear]]]));

    expect(compareSummaries(summarizePerformance(rows), merged)).toEqual([]);
    expect(merged.missedBuyCounterfactual.candidates).toBe(2);
    // One window, therefore one best-per-window candidate, despite spanning two shards.
    expect(merged.missedBuyCounterfactual.windows).toBe(1);
    expect(merged.missedBuyCounterfactual.bestPerWindowCandidates).toBe(1);
  });

  it('breaks equal-edge best-per-window ties by candidate identity', () => {
    const loss = counterfactualRow({ id: 'a-loss', symbol: 'BTC', closesAt: '2026-08-14T00:15:00Z', price: 0.40, outcome: 'DOWN' });
    const win = counterfactualRow({ id: 'b-win', symbol: 'ETH', closesAt: '2026-08-14T00:15:00Z', price: 0.40, outcome: 'UP' });
    const direct = summarizePerformance([win, loss]);
    const merged = summarizeFromRollups(rollupsFor([['newer', [win]], ['older', [loss]]]));

    expect(compareSummaries(direct, merged)).toEqual([]);
    expect(merged.missedBuyCounterfactual.bestPerWindowWins).toBe(0);
  });

  it('excludes a snapshot outside the five-minute window in both paths alike', () => {
    const rows = [{ ...counterfactualRow({ id: 'cf-late', closesAt: '2026-08-14T00:15:00Z', price: 0.40 }), secondsRemaining: 60 }];
    expect(summarizePerformance(rows).missedBuyCounterfactual.candidates).toBe(0);
    expect(compareSummaries(
      summarizePerformance(rows),
      summarizeFromRollups(rollupsFor([['2026-08-14', rows]])),
    )).toEqual([]);
  });

  it('excludes a side already above the selected-side floor in both paths alike', () => {
    // 0.62 clears the floor, so the policy did not reject it and it is not a missed buy.
    const rows = [counterfactualRow({ id: 'cf-high', closesAt: '2026-08-14T00:15:00Z', price: 0.40, probabilityUp: 0.62 })];
    expect(summarizePerformance(rows).missedBuyCounterfactual.candidates).toBe(0);
    expect(compareSummaries(
      summarizePerformance(rows),
      summarizeFromRollups(rollupsFor([['2026-08-14', rows]])),
    )).toEqual([]);
  });
});

describe('a cycle split across two shards', () => {
  it('merges its rows and re-chooses the earliest-issued representative', () => {
    // Cycles were measured never to span a shard. The merge does not rely on that either.
    const cycle = (id: string, issuedAt: string, correct: boolean) => forecast({
      id, cycleId: 'btc:2026-08-14T00:15:00Z', status: 'resolved', correct,
      outcome: correct ? 'UP' : 'DOWN', entrySide: 'UP', brierScore: 0.2, logLoss: 0.4,
      predictedEdge: 0.05, realizedReturn: correct ? 0.3 : -0.3, secondsRemaining: 300,
      issuedAt, closesAt: '2026-08-14T00:15:00Z', resolvedAt: '2026-08-14T00:15:30Z',
    });
    const before = [cycle('a', '2026-08-13T23:58:00Z', false)];
    const after = [cycle('b', '2026-08-14T00:01:00Z', true), cycle('c', '2026-08-14T00:02:00Z', true)];
    const rows = [...before, ...after];
    const merged = summarizeFromRollups(rollupsFor([['2026-08-13', before], ['2026-08-14', after]]));

    expect(compareSummaries(summarizePerformance(rows), merged)).toEqual([]);
    expect(merged.resolvedCycles).toBe(1);
    // The representative is the earliest-issued row, which is the incorrect one in the older shard.
    expect(merged.currentCycleStreak).toBe(-1);
  });
});
