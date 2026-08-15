import { describe, expect, it } from 'vitest';
import { compareSummaries } from './forecast-storage';
import { buildSummaryRollup, leadingStreak, summarizeFromRollups } from './forecast-rollup';
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
