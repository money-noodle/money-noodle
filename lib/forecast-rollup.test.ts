import { describe, expect, it } from 'vitest';
import { compareSummaries } from './forecast-storage';
import { assertRollupOrdering, buildSummaryRollup, mergeRuns, runFromSequence, summarizeFromRollups } from './forecast-rollup';
import { summarizePerformance } from './performance';
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

describe('the run monoid', () => {
  it('describes a sequence that is entirely one run', () => {
    expect(runFromSequence([true, true, true])).toMatchObject({ count: 3, prefix: 3, suffix: 3, uniform: true });
  });

  it('measures the runs at each end independently', () => {
    expect(runFromSequence([true, true, false, false, false])).toMatchObject({ prefix: 2, suffix: 3, uniform: false });
  });

  it('is the identity on an empty sequence', () => {
    const run = runFromSequence([true, false]);
    expect(mergeRuns(runFromSequence([]), run)).toEqual(run);
    expect(mergeRuns(run, runFromSequence([]))).toEqual(run);
  });

  it('extends a prefix across the join only when the left side is entirely one run', () => {
    const joined = mergeRuns(runFromSequence([true, true]), runFromSequence([true, false]));
    expect(joined).toMatchObject({ count: 4, prefix: 3, uniform: false });
    const blocked = mergeRuns(runFromSequence([true, false]), runFromSequence([false, false]));
    expect(blocked).toMatchObject({ count: 4, prefix: 1 });
  });

  it('is associative, so the answer does not depend on how the history is split', () => {
    const values = [true, true, false, true, true, true, false, false, true];
    const whole = runFromSequence(values);
    for (let cut = 0; cut <= values.length; cut += 1) {
      const split = mergeRuns(runFromSequence(values.slice(0, cut)), runFromSequence(values.slice(cut)));
      expect(split).toEqual(whole);
    }
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

describe('the shard ordering assertion', () => {
  const ordered: Array<[string, TrackedForecast[]]> = [
    ['2026-08-12', day('2026-08-12', 7, () => true)],
    ['2026-08-13', day('2026-08-13', 7, () => true)],
  ];

  it('passes when shards do not overlap', () => {
    expect(assertRollupOrdering(rollupsFor(ordered))).toEqual([]);
  });

  it('fails loudly when a row resolves late enough to overlap the next shard', () => {
    // The property holds today only because resolution lag is far shorter than a cycle. A row that
    // breaks it would silently corrupt both streaks and the timeline, so it must be caught here.
    const late = day('2026-08-12', 7, () => true).map((row, index) =>
      index === 6 ? { ...row, resolvedAt: '2026-08-13T11:00:00Z' } : row);
    const errors = assertRollupOrdering(rollupsFor([['2026-08-12', late], ordered[1]]));
    expect(errors.join(' ')).toContain('overlaps the previous shard on resolution time');
  });

  it('ignores shards that contribute no resolved rows', () => {
    const open = [forecast({ id: 'open-1', issuedAt: '2026-08-11T10:00:00Z', closesAt: '2026-08-11T10:15:00Z' })];
    expect(assertRollupOrdering(rollupsFor([ordered[0], ['open', open], ordered[1]]))).toEqual([]);
  });
});
