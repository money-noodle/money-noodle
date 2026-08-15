import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUMMARY_FLOAT_TOLERANCE, buildForecastStoragePlan, compareSummaries, verifyForecastStoragePlan, writeForecastStoragePlan } from './forecast-storage';
import { summarizePerformance } from './performance';
import type { PerformanceSummary, TrackedForecast } from './types';

function forecast(overrides: Partial<TrackedForecast> = {}): TrackedForecast {
  return {
    id: 'btc:1',
    symbol: 'BTC',
    marketUrl: 'https://example.com/btc',
    issuedAt: '2026-08-14T10:00:00Z',
    closesAt: '2026-08-14T10:15:00Z',
    direction: 'UP',
    probabilityUp: 0.7,
    directionalLikelihood: 0.7,
    confidence: 0.65,
    modelVersion: 'test',
    policyVersion: 'test',
    polymarketProbabilityUp: 0.5,
    factors: [],
    status: 'pending',
    ...overrides,
  };
}

describe('forecast storage layout planning', () => {
  it('keeps unresolved rows hot and shards terminal rows by issuance day', () => {
    const rows = [
      forecast({ id: 'pending' }),
      // Deliberately separate issuance days. Resolution columns are merged by `(time, id)` and do not
      // rely on shard order, so overlaps and ties remain deterministic.
      forecast({ id: 'resolved-a', status: 'resolved', correct: true, outcome: 'UP', issuedAt: '2026-08-13T23:59:00Z', closesAt: '2026-08-14T00:00:00Z', resolvedAt: '2026-08-14T00:00:30Z' }),
      forecast({ id: 'resolved-b', status: 'resolved', correct: false, outcome: 'DOWN', issuedAt: '2026-08-14T00:01:00Z', resolvedAt: '2026-08-14T10:15:30Z' }),
      forecast({ id: 'invalid', status: 'invalid', issuedAt: '2026-08-14T00:02:00Z' }),
    ];
    const plan = buildForecastStoragePlan(rows, '2026-08-14T12:00:00Z');
    expect(plan.open.map((item) => item.id)).toEqual(['pending']);
    expect(plan.index).toMatchObject({ totalRows: 4, openRows: 1, terminalRows: 3 });
    expect(plan.shards.map((shard) => shard.entry.shardId)).toEqual(['2026-08-13', '2026-08-14']);
    expect(plan.shards.find((shard) => shard.entry.shardId === '2026-08-14')?.rollup).toMatchObject({
      version: 'forecast-rollup-v1', shardId: '2026-08-14', resolved: 1, invalid: 1, pending: 0,
    });
    expect(plan.index.shards[1].rollupSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyForecastStoragePlan(rows, plan)).toMatchObject({ ok: true, errors: [] });
  });

  it('reproduces the order-dependent statistics when rows are relaid out', () => {
    // Seven correlated assets settling on one timestamp is the ordinary case, and it is what makes
    // ties pervasive. The layout reorders these rows; `timeline` and the streaks must not move.
    const rows = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE', 'XRP'].flatMap((symbol, index) =>
      [0, 1].map((n) => forecast({
        id: `${symbol}:${n}`, symbol, status: 'resolved', outcome: 'UP',
        correct: (index + n) % 3 !== 0, brierScore: 0.2, realizedReturn: 0.1, predictedEdge: 0.1,
        issuedAt: '2026-08-14T10:00:00Z', closesAt: '2026-08-14T10:15:00Z', resolvedAt: '2026-08-14T10:15:30Z',
      })));
    const plan = buildForecastStoragePlan(rows, '2026-08-14T12:00:00Z');
    const planned = [...plan.open, ...plan.shards.flatMap((shard) => shard.rows)];
    // A layout that genuinely reorders, so the assertion is not vacuous.
    expect(planned.map((item) => item.id)).not.toEqual(rows.map((item) => item.id));

    const before = summarizePerformance(rows);
    const after = summarizePerformance(planned);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.currentStreak).toBe(before.currentStreak);
    expect(after.currentCycleStreak).toBe(before.currentCycleStreak);
    expect(compareSummaries(before, after)).toEqual([]);
  });

  describe('the summary comparison gate', () => {
    const base = () => summarizePerformance([
      forecast({ id: 'a', status: 'resolved', correct: true, outcome: 'UP', brierScore: 0.1, realizedReturn: 0.2, predictedEdge: 0.1 }),
      forecast({ id: 'b', status: 'resolved', correct: false, outcome: 'DOWN', brierScore: 0.4, realizedReturn: -0.3, predictedEdge: 0.1 }),
    ]);

    const scaleMeanReturn = (summary: PerformanceSummary, factor: number): PerformanceSummary => {
      expect(summary.meanRealizedReturn).toBeTypeOf('number');
      return { ...summary, meanRealizedReturn: summary.meanRealizedReturn! * factor };
    };

    it('accepts float aggregates that differ only by summation order', () => {
      expect(compareSummaries(base(), scaleMeanReturn(base(), 1 + SUMMARY_FLOAT_TOLERANCE / 10))).toEqual([]);
    });

    it('accepts last-bit summation noise near zero without magnifying it into a relative failure', () => {
      const before = base();
      const after = { ...before, meanRealizedReturn: 1.45e-16 };
      expect(compareSummaries({ ...before, meanRealizedReturn: 0 }, after)).toEqual([]);
    });

    it('rejects a float aggregate that moved further than summation order explains', () => {
      expect(compareSummaries(base(), scaleMeanReturn(base(), 1.01)).join(' ')).toContain('meanRealizedReturn');
    });

    it('rejects any countable difference exactly, with no tolerance', () => {
      const off = base();
      off.resolved -= 1;
      expect(compareSummaries(base(), off).join(' ')).toContain('summary.resolved: 2 != 1');
    });

    it('catches an order-dependent statistic the headline counters cannot see', () => {
      const reordered = base();
      reordered.timeline = [...reordered.timeline].reverse();
      const differences = compareSummaries(base(), reordered);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.join(' ')).toContain('timeline');
    });

    it('reports a changed array length rather than walking past it', () => {
      const truncated = base();
      truncated.timeline = truncated.timeline.slice(0, -1);
      expect(compareSummaries(base(), truncated).join(' ')).toMatch(/timeline: length \d+ != \d+/);
    });

    it('caps runaway output so a systematic divergence stays readable', () => {
      const before = base();
      const after = JSON.parse(JSON.stringify(before)) as PerformanceSummary;
      after.timeline = after.timeline.map((point) => ({ ...point, cumulativeAccuracy: point.cumulativeAccuracy + 0.5, rollingAccuracy: point.rollingAccuracy + 0.5 }));
      expect(compareSummaries(before, after, SUMMARY_FLOAT_TOLERANCE, 3)).toHaveLength(3);
    });
  });

  it('rejects a stored rollup that no longer matches its indexed checksum', () => {
    const rows = [forecast({ id: 'resolved', status: 'resolved', correct: true, outcome: 'UP' })];
    const plan = buildForecastStoragePlan(rows, '2026-08-14T12:00:00Z');
    plan.shards[0].rollup.correct += 1;
    expect(verifyForecastStoragePlan(rows, plan).errors.join(' ')).toContain('rollup checksum');
  });

  it('writes open rows, shards, sufficient-statistic rollups, and index atomically readable as JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-forecast-storage-'));
    try {
      const rows = [
        forecast({ id: 'pending' }),
        forecast({ id: 'resolved', status: 'resolved', correct: true, outcome: 'UP' }),
      ];
      const plan = buildForecastStoragePlan(rows, '2026-08-14T12:00:00Z');
      await writeForecastStoragePlan(root, plan);
      const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
      const open = JSON.parse(await readFile(path.join(root, 'open.json'), 'utf8'));
      const shardRaw = await readFile(path.join(root, '2026-08-14.json'), 'utf8');
      const rollupRaw = await readFile(path.join(root, '2026-08-14.rollup.json'), 'utf8');
      const shard = JSON.parse(shardRaw);
      const rollup = JSON.parse(rollupRaw);
      expect(index).toMatchObject({ version: 'forecast-storage-v2' });
      expect(index.shards).toHaveLength(1);
      expect(index.shards[0].sha256).toBe(createHash('sha256').update(shardRaw).digest('hex'));
      expect(index.shards[0].rollupSha256).toBe(createHash('sha256').update(rollupRaw).digest('hex'));
      expect(open.map((item: TrackedForecast) => item.id)).toEqual(['pending']);
      expect(shard.map((item: TrackedForecast) => item.id)).toEqual(['resolved']);
      expect(rollup).toMatchObject({ version: 'forecast-rollup-v1', shardId: '2026-08-14', resolved: 1 });
      expect(rollup.timeline).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
